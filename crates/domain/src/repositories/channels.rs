use db::rusqlite::{Connection, OptionalExtension, Row, params};

use crate::Result;
use crate::application::ports::{ChannelConnection, ChannelConnectionRecord};

const SELECT_CHANNELS: &str = r#"select "id", "platform", "locale", "provider", "provider_account_id", "target_id", "label", "enabled", "source", "created_at", "updated_at" from "channel_connections""#;

fn channel(row: &Row<'_>) -> db::rusqlite::Result<ChannelConnectionRecord> {
    Ok(ChannelConnectionRecord {
        connection: ChannelConnection {
            id: row.get(0)?,
            platform: row.get(1)?,
            locale: row.get(2)?,
            provider: row.get(3)?,
            provider_account_id: row.get(4)?,
            target_id: row.get(5)?,
            label: row.get(6)?,
            enabled: row.get(7)?,
            source: row.get(8)?,
        },
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

/// Channel routing: which account each platform and locale publishes through.
pub struct ChannelStore<'a> {
    sqlite: &'a Connection,
}

impl<'a> ChannelStore<'a> {
    pub fn new(sqlite: &'a Connection) -> Self {
        Self { sqlite }
    }

    pub fn list(&self, enabled_only: bool) -> Result<Vec<ChannelConnectionRecord>> {
        let mut statement = if enabled_only {
            self.sqlite.prepare(&format!(
                r#"{SELECT_CHANNELS} where "channel_connections"."enabled" = ?"#
            ))?
        } else {
            self.sqlite.prepare(SELECT_CHANNELS)?
        };
        let rows: db::rusqlite::Result<Vec<_>> = if enabled_only {
            statement.query_map([1], channel)?.collect()
        } else {
            statement.query_map([], channel)?.collect()
        };
        Ok(rows?)
    }

    pub fn get(&self, id: &str) -> Result<Option<ChannelConnectionRecord>> {
        Ok(self
            .sqlite
            .query_row(
                &format!(r#"{SELECT_CHANNELS} where "channel_connections"."id" = ?"#),
                [id],
                channel,
            )
            .optional()?)
    }

    pub fn upsert(&self, input: &ChannelConnection, now: &str) -> Result<()> {
        self.sqlite.execute(
            r#"insert into "channel_connections" ("id", "platform", "locale", "provider", "provider_account_id", "target_id", "label", "enabled", "source", "created_at", "updated_at") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict ("channel_connections"."id") do update set "platform" = ?, "locale" = ?, "provider" = ?, "provider_account_id" = ?, "target_id" = ?, "label" = ?, "enabled" = ?, "source" = ?, "updated_at" = ?"#,
            params![
                input.id,
                input.platform,
                input.locale,
                input.provider,
                input.provider_account_id,
                input.target_id,
                input.label,
                input.enabled,
                input.source,
                now,
                now,
                input.platform,
                input.locale,
                input.provider,
                input.provider_account_id,
                input.target_id,
                input.label,
                input.enabled,
                input.source,
                now
            ],
        )?;
        Ok(())
    }

    pub fn disable(&self, id: &str, now: &str) -> Result<()> {
        self.sqlite.execute(
            r#"update "channel_connections" set "enabled" = ?, "updated_at" = ? where "channel_connections"."id" = ?"#,
            params![0, now, id],
        )?;
        Ok(())
    }

    /// The schema allows several enabled accounts for one platform and locale,
    /// so which one a video goes to has to be a rule rather than whatever
    /// SQLite returned first: the most recently connected account wins.
    pub fn find(&self, platform: &str, locale: &str) -> Result<Option<ChannelConnectionRecord>> {
        Ok(self
            .sqlite
            .query_row(
                &format!(
                    r#"{SELECT_CHANNELS} where ("channel_connections"."platform" = ? and "channel_connections"."locale" = ? and "channel_connections"."enabled" = ?) order by "channel_connections"."updated_at" desc, "channel_connections"."id" desc"#
                ),
                params![platform, locale, 1],
                channel,
            )
            .optional()?)
    }
}
