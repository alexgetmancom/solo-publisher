/// Escapes text for Telegram's legacy `Markdown` parse mode, the one markup
/// flavour this application sends. Its special characters are `\ _ * [ ] ``;
/// escaping the MarkdownV2 set instead would render literal backslashes in front
/// of dots, hyphens and parentheses.
pub fn escape_markdown(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\\' | '_' | '*' | '[' | ']' | '`') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}
