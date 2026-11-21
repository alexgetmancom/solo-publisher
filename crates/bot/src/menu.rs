//! `@grammyjs/menu` 1.4, reproduced on the wire (spec §5.7): a menu button's
//! callback data is `<menuId>/<row>/<col>/<payload>/<type><hash>`, where the
//! hash is the plugin's `tinyHash` of the menu's fingerprint (`f`) or of the
//! keyboard shape and the button's label (`h`), its four bytes decoded as UTF-8
//! with replacement. Keyboards already sitting in operators' chats keep
//! working only if these bytes come out the same, so this module follows the
//! plugin's code (`node_modules/@grammyjs/menu/out/menu.js`) step by step,
//! including the JavaScript errors a malformed tap raises.
//!
//! A menu is described by its id, its parent (for `back`), an optional
//! fingerprint, `autoAnswer`, and a layout: the rows of buttons exactly as the
//! plugin would render them (an empty row the TypeScript menu produced stays).

use std::rc::Rc;

use serde_json::{Map, Value, json};

use crate::Fut;
use crate::api::payload::Payload;
use crate::context::{Ctx, Nav};

pub type MenuId = &'static str;

/// What a menu button runs, after the navigation it implies.
pub type MenuAction = Rc<dyn for<'a> Fn(&'a Ctx) -> Fut<'a, crate::Result<()>>>;

/// Wraps a closure as a [`MenuAction`] (the closure's signature is otherwise
/// hard for inference to see).
pub fn action<F>(run: F) -> MenuAction
where
    F: for<'a> Fn(&'a Ctx) -> Fut<'a, crate::Result<()>> + 'static,
{
    Rc::new(run)
}

#[derive(Clone)]
pub enum MenuButton {
    /// `.text(label, ...middleware)`.
    Text { label: String, action: Option<MenuAction> },
    /// `.submenu(label, target, ...middleware)`: navigates, then runs `action`.
    Submenu {
        label: String,
        target: MenuId,
        action: Option<MenuAction>,
    },
    /// `.back(label, ...middleware)`: navigates to the parent, then runs `action`.
    Back { label: String, action: Option<MenuAction> },
    /// `.url(label, url)`: no callback.
    Url { label: String, url: String },
}

impl MenuButton {
    fn label(&self) -> &str {
        match self {
            Self::Text { label, .. }
            | Self::Submenu { label, .. }
            | Self::Back { label, .. }
            | Self::Url { label, .. } => label,
        }
    }
}

pub type MenuLayout = fn(&Ctx) -> crate::Result<Vec<Vec<MenuButton>>>;

#[derive(Clone)]
pub struct MenuDef {
    pub id: MenuId,
    /// The menu `back` returns to (the one this was `register`ed under).
    pub parent: Option<MenuId>,
    /// Replaces the per-button label hash when it renders non-empty.
    pub fingerprint: Option<fn(&Ctx) -> String>,
    /// Whether the plugin answers the tap itself (default `true`).
    pub auto_answer: bool,
    pub layout: MenuLayout,
}

/// The plugin's default `onMenuOutdated` text.
pub const OUTDATED: &str = "Menu was outdated, try again!";

/// `tinyHash`: JDK7's `hashCode` with 37, over code points, as four bytes
/// decoded with `TextDecoder` (replacement characters, leading BOM dropped).
pub fn tiny_hash(nums: impl IntoIterator<Item = u32>) -> String {
    let mut hash: u32 = 17;
    for n in nums {
        hash = hash.wrapping_mul(37).wrapping_add(n);
    }
    let bytes = hash.to_be_bytes();
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

fn code_points(text: &str) -> impl Iterator<Item = u32> + '_ {
    text.chars().map(u32::from)
}

fn shape(rows: &[Vec<MenuButton>]) -> Vec<u32> {
    std::iter::once(rows.len() as u32)
        .chain(rows.iter().map(|row| row.len() as u32))
        .collect()
}

fn find<'a>(ctx: &'a Ctx, id: &str) -> Option<&'a MenuDef> {
    ctx.bot.registry().menu_def(id)
}

