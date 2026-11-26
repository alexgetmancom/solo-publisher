//! The `platform_tokens` row each
//! credential this Studio renews or was connected with lives in, sealed.

use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{Connection, OptionalExtension, Row, params_from_iter};

use crate::channels::Result;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlatformToken {
    pub target: String,
    pub sealed_token: String,
    /// Present only when the credential was seeded from .env; a token issued
    /// by a browser connection belongs to the database.
    pub seed_fingerprint: Option<String>,
    pub account_id: Option<String>,
    pub sealed_refresh_token: Option<String>,
    pub expires_at: Option<String>,
    pub refreshed_at: String,
    pub updated_at: String,
    /// The largest attachment the channel accepts, as the platform reported it.
    pub upload_limit_bytes: Option<i64>,
}

fn token(row: &Row<'_>) -> db::rusqlite::Result<PlatformToken> {
    Ok(PlatformToken {
        target: row.get("target")?,
        sealed_token: row.get("sealed_token")?,
        seed_fingerprint: row.get("seed_fingerprint")?,
        account_id: row.get("account_id")?,
        sealed_refresh_token: row.get("sealed_refresh_token")?,
        expires_at: row.get("expires_at")?,
        refreshed_at: row.get("refreshed_at")?,
        updated_at: row.get("updated_at")?,
        upload_limit_bytes: row.get("upload_limit_bytes")?,
    })
}

/// `platformToken`.
pub fn platform_token(sqlite: &Connection, target: &str) -> Result<Option<PlatformToken>> {
    Ok(sqlite
        .query_row(
            r#"select "target", "sealed_token", "seed_fingerprint", "account_id", "sealed_refresh_token", "expires_at", "refreshed_at", "updated_at", "upload_limit_bytes" from "platform_tokens" where "platform_tokens"."target" = ?"#,
            [target],
            token,
        )
        .optional()?)
}

/// What one store writes. The three columns only some credentials carry are
/// `None` when the writer does not name them: a new row stores NULL there and
/// an existing one keeps its value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenWrite {
    pub sealed_token: String,
    pub seed_fingerprint: Option<String>,
    pub account_id: Option<String>,
    pub sealed_refresh_token: Option<Option<String>>,
    pub expires_at: Option<Option<String>>,
    pub refreshed_at: String,
    pub upload_limit_bytes: Option<Option<i64>>,
    pub updated_at: String,
}

fn text(value: &Option<String>) -> SqlValue {
    value.clone().map_or(SqlValue::Null, SqlValue::Text)
}

fn assignments(row: &TokenWrite) -> Vec<(&'static str, SqlValue)> {
    let mut set: Vec<(&str, SqlValue)> = vec![
        ("sealed_token", SqlValue::Text(row.sealed_token.clone())),
        ("seed_fingerprint", text(&row.seed_fingerprint)),
        ("account_id", text(&row.account_id)),
    ];
    if let Some(value) = &row.sealed_refresh_token {
        set.push(("sealed_refresh_token", text(value)));
    }
    if let Some(value) = &row.expires_at {
        set.push(("expires_at", text(value)));
    }
    set.push(("refreshed_at", SqlValue::Text(row.refreshed_at.clone())));
    set.push(("updated_at", SqlValue::Text(row.updated_at.clone())));
    if let Some(value) = row.upload_limit_bytes {
        set.push(("upload_limit_bytes", value.map_or(SqlValue::Null, SqlValue::Integer)));
    }
    set
}

/// `storePlatformToken`: insert, or update the named columns.
pub fn store_platform_token(sqlite: &Connection, target: &str, row: &TokenWrite) -> Result<()> {
    let set = assignments(row);
    let columns: Vec<&str> = set.iter().map(|(column, _)| *column).collect();
    let placeholders: Vec<String> = (2..=set.len() + 1).map(|index| format!("?{index}")).collect();
    let updates: Vec<String> = columns
        .iter()
        .zip(&placeholders)
        .map(|(column, placeholder)| format!(r#""{column}" = {placeholder}"#))
        .collect();
    let sql = format!(
        r#"insert into "platform_tokens" ("target", {}) values (?1, {}) on conflict ("platform_tokens"."target") do update set {}"#,
        columns
            .iter()
            .map(|column| format!(r#""{column}""#))
            .collect::<Vec<_>>()
            .join(", "),
        placeholders.join(", "),
        updates.join(", ")
    );
    let values = std::iter::once(SqlValue::Text(target.into())).chain(set.into_iter().map(|(_, value)| value));
    sqlite.execute(&sql, params_from_iter(values))?;
    Ok(())
}

/// A store that holds only while the row is still the one the caller read:
/// the update names that row's `updated_at` and refresh token in its `WHERE`,
/// and with no row read the insert gives way to a row stored meanwhile.
/// `false` means the row changed (or appeared) first and nothing was written.
pub fn store_platform_token_unless_changed(
    sqlite: &Connection,
    target: &str,
    row: &TokenWrite,
    read: Option<&PlatformToken>,
) -> Result<bool> {
    let set = assignments(row);
    let columns: Vec<String> = set.iter().map(|(column, _)| format!(r#""{column}""#)).collect();
    let mut values: Vec<SqlValue> = vec![SqlValue::Text(target.into())];
    values.extend(set.iter().map(|(_, value)| value.clone()));
    let sql = match read {
        None => {
            let placeholders: Vec<String> = (2..=set.len() + 1).map(|index| format!("?{index}")).collect();
            format!(
                r#"insert into "platform_tokens" ("target", {}) values (?1, {}) on conflict ("platform_tokens"."target") do nothing"#,
                columns.join(", "),
                placeholders.join(", ")
            )
        }
        Some(read) => {
            let updates: Vec<String> = columns
                .iter()
                .enumerate()
                .map(|(index, column)| format!("{column} = ?{}", index + 2))
                .collect();
            let updated_at = values.len() + 1;
            values.push(SqlValue::Text(read.updated_at.clone()));
            values.push(text(&read.sealed_refresh_token));
            format!(
                r#"update "platform_tokens" set {} where "platform_tokens"."target" = ?1 and "platform_tokens"."updated_at" = ?{updated_at} and "platform_tokens"."sealed_refresh_token" is ?{}"#,
                updates.join(", "),
                updated_at + 1
            )
        }
    };
    Ok(sqlite.execute(&sql, params_from_iter(values))? == 1)
}
