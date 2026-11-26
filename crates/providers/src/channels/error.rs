//! What a channel operation refuses with. Every variant reads as its bare
//! message; the provider's own error stays inspectable.

use std::fmt;

use foundation::secret_box::SecretBoxError;
use runtime::http::ExternalError;

#[derive(Debug)]
pub enum Error {
    /// A provider call failed (`ExternalHttpError`, `ExternalTransportError`).
    External(ExternalError),
    Domain(domain::Error),
    /// A plain refusal with this message.
    Message(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn message(text: impl Into<String>) -> Self {
        Self::Message(text.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::External(error) => error.fmt(f),
            Self::Domain(error) => error.fmt(f),
            Self::Message(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for Error {}

impl From<ExternalError> for Error {
    fn from(error: ExternalError) -> Self {
        Self::External(error)
    }
}

impl From<domain::Error> for Error {
    fn from(error: domain::Error) -> Self {
        Self::Domain(error)
    }
}

impl From<db::rusqlite::Error> for Error {
    fn from(error: db::rusqlite::Error) -> Self {
        Self::Domain(error.into())
    }
}

impl From<SecretBoxError> for Error {
    fn from(error: SecretBoxError) -> Self {
        Self::Message(error.to_string())
    }
}

/// The Studio boundaries speak `domain::Error`; a refusal crosses as its message.
impl From<Error> for domain::Error {
    fn from(error: Error) -> Self {
        match error {
            Error::Domain(error) => error,
            other => domain::Error::message(other.to_string()),
        }
    }
}
