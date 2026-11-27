//! Where posts go and what is added to them:
//! channels (list, card, disable, connect), default platforms and the
//! YouTube signature.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use content::Locale;
use domain::channels::{list_channels, registered_post_target_ids};
use domain::studio::boundaries::{ConnectPlatform, MetaOauthPlatform};
use domain::studio::services::channels::{
    ChannelReport, ChannelStatus, ZernioConnectionOption, zernio_connection_options,
};
use domain::targets::{TARGETS, TargetDefinition, direct_connect_targets};
use foundation::i18n::{Key, t};
use foundation::markdown::escape_markdown;

use super::{
    CHANNEL_CONNECT_MENU, CHANNEL_DISABLE_MENU, CHANNEL_MENU, CHANNELS_MENU, DEFAULT_TARGETS_MENU, PUBLISHING_MENU,
    Range, SETTINGS_MENU, YOUTUBE_SIGNATURE_MENU, YOUTUBE_SIGNATURE_STEP, ask_input, back_to_settings, clear_input,
    menu, settings_screen, settings_update, switch_label,
};
use crate::api::payload::{Field, Payload};
use crate::context::Ctx;
use crate::effects::show_screen;
use crate::error_text::describe_error;
use crate::menu::{self, MenuButton, action};
use crate::registry::Registry;

thread_local! {
    /// The Zernio accounts the actor's last discovery found, with the language
    /// they were looked up for.
    static DISCOVERED_ACCOUNTS: RefCell<HashMap<i64, (Locale, Vec<ZernioConnectionOption>)>> =
        RefCell::new(HashMap::new());
    /// Which channel's card the operator is looking at. The list and the card
    /// are two screens over one collection, and menus carry no payload.
    static OPEN_CHANNEL: RefCell<HashMap<i64, String>> = RefCell::new(HashMap::new());
}

fn open_channel(actor_id: i64) -> Option<String> {
    OPEN_CHANNEL.with(|open| open.borrow().get(&actor_id).cloned())
}

fn close_channel(actor_id: i64) {
    OPEN_CHANNEL.with(|open| open.borrow_mut().remove(&actor_id));
}

fn forget_discovered(actor_id: i64) {
    DISCOVERED_ACCOUNTS.with(|discovered| discovered.borrow_mut().remove(&actor_id));
}

pub(super) fn register(registry: &mut Registry) {
    menu(registry, PUBLISHING_MENU, SETTINGS_MENU, publishing_layout);
    menu(registry, CHANNELS_MENU, PUBLISHING_MENU, channels_layout);
    menu(registry, CHANNEL_MENU, CHANNELS_MENU, channel_card_layout);
    menu(registry, CHANNEL_DISABLE_MENU, CHANNEL_MENU, channel_disable_layout);
    menu(registry, CHANNEL_CONNECT_MENU, CHANNELS_MENU, channel_connect_layout);
    menu(registry, DEFAULT_TARGETS_MENU, PUBLISHING_MENU, default_targets_layout);
    menu(
        registry,
        YOUTUBE_SIGNATURE_MENU,
        PUBLISHING_MENU,
        youtube_signature_layout,
    );
}

fn publishing_layout(ctx: &Ctx) -> crate::Result<Vec<Vec<MenuButton>>> {
    let mut range = Range::new()
        .submenu(
            t(Key::SettingsChannels, &[]),
            CHANNELS_MENU,
            settings_screen(channels_text, true),
        )
        .submenu(
            t(Key::SettingsDefaultTargets, &[]),
            DEFAULT_TARGETS_MENU,
            settings_screen(default_targets_text, false),
        )
        .row();
    if list_channels(ctx.db(), true)?
        .iter()
        .any(|channel| channel.connection.platform == "youtube")
    {
        range = range
            .submenu(
                t(Key::SettingsYoutubeSignature, &[]),
                YOUTUBE_SIGNATURE_MENU,
                settings_screen(youtube_signature_text, false),
            )
            .row();
    }
    range
        .back(t(Key::SettingsBackToSettings, &[]), back_to_settings())
        .done()
}