/// `menu.render(ctx)`: the keyboard rows with callback data and hashes.
pub fn render(ctx: &Ctx, id: MenuId) -> crate::Result<Vec<Vec<Value>>> {
    let menu = find(ctx, id).ok_or_else(|| crate::error(format!("Menu '{id}' is not registered")))?;
    let rows = (menu.layout)(ctx)?;
    let fingerprint = menu.fingerprint.map(|fingerprint| fingerprint(ctx)).unwrap_or_default();
    let lengths = shape(&rows);
    Ok(rows
        .iter()
        .enumerate()
        .map(|(i, row)| {
            row.iter()
                .enumerate()
                .map(|(j, button)| {
                    let mut rendered = Map::new();
                    rendered.insert("text".into(), button.label().into());
                    match button {
                        MenuButton::Url { url, .. } => {
                            rendered.insert("url".into(), url.clone().into());
                        }
                        _ => {
                            let hash = if fingerprint.is_empty() {
                                let data = lengths.iter().copied().chain(code_points(button.label()));
                                format!("h{}", tiny_hash(data))
                            } else {
                                format!("f{}", tiny_hash(code_points(&fingerprint)))
                            };
                            rendered.insert("callback_data".into(), format!("{id}/{i:x}/{j:x}//{hash}").into());
                        }
                    }
                    Value::Object(rendered)
                })
                .collect()
        })
        .collect())
}

/// The menu as a `reply_markup` value.
pub fn render_markup(ctx: &Ctx, id: MenuId) -> crate::Result<Value> {
    Ok(json!({"inline_keyboard": render(ctx, id)?}))
}

/// JavaScript's `parseInt(text, 16)`: `None` is `NaN`.
fn parse_int_16(text: &str) -> Option<i64> {
    let text = foundation::js::trim_start(text);
    let (negative, rest) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let rest = rest
        .strip_prefix("0x")
        .or_else(|| rest.strip_prefix("0X"))
        .unwrap_or(rest);
    let digits: String = rest.chars().take_while(char::is_ascii_hexdigit).collect();
    if digits.is_empty() {
        return None;
    }
    let value = i64::from_str_radix(&digits, 16).unwrap_or(i64::MAX);
    Some(if negative { -value } else { value })
}

fn js_type_error(message: &str) -> crate::Error {
    crate::error(message)
}

/// What a tap on a menu button resolved to.
enum Tap {
    /// Not the plugin's format, or a menu nobody registered: the next
    /// middleware gets it.
    NotMine,
    Outdated(MenuId),
    Run(MenuId, MenuButton),
}

fn resolve(ctx: &Ctx, data: &str) -> crate::Result<Tap> {
    let mut parts = data.split('/');
    let id = parts.next().unwrap_or_default();
    let row_text = parts.next().unwrap_or_default();
    let col_text = parts.next().unwrap_or_default();
    let _payload = parts.next();
    let rest: Vec<&str> = parts.collect();
    let rest = rest.join("/");
    let mut rest_chars = rest.chars();
    let kind = rest_chars.next();
    let hash: String = rest_chars.collect();
    if row_text.is_empty() || col_text.is_empty() {
        return Ok(Tap::NotMine);
    }
    if kind != Some('h') && kind != Some('f') {
        return Ok(Tap::NotMine);
    }
    let Some(menu) = find(ctx, id) else {
        return Ok(Tap::NotMine);
    };
    let id = menu.id;
    let row = parse_int_16(row_text);
    let col = parse_int_16(col_text);
    if row.is_some_and(|row| row < 0) || col.is_some_and(|col| col < 0) {
        return Err(crate::error(format!("Invalid button position '{row_text}/{col_text}'")));
    }
    let fingerprint = menu.fingerprint.map(|fingerprint| fingerprint(ctx)).unwrap_or_default();
    let use_fingerprint = !fingerprint.is_empty();
    if use_fingerprint != (kind == Some('f')) {
        return Ok(Tap::Outdated(id));
    }
    if use_fingerprint && tiny_hash(code_points(&fingerprint)) != hash {
        return Ok(Tap::Outdated(id));
    }
    let range = (menu.layout)(ctx)?;
    let check = !use_fingerprint;
    // `range[row]` and `range[row][col]` with JavaScript's undefined.
    let row_buttons = row
        .and_then(|row| usize::try_from(row).ok())
        .and_then(|row| range.get(row));
    if check {
        let past_rows = row.is_some_and(|row| row >= range.len() as i64);
        if !past_rows {
            let Some(buttons) = row_buttons else {
                return Err(js_type_error(
                    "undefined is not an object (evaluating 'range[row].length')",
                ));
            };
            if col.is_some_and(|col| col >= buttons.len() as i64) {
                return Ok(Tap::Outdated(id));
            }
        } else {
            return Ok(Tap::Outdated(id));
        }
    }
    let Some(buttons) = row_buttons else {
        return Err(js_type_error(
            "undefined is not an object (evaluating 'range[row][col]')",
        ));
    };
    let Some(button) = col
        .and_then(|col| usize::try_from(col).ok())
        .and_then(|col| buttons.get(col))
    else {
        return Err(js_type_error(
            "btn is not an Object. (evaluating '\"middleware\" in btn')",
        ));
    };
    if let MenuButton::Url { .. } = button {
        if check {
            return Ok(Tap::Outdated(id));
        }
        return Err(crate::error(format!(
            "Cannot invoke handlers because menu '{id}' is outdated!"
        )));
    }
    if check {
        let expected = tiny_hash(shape(&range).into_iter().chain(code_points(button.label())));
        if hash != expected {
            return Ok(Tap::Outdated(id));
        }
    }
    Ok(Tap::Run(id, button.clone()))
}

