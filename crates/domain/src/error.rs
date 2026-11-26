use std::borrow::Cow;

use db::rusqlite;
use foundation::errors::StudioError;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    /// A JSON column or JSON text argument that does not parse, or does not
    /// have the shape the record declares.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Studio(#[from] StudioError),
    /// A plain refusal that carries only its message.
    #[error("{0}")]
    Message(Cow<'static, str>),
    /// A settlement fenced by a lease that another worker has since taken.
    /// It rolls the settlement back; the queue reports it, it never escapes.
    #[error("publish_job_lock_lost:{0}")]
    PublishLockLost(i64),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// A plain refusal with the given message.
    pub fn message(text: impl Into<Cow<'static, str>>) -> Self {
        Self::Message(text.into())
    }
}
