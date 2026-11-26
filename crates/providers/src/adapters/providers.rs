//! The provider calls Studio waits on through the bot's `Adapters`
//! (`domain`'s `VideoProvider`, `YoutubeUploads`; the Zernio directory is
//! `providers::channels::zernio`): the
//! same functions the delivery adapters use, over the live configuration.

use std::rc::Rc;
use std::sync::Arc;

use content::Locale;
use domain::application::ports::SystemClock;
use domain::publishing::boundaries::{ProviderOutcome, VideoProvider};
use domain::studio::boundaries::YoutubeUploads;
use foundation::config::{Config, SharedConfig};
use runtime::http::HttpClient;
use serde_json::Value;

use crate::adapters::error::AdapterError;
use crate::adapters::ports::AdapterContext;
use crate::adapters::video_publishers::keep_youtube_upload_private;
use crate::adapters::zernio::{ZernioPlatform, publish_zernio_instagram_reel, zernio_post_outcome};

pub struct ProviderCalls {
    client: HttpClient,
    config: SharedConfig,
}

impl ProviderCalls {
    pub fn new(client: HttpClient, config: SharedConfig) -> Self {
        Self { client, config }
    }

    fn context(&self, config: Arc<Config>) -> AdapterContext {
        AdapterContext {
            config,
            client: self.client.clone(),
            clock: Rc::new(SystemClock),
        }
    }
}

fn refused(error: AdapterError) -> domain::Error {
    domain::Error::message(error.message().to_owned())
}

impl VideoProvider for ProviderCalls {
    async fn post_outcome(&self, provider_post_id: &str, platform: &str) -> domain::Result<ProviderOutcome> {
        let platform = ZernioPlatform::parse(platform)
            .ok_or_else(|| domain::Error::message(format!("Zernio does not publish to {platform}")))?;
        let outcome = zernio_post_outcome(&self.context(self.config.load()), provider_post_id, platform)
            .await
            .map_err(refused)?;
        Ok(ProviderOutcome {
            provider_post_id: Some(outcome.publication.provider_post_id),
            external_id: outcome.publication.external_id,
            url: outcome.publication.url,
            failure: outcome.failure,
        })
    }

    async fn publish_instagram_reel(
        &self,
        account_id: &str,
        public_url: &str,
        metadata: &Value,
        request_id: &str,
    ) -> domain::Result<ProviderOutcome> {
        let caption = metadata
            .get("caption")
            .and_then(Value::as_str)
            .ok_or_else(|| domain::Error::message("Instagram metadata has no caption"))?;
        let published = publish_zernio_instagram_reel(
            &self.context(self.config.load()),
            account_id,
            public_url,
            caption,
            request_id,
        )
        .await
        .map_err(refused)?;
        Ok(ProviderOutcome {
            provider_post_id: Some(published.provider_post_id),
            external_id: published.external_id,
            url: published.url,
            failure: None,
        })
    }
}

impl YoutubeUploads for ProviderCalls {
    async fn keep_private(&self, config: &Config, video_id: &str, locale: Locale) -> domain::Result<()> {
        keep_youtube_upload_private(&self.context(Arc::new(config.clone())), video_id, locale)
            .await
            .map_err(refused)
    }
}