fn channel_report(ctx: &Ctx) -> crate::Result<Vec<ChannelReport>> {
    Ok(ctx.services().channels.report(true)?)
}

/// The channel list: one button per channel, two to a row, each carrying its
/// own state.
fn channels_layout(ctx: &Ctx) -> crate::Result<Vec<Vec<MenuButton>>> {
    let actor_id = ctx.actor_id();
    let report = channel_report(ctx)?;
    let mut range = Range::new();
    for (index, channel) in report.iter().enumerate() {
        let id = channel.id.clone();
        range = range.submenu(
            format!("{} {}", channel_glyph(channel.status), channel.label),
            CHANNEL_MENU,
            settings_screen(
                move |ctx| {
                    OPEN_CHANNEL.with(|open| open.borrow_mut().insert(actor_id, id.clone()));
                    channel_card_text(ctx, Some(&id))
                },
                false,
            ),
        );
        if index % 2 == 1 {
            range = range.row();
        }
    }
    if report.len() % 2 == 1 {
        range = range.row();
    }
    range
        .submenu(
            t(Key::SettingsChannelsConnect, &[]),
            CHANNEL_CONNECT_MENU,
            settings_screen(|_| Ok(connect_text(None, 0)), true),
        )
        .row()
        .back(
            t(Key::SettingsBackToPublishing, &[]),
            settings_update(
                move |_| {
                    close_channel(actor_id);
                    Ok(())
                },
                |_| Ok(t(Key::SettingsCategoryPublishingBody, &[])),
                None,
                true,
            ),
        )
        .done()
}

fn channel_card_layout(ctx: &Ctx) -> crate::Result<Vec<Vec<MenuButton>>> {
    let actor_id = ctx.actor_id();
    Range::new()
        .submenu(
            t(Key::SettingsDisableChannel, &[]),
            CHANNEL_DISABLE_MENU,
            settings_screen(
                move |ctx| disable_confirm_text(ctx, open_channel(actor_id).as_deref()),
                true,
            ),
        )
        .row()
        .back(
            t(Key::SettingsBackToChannels, &[]),
            settings_screen(channels_text, true),
        )
        .done()
}

/// Disabling takes a channel out of every future publication; it gets a
/// screen of its own, one tap away from nothing harmless.
fn channel_disable_layout(ctx: &Ctx) -> crate::Result<Vec<Vec<MenuButton>>> {
    let actor_id = ctx.actor_id();
    Range::new()
        // Two levels up, not one: the card it came from is about to describe a
        // channel that no longer exists.
        .text(
            t(Key::SettingsDisableChannelYes, &[]),
            action(move |ctx| {
                Box::pin(async move {
                    if let Some(channel_id) = open_channel(actor_id) {
                        ctx.services().channels.disable(&channel_id)?;
                    }
                    close_channel(actor_id);
                    ctx.answer_callback_query(Some(&t(Key::SettingsChannelDisabled, &[])), false)
                        .await?;
                    show_screen(ctx, &channels_text(ctx)?, Payload::new()).await?;
                    menu::nav(ctx, CHANNELS_MENU);
                    Ok(())
                })
            }),
        )
        .row()
        .back(
            t(Key::CommonCancel, &[]),
            settings_screen(
                move |ctx| channel_card_text(ctx, open_channel(actor_id).as_deref()),
                false,
            ),
        )
        .done()
}

