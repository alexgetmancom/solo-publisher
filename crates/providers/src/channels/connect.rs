//! Starting a connection the way the CLI, the
//! dashboard and the bot do, and the [`ChannelConnectLinks`] boundary Studio
//! reaches the signed links through.

use content::Locale;
use domain::application::ports::Clock;
use domain::studio::boundaries::{ChannelConnectLinks, ConnectPlatform, ConnectStart, MetaOauthPlatform};
use foundation::config::Config;
use jiff::Timestamp;

use crate::channels::encode::set;
use crate::channels::entropy::Entropy;
use crate::channels::meta::{meta_oauth_connect_path, meta_oauth_connect_url, meta_provider};
use crate::channels::x::{x_oauth_authorize_url, x_oauth_connect_path, x_oauth_connect_url};
use crate::channels::youtube::youtube_oauth_authorize_url;
use crate::channels::{Error, Result};

const LINK_TTL_MINUTES: u32 = 10;

pub const CONNECT_PLATFORMS: [ConnectPlatform; 4] = [
    ConnectPlatform::Threads,
    ConnectPlatform::Instagram,
    ConnectPlatform::X,
    ConnectPlatform::Youtube,
];

fn platform_name(platform: ConnectPlatform) -> &'static str {
    match platform {
        ConnectPlatform::Threads => "threads",
        ConnectPlatform::Instagram => "instagram",
        ConnectPlatform::X => "x",
        ConnectPlatform::Youtube => "youtube",
    }
}

/// The settings a platform's connection still needs, by name.
fn missing(config: &Config, platform: ConnectPlatform, locale: Locale) -> (&'static str, Vec<String>) {
    let key = set(&config.token_encryption_key);
    let names = |checks: [(bool, String); 3]| -> Vec<String> {
        checks
            .into_iter()
            .filter(|(present, _)| !present)
            .map(|(_, name)| name)
            .collect()
    };
    match platform {
        ConnectPlatform::Threads | ConnectPlatform::Instagram => {
            let meta = meta_provider(match platform {
                ConnectPlatform::Threads => MetaOauthPlatform::Threads,
                _ => MetaOauthPlatform::Instagram,
            });
            let present = |value: Option<&str>| value.is_some_and(|value| !value.is_empty());
            (
                meta.label,
                names([
                    (present(meta.app_id(config)), meta.app_id_name.into()),
                    (present(meta.app_secret(config)), meta.app_secret_name.into()),
                    (key, "TOKEN_ENCRYPTION_KEY".into()),
                ]),
            )
        }
        ConnectPlatform::X => (
            "X",
            names([
                (set(&config.x_client_id), "X_CLIENT_ID".into()),
                (set(&config.x_client_secret), "X_CLIENT_SECRET".into()),
                (key, "TOKEN_ENCRYPTION_KEY".into()),
            ]),
        ),
        ConnectPlatform::Youtube => {
            let suffix = if locale == Locale::En { "EN" } else { "RU" };
            let credentials = crate::external::youtube::youtube_credentials(config, locale);
            let present = |value: Option<&str>| value.is_some_and(|value| !value.is_empty());
            (
                "YouTube",
                names([
                    (present(credentials.client_id), format!("YOUTUBE_{suffix}_CLIENT_ID")),
                    (
                        present(credentials.client_secret),
                        format!("YOUTUBE_{suffix}_CLIENT_SECRET"),
                    ),
                    (key, "TOKEN_ENCRYPTION_KEY".into()),
                ]),
            )
        }
    }
}

/// `startConnect`: the link the operator opens. Meta links go through this
/// Studio's own start route; X and YouTube straight to the consent screen.
pub fn start_connect(
    config: &Config,
    platform: ConnectPlatform,
    locale: Locale,
    now: Timestamp,
    entropy: &dyn Entropy,
) -> Result<ConnectStart> {
    let (label, missing) = missing(config, platform, locale);
    if !missing.is_empty() {
        return Err(Error::message(format!(
            "{label} is not configured: {}",
            missing.join(", ")
        )));
    }
    let url = match platform {
        ConnectPlatform::Threads => meta_oauth_connect_url(config, MetaOauthPlatform::Threads, locale, now, entropy)?,
        ConnectPlatform::Instagram => {
            meta_oauth_connect_url(config, MetaOauthPlatform::Instagram, locale, now, entropy)?
        }
        ConnectPlatform::X => x_oauth_authorize_url(config, now, entropy)?,
        ConnectPlatform::Youtube => youtube_oauth_authorize_url(config, locale, now, entropy)?,
    };
    Ok(ConnectStart {
        platform: platform_name(platform),
        locale: (platform != ConnectPlatform::X).then_some(locale.as_str()),
        kind: "redirect",
        url,
        expires_in_minutes: LINK_TTL_MINUTES,
    })
}

/// The signed connection links, on this process's clock and randomness.
pub struct ConnectLinks<C, E> {
    clock: C,
    entropy: E,
}

impl<C: Clock, E: Entropy> ConnectLinks<C, E> {
    pub fn new(clock: C, entropy: E) -> Self {
        Self { clock, entropy }
    }
}

impl<C: Clock, E: Entropy> ChannelConnectLinks for ConnectLinks<C, E> {
    fn meta_oauth_connect_url(
        &self,
        config: &Config,
        platform: MetaOauthPlatform,
        locale: Locale,
    ) -> domain::Result<String> {
        Ok(meta_oauth_connect_url(
            config,
            platform,
            locale,
            self.clock.now(),
            &self.entropy,
        )?)
    }

    fn meta_oauth_connect_path(
        &self,
        config: &Config,
        platform: MetaOauthPlatform,
        locale: Locale,
    ) -> domain::Result<String> {
        Ok(meta_oauth_connect_path(config, platform, locale)?)
    }

    fn x_oauth_connect_url(&self, config: &Config) -> domain::Result<String> {
        Ok(x_oauth_connect_url(config)?)
    }

    fn x_oauth_connect_path(&self, config: &Config) -> domain::Result<String> {
        Ok(x_oauth_connect_path(config)?)
    }

    fn start_connect(
        &self,
        config: &Config,
        platform: ConnectPlatform,
        locale: Locale,
        now: Timestamp,
    ) -> domain::Result<ConnectStart> {
        Ok(start_connect(config, platform, locale, now, &self.entropy)?)
    }
}
