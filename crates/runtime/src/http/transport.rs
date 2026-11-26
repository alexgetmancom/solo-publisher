//! The wire under every external call: one request in, the status and headers
//! out, the body read afterwards at the caller's pace. Every adapter takes it
//! as a parameter, so a test hands a recording transport to the same code
//! production runs over [`ReqwestTransport`].

use std::path::PathBuf;
use std::pin::Pin;
use std::time::Duration;

use futures_util::StreamExt as _;
use futures_util::stream;
use tokio::io::AsyncSeekExt as _;

/// A future the single-threaded runtime awaits; nothing here is `Send`.
pub type Fut<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Method {
    Get,
    Head,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Head => "HEAD",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
        }
    }
}

/// One piece of a request body. A file is streamed from `offset` to its end
/// rather than read into memory (`Bun.file(path).slice(offset)`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BodyPart {
    Bytes(Vec<u8>),
    File { path: PathBuf, offset: u64 },
}

/// The request body, sent as its parts back to back; empty sends none.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Body(pub Vec<BodyPart>);

impl Body {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The body as one byte string, when no part is a file: what a recording
    /// transport compares.
    pub fn as_bytes(&self) -> Option<Vec<u8>> {
        let mut bytes = Vec::new();
        for part in &self.0 {
            match part {
                BodyPart::Bytes(chunk) => bytes.extend_from_slice(chunk),
                BodyPart::File { .. } => return None,
            }
        }
        Some(bytes)
    }
}

/// One request. Headers keep the caller's order and spelling.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Body,
    /// The caller's own deadline over the whole exchange, body included
    /// (`signal: AbortSignal.timeout(ms)`). The client's ceiling, which ends
    /// at the response headers, applies regardless.
    pub deadline: Option<Duration>,
    /// `redirect: "follow"`, `fetch`'s default; off is `redirect: "manual"`,
    /// the 3xx answered as it came.
    pub follow_redirects: bool,
}

impl HttpRequest {
    pub fn new(method: Method, url: impl Into<String>) -> Self {
        Self {
            method,
            url: url.into(),
            headers: Vec::new(),
            body: Body::default(),
            deadline: None,
            follow_redirects: true,
        }
    }

    pub fn get(url: impl Into<String>) -> Self {
        Self::new(Method::Get, url)
    }

    pub fn post(url: impl Into<String>) -> Self {
        Self::new(Method::Post, url)
    }

    pub fn put(url: impl Into<String>) -> Self {
        Self::new(Method::Put, url)
    }

    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn body(mut self, body: Body) -> Self {
        self.body = body;
        self
    }

    /// A string body, sent with the headers the caller set and no others
    /// (Bun's `Request` adds no content type for a string).
    pub fn text(self, body: impl Into<String>) -> Self {
        self.body(Body(vec![BodyPart::Bytes(body.into().into_bytes())]))
    }

    /// A form body: absent values are skipped, and
    /// `fetch`'s implicit content type is set unless the caller set one.
    pub fn form(self, fields: &[(&str, Option<&str>)]) -> Self {
        let encoded = super::form_body(fields);
        let with_type = if self.header_value("content-type").is_some() {
            self
        } else {
            self.header("content-type", "application/x-www-form-urlencoded;charset=UTF-8")
        };
        with_type.body(Body(vec![BodyPart::Bytes(encoded.into_bytes())]))
    }

    pub fn deadline(mut self, deadline: Duration) -> Self {
        self.deadline = Some(deadline);
        self
    }

    /// `redirect: "manual"`.
    pub fn manual_redirect(mut self) -> Self {
        self.follow_redirects = false;
        self
    }

    /// The first header of that name, compared case-insensitively.
    pub fn header_value(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Response headers, looked up case-insensitively; a value reads without its
/// surrounding HTTP whitespace, a repeated header as its values joined by
/// `", "`, as `Headers.get` does.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Headers(pub Vec<(String, String)>);

impl Headers {
    pub fn get(&self, name: &str) -> Option<String> {
        let values: Vec<&str> = self
            .0
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.trim_matches([' ', '\t', '\r', '\n']))
            .collect();
        (!values.is_empty()).then(|| values.join(", "))
    }
}

/// The request got no answer, or its body stopped arriving. `timed_out` is the
/// caller's deadline expiring (`TimeoutError`), as opposed to any other loss.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransportFailure {
    pub message: String,
    pub timed_out: bool,
}

/// A response body, read chunk by chunk.
pub trait ResponseBody {
    /// The next chunk, or `None` once the body has ended.
    fn next_chunk(&mut self) -> Fut<'_, Result<Option<Vec<u8>>, TransportFailure>>;
}

/// A body already in memory: what a test transport answers with.
pub struct BufferedBody(Option<Vec<u8>>);

impl BufferedBody {
    pub fn new(bytes: impl Into<Vec<u8>>) -> Self {
        Self(Some(bytes.into()))
    }
}

