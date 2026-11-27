//! The callback-data grammar: screen buttons,
//! the publication namespace and its dialog
//! revision prefix. The menu plugin's own
//! format lives in [`crate::menu`].

use std::sync::LazyLock;

use domain::application::conversation_flow::PublicationKind;
use foundation::errors::StudioError;
use regex::Regex;

/// Every button that is not a publication control or a menu button, with the
/// arguments it carries, whether a newer tap on it makes an older one
/// redundant, and the area of the bot that routes it.
macro_rules! screens {
    ($($variant:ident = $name:literal [$($arg:literal),*] $supersedable:literal $area:literal,)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum ScreenId { $($variant,)* }

        impl ScreenId {
            pub const ALL: &'static [ScreenId] = &[$(ScreenId::$variant,)*];

            pub fn name(self) -> &'static str {
                match self { $(ScreenId::$variant => $name,)* }
            }

            /// The declared argument names, in order.
            pub fn args(self) -> &'static [&'static str] {
                match self { $(ScreenId::$variant => &[$($arg),*],)* }
            }

            pub fn supersedable(self) -> bool {
                match self { $(ScreenId::$variant => $supersedable,)* }
            }

            /// The area of the bot whose module routes this button.
            pub fn area(self) -> &'static str {
                match self { $(ScreenId::$variant => $area,)* }
            }

            pub fn from_name(name: &str) -> Option<Self> {
                match name { $($name => Some(ScreenId::$variant),)* _ => None }
            }
        }
    };
}

screens! {
    Noop = "noop" [] true "entry",
    MenuHome = "menu_home" [] true "entry",
    QueueHome = "queue_home" [] true "queue",
    QueuePage = "queue_page" ["page"] true "queue",
    QueueAttention = "queue_attention" [] true "queue",
    QueueAttentionPage = "queue_attention_page" ["page"] true "queue",
    Progress = "progress" ["draft"] true "post",
    ProgressDetails = "progress_details" ["draft"] true "post",
    ProgressCancel = "progress_cancel" ["draft"] false "post",
    ProgressCancelConfirm = "progress_cancel_confirm" ["draft"] false "post",
    DeliveryPreviewVideo = "delivery_preview_video" ["id"] false "video",
    IntakeKind = "intake_kind" ["choice"] false "intake",
    IntakeLocale = "intake_locale" ["locale"] false "intake",
    IntakeDownload = "intake_download" ["revision", "choice"] false "intake",
    IntakeTarget = "intake_target" ["target"] false "intake",
    IntakeCancel = "intake_cancel" [] false "intake",
    DeployMenu = "deploy_menu" ["revision"] false "deploy",
    DeployRbAsk = "deploy_rb_ask" ["target", "revision"] false "deploy",
    DeployPrAsk = "deploy_pr_ask" ["target", "revision"] false "deploy",
    DeployRollback = "deploy_rollback" ["target", "revision"] false "deploy",
    DeployPromote = "deploy_promote" ["target", "revision"] false "deploy",
}

/// A parsed screen button: its id and its arguments by declared name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScreenCallback {
    pub id: ScreenId,
    pub args: Vec<(&'static str, String)>,
}

impl ScreenCallback {
    pub fn arg(&self, name: &str) -> &str {
        self.args
            .iter()
            .find(|(declared, _)| *declared == name)
            .map_or("", |(_, value)| value.as_str())
    }
}

fn invalid_argument(detail: String) -> StudioError {
    StudioError::new("action.invalid-callback-argument").with_param("detail", detail)
}

/// `screenCallback(id, args)`: the arity is checked where the button is built.
pub fn screen_callback(id: ScreenId, args: &[&dyn std::fmt::Display]) -> Result<String, StudioError> {
    let declared = id.args();
    if args.len() != declared.len() {
        return Err(invalid_argument(format!(
            "{} takes {} arguments",
            id.name(),
            declared.len()
        )));
    }
    let values: Vec<String> = args.iter().map(ToString::to_string).collect();
    if values.iter().any(|value| value.contains(':') || value.is_empty()) {
        return Err(invalid_argument(id.name().to_owned()));
    }
    let mut data = id.name().to_owned();
    for value in values {
        data.push(':');
        data.push_str(&value);
    }
    Ok(data)
}

