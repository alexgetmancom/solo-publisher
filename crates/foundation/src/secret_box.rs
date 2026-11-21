//! Encryption for credentials this Studio renews on its own.
//!
//! A renewed platform token cannot live in .env (mounted read-only, owned by
//! the host), so it is kept in the database — which leaves the machine every
//! day as a backup. What is stored is a sealed value; the key stays in .env.
//!
//! AES-256-GCM, stored as `base64(iv).base64(tag).base64(ciphertext)`: the tag
//! makes a tampered or truncated value fail loudly instead of decrypting into
//! something that looks like a token. Byte-compatible with the TypeScript
//! `secret-box.ts` in both directions.

use std::fmt;

use aes_gcm::aead::{AeadInPlace, KeyInit, OsRng, rand_core::RngCore};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use base64::Engine as _;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::{DecodePaddingMode, general_purpose::STANDARD};
use sha2::{Digest, Sha256};

use crate::js;

/// Node's decoder accepts values with or without padding and ignores trailing bits.
const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SecretBoxError(&'static str);

impl fmt::Display for SecretBoxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for SecretBoxError {}

const BAD_KEY: SecretBoxError =
    SecretBoxError("TOKEN_ENCRYPTION_KEY must be 32 bytes of hex — generate one with: openssl rand -hex 32");
const BAD_FORMAT: SecretBoxError = SecretBoxError("stored secret is not in the expected format");
/// The message Node and Bun give for a failed GCM authentication.
const UNAUTHENTIC: SecretBoxError = SecretBoxError("Unsupported state or unable to authenticate data");

#[derive(Clone)]
pub struct SecretKey([u8; 32]);

impl fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretKey(..)")
    }
}

impl SecretKey {
    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Reads TOKEN_ENCRYPTION_KEY. Absent or empty means this Studio does not
/// renew tokens. Hex is decoded as Node's `Buffer.from(value, "hex")` does:
/// pairs up to the first invalid one, so trailing junk after 64 digits is ignored.
pub fn encryption_key(raw: Option<&str>) -> Result<Option<SecretKey>, SecretBoxError> {
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
        return Ok(None);
    };
    let digits = js::trim(raw).as_bytes();
    let mut key = Vec::with_capacity(32);
    for pair in digits.as_chunks::<2>().0 {
        match (hex_digit(pair[0]), hex_digit(pair[1])) {
            (Some(high), Some(low)) => key.push(high << 4 | low),
            _ => break,
        }
    }
    key.try_into().map(|key| Some(SecretKey(key))).map_err(|_| BAD_KEY)
}

fn hex_digit(byte: u8) -> Option<u8> {
    char::from(byte).to_digit(16).map(|digit| digit as u8)
}

pub fn seal(value: &str, key: &SecretKey) -> String {
    let mut iv = [0u8; 12];
    OsRng.fill_bytes(&mut iv);
    let mut body = value.as_bytes().to_vec();
    let tag = Aes256Gcm::new(&key.0.into())
        .encrypt_in_place_detached(Nonce::from_slice(&iv), b"", &mut body)
        .expect("AES-GCM encrypts any value shorter than 64 GiB");
    [STANDARD.encode(iv), STANDARD.encode(tag), STANDARD.encode(body)].join(".")
}

pub fn open(sealed: &str, key: &SecretKey) -> Result<String, SecretBoxError> {
    let mut parts = sealed.split('.');
    let (Some(iv), Some(tag), Some(body)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(BAD_FORMAT);
    };
    if iv.is_empty() || tag.is_empty() || body.is_empty() {
        return Err(BAD_FORMAT);
    }
    let decode = |part: &str| LENIENT.decode(part).map_err(|_| UNAUTHENTIC);
    let (iv, tag, mut body) = (decode(iv)?, decode(tag)?, decode(body)?);
    if iv.len() != 12 || tag.len() != 16 {
        return Err(UNAUTHENTIC);
    }
    Aes256Gcm::new(&key.0.into())
        .decrypt_in_place_detached(Nonce::from_slice(&iv), b"", &mut body, Tag::from_slice(&tag))
        .map_err(|_| UNAUTHENTIC)?;
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// Identifies the .env value a stored token grew from, without keeping it:
/// the first 32 hex digits of its SHA-256.
pub fn fingerprint(value: &str) -> String {
    Sha256::digest(value.as_bytes())[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
