//! The Stories account's MTProto session: the SQLite file at
//! `TELEGRAM_CHANNEL_STORIES_SESSION`, in the layout mtcute 0.32 wrote it, so
//! an account already signed in stays signed in.
//!
//! Two parts of that file matter: `auth_keys(dc, key)`, the permanent 256-byte
//! authorization key of each datacenter, and `key_value['dc_main']`, the home
//! datacenter as mtcute's `serializeBasicDcOption` writes it — `[version (1|2),
//! dc id, flags (bit 0 IPv6, bit 1 media-only, bit 2 test servers, version 2
//! only)]`, then the address as a TL string and the port as a little-endian
//! int32. Everything else mtcute keeps there (peers, update state, salts) is
//! left alone and not needed: grammers keeps its peers and update state in
//! memory for the one connection it makes.
//!
//! The file is written back when grammers moves the home datacenter or holds
//! a new permanent key, which is what a sign-in that migrates datacenters
//! produces; `dc_main` is written as version 2.

use std::fmt;
use std::net::{IpAddr, SocketAddrV4, SocketAddrV6};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use grammers_client::session::types::{ChannelState, DcOption, PeerId, PeerInfo, UpdateState, UpdatesState};
use grammers_client::session::{BoxFuture, Session, SessionData};
use grammers_client::tl::{Cursor, Deserializable as _, Serializable as _};
use rusqlite::{Connection, OpenFlags, OptionalExtension as _, params};

const DC_MAIN: &str = "dc_main";
/// mtcute's own definitions, so a file created here has the same two tables.
const SCHEMA: &str = "
create table if not exists auth_keys (dc integer primary key, key blob not null);
create table if not exists key_value (key text primary key, value blob not null);
";
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub struct SessionError(String);

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SessionError {}

fn file_error(path: &Path, error: impl fmt::Display) -> SessionError {
    SessionError(format!("telegram_channel_story_session {}: {error}", path.display()))
}

/// The session file, loaded into grammers' in-memory session data.
pub struct SessionFile {
    path: PathBuf,
    data: Mutex<SessionData>,
}

impl SessionFile {
    /// The file as it is; a missing file is an error (nobody signed in).
    pub fn open(path: &Path) -> Result<Self, SessionError> {
        Self::load(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
    }

    /// The file, created empty when missing: the start of a sign-in.
    pub fn open_or_create(path: &Path) -> Result<Self, SessionError> {
        Self::load(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE)
    }

    fn load(path: &Path, flags: OpenFlags) -> Result<Self, SessionError> {
        let connection = connect(path, flags)?;
        connection
            .execute_batch(SCHEMA)
            .map_err(|error| file_error(path, error))?;
        let mut data = SessionData::default();
        let dc_main: Option<Vec<u8>> = connection
            .query_row("select value from key_value where key = ?1", [DC_MAIN], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|error| file_error(path, error))?;
        if let Some(bytes) = dc_main {
            let main = parse_dc_main(&bytes).map_err(|reason| file_error(path, reason))?;
            let option = data.dc_options.entry(main.id).or_insert_with(|| unknown_dc(main.id));
            match main.ip {
                IpAddr::V4(ip) => option.ipv4 = SocketAddrV4::new(ip, main.port),
                IpAddr::V6(ip) => option.ipv6 = SocketAddrV6::new(ip, main.port, 0, 0),
            }
            data.home_dc = main.id;
        }
        let mut keys = connection
            .prepare("select dc, key from auth_keys")
            .map_err(|error| file_error(path, error))?;
        let keys = keys
            .query_map([], |row| Ok((row.get::<_, i32>(0)?, row.get::<_, Vec<u8>>(1)?)))
            .map_err(|error| file_error(path, error))?;
        for key in keys {
            let (dc, key) = key.map_err(|error| file_error(path, error))?;
            let key: [u8; 256] = key.try_into().map_err(|key: Vec<u8>| {
                file_error(path, format!("the key of DC {dc} is {} bytes, not 256", key.len()))
            })?;
            data.dc_options.entry(dc).or_insert_with(|| unknown_dc(dc)).auth_key = Some(key);
        }
        Ok(Self {
            path: path.to_owned(),
            data: Mutex::new(data),
        })
    }

    /// The home datacenter as it stands, with its permanent key if one exists.
    pub fn home_dc(&self) -> Result<DcOption, SessionError> {
        let data = self.data()?;
        data.dc_options
            .get(&data.home_dc)
            .cloned()
            .ok_or_else(|| SessionError(format!("the home DC {} has no address", data.home_dc)))
    }

    fn data(&self) -> Result<MutexGuard<'_, SessionData>, SessionError> {
        self.data
            .lock()
            .map_err(|_| SessionError("the session lock is poisoned".into()))
    }

