//! Drizzle's bun-sqlite migrator, reproduced so a database migrated by either
//! side is the same file to the other: the same `__drizzle_migrations` DDL,
//! a row per migration with the SHA-256 of its text and the journal's `when`,
//! and "apply everything newer than the newest row" in one transaction.

use rusqlite::{Connection, OptionalExtension};

struct Migration {
    created_at: i64,
    hash: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

/// Byte for byte what drizzle runs, because SQLite keeps this text in
/// `sqlite_master`.
const MIGRATIONS_TABLE: &str = "\n\t\t\tCREATE TABLE IF NOT EXISTS \"__drizzle_migrations\" (\n\t\t\t\tid SERIAL PRIMARY KEY,\n\t\t\t\thash text NOT NULL,\n\t\t\t\tcreated_at numeric\n\t\t\t)\n\t\t";

pub(crate) fn migrate(sqlite: &Connection) -> rusqlite::Result<()> {
    sqlite.execute(MIGRATIONS_TABLE, [])?;
    let last: Option<f64> = sqlite
        .query_row(
            "SELECT id, hash, created_at FROM \"__drizzle_migrations\" ORDER BY created_at DESC LIMIT 1",
            [],
            |row| row.get(2),
        )
        .optional()?;
    let tx = sqlite.unchecked_transaction()?;
    for migration in MIGRATIONS {
        if last.is_none_or(|last| last < migration.created_at as f64) {
            // Each chunk must be exactly one statement: drizzle prepares a chunk
            // and silently drops whatever follows its first statement.
            for statement in migration.sql.split("--> statement-breakpoint") {
                tx.execute(statement, [])?;
            }
            tx.execute(
                "INSERT INTO \"__drizzle_migrations\" (\"hash\", \"created_at\") VALUES(?, ?)",
                (migration.hash, migration.created_at),
            )?;
        }
    }
    tx.commit()
}
