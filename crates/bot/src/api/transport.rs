//! The wire under the Bot API client: one HTTP POST per call. Everything above
//! it (encoding, the retry, the timing, the unchanged-edit guard, the menu
//! rendering) is the client's, so a test transport sits beneath all of it, the
//! way the TypeScript recorder's `fetch` sat beneath every grammY transformer.

use std::path::PathBuf;
use std::time::Duration;

use futures_util::StreamExt as _;
use futures_util::stream;

use crate::Fut;

/// One encoded call: the Bot API method, the content type, and the body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub content_type: String,
    pub body: Vec<BodyChunk>,
}

/// A body piece; a file is streamed from disk rather than read into memory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BodyChunk {
    Bytes(Vec<u8>),
    File(PathBuf),
}

/// The request never got an answer (grammY's `HttpError` cause).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransportError(pub String);

pub trait Transport {
    /// Sends one call and returns the response body, whatever its status:
    /// Telegram answers its errors as JSON too.
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<Vec<u8>, TransportError>>;
}

/// The real Bot API over HTTPS (or a local Bot API server at `api_root`).
pub struct HttpTransport {
    client: reqwest::Client,
    api_root: String,
    token: String,
}

impl HttpTransport {
    /// grammY's default request timeout is 500 s; long polling waits 30 s.
    pub fn new(api_root: &str, token: &str) -> Result<Self, TransportError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(500))
            .build()
            .map_err(|error| TransportError(error.to_string()))?;
        Ok(Self {
            client,
            api_root: api_root.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
        })
    }
}

impl Transport for HttpTransport {
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<Vec<u8>, TransportError>> {
        Box::pin(async move {
            let url = format!("{}/bot{}/{}", self.api_root, self.token, request.method);
            let chunks = stream::iter(request.body).then(|chunk| async move {
                match chunk {
                    BodyChunk::Bytes(bytes) => Ok(stream::iter([Ok::<_, std::io::Error>(bytes.into())]).boxed()),
                    BodyChunk::File(path) => tokio::fs::File::open(&path)
                        .await
                        .map(|file| tokio_util::io::ReaderStream::new(file).boxed()),
                }
            });
            let body = chunks
                .map(|opened| match opened {
                    Ok(file) => file,
                    Err(error) => stream::iter([Err(error)]).boxed(),
                })
                .flatten();
            let response = self
                .client
                .post(url)
                .header("content-type", request.content_type)
                .header("connection", "keep-alive")
                .body(reqwest::Body::wrap_stream(body))
                .send()
                .await
                .map_err(|error| TransportError(error.without_url().to_string()))?;
            let bytes = response
                .bytes()
                .await
                .map_err(|error| TransportError(error.without_url().to_string()))?;
            Ok(bytes.to_vec())
        })
    }
}