/// A button with no arguments; it cannot fail.
pub fn screen(id: ScreenId) -> String {
    debug_assert!(id.args().is_empty(), "{} takes arguments", id.name());
    id.name().to_owned()
}

/// `parseScreenCallback`: unknown id or wrong arity is not a screen button.
pub fn parse_screen_callback(data: &str) -> Option<ScreenCallback> {
    let mut parts = data.split(':');
    let id = ScreenId::from_name(parts.next()?)?;
    let values: Vec<&str> = parts.collect();
    let declared = id.args();
    if values.len() != declared.len() {
        return None;
    }
    Some(ScreenCallback {
        id,
        args: declared
            .iter()
            .zip(values)
            .map(|(name, value)| (*name, value.to_owned()))
            .collect(),
    })
}

/// `supersedableScreen`.
pub fn supersedable_screen(data: &str) -> Option<ScreenId> {
    parse_screen_callback(data)
        .map(|callback| callback.id)
        .filter(|id| id.supersedable())
}

/// A screen argument as an integer of at least `min`. Buttons sent with an
/// empty argument mean 0.
pub fn screen_number(value: &str, min: i64) -> Option<i64> {
    let parsed = if value.is_empty() {
        0
    } else {
        value.parse::<i64>().ok()?
    };
    (parsed >= min).then_some(parsed)
}

/// A tap in the publication namespace: `p:<kind>:<action>[:<arg>…]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicationCallback {
    pub kind: PublicationKind,
    pub action: String,
    pub args: Vec<String>,
}

static SESSION_VERSION_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)^sv(\d+)\|(.*)$").unwrap());
static PUBLICATION_CALLBACK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^p:(post|video):([^:]+)(?::(.*))?$").unwrap());

/// `publicationCallback(kind, action, args, revision)`.
pub fn publication_callback(
    kind: PublicationKind,
    action: &str,
    args: &[&dyn std::fmt::Display],
    revision: Option<i64>,
) -> Result<String, StudioError> {
    let values: Vec<String> = args.iter().map(ToString::to_string).collect();
    if values.iter().any(|value| value.contains(':')) {
        return Err(StudioError::new("action.invalid-callback-argument"));
    }
    let mut data = format!("p:{}:{action}", kind.as_str());
    for value in values {
        data.push(':');
        data.push_str(&value);
    }
    Ok(versioned_callback(&data, revision))
}

/// `parsePublicationCallback`.
pub fn parse_publication_callback(data: &str) -> Option<PublicationCallback> {
    let captures = PUBLICATION_CALLBACK.captures(data)?;
    let kind = match &captures[1] {
        "post" => PublicationKind::Post,
        _ => PublicationKind::Video,
    };
    Some(PublicationCallback {
        kind,
        action: captures[2].to_owned(),
        args: match captures.get(3) {
            Some(args) if !args.as_str().is_empty() => args.as_str().split(':').map(str::to_owned).collect(),
            _ => Vec::new(),
        },
    })
}

/// `versionedCallback`: `sv<revision>|<data>`.
pub fn versioned_callback(data: &str, revision: Option<i64>) -> String {
    match revision {
        Some(revision) => format!("sv{revision}|{data}"),
        None => data.to_owned(),
    }
}

/// `parseSessionCallback`: the optional revision prefix, then the namespace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionCallback {
    pub data: String,
    pub callback: Option<PublicationCallback>,
    pub revision: Option<i64>,
}

pub fn parse_session_callback(data: &str) -> SessionCallback {
    let prefix = SESSION_VERSION_PREFIX.captures(data);
    let payload = prefix
        .as_ref()
        .map_or(data, |captures| captures.get(2).map_or("", |m| m.as_str()));
    // The revision is digits; one past i64 is a revision no session carries.
    let revision = prefix
        .as_ref()
        .map(|captures| captures[1].parse::<i64>().unwrap_or(i64::MAX));
    SessionCallback {
        data: payload.to_owned(),
        callback: parse_publication_callback(payload),
        revision,
    }
}

