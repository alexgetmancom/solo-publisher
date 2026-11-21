//! Health, host and channel administration: `maintenance.ts` (audit, backup,
//! restore, publication consistency), `backup-export.ts`, `disk-report.ts`,
//! `doctor.ts`, `foundation/deployment.ts` (`readDeploymentReleases`), the
//! date repair, the credential exports and channel commands of `registry.ts`,
//! `format-support.ts` (`recordFormatEvidence`), `threads-authorize.ts`,
//! `telegram-stories-login.ts`.

use serde_json::Value;

use super::not_ported;

not_ported!(
    analytics_export,
    youtube_export,
    doctor,
    deployments,
    dates_repair,
    audit,
    publication_repair,
    disk,
    backup,
    backup_stream,
    restore,
    format_record,
    channel_connect,
    connect_link,
    channel_disable,
    credential_set,
    telegram_stories_login,
    threads_authorize,
);

pub fn format_connect_link(result: &Value) -> String {
    format!(
        "{}\n\nOpen within {} minutes.",
        result["url"].as_str().unwrap_or_default(),
        result["expiresInMinutes"]
    )
}

pub fn format_credential_set(result: &Value) -> String {
    format!(
        "{} key stored ({})",
        result["target"].as_str().unwrap_or_default(),
        result["account"].as_str().unwrap_or_default()
    )
}
