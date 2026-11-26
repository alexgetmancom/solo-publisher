//! The Studio's SQLite database: one file shared with its `ops` CLI, opened
//! with the same pragmas, migrated by the drizzle bookkeeping production's
//! database carries and guarded by the date triggers.

mod date_guards;
mod migrations;

use std::path::Path;
use std::time::Duration;
use std::{fs, io};

pub use date_guards::install_date_guards;
pub use rusqlite;
use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// Runtime handle exposed to application services and interfaces. Raw SQLite
/// is reachable only through [`unsafe_db`].
pub struct BackendDb {
    sqlite: Connection,
}

impl BackendDb {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        Self::open_with_timeout(path, Duration::from_secs(30))
    }

    pub fn open_with_timeout(path: impl AsRef<Path>, timeout: Duration) -> Result<Self, Error> {
        let path = path.as_ref();
        if path != Path::new(":memory:")
            && let Some(parent) = path.parent()
        {
            fs::create_dir_all(parent)?;
        }
        let sqlite = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        sqlite.execute_batch("PRAGMA journal_mode = WAL")?;
        sqlite.execute_batch(&format!("PRAGMA busy_timeout = {}", timeout.as_millis()))?;
        // Read latency under concurrent writes is dominated by the writers' fsyncs
        // and by page reads missing a tiny cache. In WAL mode NORMAL keeps commits
        // durable across process crashes and only risks the last commits on a host
        // power loss, which is the right trade for this workload.
        sqlite.execute_batch("PRAGMA synchronous = NORMAL")?;
        sqlite.execute_batch("PRAGMA cache_size = -16384")?; // 16 MB per connection
        sqlite.execute_batch("PRAGMA mmap_size = 33554432")?; // 32 MB
        sqlite.execute_batch("PRAGMA wal_autocheckpoint = 4000")?; // ~16 MB, off the read path more often
        // The baseline creates children before their parents, so foreign keys stay
        // off until it has run.
        sqlite.execute_batch("PRAGMA foreign_keys = OFF")?;
        migrations::migrate(&sqlite)?;
        sqlite.execute_batch("PRAGMA foreign_keys = ON")?;
        // After the migrations, so a column created by one is guarded from the start.
        install_date_guards(&sqlite)?;
        Ok(Self { sqlite })
    }

    /// A single consistent copy at `target`, replacing any file there. Copying
    /// the main file alone would miss commits still sitting in the WAL; `VACUUM
    /// INTO` merges it first.
    pub fn backup(&self, target: &str) -> Result<(), Error> {
        if Path::new(target).exists() {
            fs::remove_file(target)?;
        }
        self.sqlite.execute("VACUUM INTO ?", [target])?;
        Ok(())
    }

    /// `BEGIN DEFERRED`: takes the write lock at the first write, so a read
    /// made before it can be stale by then.
    pub fn transaction<T, E: From<rusqlite::Error>>(
        &mut self,
        work: impl FnOnce(&Transaction<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        self.run(TransactionBehavior::Deferred, work)
    }

    /// `BEGIN IMMEDIATE`: takes the write lock up front, so what the work reads
    /// still holds when it writes. Another writer waits up to the busy timeout.
    pub fn immediate_transaction<T, E: From<rusqlite::Error>>(
        &mut self,
        work: impl FnOnce(&Transaction<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        self.run(TransactionBehavior::Immediate, work)
    }

    fn run<T, E: From<rusqlite::Error>>(
        &mut self,
        behavior: TransactionBehavior,
        work: impl FnOnce(&Transaction<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        let tx = self.sqlite.transaction_with_behavior(behavior)?;
        // An error drops `tx`, which rolls it back.
        let result = work(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn close(self) -> Result<(), Error> {
        self.sqlite.close().map_err(|(_, error)| error.into())
    }
}

/// Explicit escape hatch for infrastructure and diagnostic code that needs raw
/// SQLite. Keep it out of Studio and Content application services.
pub fn unsafe_db(backend_db: &BackendDb) -> &Connection {
    &backend_db.sqlite
}
