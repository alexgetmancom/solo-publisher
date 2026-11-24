//! `cargo xtask family-routes < adapted.json`: the host proxy's configuration,
//! as `caddy adapt` builds it from `deploy/caddy/Caddyfile`, still sends the
//! Family phone's presence POSTs to the authenticated intake on VM-106 rather
//! than to the website, and does so before any of the site's proxy routes. CI's
//! repository analysis pipes the adapted configuration in.

use std::io::Read as _;

use serde_json::Value;

const PATHS: [&str; 2] = ["/presence/point", "/presence/place"];
const INTAKE: &str = "192.168.10.106:8787";

pub fn main(argv: Vec<String>) -> u8 {
    if !argv.is_empty() {
        eprintln!("usage: caddy adapt … | cargo xtask family-routes");
        return 1;
    }
    let mut input = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut input) {
        eprintln!("cannot read the adapted configuration: {error}");
        return 1;
    }
    let checked = serde_json::from_str(&input)
        .map_err(|error| format!("the adapted configuration is not JSON: {error}"))
        .and_then(|config| check(&config));
    match checked {
        Ok(()) => {
            println!("Family phone routes reach the authenticated VM106 intake before the website.");
            0
        }
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}

fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value.get(key).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn strings<'a>(value: &'a Value, key: &str) -> Option<Vec<&'a str>> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
}

/// A route's handlers, and those of every subroute inside them.
fn handlers(route: &Value) -> Vec<&Value> {
    list(route, "handle")
        .iter()
        .flat_map(|handler| std::iter::once(handler).chain(list(handler, "routes").iter().flat_map(handlers)))
        .collect()
}

fn is_proxy(handler: &&Value) -> bool {
    handler.get("handler").and_then(Value::as_str) == Some("reverse_proxy")
}

pub fn check(config: &Value) -> Result<(), String> {
    let servers = config["apps"]["http"]["servers"].as_object();
    let routes: Vec<&Value> = servers
        .into_iter()
        .flat_map(|servers| servers.values())
        .flat_map(|server| list(server, "routes"))
        .collect();
    let site = routes
        .iter()
        .find(|route| {
            list(route, "match")
                .iter()
                .any(|matcher| strings(matcher, "host").is_some_and(|hosts| hosts.contains(&"alexgetman.com")))
        })
        .ok_or("Family: alexgetman.com host route is missing")?;
    let site_routes: Vec<&Value> = list(site, "handle")
        .iter()
        .flat_map(|handler| list(handler, "routes"))
        .collect();
    let first_proxy = site_routes
        .iter()
        .position(|candidate| handlers(candidate).iter().any(is_proxy));
    for path in PATHS {
        let route = site_routes
            .iter()
            .position(|candidate| {
                list(candidate, "match").iter().any(|matcher| {
                    strings(matcher, "path").is_some_and(|paths| paths.contains(&path))
                        && strings(matcher, "method").is_none_or(|methods| methods.contains(&"POST"))
                })
            })
            .ok_or_else(|| format!("Family: POST {path} route is missing"))?;
        if first_proxy != Some(route) {
            return Err(format!("Family: {path} must precede the site's proxy routes"));
        }
        let proxies: Vec<&Value> = handlers(site_routes[route]).into_iter().filter(is_proxy).collect();
        let upstreams = proxies.first().map_or(&[][..], |proxy| list(proxy, "upstreams"));
        if proxies.len() != 1 || upstreams.len() != 1 || upstreams[0]["dial"].as_str() != Some(INTAKE) {
            return Err(format!("Family: {path} must reach the VM106 intake, not the website"));
        }
        let headers = &proxies[0]["headers"]["request"];
        let deleted = strings(headers, "delete")
            .unwrap_or_default()
            .into_iter()
            .any(|name| name == "*" || name.eq_ignore_ascii_case("x-family-token"));
        let overwritten = headers["set"]
            .as_object()
            .is_some_and(|set| set.keys().any(|name| name.eq_ignore_ascii_case("x-family-token")));
        if deleted || overwritten {
            return Err(format!("Family: {path} must preserve the phone's authentication token"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::check;

    fn proxy(dial: &str) -> Value {
        json!({
            "handler": "reverse_proxy",
            "upstreams": [{"dial": dial}],
            "headers": {"request": {"set": {"X-Real-Ip": ["{http.request.remote.host}"]}, "delete": []}},
        })
    }

    /// The adapted site: middleware, the phone's intake, then the website.
    fn site_routes() -> Vec<Value> {
        vec![
            json!({"handle": [{"handler": "encode"}]}),
            json!({
                "match": [{"path": ["/presence/place", "/presence/point"]}],
                "handle": [{"handler": "subroute", "routes": [{"handle": [proxy("192.168.10.106:8787")]}]}],
            }),
            json!({"handle": [proxy("127.0.0.1:8792")]}),
        ]
    }

    fn configuration(routes: Vec<Value>) -> Value {
        json!({"apps": {"http": {"servers": {"srv0": {"routes": [{
            "match": [{"host": ["alexgetman.com"]}],
            "handle": [{"handler": "subroute", "routes": routes}],
        }]}}}}})
    }

    fn intake(routes: &mut [Value]) -> &mut Value {
        &mut routes[1]["handle"][0]["routes"][0]["handle"][0]
    }

    #[test]
    fn the_phone_intake_passes_alongside_normal_site_middleware() {
        assert_eq!(check(&configuration(site_routes())), Ok(()));
    }

    #[test]
    fn losing_the_phone_route_is_refused() {
        let mut routes = site_routes();
        routes.remove(1);
        assert!(check(&configuration(routes)).unwrap_err().contains("route is missing"));
    }

    #[test]
    fn phone_posts_routed_to_the_website_are_refused() {
        let mut routes = site_routes();
        intake(&mut routes)["upstreams"][0]["dial"] = json!("127.0.0.1:8792");
        assert!(check(&configuration(routes)).unwrap_err().contains("not the website"));
    }

    #[test]
    fn a_website_fallback_shadowing_the_phone_route_is_refused() {
        let mut routes = site_routes();
        routes.reverse();
        assert!(check(&configuration(routes)).unwrap_err().contains("must precede"));
    }

    #[test]
    fn dropping_the_phones_authentication_header_is_refused() {
        let mut routes = site_routes();
        intake(&mut routes)["headers"]["request"]["delete"] = json!(["X-Family-Token"]);
        assert!(
            check(&configuration(routes))
                .unwrap_err()
                .contains("authentication token")
        );
    }
}