fn channel_connect_layout(ctx: &Ctx) -> crate::Result<Vec<Vec<MenuButton>>> {
    let actor_id = ctx.actor_id();
    let channels = ctx.services().channels;
    let mut range = Range::new();
    let discovered = DISCOVERED_ACCOUNTS.with(|discovered| discovered.borrow().get(&actor_id).cloned());
    if let Some((locale, options)) = discovered {
        for option in options {
            let label = option.label.clone();
            range = range
                .text(
                    label,
                    action(move |ctx| {
                        let option = option.clone();
                        Box::pin(async move {
                            ctx.services()
                                .channels
                                .connect_zernio(&option.account_id, locale, option.key)
                                .await?;
                            forget_discovered(actor_id);
                            ctx.answer_callback_query(Some(&t(Key::SettingsChannelConnected, &[])), false)
                                .await?;
                            show_screen(ctx, &connect_text(None, 0), Payload::new()).await
                        })
                    }),
                )
                .row();
        }
    }
    for platform in [MetaOauthPlatform::Threads, MetaOauthPlatform::Instagram] {
        let ru = channels.native_connect_url(platform, Locale::Ru);
        let en = channels.native_connect_url(platform, Locale::En);
        let label = channel_platform_label(platform);
        let connected = ru.is_some() || en.is_some();
        if let Some(url) = ru {
            range = range.url(native_label(label, "RU"), url);
        }
        if let Some(url) = en {
            range = range.url(native_label(label, "EN"), url);
        }
        if connected {
            range = range.row();
        }
    }
    if let Some(url) = channels.x_connect_url() {
        range = range.url(native_label("X", "EN"), url).row();
    }
    for locale in [Locale::Ru, Locale::En] {
        range = range.text(
            native_label("YouTube", &locale.as_str().to_uppercase()),
            action(move |ctx| {
                Box::pin(async move {
                    match ctx.services().channels.start_connect(ConnectPlatform::Youtube, locale) {
                        Ok(started) => {
                            let text = t(
                                Key::SettingsConnectRedirect,
                                &[("url", &started.url), ("minutes", &started.expires_in_minutes)],
                            );
                            show_screen(ctx, &text, Payload::new()).await
                        }
                        Err(error) => {
                            let text = foundation::text::utf16_prefix_lossy(&describe_error(&error), 190);
                            ctx.answer_callback_query(Some(&text), true).await
                        }
                    }
                })
            }),
        );
    }
    range = range.row();
    let connected: HashSet<String> = channels
        .list(true)?
        .into_iter()
        .map(|channel| channel.connection.id)
        .collect();
    for target in direct_connect_targets()
        .into_iter()
        .filter(|target| !connected.contains(target.id))
    {
        let id = target.id;
        range = range
            .text(
                t(Key::SettingsEnableTarget, &[("target", &target.label)]),
                settings_update(
                    move |ctx| {
                        ctx.services().channels.connect_target(id, None, None, None, None)?;
                        Ok(())
                    },
                    |_| Ok(connect_text(None, 0)),
                    Some(t(Key::SettingsChannelConnected, &[])),
                    true,
                ),
            )
            .row();
    }
    if ctx.config.zernio_api_key.as_deref().is_some_and(|key| !key.is_empty()) {
        range = range
            .text("➕ Zernio · RU", discover_zernio(Locale::Ru))
            .text("➕ Zernio · EN", discover_zernio(Locale::En))
            .row();
    }
    range
        .back(
            t(Key::SettingsBackToChannels, &[]),
            settings_update(
                move |_| {
                    forget_discovered(actor_id);
                    Ok(())
                },
                channels_text,
                None,
                true,
            ),
        )
        .done()
}

/// Looks up the actor's Zernio accounts and offers the routes they can serve.
fn discover_zernio(locale: Locale) -> crate::menu::MenuAction {
    action(move |ctx| {
        Box::pin(async move {
            let found: crate::Result<()> = async {
                let accounts = ctx.services().channels.discover_zernio_accounts().await?;
                let options: Vec<ZernioConnectionOption> = accounts
                    .iter()
                    .flat_map(|account| zernio_connection_options(account, locale))
                    .collect();
                let count = options.len();
                let supported: HashSet<&str> = options.iter().map(|option| option.account_id.as_str()).collect();
                let hidden = accounts.len() - supported.len();
                DISCOVERED_ACCOUNTS.with(|discovered| {
                    discovered
                        .borrow_mut()
                        .insert(ctx.actor_id(), (locale, options.clone()))
                });
                ctx.answer_callback_query(Some(&t(Key::SettingsChannelsFound, &[("count", &count)])), false)
                    .await?;
                show_screen(ctx, &connect_text(Some(count), hidden), Payload::new()).await?;
                menu::update(ctx);
                Ok(())
            }
            .await;
            if found.is_err() {
                ctx.answer_callback_query(Some(&t(Key::SettingsChannelsError, &[])), true)
                    .await?;
            }
            Ok(())
        })
    })
}

