//! Which kind of publication keeps its status where. The queue settles a job
//! and asks for the owner to be refreshed; it never learns what kinds exist.

use super::Publishing;
use crate::Result;
use crate::application::publication_ref::{PublicationRefKind, parse_publication_ref};

/// Refreshes the publication a settled job belongs to. A key naming a kind
/// with no owner — video settles through its own workflow — is not an error.
pub fn refresh_publication_owner(publishing: &Publishing<'_>, publication_key: &str) -> Result<()> {
    let Some(reference) = parse_publication_ref(Some(publication_key)) else {
        return Ok(());
    };
    match reference.kind {
        PublicationRefKind::Post => publishing.refresh_publication_status(reference.id),
        PublicationRefKind::Article => publishing.refresh_article_status(reference.id),
        PublicationRefKind::Draft | PublicationRefKind::Video => Ok(()),
    }
}
