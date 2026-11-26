//! The Zernio account directory Studio's channel service discovers
//! connections from (`listZernioAccounts` over the provider's API). Which
//! routes an account can serve is `domain`'s `zernio_connection_options`.

use crate::external::zernio::list_zernio_accounts;
use domain::studio::boundaries::{ZernioAccount, ZernioDirectory};
use foundation::config::Config;
use runtime::http::HttpClient;

pub struct ZernioAccounts {
    http: HttpClient,
}

impl ZernioAccounts {
    pub fn new(http: HttpClient) -> Self {
        Self { http }
    }
}

impl ZernioDirectory for ZernioAccounts {
    async fn accounts(&self, config: &Config) -> domain::Result<Vec<ZernioAccount>> {
        list_zernio_accounts(&self.http, config)
            .await
            .map_err(|error| domain::Error::message(error.to_string()))
    }
}
