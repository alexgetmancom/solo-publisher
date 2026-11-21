//! `foundation/external/instagram.ts`.

use content::Locale;
use foundation::config::Config;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InstagramCredentials<'a> {
    pub access_token: Option<&'a str>,
    pub user_id: Option<&'a str>,
}

pub fn instagram_credentials_for_locale(config: &Config, locale: Locale) -> InstagramCredentials<'_> {
    match locale {
        Locale::Ru => InstagramCredentials {
            access_token: config.instagram_ru_access_token.as_deref(),
            user_id: config.instagram_ru_user_id.as_deref(),
        },
        Locale::En => InstagramCredentials {
            access_token: config.instagram_en_access_token.as_deref(),
            user_id: config.instagram_en_user_id.as_deref(),
        },
    }
}

/// Which Graph host answers for a token. Instagram Login tokens (`IG…`) are
/// served by graph.instagram.com, tokens issued through a linked Facebook page
/// by graph.facebook.com, and each host rejects the other's. Both kinds
/// coexist across locales, so the host is a property of the credential.
pub fn instagram_graph_host(token: &str) -> &'static str {
    if token.starts_with("IG") {
        "graph.instagram.com"
    } else {
        "graph.facebook.com"
    }
}
