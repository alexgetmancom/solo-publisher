//! How the bot writes the time of one queued or published item (`bot/queue-time.ts`).

use foundation::i18n::{Key, t};
use foundation::time::{Zone, format_zoned_clock, format_zoned_day_month, zoned_day_distance};
use jiff::Timestamp;

/// `Сегодня, 12:00`, `Вчера, …`, `Завтра, …`, else `5 авг., 12:00`.
pub fn format_queue_time(date: Timestamp, now: Timestamp, zone: &Zone) -> String {
    let clock = format_zoned_clock(date, zone);
    match zoned_day_distance(date, now, zone) {
        0 => format!("{}, {clock}", t(Key::CommonToday, &[])),
        -1 => format!("{}, {clock}", t(Key::CommonYesterday, &[])),
        1 => format!("{}, {clock}", t(Key::CommonTomorrow, &[])),
        _ => format!("{}, {clock}", format_zoned_day_month(date, zone)),
    }
}
