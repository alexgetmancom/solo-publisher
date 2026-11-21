/// Whether `value` parses as a WHATWG URL whose scheme is http or https.
pub fn is_http_url(value: &str) -> bool {
    ::url::Url::parse(value).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}
