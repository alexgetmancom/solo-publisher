//! `foundation/external/youtube.ts`.

use content::Locale;
use foundation::config::Config;
use serde_json::Value;

use crate::http::{ExternalError, HttpClient, HttpRequest};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct YoutubeCredentials<'a> {
    pub client_id: Option<&'a str>,
    pub client_secret: Option<&'a str>,
    pub refresh_token: Option<&'a str>,
}

pub fn youtube_credentials(config: &Config, locale: Locale) -> YoutubeCredentials<'_> {
    match locale {
        Locale::En => YoutubeCredentials {
            client_id: config.youtube_en_client_id.as_deref(),
            client_secret: config.youtube_en_client_secret.as_deref(),
            refresh_token: config.youtube_en_refresh_token.as_deref(),
        },
        Locale::Ru => YoutubeCredentials {
            client_id: config.youtube_ru_client_id.as_deref(),
            client_secret: config.youtube_ru_client_secret.as_deref(),
            refresh_token: config.youtube_ru_refresh_token.as_deref(),
        },
    }
}

/// `youtubeAccessToken`: a fresh OAuth access token for the locale's account.
pub async fn youtube_access_token(
    client: &HttpClient,
    config: &Config,
    locale: Locale,
) -> Result<String, ExternalError> {
    let credentials = youtube_credentials(config, locale);
    let request = HttpRequest::post("https://oauth2.googleapis.com/token").form(&[
        ("client_id", credentials.client_id),
        ("client_secret", credentials.client_secret),
        ("refresh_token", credentials.refresh_token),
        ("grant_type", Some("refresh_token")),
    ]);
    let token = client.request_json(request).await?;
    // TypeScript read the field unchecked and sent `Bearer undefined` on.
    token
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ExternalError::message("YouTube token response carried no access_token"))
}
