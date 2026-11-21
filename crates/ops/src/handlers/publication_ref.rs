//! `operations/publication-ref.ts`: external command input resolved to the
//! stable publication identity Operations commands use.

use db::rusqlite::{Connection, OptionalExtension, params};
use domain::application::publication_ref::{PublicationRefKind, publication_ref};
use foundation::js;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedPublicationRef {
    pub post_id: i64,
    pub publication_key: String,
}

/// The stored post id of a draft carrying `id` (bound as `Number(...)` was,
/// so a fraction or `NaN` matches nothing), when it is truthy.
fn stored_post_id(sqlite: &Connection, id: f64) -> db::rusqlite::Result<Option<i64>> {
    let found: Option<Option<i64>> = sqlite
        .query_row(
            "SELECT post_id FROM drafts WHERE post_id = ? LIMIT 1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.flatten().filter(|post_id| *post_id != 0))
}

/// `resolvePublicationRef`: `post:<id>` keeps the spelling it was given as
/// its key; a bare number resolves to `post:<id>`.
pub(crate) fn resolve_publication_ref(
    sqlite: &Connection,
    reference: &str,
) -> db::rusqlite::Result<Option<ResolvedPublicationRef>> {
    let trimmed = js::trim(reference);
    let digits = |value: &str| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
    let post_key_ref = trimmed.starts_with("post:").then_some(trimmed);
    let numeric = match trimmed.strip_prefix("post:") {
        Some(rest) if digits(rest) => Some(rest),
        _ => digits(trimmed).then_some(trimmed),
    };
    if let Some(key) = post_key_ref
        && let Some(post_id) = stored_post_id(sqlite, js::number(&key[5..]))?
    {
        return Ok(Some(ResolvedPublicationRef {
            post_id,
            publication_key: key.to_owned(),
        }));
    }
    let Some(numeric) = numeric else { return Ok(None) };
    Ok(
        stored_post_id(sqlite, js::number(numeric))?.map(|post_id| ResolvedPublicationRef {
            post_id,
            publication_key: publication_ref(PublicationRefKind::Post, post_id),
        }),
    )
}
