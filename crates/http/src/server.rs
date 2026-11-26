//! The listener: HTTP/1.1 connections, each on its own task, with the
//! request and idle limits the goldens pin, and a graceful stop.
//!
//! Connections are spawned with `tokio::spawn`: they only route and move
//! bytes (the router is `Send`); route bodies reach the Studio thread through
//! [`Local`](crate::Local). On the Studio's current-thread runtime both run on
//! the one thread.

use std::future::Future;
use std::pin::{Pin, pin};
use std::time::Duration;

use axum::Router;
use content::assets::STUDIO_MEDIA_MAX_BYTES;
use foundation::logger::{LogLevel, log};
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::server::graceful::GracefulShutdown;
use hyper_util::service::TowerToHyperService;
use serde_json::json;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio_io_timeout::TimeoutStream;
use tower::Layer as _;
use tower_http::limit::{RequestBodyLimit, RequestBodyLimitLayer};

use crate::{HttpState, router};

/// A video upload is one body of up to a gigabyte, plus room for the request.
pub const MAX_REQUEST_BODY_BYTES: u64 = STUDIO_MEDIA_MAX_BYTES + 1024 * 1024;

/// A connection with no traffic either way for this long is closed: the MCP
/// stream pings every 30 seconds and a slow upload can pause (Bun's maximum).
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(255);

/// Accepts connections until `stop` completes, then stops accepting and
/// returns once the requests in flight are answered (an
/// idle keep-alive connection closes at once). Must run inside the
/// process's `LocalSet` (see [`router`]).
pub async fn serve(listener: TcpListener, state: HttpState, stop: impl Future<Output = ()>) {
    let app = RequestBodyLimitLayer::new(MAX_REQUEST_BODY_BYTES as usize).layer(router(state));
    let connections = GracefulShutdown::new();
    let mut stop = pin!(stop);
    loop {
        let accepted = tokio::select! {
            () = &mut stop => break,
            accepted = listener.accept() => accepted,
        };
        let stream = match accepted {
            Ok((stream, _)) => stream,
            // A connection that failed before it was accepted (reset, out of
            // descriptors for a moment) is that connection's problem.
            Err(error) if is_connection_error(&error) => continue,
            Err(error) => {
                log(
                    LogLevel::Warn,
                    "accept failed",
                    Some(json!({"error": error.to_string()})),
                );
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        let connection = connections.watch(connection(stream, app.clone()));
        // A client that goes away mid-request is not the server's error.
        tokio::spawn(async move {
            let _ = connection.await;
        });
    }
    drop(listener);
    connections.shutdown().await;
}

type App = RequestBodyLimit<Router>;

/// A connection hyper serves, its stream closing after [`IDLE_TIMEOUT`].
type Connection<S> = http1::Connection<TokioIo<Pin<Box<TimeoutStream<S>>>>, TowerToHyperService<App>>;

/// One HTTP/1.1 connection, closed after [`IDLE_TIMEOUT`] without traffic.
fn connection<S>(stream: S, app: App) -> Connection<S>
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let mut stream = TimeoutStream::new(stream);
    stream.set_read_timeout(Some(IDLE_TIMEOUT));
    stream.set_write_timeout(Some(IDLE_TIMEOUT));
    http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(IDLE_TIMEOUT)
        .serve_connection(TokioIo::new(Box::pin(stream)), TowerToHyperService::new(app))
}

fn is_connection_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionReset
    )
}

#[cfg(test)]
mod tests {
    use std::rc::Rc;
    use std::time::Duration;

    use channels::entropy::Entropy;
    use channels::oauth_routes::ChannelRegistrar;
    use db::BackendDb;
    use domain::application::ports::{ChannelConnectionRecord, Clock};
    use domain::studio::Studio;
    use domain::studio::services::channels::ChannelInput;
    use foundation::config::{Config, SharedConfig};
    use hyper_util::server::graceful::GracefulShutdown;
    use runtime::http::HttpClient;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tower::Layer as _;
    use tower_http::limit::RequestBodyLimitLayer;

    use super::{App, MAX_REQUEST_BODY_BYTES, connection};
    use crate::{Backend, HttpState, router};

    /// The routes below never reach the Studio.
    struct Untouched;

    impl Backend for Untouched {
        fn db(&self) -> &BackendDb {
            unreachable!()
        }
        fn clock(&self) -> &dyn Clock {
            unreachable!()
        }
        fn config(&self) -> &SharedConfig {
            unreachable!()
        }
        fn studio<'a>(&'a self, _: &'a Config) -> Studio<'a> {
            unreachable!()
        }
        fn http(&self) -> &HttpClient {
            unreachable!()
        }
        fn entropy(&self) -> &dyn Entropy {
            unreachable!()
        }
    }

    impl ChannelRegistrar for Untouched {
        fn connect(&self, _: &ChannelInput) -> domain::Result<ChannelConnectionRecord> {
            unreachable!()
        }
    }

    fn app() -> App {
        RequestBodyLimitLayer::new(MAX_REQUEST_BODY_BYTES as usize).layer(router(HttpState::new(Rc::new(Untouched))))
    }

    async fn exchange(request: &str) -> String {
        let (mut client, server) = tokio::io::duplex(1 << 16);
        tokio::spawn(connection(server, app()));
        client.write_all(request.as_bytes()).await.unwrap();
        let mut answer = String::new();
        client.read_to_string(&mut answer).await.unwrap();
        answer
    }

    #[tokio::test(flavor = "current_thread")]
    async fn connections_are_served_on_the_local_set() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let ok = exchange("GET /healthz/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await;
                assert!(ok.starts_with("HTTP/1.1 200 OK\r\n"), "{ok}");
                assert!(ok.contains("content-type: text/plain; charset=utf-8\r\n"), "{ok}");
                assert!(ok.ends_with("\r\n\r\nok\n"), "{ok}");
                let head = exchange("HEAD /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await;
                assert!(
                    head.starts_with("HTTP/1.1 200 OK\r\n") && head.ends_with("\r\n\r\n"),
                    "{head}"
                );
                let unknown = exchange("DELETE /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await;
                assert!(unknown.starts_with("HTTP/1.1 404 Not Found\r\n") && unknown.ends_with("not found\n"));
                assert!(!unknown.contains("allow:"), "{unknown}");
                let large = exchange(&format!(
                    "POST /api/studio/media HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
                    MAX_REQUEST_BODY_BYTES + 1
                ))
                .await;
                assert!(large.starts_with("HTTP/1.1 413 Payload Too Large\r\n"), "{large}");
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stopping_answers_then_closes_a_kept_alive_connection() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (mut client, server) = tokio::io::duplex(1 << 16);
                let connections = GracefulShutdown::new();
                let served = tokio::spawn(connections.watch(connection(server, app())));
                client
                    .write_all(b"GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n")
                    .await
                    .unwrap();
                let mut answer = Vec::new();
                while !answer.ends_with(b"\r\n\r\nok\n") {
                    let mut chunk = [0; 1024];
                    let read = client.read(&mut chunk).await.unwrap();
                    assert!(read > 0, "{}", String::from_utf8_lossy(&answer));
                    answer.extend_from_slice(&chunk[..read]);
                }
                tokio::time::timeout(Duration::from_secs(5), connections.shutdown())
                    .await
                    .expect("an idle connection closes when the server stops");
                assert!(served.await.unwrap().is_ok());
                let mut rest = Vec::new();
                client.read_to_end(&mut rest).await.unwrap();
                assert!(rest.is_empty());
            })
            .await;
    }
}
