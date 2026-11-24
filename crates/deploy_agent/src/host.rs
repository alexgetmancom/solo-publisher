//! What the agent does to the world besides its own files: `docker`, and
//! HTTP to health endpoints, a remote agent and the Telegram Bot API. A test
//! drives both through [`Host`].

use std::future::Future;
use std::os::unix::process::ExitStatusExt as _;
use std::pin::Pin;
use std::process::Stdio;
use std::time::Duration;

use http_body_util::{BodyExt as _, Full};
use hyper::body::Bytes;
use hyper::{Method, Request, Uri};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

pub type Fut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A `docker` run to its end.
#[derive(Clone, Debug, Default)]
pub struct Output {
    /// The exit code; a process killed by a signal reads as `128 + signal`.
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Debug)]
pub struct OutboundRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<String>,
    pub timeout: Duration,
}

#[derive(Clone, Debug)]
pub struct OutboundResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

pub trait Host: Send + Sync + 'static {
    /// Runs `docker` (from `PATH`) with `args`; `Err` when it cannot start.
    fn docker(&self, args: Vec<String>) -> Fut<'_, std::io::Result<Output>>;
    /// `Err` when nothing answered within the request's timeout.
    fn http(&self, request: OutboundRequest) -> Fut<'_, Result<OutboundResponse, String>>;
}

/// This host: its `docker` and its network.
pub struct System;

impl Host for System {
    fn docker(&self, args: Vec<String>) -> Fut<'_, std::io::Result<Output>> {
        Box::pin(async move {
            let output = tokio::process::Command::new("docker")
                .args(&args)
                .stdin(Stdio::null())
                .output()
                .await?;
            Ok(Output {
                code: output
                    .status
                    .code()
                    .unwrap_or_else(|| 128 + output.status.signal().unwrap_or(0)),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            })
        })
    }

    fn http(&self, request: OutboundRequest) -> Fut<'_, Result<OutboundResponse, String>> {
        Box::pin(async move {
            let timeout = request.timeout;
            tokio::time::timeout(timeout, exchange(request))
                .await
                .unwrap_or_else(|_| Err(format!("request timed out after {}s", timeout.as_secs())))
        })
    }
}

/// One HTTP/1.1 request on a connection of its own. Plain HTTP only: the
/// configuration refuses any other scheme at start.
async fn exchange(request: OutboundRequest) -> Result<OutboundResponse, String> {
    let uri: Uri = request
        .url
        .parse()
        .map_err(|error| format!("{}: {error}", request.url))?;
    if uri.scheme_str() != Some("http") {
        return Err(format!("{} is not an http:// URL", request.url));
    }
    let host = uri.host().ok_or_else(|| format!("{} names no host", request.url))?;
    let port = uri.port_u16().unwrap_or(80);
    let stream = TcpStream::connect((host.trim_start_matches('[').trim_end_matches(']'), port))
        .await
        .map_err(|error| error.to_string())?;
    send(stream, &uri, request).await
}

async fn send<S>(stream: S, uri: &Uri, request: OutboundRequest) -> Result<OutboundResponse, String>
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|error| error.to_string())?;
    tokio::spawn(connection);
    let authority = uri.authority().map_or("", |authority| authority.as_str()).to_owned();
    let mut builder = Request::builder()
        .method(request.method)
        .uri(uri.path_and_query().map_or("/", |path| path.as_str()))
        .header("host", authority);
    for (name, value) in request.headers {
        builder = builder.header(name, value);
    }
    let outgoing = builder
        .body(Full::new(Bytes::from(request.body.unwrap_or_default())))
        .map_err(|error| error.to_string())?;
    let response = sender.send_request(outgoing).await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let body = response
        .into_body()
        .collect()
        .await
        .map_err(|error| error.to_string())?
        .to_bytes()
        .to_vec();
    Ok(OutboundResponse { status, body })
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;

    use hyper::body::Incoming;
    use hyper::service::service_fn;

    use super::*;

    /// What goes on the wire, read back by a server on the other end.
    #[tokio::test]
    async fn a_request_carries_its_path_host_headers_and_body() {
        let (client, server) = tokio::io::duplex(1 << 16);
        tokio::spawn(async move {
            let service = service_fn(|request: Request<Incoming>| async move {
                let head = format!(
                    "{} {} host={} auth={} type={}",
                    request.method(),
                    request.uri(),
                    request.headers()["host"].to_str().unwrap(),
                    request.headers()["authorization"].to_str().unwrap(),
                    request.headers()["content-type"].to_str().unwrap(),
                );
                let body = request.into_body().collect().await.unwrap().to_bytes();
                let mut response = hyper::Response::new(Full::new(Bytes::from(format!(
                    "{head} body={}",
                    String::from_utf8_lossy(&body)
                ))));
                *response.status_mut() = hyper::StatusCode::ACCEPTED;
                Ok::<_, Infallible>(response)
            });
            hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(server), service)
                .await
                .unwrap();
        });
        let url = "http://127.0.0.1:9098/v1/deploy?x=1";
        let response = send(
            client,
            &url.parse().unwrap(),
            OutboundRequest {
                method: Method::POST,
                url: url.into(),
                headers: vec![
                    ("authorization", "Bearer token".into()),
                    ("content-type", "application/json".into()),
                ],
                body: Some(r#"{"release":"abc1234"}"#.into()),
                timeout: Duration::from_secs(1),
            },
        )
        .await
        .unwrap();
        assert_eq!(response.status, 202);
        assert_eq!(
            String::from_utf8(response.body).unwrap(),
            r#"POST /v1/deploy?x=1 host=127.0.0.1:9098 auth=Bearer token type=application/json body={"release":"abc1234"}"#
        );
    }
}
