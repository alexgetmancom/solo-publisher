//! Threads credentials, per locale.

use content::Locale;
use foundation::config::Config;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ThreadsCredentials<'a> {
    pub access_token: Option<&'a str>,
    /// Named in "missing …" refusals.
    pub env_name: &'static str,
}

/// The `threads_ru` / `threads_en` target's credential, by the target's locale.
pub fn threads_credentials(config: &Config, locale: Locale) -> ThreadsCredentials<'_> {
    match locale {
        Locale::En => ThreadsCredentials {
            access_token: config.threads_en_access_token.as_deref(),
            env_name: "THREADS_EN_ACCESS_TOKEN",
        },
        Locale::Ru => ThreadsCredentials {
            access_token: config.threads_ru_access_token.as_deref(),
            env_name: "THREADS_RU_ACCESS_TOKEN",
        },
    }
}
