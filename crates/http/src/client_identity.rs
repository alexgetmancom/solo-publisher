//! A privacy-preserving visitor identity from the trusted proxy header
//! (`foundation/client-identity.ts`).

use axum::http::HeaderMap;
use foundation::config::Config;
use hmac::{Hmac, Mac as _};
use sha2::Sha256;

use crate::headers::header;

/// HMAC-SHA256 of the address in the configured header, keyed by the salt.
/// The header is configured, never guessed: honouring any `X-Forwarded-For` a
/// client sends would let anyone mint a fresh identity per request. A request
/// the proxy did not label shares one bucket, which keeps the public rate
/// limit conservative.
pub fn client_ip_hash(headers: &HeaderMap, config: &Config) -> String {
    let value = header(headers, config.trusted_client_ip_header.as_str()).unwrap_or_default();
    let address = match foundation::js::trim(&value) {
        "" => "unknown",
        address => address,
    };
    let mut mac = Hmac::<Sha256>::new_from_slice(config.client_ip_hash_salt.as_bytes()).expect("HMAC takes any key");
    mac.update(address.as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
