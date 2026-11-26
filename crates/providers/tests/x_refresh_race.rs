//! A refresh whose request is in flight while an operator reconnects X must
//! not overwrite the newer pair with the older one: the transport here swaps
//! the stored pair before it answers, as the OAuth callback would.

use std::rc::Rc;

use db::rusqlite::Connection;
use db::{BackendDb, unsafe_db};
use foundation::config::{SharedConfig, load_config};
use foundation::secret_box::{SecretKey, encryption_key, open, seal};
use jiff::Timestamp;
use providers::channels::token_store::{TokenWrite, platform_token, store_platform_token};
use providers::channels::x::{XRefresh, refresh_x_token};
use runtime::http::{Fut, HttpClient, HttpRequest, HttpResponse, Transport, TransportFailure};

const KEY_HEX: &str = "22";

/// Answers the refresh with an older-generation pair after `during` ran.
struct RacingX<F: Fn()> {
    during: F,
}

impl<F: Fn()> Transport for RacingX<F> {
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<HttpResponse, TransportFailure>> {
        assert_eq!(request.url, "https://api.x.com/2/oauth2/token");
        (self.during)();
        Box::pin(async {
            Ok(HttpResponse::buffered(
                200,
                vec![("content-type".into(), "application/json".into())],
                r#"{"access_token":"refreshed-access","refresh_token":"refreshed-refresh","expires_in":7200}"#,
            ))
        })
    }
}

fn pair(key: &SecretKey, access: &str, refresh: &str, expires_at: &str, stamp: &str) -> TokenWrite {
    TokenWrite {
        sealed_token: seal(access, key),
        seed_fingerprint: None,
        account_id: Some("acct".into()),
        sealed_refresh_token: Some(Some(seal(refresh, key))),
        expires_at: Some(Some(expires_at.into())),
        refreshed_at: stamp.into(),
        upload_limit_bytes: None,
        updated_at: stamp.into(),
    }
}

/// The reconnect the transport performs on a second connection to the file.
fn reconnect(path: &str, config: &SharedConfig, key: &SecretKey) {
    let other = Connection::open(path).unwrap();
    let write = pair(
        key,
        "new-access",
        "new-refresh",
        "2099-01-01T00:00:00.000Z",
        "2026-11-21T10:00:01.000Z",
    );
    store_platform_token(&other, "x", &write).unwrap();
    config.update(|current| {
        let mut next = current.clone();
        next.x_access_token = Some("new-access".into());
        next.x_refresh_token = Some("new-refresh".into());
        next
    });
}

async fn race(seed_old_row: bool) {
    let dir = std::env::temp_dir().join(format!("x-refresh-race-{}-{seed_old_row}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("studio.db");
    let path = path.to_str().unwrap().to_owned();
    let db = BackendDb::open(&path).unwrap();
    let config = SharedConfig::new(
        load_config([
            ("TOKEN_ENCRYPTION_KEY".to_owned(), KEY_HEX.repeat(32)),
            ("X_CLIENT_ID".to_owned(), "client".to_owned()),
            ("X_CLIENT_SECRET".to_owned(), "secret".to_owned()),
        ])
        .unwrap(),
    );
    config.update(|current| {
        let mut next = current.clone();
        next.x_refresh_token = Some("old-refresh".into());
        next
    });
    let key = encryption_key(Some(&KEY_HEX.repeat(32))).unwrap().unwrap();
    if seed_old_row {
        let old = pair(
            &key,
            "old-access",
            "old-refresh",
            "2026-11-21T10:00:00.000Z",
            "2026-11-21T08:00:00.000Z",
        );
        store_platform_token(unsafe_db(&db), "x", &old).unwrap();
    }
    let transport = RacingX {
        during: {
            let (path, config, key) = (path.clone(), config.clone(), key.clone());
            move || reconnect(&path, &config, &key)
        },
    };
    let http = HttpClient::new(Rc::new(transport));

    let now: Timestamp = "2026-11-21T10:00:00Z".parse().unwrap();
    let outcome = refresh_x_token(&config, unsafe_db(&db), &http, now).await.unwrap();

    assert_eq!(outcome, XRefresh::Superseded);
    let row = platform_token(unsafe_db(&db), "x").unwrap().unwrap();
    assert_eq!(open(&row.sealed_token, &key).unwrap(), "new-access");
    assert_eq!(open(&row.sealed_refresh_token.unwrap(), &key).unwrap(), "new-refresh");
    assert_eq!(row.expires_at.as_deref(), Some("2099-01-01T00:00:00.000Z"));
    let live = config.load();
    assert_eq!(live.x_access_token.as_deref(), Some("new-access"));
    assert_eq!(live.x_refresh_token.as_deref(), Some("new-refresh"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn refresh_does_not_overwrite_a_pair_reconnected_meanwhile() {
    race(true).await;
}

#[tokio::test(flavor = "current_thread")]
async fn refresh_does_not_overwrite_a_row_stored_meanwhile() {
    race(false).await;
}
