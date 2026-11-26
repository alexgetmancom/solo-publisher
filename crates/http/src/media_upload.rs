//! An upload body streamed to a private temporary file under a byte cap,
//! so a gigabyte video never sits in
//! memory.

use std::fmt;
use std::path::Path;

use axum::body::Body;
use http_body_util::BodyExt as _;
use tokio::io::AsyncWriteExt as _;

#[derive(Debug, PartialEq, Eq)]
pub enum MediaUploadError {
    TooLarge {
        max_bytes: u64,
    },
    Empty,
    /// The body broke off or the file could not be written.
    Failed(String),
}

impl fmt::Display for MediaUploadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { max_bytes } => {
                let megabytes = (*max_bytes as f64 / 1024.0 / 1024.0).ceil();
                write!(f, "Media upload exceeds the {megabytes} MB limit.")
            }
            Self::Empty => f.write_str("Media file is empty."),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

fn failed(error: impl fmt::Display) -> MediaUploadError {
    MediaUploadError::Failed(error.to_string())
}

/// Writes `body` to `target` (mode 0600) and returns its
/// size. The chunk that crosses `max_bytes` is refused before it is written.
pub async fn stream_upload_to_file(mut body: Body, target: &Path, max_bytes: u64) -> Result<u64, MediaUploadError> {
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(target)
        .await
        .map_err(failed)?;
    let mut byte_size = 0u64;
    while let Some(frame) = body.frame().await {
        let Ok(chunk) = frame.map_err(failed)?.into_data() else {
            continue;
        };
        byte_size += chunk.len() as u64;
        if byte_size > max_bytes {
            return Err(MediaUploadError::TooLarge { max_bytes });
        }
        file.write_all(&chunk).await.map_err(failed)?;
    }
    if byte_size == 0 {
        return Err(MediaUploadError::Empty);
    }
    file.flush().await.map_err(failed)?;
    Ok(byte_size)
}
