//! The golden host: the boundaries Studio calls but the bot does
//! not own. The stores (Story cards, reminders, the credential breaker,
//! the readiness report, the video completion notice) are the real ones; of
//! the rest only what the registered areas reach is implemented, and anything
//! else panics with its name, so a case that reaches it fails loudly instead
//! of diverging quietly.

use std::rc::Rc;

use bot::Host;
use content::Locale;
use db::rusqlite::Connection;
use domain::application::ports::FixedClock;
use domain::delivery::VideoCompletionNotice;
use domain::notifications::ReminderJobs;
use domain::observability::auth_circuit::AuthCircuitBreaker;
use domain::observability::capabilities::CapabilityReadiness;
use domain::publishing::Boundaries;
use domain::publishing::boundaries::{Jitter, NoWorker, UsageMeter};
use domain::story_cards::StoryCardStore;
use domain::studio::boundaries::{
    ChannelConnectLinks, ConnectPlatform, ConnectStart, MetaOauthPlatform, StoryDerivatives, StudioBoundaries,
};
use foundation::config::{Config, SharedConfig};
use jiff::Timestamp;

fn not_in_host(what: &str) -> ! {
    panic!(
        "{what} is not implemented in the golden host (crates/bot/tests/support/host.rs); the area that reaches it adds it"
    )
}

/// The real stores run on the case's clock; the rest is below.
pub(crate) struct GoldenHost {
    auth_circuit: AuthCircuitBreaker<Rc<FixedClock>>,
    story_cards: StoryCardStore<Rc<FixedClock>>,
    video_completion: VideoCompletionNotice<Rc<FixedClock>>,
    reminders: ReminderJobs<Rc<FixedClock>>,
    readiness: CapabilityReadiness,
}

impl GoldenHost {
    pub(crate) fn new(config: SharedConfig, clock: Rc<FixedClock>) -> Self {
        Self {
            auth_circuit: AuthCircuitBreaker::new(clock.clone()),
            story_cards: StoryCardStore::new(clock.clone()),
            video_completion: VideoCompletionNotice::new(clock.clone()),
            reminders: ReminderJobs::new(clock),
            readiness: CapabilityReadiness::new(config),
        }
    }
}

impl Jitter for GoldenHost {
    fn unit(&self) -> f64 {
        not_in_host("retry jitter")
    }
}

/// Usage counters are observability rows no golden shows.
impl UsageMeter for GoldenHost {
    fn record(&self, _: &Connection, _: &str, _: bool, _: u64) {}
}

impl StoryDerivatives for GoldenHost {
    fn ensure(&self, _: &str, _: bool, _: i64) {
        not_in_host("Story derivatives")
    }
}

/// `required(value, name)` of the OAuth links: a trimmed, non-blank value.
fn required(value: &Option<String>, name: &str) -> domain::Result<()> {
    match value.as_deref().map(foundation::js::trim) {
        Some(value) if !value.is_empty() => Ok(()),
        _ => Err(domain::Error::message(format!("{name} is required for browser OAuth"))),
    }
}

fn encryption_key_set(config: &Config) -> bool {
    matches!(
        foundation::secret_box::encryption_key(config.token_encryption_key.as_deref()),
        Ok(Some(_))
    )
}

fn meta_app(
    config: &Config,
    platform: MetaOauthPlatform,
) -> (&Option<String>, &'static str, &Option<String>, &'static str) {
    match platform {
        MetaOauthPlatform::Threads => (
            &config.threads_app_id,
            "THREADS_APP_ID",
            &config.threads_app_secret,
            "THREADS_APP_SECRET",
        ),
        MetaOauthPlatform::Instagram => (
            &config.instagram_app_id,
            "INSTAGRAM_APP_ID",
            &config.instagram_app_secret,
            "INSTAGRAM_APP_SECRET",
        ),
    }
}

fn meta_platform(platform: MetaOauthPlatform) -> &'static str {
    match platform {
        MetaOauthPlatform::Threads => "threads",
        MetaOauthPlatform::Instagram => "instagram",
    }
}

fn assert_meta_configured(config: &Config, platform: MetaOauthPlatform) -> domain::Result<()> {
    let (id, id_name, secret, secret_name) = meta_app(config, platform);
    required(&config.token_encryption_key, "TOKEN_ENCRYPTION_KEY")?;
    required(id, id_name)?;
    required(secret, secret_name)
}

fn base_url(config: &Config) -> &str {
    config
        .public_base_url
        .strip_suffix('/')
        .unwrap_or(&config.public_base_url)
}