fn default_targets_layout(ctx: &Ctx) -> crate::Result<Vec<Vec<MenuButton>>> {
    let selected = ctx.services().settings.default_targets()?;
    let rows = connected_targets(ctx)?;
    let mut range = Range::new();
    for (index, target) in rows.iter().enumerate() {
        let id = target.id;
        range = range.text(
            switch_label(selected.get(id), target.label),
            settings_update(
                move |ctx| {
                    ctx.services().settings.toggle_default_target(id)?;
                    Ok(())
                },
                default_targets_text,
                None,
                false,
            ),
        );
        if index % 2 == 1 {
            range = range.row();
        }
    }
    if rows.len() % 2 == 1 {
        range = range.row();
    }
    range
        .back(
            t(Key::SettingsBackToPublishing, &[]),
            settings_screen(|_| Ok(t(Key::SettingsCategoryPublishingBody, &[])), true),
        )
        .done()
}

fn youtube_signature_layout(_: &Ctx) -> crate::Result<Vec<Vec<MenuButton>>> {
    Range::new()
        .text(
            t(Key::SettingsEdit, &[]),
            ask_input(
                YOUTUBE_SIGNATURE_STEP,
                YOUTUBE_SIGNATURE_MENU,
                Key::SettingsYoutubeEditPrompt,
            ),
        )
        .text(
            t(Key::SettingsClear, &[]),
            settings_update(
                |ctx| Ok(ctx.services().settings.clear_youtube_signature()?),
                youtube_signature_text,
                Some(t(Key::SettingsCleared, &[])),
                false,
            ),
        )
        .row()
        .back(
            t(Key::SettingsBackToPublishing, &[]),
            settings_update(
                clear_input,
                |_| Ok(t(Key::SettingsCategoryPublishingBody, &[])),
                None,
                true,
            ),
        )
        .done()
}

/// `collectYoutubeSignature`: the typed signature, saved, and its screen again.
pub(super) async fn collect_youtube_signature(ctx: &Ctx, text: &str) -> crate::Result<()> {
    ctx.services().settings.set_youtube_signature(text)?;
    show_screen(ctx, &t(Key::SettingsYoutubeSaved, &[]), Payload::new()).await?;
    show_screen(
        ctx,
        &youtube_signature_text(ctx)?,
        Payload::new()
            .markdown()
            .reply_markup(Field::Menu(YOUTUBE_SIGNATURE_MENU)),
    )
    .await
}

fn native_label(platform: &str, locale: &str) -> String {
    t(
        Key::SettingsConnectNative,
        &[("platform", &platform), ("locale", &locale)],
    )
}

fn channel_platform_label(platform: MetaOauthPlatform) -> &'static str {
    match platform {
        MetaOauthPlatform::Threads => "Threads",
        MetaOauthPlatform::Instagram => "Instagram",
    }
}

fn channels_text(ctx: &Ctx) -> crate::Result<String> {
    let report = channel_report(ctx)?;
    let title = t(Key::SettingsChannelsTitle, &[]);
    if report.is_empty() {
        return Ok(format!("{title}\n\n{}", t(Key::SettingsChannelsNone, &[])));
    }
    Ok(format!(
        "{title}\n\n{}",
        t(Key::SettingsChannelsCount, &[("count", &report.len())])
    ))
}

