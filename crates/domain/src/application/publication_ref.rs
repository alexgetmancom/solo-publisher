//! Every Studio publication identity in the one event-journal format,
//! `<kind>:<id>`.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicationRefKind {
    Article,
    Draft,
    Post,
    Video,
}

impl PublicationRefKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Article => "article",
            Self::Draft => "draft",
            Self::Post => "post",
            Self::Video => "video",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PublicationRef {
    pub kind: PublicationRefKind,
    pub id: i64,
}

impl fmt::Display for PublicationRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.kind.as_str(), self.id)
    }
}

pub fn publication_ref(kind: PublicationRefKind, id: i64) -> String {
    PublicationRef { kind, id }.to_string()
}

/// `^(article|draft|post|video):(\d+)$`, and only ids JavaScript holds exactly
/// (`Number.isSafeInteger`). Leading zeros are accepted, so `video:01` parses
/// as `video:1`.
pub fn parse_publication_ref(value: Option<&str>) -> Option<PublicationRef> {
    const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
    let (kind, digits) = value?.split_once(':')?;
    let kind = match kind {
        "article" => PublicationRefKind::Article,
        "draft" => PublicationRefKind::Draft,
        "post" => PublicationRefKind::Post,
        "video" => PublicationRefKind::Video,
        _ => return None,
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let id = digits.parse::<u64>().ok().filter(|id| *id <= MAX_SAFE_INTEGER)?;
    Some(PublicationRef { kind, id: id as i64 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_what_the_typescript_pattern_accepts() {
        let parsed = |value: &str| parse_publication_ref(Some(value)).map(|r| r.to_string());
        assert_eq!(parsed("video:01").as_deref(), Some("video:1"));
        assert_eq!(
            parsed("post:9007199254740991").as_deref(),
            Some("post:9007199254740991")
        );
        assert_eq!(parsed("post:9007199254740992"), None);
        assert_eq!(parsed("post:99999999999999999999999"), None);
        assert_eq!(parsed("post:"), None);
        assert_eq!(parsed("post:1:2"), None);
        assert_eq!(parsed("post:-1"), None);
        assert_eq!(parsed("Post:1"), None);
        assert_eq!(parsed("post:١"), None);
        assert_eq!(parse_publication_ref(None), None);
    }
}