/// `URLSearchParams` serialisation (application/x-www-form-urlencoded).
fn form_encode(pairs: &[(&str, &str)]) -> String {
    let encode = |text: &str| {
        text.bytes()
            .map(|byte| match byte {
                b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => (byte as char).to_string(),
                b' ' => "+".to_owned(),
                other => format!("%{other:02X}"),
            })
            .collect::<String>()
    };
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// The OAuth links as the recorded Studio built them. The sealed state and the PKCE challenge are
/// random there and recorded as `<random>`, so any value stands in for them.
impl ChannelConnectLinks for GoldenHost {
    fn meta_oauth_connect_url(
        &self,
        config: &Config,
        platform: MetaOauthPlatform,
        _: Locale,
    ) -> domain::Result<String> {
        assert_meta_configured(config, platform)?;
        Ok(format!(
            "{}/oauth/{}/start?state=sealed-state",
            base_url(config),
            meta_platform(platform)
        ))
    }
    fn meta_oauth_connect_path(
        &self,
        config: &Config,
        platform: MetaOauthPlatform,
        locale: Locale,
    ) -> domain::Result<String> {
        assert_meta_configured(config, platform)?;
        Ok(format!(
            "/oauth/{}/start?locale={}",
            meta_platform(platform),
            locale.as_str()
        ))
    }
    fn x_oauth_connect_url(&self, config: &Config) -> domain::Result<String> {
        Ok(format!("{}{}", base_url(config), self.x_oauth_connect_path(config)?))
    }
    fn x_oauth_connect_path(&self, config: &Config) -> domain::Result<String> {
        required(&config.x_client_id, "X_CLIENT_ID")?;
        required(&config.x_client_secret, "X_CLIENT_SECRET")?;
        if !encryption_key_set(config) {
            return Err(domain::Error::message(
                "TOKEN_ENCRYPTION_KEY is required for browser OAuth",
            ));
        }
        Ok("/oauth/x/start".into())
    }
    fn start_connect(
        &self,
        config: &Config,
        platform: ConnectPlatform,
        locale: Locale,
        _: Timestamp,
    ) -> domain::Result<ConnectStart> {
        let ConnectPlatform::Youtube = platform else {
            not_in_host("starting a Threads, Instagram or X connection");
        };
        let (client_id, client_secret, suffix) = match locale {
            Locale::En => (&config.youtube_en_client_id, &config.youtube_en_client_secret, "EN"),
            Locale::Ru => (&config.youtube_ru_client_id, &config.youtube_ru_client_secret, "RU"),
        };
        let set = |value: &Option<String>| value.as_deref().is_some_and(|value| !value.is_empty());
        let missing: Vec<String> = [
            (!set(client_id)).then(|| format!("YOUTUBE_{suffix}_CLIENT_ID")),
            (!set(client_secret)).then(|| format!("YOUTUBE_{suffix}_CLIENT_SECRET")),
            (!set(&config.token_encryption_key)).then(|| "TOKEN_ENCRYPTION_KEY".to_owned()),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !missing.is_empty() {
            return Err(domain::Error::message(format!(
                "YouTube is not configured: {}",
                missing.join(", ")
            )));
        }
        if !encryption_key_set(config) {
            return Err(domain::Error::message(
                "TOKEN_ENCRYPTION_KEY is required for browser OAuth",
            ));
        }
        let redirect_uri = format!("{}/oauth/youtube", base_url(config));
        let query = form_encode(&[
            ("response_type", "code"),
            ("client_id", client_id.as_deref().unwrap_or_default()),
            ("redirect_uri", &redirect_uri),
            (
                "scope",
                "https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly",
            ),
            ("state", "sealed-state"),
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("include_granted_scopes", "false"),
            ("code_challenge", "pkce-challenge"),
            ("code_challenge_method", "S256"),
        ]);
        Ok(ConnectStart {
            platform: "youtube",
            locale: Some(locale.as_str()),
            kind: "redirect",
            url: format!("https://accounts.google.com/o/oauth2/v2/auth?{query}"),
            expires_in_minutes: 10,
        })
    }
}

impl Host for GoldenHost {
    fn publishing(&self) -> Boundaries<'_> {
        Boundaries {
            jitter: self,
            // Ringing the publish worker has no visible effect in a golden.
            bell: &NoWorker,
            auth_circuit: &self.auth_circuit,
            usage: self,
            story_cards: &self.story_cards,
            video_completion: &self.video_completion,
        }
    }

    fn studio(&self) -> StudioBoundaries<'_> {
        StudioBoundaries {
            reminders: &self.reminders,
            story_derivatives: self,
            readiness: &self.readiness,
            connect_links: self,
        }
    }
}
