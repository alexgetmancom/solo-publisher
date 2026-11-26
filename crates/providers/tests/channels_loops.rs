//! The loop bodies run end to end over an empty Studio: nothing to renew,
//! refresh or apply, so no provider is called, and the observability tick
//! leaves its worker record.

use std::rc::Rc;

use db::{BackendDb, unsafe_db};
use foundation::config::{SharedConfig, load_config};
use providers::channels::loops::{credentials_tick, observability_tick, platform_tokens_tick, x_token_tick};
use runtime::http::{Fut, HttpClient, HttpRequest, HttpResponse, Transport, TransportFailure};

struct Unreachable;

impl Transport for Unreachable {
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<HttpResponse, TransportFailure>> {
        panic!("no provider is called here, got {}", request.url)
    }
}

#[tokio::test(flavor = "current_thread")]
async fn ticks_run_over_an_empty_studio() {
    let db = BackendDb::open(":memory:").unwrap();
    let config = SharedConfig::new(load_config([("TOKEN_ENCRYPTION_KEY".to_owned(), "22".repeat(32))]).unwrap());
    let http = HttpClient::new(Rc::new(Unreachable));
    credentials_tick(&config, &db).await.unwrap();
    platform_tokens_tick(&config, &db, &http).await.unwrap();
    x_token_tick(&config, &db, &http).await.unwrap();
    observability_tick(&config, &db, &http).await.unwrap();
    observability_tick(&config, &db, &http).await.unwrap();
    let state: String = unsafe_db(&db)
        .query_row(
            "SELECT state_json FROM worker_state WHERE name = 'observability'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(state.starts_with(r#"{"alerts":0,"credentials":0,"ok":true"#), "{state}");
    let restarts: i64 = unsafe_db(&db)
        .query_row(
            "SELECT count(*) FROM publication_events WHERE target = 'runtime'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        restarts, 0,
        "the first cycle adopts the boot identity, the second sees itself"
    );
}
