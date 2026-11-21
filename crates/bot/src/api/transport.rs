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

/// What the Bot API file endpoint answered: its status, the length it
/// announced, and the body, read up to one byte past the caller's limit so an
/// oversized file is told apart without being read whole.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Downloaded {
    pub status: u16,
    pub content_length: Option<u64>,
    pub body: Vec<u8>,
}

pub trait Transport {
    /// Sends one call and returns the response body, whatever its status:
    /// Telegram answers its errors as JSON too.
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<Vec<u8>, TransportError>>;

    /// `GET <api root>/file/bot<token>/<file_path>`: a file `getFile` named
    /// by a relative path (the cloud Bot API; a local server answers absolute
    /// paths, which are read from disk instead).
    fn download(
        &self,
        file_path: &str,
        max_bytes: u64,
        timeout: Duration,
    ) -> Fut<'_, Result<Downloaded, TransportError>>;
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

    fn download(
        &self,
        file_path: &str,
        max_bytes: u64,
        timeout: Duration,
    ) -> Fut<'_, Result<Downloaded, TransportError>> {
        let url = format!("{}/file/bot{}/{file_path}", self.api_root, self.token);
        Box::pin(async move {
            let failed = |error: reqwest::Error| TransportError(error.without_url().to_string());
            let mut response = self.client.get(url).timeout(timeout).send().await.map_err(failed)?;
            let status = response.status().as_u16();
            let content_length = response.content_length();
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(failed)? {
                body.extend_from_slice(&chunk);
                if body.len() as u64 > max_bytes {
                    break;
                }
            }
            Ok(Downloaded {
                status,
                content_length,
                body,
            })
        })
    }
}
