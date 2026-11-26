[English](backups.md) · [Русский](backups.ru.md)

# Backups

Two things are worth keeping, and they are kept differently because they differ
by three orders of magnitude in size.

## The database, which arrives on its own

When Telegram is configured, the Studio silently sends a daily copy of its
database to the same chat you author from: posts, schedules, delivery state,
analytics and external ids. It is on unless you turn it off under **Settings →
Notifications → Database backup**. An MCP-only or site-only Studio has no chat
to deliver that copy to, so back up its data directory (`STUDIO_DATA_DIR_HOST`
in `deploy/alex.env` / `deploy/maru.env`) directly.

It is a real snapshot taken with SQLite's own backup, never a file copy. A live
database has a write-ahead log beside it, and a plain copy of one is a corrupt
database that only announces itself when someone tries to restore it.

To restore, download the file from the chat and (for Maru: `--as maru` and
`maru-backend`):

```bash
ssh "$OPS_SSH_TARGET" 'docker exec -i -u 1000 alexgetman-backend sh -c "cat > /data/restore.db"' < <downloaded>.db
cargo xtask ops-prod restore --source /data/restore.db --force
ssh "$OPS_SSH_TARGET" docker restart alexgetman-backend
```

## The media, which a backup host pulls

Media is not in that copy and cannot be: those files are far past what Telegram
accepts. They live on the data volume — video, posters, story cards and the
published site's assets — and they are the part that cannot be regenerated.

The Studio does not store a backup of them. It emits one:

```bash
cargo xtask ops-prod [--as alex|maru] backup-stream --what media > media.tar.gz
```

Nothing is written to the Studio's host. That is the point of the shape: a copy
kept beside the thing it protects dies with it, and a Studio holding credentials
that can write to the backup store hands them to whoever takes the Studio. So
the machine that keeps the backups reaches in and pulls, and the Studio holds
nothing.

`--what db` streams the database the same way, for a backup host that would
rather have its own copy than rely on the daily Telegram one.

### Pulling from another machine

The backup machine's key is pinned in the Studio host's
`~/.ssh/authorized_keys` to a forced command, so that key can run nothing else —
no shell, no path of the caller's choosing. On the production host that command
is `/home/deploy/bin/alexgetman-backup-export`, which accepts
`backup-export <what> <studio>` ([deploy/README.md](../deploy/README.md)):

```text
command="/home/deploy/bin/alexgetman-backup-export",restrict ssh-ed25519 AAAA... backup
```

Then, from the backup machine, on whatever schedule suits you:

```bash
ssh <studio-host> "backup-export media <studio>" > media-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
```

Anything that reads a stream works — a file, `restic backup --stdin`, a pipe
into object storage. Solo Publisher ships no scheduler and no storage
integration on purpose: a credential, a retention policy and a cron entry are
things every host already has a tool for, and each one we shipped would be
another thing to configure and get wrong.

Paths inside the archive are relative to the container's `/data`, where every
media mount lives, so it restores there unchanged:

```bash
ssh "$OPS_SSH_TARGET" 'docker exec -i -u 1000 alexgetman-backend tar -xzf - -C /data' < media-<stamp>.tar.gz
```

### The check that notices when it stops

Each completed export is recorded in the Studio's own database, and `doctor`
reports the deployment unhealthy once no media export has been pulled for a
week:

```bash
cargo xtask ops-prod [--as alex|maru] doctor
```

This is deliberately a check for *absence*, not a report of failure. A puller
that errors can tell you; a puller that is switched off, unplugged or quietly
uninstalled cannot, and that is the case worth catching. The Studio only knows
whether its media left recently, which is the question that matters.

## What is not worth backing up

`/home/deploy/caddy/data` holds TLS certificates, which Caddy obtains again by
itself. `/home/deploy/bot-api/data` (`BOT_API_DATA_DIR_HOST`) holds Telegram's
local file cache. Losing either costs a restart,
not data.
