//! The session file mtcute 0.32.1 leaves behind (`fixtures/mtcute.session`,
//! written by mtcute's own storage with a random key for DC 2) loads as the
//! signed-in home datacenter, and what grammers changes during a sign-in
//! lands back in it in mtcute's layout.

use std::net::SocketAddrV4;
use std::path::{Path, PathBuf};

use grammers_client::session::Session as _;
use grammers_client::session::types::DcOption;
use mtproto::session::SessionFile;
use rusqlite::Connection;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../_trash-rust/tmp/mtproto-tests")
        .join(format!("{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn block_on<T>(work: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(work)
}

fn dc_main(path: &Path) -> Vec<u8> {
    Connection::open(path)
        .unwrap()
        .query_row("select value from key_value where key = 'dc_main'", [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn the_mtcute_session_loads_and_keeps_a_sign_in_that_moved() {
    let dir = scratch("moved");
    let path = dir.join("telegram_channel_stories");
    std::fs::copy(fixtures().join("mtcute.session"), &path).unwrap();
    let key_hex = std::fs::read_to_string(fixtures().join("mtcute.session.key.hex")).unwrap();
    let key: Vec<u8> = (0..512)
        .step_by(2)
        .map(|index| u8::from_str_radix(&key_hex[index..index + 2], 16).unwrap())
        .collect();

    let session = SessionFile::open(&path).unwrap();
    let home = session.home_dc().unwrap();
    assert_eq!(home.id, 2);
    assert_eq!(home.ipv4, "149.154.167.50:443".parse::<SocketAddrV4>().unwrap());
    assert_eq!(home.auth_key.map(|key| key.to_vec()), Some(key.clone()));
    assert_eq!(session.home_dc_id().unwrap(), 2);

    // Telegram moves the account to DC 4 and a key is made there.
    let dc4 = session.dc_option(4).unwrap().unwrap();
    block_on(session.set_dc_option(&DcOption {
        auth_key: Some([7; 256]),
        ..dc4
    }))
    .unwrap();
    block_on(session.set_home_dc_id(4)).unwrap();
    drop(session);

    let reloaded = SessionFile::open(&path).unwrap();
    let home = reloaded.home_dc().unwrap();
    assert_eq!(home.id, 4);
    assert_eq!(home.ipv4, "149.154.167.92:443".parse::<SocketAddrV4>().unwrap());
    assert_eq!(home.auth_key, Some([7; 256]));
    assert_eq!(
        reloaded.dc_option(2).unwrap().unwrap().auth_key.map(|key| key.to_vec()),
        Some(key)
    );
    // serializeBasicDcOption, version 2: header, TL string, int32 port.
    let mut expected = vec![2, 4, 0, 14];
    expected.extend_from_slice(b"149.154.167.92");
    expected.extend_from_slice(&[0, 0xbb, 0x01, 0, 0]);
    assert_eq!(dc_main(&path), expected);
    // mtcute's own bookkeeping stays as it was.
    let migrations: i64 = Connection::open(&path)
        .unwrap()
        .query_row("select count(*) from mtcute_migrations", [], |row| row.get(0))
        .unwrap();
    assert_eq!(migrations, 4);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_session_for_the_test_servers_is_refused() {
    let dir = scratch("test-servers");
    let path = dir.join("telegram_channel_stories");
    std::fs::copy(fixtures().join("mtcute.session"), &path).unwrap();
    let mut test_dc = dc_main(&path);
    test_dc[2] |= 4;
    Connection::open(&path)
        .unwrap()
        .execute("update key_value set value = ?1 where key = 'dc_main'", [test_dc])
        .unwrap();
    let error = SessionFile::open(&path).err().unwrap().to_string();
    assert!(error.contains("test servers"), "{error}");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_missing_session_is_created_only_for_a_sign_in() {
    let dir = scratch("missing");
    let path = dir.join("telegram_channel_stories");
    assert!(SessionFile::open(&path).is_err());
    assert!(!path.exists());
    let created = SessionFile::open_or_create(&path).unwrap();
    assert_eq!(created.home_dc().unwrap().auth_key, None);
    assert!(path.is_file());
    std::fs::remove_dir_all(&dir).unwrap();
}
