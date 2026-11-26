/// Truncates text to at most `max_characters` Unicode code points.
///
/// There is no lone UTF-16 surrogate to repair: a Rust `&str` cannot hold one,
/// so counting code points is the whole job.
pub fn truncate_unicode(value: &str, max_characters: usize) -> &str {
    match value.char_indices().nth(max_characters) {
        Some((end, _)) => &value[..end],
        None => value,
    }
}