    /// Writes the home datacenter and every permanent key, in one transaction.
    fn persist(&self, data: &SessionData) -> Result<(), SessionError> {
        let home = data
            .dc_options
            .get(&data.home_dc)
            .ok_or_else(|| SessionError(format!("the home DC {} has no address", data.home_dc)))?;
        let dc_main = dc_main_bytes(home)?;
        let mut connection = connect(&self.path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let write = |connection: &mut Connection| -> rusqlite::Result<()> {
            let transaction = connection.transaction()?;
            transaction.execute(
                "insert or replace into key_value (key, value) values (?1, ?2)",
                params![DC_MAIN, dc_main],
            )?;
            for option in data.dc_options.values() {
                if let Some(key) = &option.auth_key {
                    transaction.execute(
                        "insert or replace into auth_keys (dc, key) values (?1, ?2)",
                        params![option.id, key.as_slice()],
                    )?;
                }
            }
            transaction.commit()
        };
        write(&mut connection).map_err(|error| file_error(&self.path, error))
    }
}

fn connect(path: &Path, flags: OpenFlags) -> Result<Connection, SessionError> {
    let connection = Connection::open_with_flags(path, flags | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|error| file_error(path, error))?;
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(|error| file_error(path, error))?;
    Ok(connection)
}

/// A datacenter grammers does not know statically; its address arrives with
/// the server's configuration.
fn unknown_dc(id: i32) -> DcOption {
    DcOption {
        id,
        ipv4: SocketAddrV4::new(std::net::Ipv4Addr::UNSPECIFIED, 0),
        ipv6: SocketAddrV6::new(std::net::Ipv6Addr::UNSPECIFIED, 0, 0, 0),
        auth_key: None,
    }
}

struct MainDc {
    id: i32,
    ip: IpAddr,
    port: u16,
}

/// mtcute's `parseBasicDcOption`; test servers are refused, since this
/// Studio only ever talks to production.
fn parse_dc_main(bytes: &[u8]) -> Result<MainDc, String> {
    let [version, id, flags, rest @ ..] = bytes else {
        return Err("dc_main is shorter than its header".into());
    };
    if *version != 1 && *version != 2 {
        return Err(format!("dc_main has unknown version {version}"));
    }
    if *version == 2 && flags & 4 != 0 {
        return Err("dc_main names Telegram's test servers, not production".into());
    }
    let mut cursor = Cursor::from_slice(rest);
    let address = String::deserialize(&mut cursor).map_err(|error| format!("dc_main address: {error}"))?;
    let port = i32::deserialize(&mut cursor).map_err(|error| format!("dc_main port: {error}"))?;
    let ip: IpAddr = address
        .parse()
        .map_err(|_| format!("dc_main address {address:?} is not an IP address"))?;
    if ip.is_ipv6() != (flags & 1 != 0) {
        return Err(format!("dc_main address {address} disagrees with its IPv6 flag"));
    }
    Ok(MainDc {
        id: i32::from(*id),
        ip,
        port: u16::try_from(port).map_err(|_| format!("dc_main port {port} is out of range"))?,
    })
}

/// `serializeBasicDcOption`, version 2, over IPv4 (the address grammers
/// connects to).
fn dc_main_bytes(option: &DcOption) -> Result<Vec<u8>, SessionError> {
    let id = u8::try_from(option.id).map_err(|_| SessionError(format!("DC id {} does not fit dc_main", option.id)))?;
    let mut bytes = vec![2, id, 0];
    let mut sink = |chunk: &[u8]| bytes.extend_from_slice(chunk);
    option.ipv4.ip().to_string().serialize(&mut sink);
    i32::from(option.ipv4.port()).serialize(&mut sink);
    Ok(bytes)
}

impl Session for SessionFile {
    type Error = SessionError;

    fn home_dc_id(&self) -> Result<i32, SessionError> {
        Ok(self.data()?.home_dc)
    }

    fn set_home_dc_id(&self, dc_id: i32) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(async move {
            let mut data = self.data()?;
            if data.home_dc == dc_id {
                return Ok(());
            }
            data.home_dc = dc_id;
            self.persist(&data)
        })
    }

    fn dc_option(&self, dc_id: i32) -> Result<Option<DcOption>, SessionError> {
        Ok(self.data()?.dc_options.get(&dc_id).cloned())
    }

    fn set_dc_option(&self, dc_option: &DcOption) -> BoxFuture<'_, Result<(), SessionError>> {
        let dc_option = dc_option.clone();
        Box::pin(async move {
            let mut data = self.data()?;
            let home = dc_option.id == data.home_dc;
            let previous = data.dc_options.insert(dc_option.id, dc_option.clone());
            // Every connection replays the server's address list; only a new
            // key or a moved home datacenter is worth a write.
            let changed = previous.is_none_or(|previous| {
                previous.auth_key != dc_option.auth_key || (home && previous.ipv4 != dc_option.ipv4)
            });
            if changed { self.persist(&data) } else { Ok(()) }
        })
    }

    fn peer(&self, peer: PeerId) -> BoxFuture<'_, Result<Option<PeerInfo>, SessionError>> {
        Box::pin(async move { Ok(self.data()?.peer_infos.get(&peer).cloned()) })
    }

    fn cache_peer(&self, peer: PeerInfo) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(async move {
            self.data()?
                .peer_infos
                .entry(peer.id())
                .or_insert_with(|| peer.clone())
                .extend_info(&peer);
            Ok(())
        })
    }

    fn updates_state(&self) -> BoxFuture<'_, Result<UpdatesState, SessionError>> {
        Box::pin(async move { Ok(self.data()?.updates_state.clone()) })
    }

    fn set_update_state(&self, update: UpdateState) -> BoxFuture<'_, Result<(), SessionError>> {
        Box::pin(async move {
            let mut data = self.data()?;
            let state = &mut data.updates_state;
            match update {
                UpdateState::All(all) => *state = all,
                UpdateState::Primary { pts, date, seq } => {
                    state.pts = pts;
                    state.date = date;
                    state.seq = seq;
                }
                UpdateState::Secondary { qts } => state.qts = qts,
                UpdateState::Channel { id, pts } => {
                    state.channels.retain(|channel| channel.id != id);
                    state.channels.push(ChannelState { id, pts });
                }
            }
            Ok(())
        })
    }
}
