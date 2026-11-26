//! The request target as the routes see it.
//!
//! Bun builds `request.url` with the WHATWG URL parser (dot segments, also
//! `%2e`, resolved; spaces and non-ASCII percent-encoded), and Hono routes on
//! `getPath`: that path through `decodeURI` (reserved characters such as
//! `%2F` stay encoded), with one trailing slash dropped (`strict: false`).
//! [`Target`] carries both; the router matches on the decoded path,
//! re-encoded only as far as a URI requires.

use axum::http::Uri;
use axum::http::uri::PathAndQuery;
use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use url::Url;

/// What a routing path cannot carry literally.
const ROUTING: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'\\')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

/// The request's `c.req.url` and `c.req.path`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    /// `request.url`: `http://localhost` and the normalized path and query.
    pub url: String,
    /// `c.req.path`: decoded by `decodeURI`, one trailing slash dropped.
    pub path: String,
}

impl Target {
    pub fn of(uri: &Uri) -> Self {
        let raw = uri.path_and_query().map_or("/", PathAndQuery::as_str);
        let parsed = Url::parse(&format!("http://localhost{raw}")).ok();
        let (url, whatwg_path) = match &parsed {
            Some(url) => (url.as_str().to_owned(), url.path().to_owned()),
            None => (format!("http://localhost{raw}"), uri.path().to_owned()),
        };
        let mut path = hono_path(&whatwg_path);
        if path.len() > 1 && path.ends_with('/') {
            path.pop();
        }
        Self { url, path }
    }

    /// The URI the router matches: the decoded path, re-encoded where a URI
    /// requires it, and the query.
    pub(crate) fn routing_uri(&self) -> Uri {
        let path = utf8_percent_encode(&self.path, ROUTING).to_string();
        let query = self.url.find('?').map_or("", |index| &self.url[index..]);
        format!("{path}{query}")
            .parse()
            .unwrap_or_else(|_| Uri::from_static("/"))
    }

    /// `new URL(request.url).searchParams.get(name)`.
    pub fn query_param(&self, name: &str) -> Option<String> {
        let url = Url::parse(&self.url).ok()?;
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    }

    /// The query as `c.req.query(name)` reads it, for a lookup that takes the
    /// first pair of a name: every value `+`- and percent-decoded (a run of
    /// escapes that does not decode stays as it was). Hono first looks for the
    /// name as written, and only then compares decoded names, so the pairs
    /// under their written names come first.
    pub(crate) fn hono_query(&self) -> Vec<(String, String)> {
        let Some((_, query)) = self.url.split_once('?') else {
            return Vec::new();
        };
        let pairs: Vec<(&str, String)> = query
            .split('&')
            .map(|pair| {
                let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
                (name, hono_decode(value))
            })
            .collect();
        let written = pairs.iter().map(|(name, value)| ((*name).to_owned(), value.clone()));
        let decoded = pairs.iter().map(|(name, value)| (hono_decode(name), value.clone()));
        written.chain(decoded).filter(|(name, _)| !name.is_empty()).collect()
    }
}

/// Hono's `_decodeURI` for a query name or value.
fn hono_decode(value: &str) -> String {
    try_decode_uri_component(&value.replace('+', " "))
}

/// Hono's `getPath` decoding: `decodeURI`, with `%25` kept as `%25`.
fn hono_path(path: &str) -> String {
    if !path.contains('%') {
        return path.to_owned();
    }
    try_decode(&path.replace("%25", "%2525"), RESERVED_URI)
}

/// `decodeURI` leaves the escapes of these characters as they are.
const RESERVED_URI: &[char] = &[';', '/', '?', ':', '@', '&', '=', '+', '$', ',', '#'];

/// `decodeURIComponent(value)`; `None` where it throws a `URIError`.
pub(crate) fn decode_uri_component(value: &str) -> Option<String> {
    decode(value, &[])
}

/// Hono's `tryDecodeURIComponent` (route parameters).
pub(crate) fn try_decode_uri_component(value: &str) -> String {
    if value.contains('%') {
        try_decode(value, &[])
    } else {
        value.to_owned()
    }
}

/// Hono's `tryDecode`: the whole value, or else each run of escapes alone,
/// a run that does not decode left as it was.
fn try_decode(value: &str, reserved: &[char]) -> String {
    if let Some(decoded) = decode(value, reserved) {
        return decoded;
    }
    let bytes = value.as_bytes();
    let mut out = String::new();
    let mut index = 0;
    while index < bytes.len() {
        let start = index;
        while index < bytes.len() && is_escape(bytes, index) {
            index += 3;
        }
        if index > start {
            let run = &value[start..index];
            out.push_str(&decode(run, reserved).unwrap_or_else(|| run.to_owned()));
            continue;
        }
        let next = value[index..].chars().next().expect("inside the value");
        out.push(next);
        index += next.len_utf8();
    }
    out
}