impl ResponseBody for BufferedBody {
    fn next_chunk(&mut self) -> Fut<'_, Result<Option<Vec<u8>>, TransportFailure>> {
        let chunk = self.0.take();
        Box::pin(async move { Ok(chunk) })
    }
}

/// What a transport answered: the status and headers, and the body unread.
pub struct HttpResponse {
    pub status: u16,
    pub headers: Headers,
    pub body: Box<dyn ResponseBody>,
}

impl HttpResponse {
    /// A canned answer, for test transports.
    pub fn buffered(status: u16, headers: Vec<(String, String)>, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status,
            headers: Headers(headers),
            body: Box::new(BufferedBody::new(body)),
        }
    }
}

pub trait Transport {
    /// Sends one request and returns once the response headers have arrived,
    /// whatever the status. `Err` is a request that got no answer.
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<HttpResponse, TransportFailure>>;
}

/// The real network, over rustls. Redirects are followed, as `fetch` does,
/// unless the request asked for them manually.
pub struct ReqwestTransport {
    client: reqwest::Client,
    manual: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new() -> Result<Self, TransportFailure> {
        let client = reqwest::Client::builder().build().map_err(failure)?;
        let manual = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(failure)?;
        Ok(Self { client, manual })
    }
}

fn failure(error: reqwest::Error) -> TransportFailure {
    TransportFailure {
        timed_out: error.is_timeout(),
        message: error.without_url().to_string(),
    }
}

fn file_failure(error: std::io::Error) -> TransportFailure {
    TransportFailure {
        message: error.to_string(),
        timed_out: false,
    }
}

impl Transport for ReqwestTransport {
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<HttpResponse, TransportFailure>> {
        Box::pin(async move {
            let method = match request.method {
                Method::Get => reqwest::Method::GET,
                Method::Head => reqwest::Method::HEAD,
                Method::Post => reqwest::Method::POST,
                Method::Put => reqwest::Method::PUT,
                Method::Patch => reqwest::Method::PATCH,
                Method::Delete => reqwest::Method::DELETE,
            };
            let client = if request.follow_redirects {
                &self.client
            } else {
                &self.manual
            };
            let mut builder = client.request(method, &request.url);
            let mut length_given = false;
            for (name, value) in &request.headers {
                length_given |= name.eq_ignore_ascii_case("content-length");
                builder = builder.header(name, value);
            }
            if let Some(deadline) = request.deadline {
                builder = builder.timeout(deadline);
            }
            if !request.body.is_empty() {
                // A known length goes out as Content-Length, as `fetch` sends
                // a file or a form, instead of chunked transfer encoding.
                if !length_given {
                    builder = builder.header("content-length", body_length(&request.body).await?.to_string());
                }
                builder = builder.body(streamed(request.body).await?);
            }
            let response = builder.send().await.map_err(failure)?;
            let headers = response
                .headers()
                .iter()
                .map(|(name, value)| {
                    (
                        name.as_str().to_owned(),
                        String::from_utf8_lossy(value.as_bytes()).into_owned(),
                    )
                })
                .collect();
            Ok(HttpResponse {
                status: response.status().as_u16(),
                headers: Headers(headers),
                body: Box::new(ReqwestBody(response)),
            })
        })
    }
}

async fn body_length(body: &Body) -> Result<u64, TransportFailure> {
    let mut length = 0;
    for part in &body.0 {
        length += match part {
            BodyPart::Bytes(bytes) => bytes.len() as u64,
            BodyPart::File { path, offset } => {
                let size = tokio::fs::metadata(path).await.map_err(file_failure)?.len();
                size.saturating_sub(*offset)
            }
        };
    }
    Ok(length)
}

/// Files are opened before the request goes out, so a missing one fails the
/// call instead of truncating a body already on the wire.
async fn streamed(body: Body) -> Result<reqwest::Body, TransportFailure> {
    let mut parts = Vec::new();
    for part in body.0 {
        parts.push(match part {
            BodyPart::Bytes(bytes) => stream::iter([Ok::<_, std::io::Error>(bytes.into())]).boxed(),
            BodyPart::File { path, offset } => {
                let mut file = tokio::fs::File::open(&path).await.map_err(file_failure)?;
                file.seek(std::io::SeekFrom::Start(offset))
                    .await
                    .map_err(file_failure)?;
                tokio_util::io::ReaderStream::new(file).boxed()
            }
        });
    }
    Ok(reqwest::Body::wrap_stream(stream::iter(parts).flatten()))
}

struct ReqwestBody(reqwest::Response);

impl ResponseBody for ReqwestBody {
    fn next_chunk(&mut self) -> Fut<'_, Result<Option<Vec<u8>>, TransportFailure>> {
        Box::pin(async move {
            let chunk = self.0.chunk().await.map_err(failure)?;
            Ok(chunk.map(|bytes| bytes.to_vec()))
        })
    }
}
