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
    /// A refusal TypeScript throws as a plain `Error` with this message.
    #[error("{0}")]
    Message(&'static str),
}

pub type Result<T> = std::result::Result<T, Error>;