/// `parseDraftId`: a positive integer.
pub fn parse_draft_id(value: Option<&str>) -> Option<i64> {
    value?.parse::<i64>().ok().filter(|id| *id > 0)
}

/// `requireSessionRevision`.
pub fn require_session_revision(current: Option<i64>, expected: Option<i64>) -> Result<(), StudioError> {
    match expected {
        Some(expected) if current != Some(expected) => Err(StudioError::new("action.session-stale")),
        _ => Ok(()),
    }
}

/// The grouping key a tap is logged under (`callbackRoute`): a menu button by
/// its position, anything else by its first two parts with numbers as `#`.
pub fn callback_route(data: Option<&str>) -> String {
    let Some(data) = data.filter(|data| !data.is_empty()) else {
        return "unknown".into();
    };
    if data.contains('/') {
        return data.split('/').take(3).collect::<Vec<_>>().join("/");
    }
    data.split(':')
        .take(2)
        .map(|part| {
            if !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) {
                "#"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screen_buttons_check_their_arity_both_ways() {
        assert_eq!(screen_callback(ScreenId::QueuePage, &[&2]).unwrap(), "queue_page:2");
        assert_eq!(
            screen_callback(ScreenId::QueuePage, &[]).unwrap_err().params,
            [("detail".to_owned(), "queue_page takes 1 arguments".to_owned())]
        );
        assert!(screen_callback(ScreenId::QueuePage, &[&"a:b"]).is_err());
        assert_eq!(parse_screen_callback("queue_page").map(|c| c.id), None);
        assert_eq!(parse_screen_callback("noop:extra"), None);
        assert_eq!(parse_screen_callback("analytics_post"), None);
        let page = parse_screen_callback("queue_page:3").unwrap();
        assert_eq!((page.id, page.arg("page")), (ScreenId::QueuePage, "3"));
        assert_eq!(supersedable_screen("queue_page:1"), Some(ScreenId::QueuePage));
        assert_eq!(supersedable_screen("progress_cancel:1"), None);
    }

    #[test]
    fn callback_numbers_are_decimal_and_empty_is_zero() {
        assert_eq!(screen_number("x", 0), None);
        assert_eq!(screen_number("-1", 0), None);
        assert_eq!(screen_number("", 0), Some(0));
        assert_eq!(screen_number("0x10", 0), None);
        assert_eq!(screen_number("16", 0), Some(16));
        assert_eq!(screen_number("0", 1), None);
        assert_eq!(parse_draft_id(Some("abc")), None);
        assert_eq!(parse_draft_id(Some("0")), None);
        assert_eq!(parse_draft_id(Some("")), None);
        assert_eq!(parse_draft_id(Some("12")), Some(12));
    }

    #[test]
    fn the_publication_namespace_and_its_revision() {
        let parsed = parse_session_callback("sv7|p:post:edit_ru:1");
        assert_eq!(parsed.revision, Some(7));
        assert_eq!(parsed.data, "p:post:edit_ru:1");
        let callback = parsed.callback.unwrap();
        assert_eq!(
            (callback.kind, callback.action.as_str(), callback.args),
            (PublicationKind::Post, "edit_ru", vec!["1".to_owned()])
        );
        assert_eq!(
            parse_session_callback("p:post:cancel_dialog").callback.unwrap().args,
            Vec::<String>::new()
        );
        assert_eq!(parse_session_callback("p:post::1").callback, None);
        assert_eq!(parse_session_callback("queue_home").callback, None);
        assert_eq!(
            publication_callback(PublicationKind::Video, "time", &[&3, &"youtube_shorts"], Some(2)).unwrap(),
            "sv2|p:video:time:3:youtube_shorts"
        );
        assert!(require_session_revision(Some(1), Some(2)).is_err());
        assert!(require_session_revision(None, None).is_ok());
    }

    #[test]
    fn routes_group_taps_by_button() {
        assert_eq!(callback_route(Some("main-menu/1/0//f1")), "main-menu/1/0");
        assert_eq!(callback_route(Some("queue_page:12")), "queue_page:#");
        assert_eq!(callback_route(Some("p:post:view:1")), "p:post");
        assert_eq!(callback_route(None), "unknown");
    }
}
