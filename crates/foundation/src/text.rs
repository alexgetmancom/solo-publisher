/// Truncates text to at most `max_characters` Unicode code points.
///
/// The TypeScript version also repaired lone UTF-16 surrogates; a Rust `&str`
/// cannot hold one, so counting code points is the whole job.
pub fn truncate_unicode(value: &str, max_characters: usize) -> &str {
    match value.char_indices().nth(max_characters) {
        Some((end, _)) => &value[..end],
        None => value,
    }
}
