//! The published self-host install: every assignment in `.env.example`, plus
//! what `compose.yaml` sets around it. Keys the template ships without a value
//! stay empty here on purpose — that is what Docker passes.

use std::path::Path;

use foundation::config::{Environment, load_config};

fn read(path: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(path);
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn is_key(key: &str) -> bool {
    key.starts_with(|c: char| c.is_ascii_uppercase())
        && key
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

fn install_environment(overrides: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();
    let mut set = |key: &str, value: &str| {
        env.retain(|(known, _)| known != key);
        env.push((key.to_owned(), value.to_owned()));
    };
    for line in read(".env.example").lines() {
        if let Some((key, value)) = line.trim().split_once('=')
            && is_key(key)
        {
            set(key, value);
        }
    }
    for line in read("compose.yaml").lines() {
        let Some(entry) = line.strip_prefix("      ").filter(|entry| !entry.starts_with(' ')) else {
            continue;
        };
        if let Some((key, value)) = entry.split_once(": ")
            && is_key(key)
            && !value.contains("${")
        {
            set(key, value.trim_matches('"'));
        }
    }
    set("PUBLIC_BASE_URL", "https://publisher.example.com");
    for (key, value) in overrides {
        set(key, value);
    }
    env
}

const SECRETS: [(&str, &str); 2] = [
    (
        "COMMAND_CENTER_TOKEN",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ),
    (
        "CLIENT_IP_HASH_SALT",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
];

#[test]
fn starts_with_nothing_configured_but_the_domain_and_the_two_secrets() {
    // An .env file states an unset key as `KEY=`; those empty strings must
    // read as absent, not as present-but-invalid values.
    let config = load_config(install_environment(&SECRETS)).unwrap();
    assert_eq!(config.node_env, Environment::Production);
    assert_eq!(config.public_base_url, "https://publisher.example.com");
    assert_eq!(
        config.command_center_url,
        "https://publisher.example.com/command-center"
    );
    assert_eq!(config.controller_bot_token, None);
    assert_eq!(config.mcp_studio_token, None);
    assert_eq!(config.telegram_channel_username, "");
}

#[test]
fn still_refuses_to_start_without_the_secrets_it_cannot_invent() {
    let error = load_config(install_environment(&[])).unwrap_err().to_string();
    assert!(error.contains("COMMAND_CENTER_TOKEN"), "{error}");
    let error = load_config(install_environment(&SECRETS[..1])).unwrap_err().to_string();
    assert!(error.contains("CLIENT_IP_HASH_SALT"), "{error}");
}

#[test]
fn names_no_channel_so_an_unconfigured_studio_cannot_publish_into_someone_elses() {
    // The default used to be a live channel.
    assert!(!read("crates/foundation/src/config.rs").contains("\"alexgetmancom\""));
}
