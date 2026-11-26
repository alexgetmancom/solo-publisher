//! The daily database copy sent to the operators' own Telegram.
//! The database is the part that
//! cannot be recreated; media is far past what Telegram accepts and belongs
//! to a volume backup. The copy is SQLite's own `VACUUM INTO`, never a file
//! copy: a live database has a write-ahead log beside it.

use std::path::Path;

use domain::observability::sync_state::{claim_sync, mark_synced};
use foundation::i18n::{Key, t};
use foundation::logger::{LogLevel, log};
use foundation::time::{Zone, format_zoned_clock, zoned_calendar_day};
use serde_json::json;

use crate::api::FileSource;
use crate::api::payload::{InputFile, Payload};
use crate::bot::Bot;
use crate::context::Ctx;
use crate::effects::error_js_string;

/// Hour of this Studio's day at which the copy is sent: late enough that the
/// day's publications are in it.
const BACKUP_HOUR: u32 = 4;
const OWNER: &str = "telegram:daily-backup";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackupDeliveryStatus {
    NotDue,
    Disabled,
    NoAdmins,
    Sent,
    Failed,
}

impl BackupDeliveryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotDue => "not_due",
            Self::Disabled => "disabled",
            Self::NoAdmins => "no_admins",
            Self::Sent => "sent",
            Self::Failed => "failed",
        }
    }
}

/// `sendDailyBackup`: one tick of the daily-backup loop.
pub async fn send_daily_backup(bot: &Bot) -> crate::Result<BackupDeliveryStatus> {
    let ctx = Ctx::worker(bot);
    let now = ctx.now();
    let timezone = ctx.ports().studio_settings().profile()?.timezone;
    let zone = Zone::parse(&timezone).ok_or_else(|| crate::error(format!("Invalid time zone specified: {timezone}")))?;
    let hour: u32 = format_zoned_clock(now, &zone)[..2].parse()?;
    if hour < BACKUP_HOUR {
        return Ok(BackupDeliveryStatus::NotDue);
    }
    if !ctx.services().settings.backup()?.enabled {
        return Ok(BackupDeliveryStatus::Disabled);
    }
    let admins = &ctx.config.controller_admin_ids;
    if admins.is_empty() {
        return Ok(BackupDeliveryStatus::NoAdmins);
    }
    let day = zoned_calendar_day(now, &zone);
    let source = format!("daily_backup:{day}");
    if !claim_sync(ctx.db(), ctx.clock(), &source, 24 * 60 * 60, OWNER)? {
        return Ok(BackupDeliveryStatus::NotDue);
    }
    // Settled before the snapshot: a failure must not retry on the next tick
    // and write a fresh copy of a multi-megabyte database every few seconds.
    mark_synced(ctx.db(), ctx.clock(), &source, None, OWNER)?;

    let directory = temporary_directory()?;
    let result = send_copy(&ctx, &directory, &day).await;
    let _ = std::fs::remove_dir_all(&directory);
    match result {
        Ok(()) => Ok(BackupDeliveryStatus::Sent),
        Err(error) => {
            let error = error_js_string(&*error);
            log(LogLevel::Warn, "daily backup not delivered", Some(json!({"error": error})));
            // The day is already claimed, so nothing retries this until
            // tomorrow; an operator who is never told cannot know.
            let text = t(
                Key::SettingsBackupFailedNotice,
                &[("error", &foundation::js::slice_utf16(&error, 1_000))],
            );
            for &actor_id in admins {
                if let Err(notify_error) = ctx.bot.api().send_message(actor_id, &text, Payload::new()).await {
                    log(
                        LogLevel::Warn,
                        "backup failure notice was not delivered",
                        Some(json!({"actorId": actor_id, "error": notify_error.js_string()})),
                    );
                }
            }
            Ok(BackupDeliveryStatus::Failed)
        }
    }
}

/// `fs.mkdtempSync(path.join(os.tmpdir(), "solo-publisher-backup-"))`.
fn temporary_directory() -> crate::Result<std::path::PathBuf> {
    let mut suffix = [0u8; 6];
    getrandom::getrandom(&mut suffix).map_err(|error| crate::error(error.to_string()))?;
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let suffix: String = suffix
        .iter()
        .map(|byte| ALPHABET[usize::from(*byte) % ALPHABET.len()] as char)
        .collect();
    let directory = std::env::temp_dir().join(format!("solo-publisher-backup-{suffix}"));
    std::fs::create_dir(&directory)?;
    Ok(directory)
}

/// `backupDatabase(backendDb, PIPELINE_DB, directory)` and the document to
/// every administrator. Silent: it arrives every day and is worth having,
/// not worth waking up for.
async fn send_copy(ctx: &Ctx, directory: &Path, day: &str) -> crate::Result<()> {
    let source = &ctx.config.pipeline_db;
    if source.as_os_str() == ":memory:" {
        return Err(crate::error("cannot back up an in-memory database"));
    }
    let stem = source.file_stem().map(|stem| stem.to_string_lossy()).unwrap_or_default();
    let stamp = foundation::time::to_iso_string(ctx.now()).replace(['-', ':'], "");
    let stamp = stamp.split_once('.').map_or(stamp.clone(), |(whole, _)| format!("{whole}Z"));
    let file = directory.join(format!("{stem}-{stamp}.db"));
    ctx.bot.deps().db.backup(&file.display().to_string())?;
    let caption = format!("🗄 {day} · {} MB", megabytes(std::fs::metadata(&file)?.len()));
    for &actor_id in &ctx.config.controller_admin_ids {
        ctx.bot
            .api()
            .send_file(
                "sendDocument",
                actor_id,
                "document",
                FileSource::Upload(InputFile::path(&file)),
                Payload::new().set("caption", caption.as_str()).set("disable_notification", true),
            )
            .await?;
    }
    Ok(())
}

/// `(bytes / 1_000_000).toFixed(1)`: a tie rounds up, as `toFixed` does.
fn megabytes(bytes: u64) -> String {
    let value = bytes as f64 / 1_000_000.0;
    let tenths = value * 10.0;
    if tenths.fract() == 0.5 {
        format!("{:.1}", tenths.ceil() / 10.0)
    } else {
        format!("{value:.1}")
    }
}