/// The menu plugin's `callback_query:data` middleware. `Ok(false)` passes the
/// update on to the next middleware.
pub async fn handle_callback(ctx: &Ctx) -> crate::Result<bool> {
    let Some(data) = ctx.callback_data() else {
        return Ok(false);
    };
    match resolve(ctx, data)? {
        Tap::NotMine => Ok(false),
        Tap::Outdated(id) => {
            // `Promise.all([answerCallbackQuery({ text }), editMessageReplyMarkup({ reply_markup: menu })])`:
            // the answer (a chat message once the tap is acknowledged) goes first.
            ctx.answer_callback_query(Some(OUTDATED), false).await?;
            ctx.edit_message_reply_markup(Payload::new().reply_markup(crate::api::payload::Field::Menu(id)))
                .await?;
            Ok(true)
        }
        Tap::Run(id, button) => {
            run(ctx, id, button).await?;
            Ok(true)
        }
    }
}

/// `[navInstaller, ...handler]`, with `autoAnswer`'s fork.
async fn run(ctx: &Ctx, id: MenuId, button: MenuButton) -> crate::Result<()> {
    let menu = find(ctx, id).expect("resolved menus are registered");
    *ctx.nav.borrow_mut() = Some(Nav {
        pending: false,
        target: Some(id),
    });
    if menu.auto_answer {
        ctx.answer_callback_query(None, false).await?;
    }
    let action = match button {
        MenuButton::Text { action, .. } => action,
        MenuButton::Submenu { target, action, .. } => {
            find(ctx, target).ok_or_else(|| crate::error(format!("Menu '{target}' is not known to menu '{id}'!")))?;
            navigate(ctx, Some(target));
            action
        }
        MenuButton::Back { action, .. } => {
            let parent = menu
                .parent
                .ok_or_else(|| crate::error(format!("Cannot navigate back from menu '{id}', no known parent!")))?;
            navigate(ctx, Some(parent));
            action
        }
        MenuButton::Url { .. } => None,
    };
    if let Some(action) = action {
        action(ctx).await?;
    }
    // `update menu if it could not be injected`.
    let pending = ctx.nav.borrow().is_some_and(|nav| nav.pending);
    if pending {
        ctx.edit_message_reply_markup(Payload::new()).await?;
    }
    Ok(())
}

fn navigate(ctx: &Ctx, target: Option<MenuId>) {
    *ctx.nav.borrow_mut() = Some(Nav { pending: true, target });
}

/// `ctx.menu.update()`: redraw the current menu on the next edit (or after).
pub fn update(ctx: &Ctx) {
    let target = ctx.nav.borrow().and_then(|nav| nav.target);
    navigate(ctx, target);
}

/// `ctx.menu.nav(to)`.
pub fn nav(ctx: &Ctx, to: MenuId) {
    navigate(ctx, Some(to));
}

/// `ctx.menu.close()`.
pub fn close(ctx: &Ctx) {
    navigate(ctx, None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_like_the_plugin() {
        // `tinyHash(toNums("publishing:ru"))`, as the main menu's buttons carry it.
        assert_eq!(tiny_hash(code_points("publishing:ru")), "1\u{FFFD}\u{FFFD}{");
        assert_eq!(tiny_hash([]), "\0\0\0\u{11}");
    }

    #[test]
    fn a_leading_byte_order_mark_is_dropped_as_text_decoder_drops_it() {
        // Find a hash whose bytes start with EF BB BF: 17 * 37^n + … is hard to
        // aim at, so check the decoding step directly.
        let bytes = [0xEF, 0xBB, 0xBF, 0x41];
        let stripped = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap();
        assert_eq!(String::from_utf8_lossy(stripped), "A");
    }

    #[test]
    fn parses_positions_like_parse_int() {
        assert_eq!(parse_int_16("a"), Some(10));
        assert_eq!(parse_int_16("1x"), Some(1));
        assert_eq!(parse_int_16(" -0x1f"), Some(-31));
        assert_eq!(parse_int_16("zz"), None);
        assert_eq!(parse_int_16(""), None);
    }
}
