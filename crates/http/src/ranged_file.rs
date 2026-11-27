//! Range-aware file serving for every route that streams a media file.
//!
//! Video seeking is why this exists: a player that gets `Accept-Ranges: bytes`
//! and then a plain 200 for its `Range` request refetches the whole file on
//! every scrub (Chrome) or refuses to seek (Safari/iOS), so the header and the
//! 206 are produced together, here. Routes that serve whole files only (the
//! video asset route Meta's importer reads) do not use this.

use std::io::SeekFrom;
use std::path::Path;

use axum::body::Body;
use axum::http::StatusCode;
use axum::response::Response;
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};
use tokio_util::io::ReaderStream;

use crate::response::set;

#[derive(Debug, PartialEq)]
enum Range {
    Whole,
    /// Inclusive bounds, as JavaScript numbers.
    Part {
        start: f64,
        end: f64,
    },
    Invalid,
}

/// One `bytes=` range, a suffix range counted from the end.
fn parse_range(value: Option<&str>, size: f64) -> Range {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Range::Whole;
    };
    let Some((first, second)) = value
        .trim()
        .strip_prefix("bytes=")
        .and_then(|spec| spec.split_once('-'))
        .filter(|(first, second)| {
            [first, second]
                .iter()
                .all(|part| part.bytes().all(|b| b.is_ascii_digit()))
        })
    else {
        return Range::Invalid;
    };
    // Both parts are digits only, so a part reads as an integer or, past
    // f64's range, as infinity.
    let number = |digits: &str| digits.parse::<f64>().unwrap_or(f64::NAN);
    // `bytes=-500` is the last 500 bytes, not the first 500.
    if first.is_empty() {
        let suffix = number(second);
        if second.is_empty() || !suffix.is_finite() || suffix <= 0.0 {
            return Range::Invalid;
        }
        return Range::Part {
            start: (size - suffix).max(0.0),
            end: size - 1.0,
        };
    }
    let start = number(first);
    let end = if second.is_empty() {
        size - 1.0
    } else {
        number(second).min(size - 1.0)
    };
    if !start.is_finite() || !end.is_finite() || start > end || start >= size {
        return Range::Invalid;
    }
    Range::Part { start, end }
}

/// `file` (of `size` bytes) for the request's `Range`,
/// with the route's own headers (type, caching) and the length headers.
pub(crate) async fn ranged_file_response(
    file: &Path,
    size: u64,
    range: Option<&str>,
    headers: &[(&'static str, &str)],
    head_only: bool,
) -> std::io::Result<Response> {
    let mut response = Response::new(Body::empty());
    for (name, value) in headers {
        set(&mut response, name, value);
    }
    set(&mut response, "accept-ranges", "bytes");
    match parse_range(range, size as f64) {
        Range::Invalid => {
            set(&mut response, "content-range", &format!("bytes */{size}"));
            *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
        }
        Range::Part { start, end } => {
            let length = end - start + 1.0;
            set(&mut response, "content-length", &length.to_string());
            set(&mut response, "content-range", &format!("bytes {start}-{end}/{size}"));
            *response.status_mut() = StatusCode::PARTIAL_CONTENT;
            if !head_only {
                *response.body_mut() = file_body(file, start.max(0.0) as u64, length.max(0.0) as u64).await?;
            }
        }
        Range::Whole => {
            set(&mut response, "content-length", &size.to_string());
            if !head_only {
                *response.body_mut() = file_body(file, 0, size).await?;
            }
        }
    }
    Ok(response)
}

/// `length` bytes of `file` from `start`, streamed.
pub(crate) async fn file_body(file: &Path, start: u64, length: u64) -> std::io::Result<Body> {
    let mut file = tokio::fs::File::open(file).await?;
    if start > 0 {
        file.seek(SeekFrom::Start(start)).await?;
    }
    Ok(Body::from_stream(ReaderStream::new(file.take(length))))
}

#[cfg(test)]
mod tests {
    use super::{Range, parse_range};

    #[test]
    fn ranges_as_typescript_reads_them() {
        let part = |start, end| Range::Part { start, end };
        assert_eq!(parse_range(None, 1000.0), Range::Whole);
        assert_eq!(parse_range(Some(""), 1000.0), Range::Whole);
        assert_eq!(parse_range(Some("bytes=-100"), 1000.0), part(900.0, 999.0));
        assert_eq!(parse_range(Some("bytes=-5000"), 1000.0), part(0.0, 999.0));
        assert_eq!(parse_range(Some("bytes=990-2000"), 1000.0), part(990.0, 999.0));
        assert_eq!(parse_range(Some("bytes=-1"), 0.0), part(0.0, -1.0));
        assert_eq!(parse_range(Some("bytes=1000-"), 1000.0), Range::Invalid);
        assert_eq!(parse_range(Some("bytes=0-1,3-4"), 1000.0), Range::Invalid);
        assert_eq!(parse_range(Some("bytes=-0"), 1000.0), Range::Invalid);
    }
}
