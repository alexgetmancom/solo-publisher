//! The string semantics of Node's POSIX `path` module and the WHATWG `URL`
//! parser, which the goldens recorded. Media paths are compared and cached as
//! strings, so they are built as exactly those strings.

use std::sync::LazyLock;

use url::Url;

static SITE_ORIGIN: LazyLock<Url> = LazyLock::new(|| Url::parse("https://site.invalid/").unwrap());

/// `new URL(value, "https://site.invalid/")`.
fn site_url(value: &str) -> domain::Result<Url> {
    SITE_ORIGIN
        .join(value)
        .map_err(|_| domain::Error::message(format!("Invalid URL: {value}")))
}

/// `new URL(value, "https://site.invalid/").search`: `?` and the query, or
/// empty when there is none or it is empty.
pub fn url_search(value: &str) -> domain::Result<String> {
    Ok(match site_url(value)?.query() {
        Some(query) if !query.is_empty() => format!("?{query}"),
        _ => String::new(),
    })
}

/// A public media URL carrying a content version (`?v=<12 hex>`): its bytes
/// never change under that name.
pub fn versioned(value: &str) -> domain::Result<bool> {
    let url = site_url(value)?;
    let version = url
        .query_pairs()
        .find(|(name, _)| name == "v")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    Ok(version.len() == 12 && version.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// `publicPath.replace(/^\/+/, "").split(/[?#]/, 1)[0]`: the file a public
/// path names, relative to the site root.
pub fn public_relative(public_path: &str) -> &str {
    let relative = public_path.trim_start_matches('/');
    relative.split(['?', '#']).next().unwrap_or_default()
}

/// Node's `normalizeString`: `.` and empty segments dropped, `..` applied.
fn normalize_segments(path: &str, allow_above_root: bool) -> String {
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.last().is_some_and(|last| *last != "..") {
                    segments.pop();
                } else if allow_above_root {
                    segments.push("..");
                }
            }
            _ => segments.push(segment),
        }
    }
    segments.join("/")
}

/// `path.normalize`.
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut normalized = normalize_segments(path, !absolute);
    if normalized.is_empty() && !absolute {
        normalized.push('.');
    }
    if !normalized.is_empty() && trailing {
        normalized.push('/');
    }
    if absolute { format!("/{normalized}") } else { normalized }
}

/// `path.join(base, relative)`.
pub fn join(base: &str, relative: &str) -> String {
    let joined = [base, relative]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        ".".into()
    } else {
        normalize(&joined)
    }
}

/// `path.resolve(base, relative)`, relative to the process's working
/// directory when neither is absolute.
pub fn resolve(base: &str, relative: &str) -> String {
    let cwd = std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut resolved = String::new();
    let mut absolute = false;
    for part in [relative, base, cwd.as_str()] {
        if part.is_empty() {
            continue;
        }
        resolved = format!("{part}/{resolved}");
        absolute = part.starts_with('/');
        if absolute {
            break;
        }
    }
    let normalized = normalize_segments(&resolved, !absolute);
    if absolute {
        format!("/{normalized}")
    } else if normalized.is_empty() {
        ".".into()
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_path_semantics() {
        assert_eq!(join("/data/site", "media/posts/a.jpg"), "/data/site/media/posts/a.jpg");
        assert_eq!(join("/data/site", "../pipeline.db"), "/data/pipeline.db");
        assert_eq!(join("/data/site", "media/"), "/data/site/media/");
        assert_eq!(join("/data/site", ""), "/data/site");
        assert_eq!(join("site", "/generated//x.webp"), "site/generated/x.webp");
        assert_eq!(resolve("/data/site", "a/../../b/"), "/data/b");
        assert_eq!(resolve("/data/site", ""), "/data/site");
        assert_eq!(normalize("../a/./b/.."), "../a");
    }

    #[test]
    fn url_semantics() {
        assert_eq!(url_search("media/a.jpg?v=abc#x").unwrap(), "?v=abc");
        assert_eq!(url_search("media/a.jpg?").unwrap(), "");
        assert_eq!(url_search("media/a b.jpg?q=a b").unwrap(), "?q=a%20b");
        assert!(versioned("media/a.jpg?x=1&v=abcdef012345").unwrap());
        assert!(!versioned("media/a.jpg?v=ABCDEF012345").unwrap());
        assert!(!versioned("media/a.jpg").unwrap());
        assert_eq!(public_relative("//media/a.jpg?v=1#x"), "media/a.jpg");
    }
}
