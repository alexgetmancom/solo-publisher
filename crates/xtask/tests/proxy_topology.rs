//! What the committed host proxy and compose files promise every Studio,
//! asserted on the files themselves.

use std::path::Path;

fn read(path: &str) -> String {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    std::fs::read_to_string(root.join(path)).unwrap_or_else(|error| panic!("{path}: {error}"))
}

#[test]
fn every_studio_is_handed_the_visitors_own_address() {
    // Both Studios attribute and rate-limit by client address and read the
    // header named by TRUSTED_CLIENT_IP_HEADER. A proxy that forwards without
    // it collapses the whole internet onto one visitor identity, which turns
    // the public rate limit into a single global budget.
    let caddy = read("deploy/caddy/Caddyfile");
    let studio = read("deploy/studio.compose.yaml");
    assert!(caddy.contains("header_up X-Real-IP {remote_host}"));
    assert!(studio.contains("TRUSTED_CLIENT_IP_HEADER: x-real-ip"));
    // Every site block must import it, or one of them silently loses the address.
    assert_eq!(
        caddy.matches("import client_address").count(),
        caddy.matches("reverse_proxy ").count()
    );
}

#[test]
fn a_studio_without_a_site_is_an_allowlist_not_a_site() {
    // A Studio operated from another machine over MCP serves no public site.
    // The default is 404, so a route that is not named does not exist.
    let caddy = read("deploy/caddy/Caddyfile");
    for route in [
        "/api/mcp",
        "/api/studio/media",
        "/media/video/asset/*",
        "/media/staging/*",
        "/oauth/*",
        "respond 404",
    ] {
        assert!(caddy.contains(route), "{route}");
    }
}

#[test]
fn one_file_describes_every_studio_and_names_none_of_them() {
    // Two committed descriptions of one service is how they drifted: the
    // second one silently lost settings the first had. Every difference is a
    // value in the host's own .env, so there is nothing left to keep in sync.
    let studio = read("deploy/studio.compose.yaml");
    assert!(!studio.contains("alexgetman"));
    assert!(!studio.contains("maru"));
    // The identity, address and port a deployment answers on have no defaults.
    // A default would let a lost host env file publish media under another
    // Studio's domain, and the request that reveals it comes from Meta.
    assert!(studio.contains("${STUDIO:?"));
    assert!(studio.contains("PUBLIC_BASE_URL: ${STUDIO_PUBLIC_BASE_URL:?"));
    assert!(studio.contains("${STUDIO_PORT:?"));
    // Backups leave as streams a backup host pulls; a Studio that wrote them
    // to a directory of its own would keep them where it loses them.
    assert!(!studio.contains("/backups"));
}

#[test]
fn the_retired_dashboard_stays_outside_the_second_studios_allowlist() {
    let caddy = read("deploy/caddy/Caddyfile");
    let allowed: Vec<&str> = caddy
        .split_once("@allowed path ")
        .and_then(|(_, rest)| rest.lines().next())
        .unwrap_or_default()
        .split(' ')
        .collect();
    for retired in ["/command-center", "/command-center/*", "/api/command-center/*"] {
        assert!(!allowed.contains(&retired), "{retired}");
    }
    for kept in ["/oauth/*", "/api/mcp", "/api/studio/media"] {
        assert!(allowed.contains(&kept), "{kept}");
    }
}

#[test]
fn the_proxy_holds_nothing_the_application_decides() {
    // Cache lifetimes, retired URLs, the Markdown twin, the Link header and the
    // noindex on the first Studio's operator surfaces ship in the image.
    // Restating any of them here creates a second place to change them, and
    // the two drift apart silently.
    let caddy = read("deploy/caddy/Caddyfile");
    for leaked in ["Cache-Control", "try_files", "root ", "text/markdown", "rel=", "410"] {
        assert!(!caddy.contains(leaked), "{leaked}");
    }
}
