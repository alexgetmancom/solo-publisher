//! External command input resolved to the
//! stable publication identity Operations commands act on.

use db::rusqlite::{Connection, OptionalExtension};
use domain::application::publication_ref::{PublicationRefKind, publication_ref};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedPublicationRef {
    pub post_id: i64,
    pub publication_key: String,
}

/// The post a draft row carries under `post_id`; a reference that is no
/// integer names none.
fn post_with_id(sqlite: &Connection, id: Option<i64>) -> Result<Option<i64>, db::rusqlite::Error> {
    let Some(id) = id else {
        return Ok(None);
    };
    Ok(sqlite
        .query_row(
            r#"select "post_id" from "drafts" where "drafts"."post_id" = ?"#,
            [id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten()
        .filter(|post_id| *post_id != 0))
}

/// `resolvePublicationRef`. A `post:` ref keeps the spelling it was given as
/// its key; a bare number is keyed canonically.
pub(crate) fn resolve_publication_ref(
    sqlite: &Connection,
    reference: &str,
) -> Result<Option<ResolvedPublicationRef>, db::rusqlite::Error> {
    let trimmed = reference.trim();
    if let Some(rest) = trimmed.strip_prefix("post:")
        && let Some(post_id) = post_with_id(sqlite, rest.trim().parse().ok())?
    {
        return Ok(Some(ResolvedPublicationRef {
            post_id,
            publication_key: trimmed.to_owned(),
        }));
    }
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
    let numeric = match trimmed.strip_prefix("post:") {
        Some(rest) if digits(rest) => rest,
        _ if digits(trimmed) => trimmed,
        _ => return Ok(None),
    };
    Ok(
        post_with_id(sqlite, numeric.parse().ok())?.map(|post_id| ResolvedPublicationRef {
            post_id,
            publication_key: publication_ref(PublicationRefKind::Post, post_id),
        }),
    )
}
