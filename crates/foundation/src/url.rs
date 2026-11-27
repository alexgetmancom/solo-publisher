use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

/// Whether `value` parses as a WHATWG URL whose scheme is http or https.
pub fn is_http_url(value: &str) -> bool {
    ::url::Url::parse(value).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

/// What `encodeURIComponent` leaves as it is: ASCII letters, digits and `-_.!~*'()`.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// A path or query component percent-encoded, as `encodeURIComponent` does.
pub fn encode_uri_component(value: &str) -> String {
    utf8_percent_encode(value, URI_COMPONENT).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_component_keeps_what_javascript_keeps() {
        assert_eq!(encode_uri_component("a b+c/é!~*'()"), "a%20b%2Bc%2F%C3%A9!~*'()");
    }
}