fn is_escape(bytes: &[u8], index: usize) -> bool {
    bytes.get(index) == Some(&b'%')
        && bytes.get(index + 1).is_some_and(u8::is_ascii_hexdigit)
        && bytes.get(index + 2).is_some_and(u8::is_ascii_hexdigit)
}

fn hex(bytes: &[u8], index: usize) -> Option<u8> {
    is_escape(bytes, index).then(|| {
        let digits = std::str::from_utf8(&bytes[index + 1..index + 3]).expect("hex digits");
        u8::from_str_radix(digits, 16).expect("hex digits")
    })
}

/// ECMAScript's `Decode(string, reservedSet)`; `None` for a `URIError`.
fn decode(value: &str, reserved: &[char]) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            let next = value[index..].chars().next()?;
            out.push(next);
            index += next.len_utf8();
            continue;
        }
        let first = hex(bytes, index)?;
        if first < 0x80 {
            let c = char::from(first);
            if reserved.contains(&c) {
                out.push_str(&value[index..index + 3]);
            } else {
                out.push(c);
            }
            index += 3;
            continue;
        }
        let length = match first.leading_ones() {
            2 => 2,
            3 => 3,
            4 => 4,
            _ => return None,
        };
        let mut octets = vec![first];
        for position in 1..length {
            let octet = hex(bytes, index + position * 3)?;
            if octet & 0xC0 != 0x80 {
                return None;
            }
            octets.push(octet);
        }
        out.push_str(std::str::from_utf8(&octets).ok()?);
        index += length * 3;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(raw: &str) -> Target {
        Target::of(&raw.parse().unwrap())
    }

    #[test]
    fn paths_as_hono_sees_them() {
        assert_eq!(target("/heal%74hz").path, "/healthz");
        assert_eq!(target("/healthz/").path, "/healthz");
        assert_eq!(target("/healthz//").path, "/healthz/");
        assert_eq!(target("/").path, "/");
        assert_eq!(target("/media/a/../../b/%2e%2e/c").path, "/c");
        assert_eq!(target("/media/staging%2Fa.mp4").path, "/media/staging%2Fa.mp4");
        assert_eq!(target("/media/%25E0.mp4").path, "/media/%25E0.mp4");
        assert_eq!(target("/media/%E0%A4%A.mp4").path, "/media/%E0%A4%A.mp4");
        assert_eq!(target("/media/a%20b%E0%A4%A4%ZZ").path, "/media/a b\u{924}%ZZ");
        assert_eq!(target("/x?v=1").url, "http://localhost/x?v=1");
        assert_eq!(target("/a%20b?v=1").routing_uri(), "/a%20b?v=1");
    }

    #[test]
    fn decode_uri_component_throws_where_javascript_does() {
        assert_eq!(decode_uri_component("a%2Fb").as_deref(), Some("a/b"));
        assert_eq!(decode_uri_component("%25E0").as_deref(), Some("%E0"));
        assert_eq!(decode_uri_component("%E0%A4%A"), None);
        assert_eq!(decode_uri_component("%"), None);
        assert_eq!(decode_uri_component("%C0%80"), None);
        assert_eq!(decode_uri_component("%ED%A0%80"), None);
        assert_eq!(try_decode_uri_component("%6Dedia"), "media");
    }

    #[test]
    fn query_as_hono_reads_it() {
        let first = |raw: &str, name: &str| {
            target(raw)
                .hono_query()
                .into_iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value)
        };
        assert_eq!(first("/x?code=a+b%2Bc&code=2", "code").as_deref(), Some("a b+c"));
        assert_eq!(first("/x?state&code=1", "state").as_deref(), Some(""));
        assert_eq!(first("/x?state=a=b", "state").as_deref(), Some("a=b"));
        assert_eq!(first("/x?state=%E0%A4%A", "state").as_deref(), Some("%E0%A4%A"));
        assert_eq!(first("/x?st%61te=1&state=2", "state").as_deref(), Some("2"));
        assert_eq!(first("/x?st%61te=1", "state").as_deref(), Some("1"));
        assert_eq!(first("/x?=1&state", "").as_deref(), None);
        assert_eq!(first("/x", "state"), None);
    }
}