/// One channel, in full.
fn channel_card_text(ctx: &Ctx, channel_id: Option<&str>) -> crate::Result<String> {
    let report = channel_report(ctx)?;
    let Some(channel) = report
        .iter()
        .find(|candidate| Some(candidate.id.as_str()) == channel_id)
    else {
        return Ok(format!(
            "{}\n\n{}",
            t(Key::SettingsChannelsTitle, &[]),
            t(Key::SettingsChannelsNone, &[])
        ));
    };
    let account = channel
        .provider_account_id
        .clone()
        .unwrap_or_else(|| t(Key::SettingsChannelAccountNone, &[]));
    Ok(t(
        Key::SettingsChannelCard,
        &[
            ("status", &channel_glyph(channel.status)),
            ("label", &escape_markdown(&channel.label)),
            ("provider", &escape_markdown(&channel.provider)),
            ("account", &escape_markdown(&account)),
            ("state", &escape_markdown(&channel_state(channel))),
        ],
    ))
}

fn disable_confirm_text(ctx: &Ctx, channel_id: Option<&str>) -> crate::Result<String> {
    let report = channel_report(ctx)?;
    let label = report
        .iter()
        .find(|candidate| Some(candidate.id.as_str()) == channel_id)
        .map_or("", |channel| channel.label.as_str());
    Ok(t(Key::SettingsDisableChannelConfirm, &[("target", &label)]))
}

fn connect_text(discovered: Option<usize>, hidden: usize) -> String {
    let suffix = discovered.map_or_else(String::new, |count| {
        format!("\n\n{}", t(Key::SettingsChannelsPick, &[("count", &count)]))
    });
    let hidden = if hidden > 0 {
        format!("\n{}", t(Key::SettingsChannelsUnsupported, &[("count", &hidden)]))
    } else {
        String::new()
    };
    format!("{}{suffix}{hidden}", t(Key::SettingsChannelsConnect, &[]))
}

/// A channel's state as one character, so the list reads down its left edge.
fn channel_glyph(status: ChannelStatus) -> &'static str {
    match status {
        ChannelStatus::Ready => "✅",
        ChannelStatus::Disabled => "⏸",
        ChannelStatus::Missing => "⚠️",
    }
}

fn channel_state(channel: &ChannelReport) -> String {
    let key = if channel.status == ChannelStatus::Ready {
        Key::SettingsChannelReady
    } else {
        Key::SettingsChannelMissing
    };
    t(key, &[("count", &channel.missing.len())])
}

fn connected_targets(ctx: &Ctx) -> crate::Result<Vec<&'static TargetDefinition>> {
    let registered = registered_post_target_ids(ctx.db())?;
    Ok(TARGETS
        .iter()
        .filter(|target| registered.iter().any(|id| id == target.id))
        .collect())
}

fn default_targets_text(ctx: &Ctx) -> crate::Result<String> {
    let selected = ctx.services().settings.default_targets()?;
    let active = connected_targets(ctx)?
        .into_iter()
        .filter(|target| selected.get(target.id))
        .map(|target| target.label)
        .collect::<Vec<_>>()
        .join(", ");
    let active = if active.is_empty() {
        t(Key::SettingsDefaultTargetsNone, &[])
    } else {
        active
    };
    Ok(format!(
        "{}\n\n{}: *{}*\n\n{}",
        t(Key::SettingsDefaultTargetsTitle, &[]),
        t(Key::SettingsDefaultTargetsActive, &[]),
        escape_markdown(&active),
        t(Key::SettingsDefaultTargetsHint, &[])
    ))
}

fn youtube_signature_text(ctx: &Ctx) -> crate::Result<String> {
    let signature = ctx.services().settings.youtube_signature()?;
    let signature = if signature.is_empty() {
        t(Key::SettingsYoutubeNotSet, &[])
    } else {
        escape_markdown(&signature)
    };
    Ok(t(Key::SettingsYoutubeBody, &[("signature", &signature)]))
}
