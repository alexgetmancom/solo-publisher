//! One Story: connect, load the account, resolve the channel, upload the
//! file, `stories.sendStory`, under TypeScript's deadlines (connect 30 s,
//! identity 30 s, the rest 120 s, teardown 5 s).
//!
//! Everything before `stories.sendStory` is handed to the sender is not sent.
//! After it, Telegram's own refusal is not sent either, except a server-side
//! failure (code 500 and up, or negative), which may have happened after the
//! Story was stored; a deadline, a dropped connection, or an answer without
//! the Story are ambiguous.

use std::cell::Cell;
use std::path::Path;
use std::time::Duration;

use adapters::telegram_stories::{StoryError, StoryRequest, StoryUploadMedia};
use grammers_client::tl::{enums, functions, types};
use grammers_client::{Client, InvocationError};
use tokio::io::AsyncReadExt as _;

use crate::Credentials;
use crate::connection::with_client;
use crate::session::SessionFile;

const CONNECT: Duration = Duration::from_secs(30);
const IDENTITY: Duration = Duration::from_secs(30);
const SEND: Duration = Duration::from_secs(120);
const STORY_TIMEOUT: &str = "telegram_channel_story_timeout";
pub const NOT_SIGNED_IN: &str =
    "telegram_channel_story_not_signed_in: sign the Stories account in with `ops telegram-stories-login`";

fn media_path(media: &StoryUploadMedia) -> &Path {
    match media {
        StoryUploadMedia::Photo { path } | StoryUploadMedia::Video { path, .. } => path,
    }
}

/// Posts `request` and returns the Story's id.
pub async fn post_story(credentials: &Credentials, request: &StoryRequest) -> Result<i64, StoryError> {
    let path = media_path(&request.media);
    if !tokio::fs::metadata(path).await.is_ok_and(|metadata| metadata.is_file()) {
        return Err(StoryError::Refused(format!("story_media_missing: {}", path.display())));
    }
    if !credentials.session.is_file() {
        return Err(StoryError::Refused(NOT_SIGNED_IN.into()));
    }
    let session = SessionFile::open(&credentials.session).map_err(|error| StoryError::Refused(error.to_string()))?;
    let home = session
        .home_dc()
        .map_err(|error| StoryError::Refused(error.to_string()))?;
    if home.auth_key.is_none() {
        return Err(StoryError::Refused(NOT_SIGNED_IN.into()));
    }
    with_client(credentials.api_id, session, async |client| {
        before_send(
            CONNECT,
            client.invoke(&functions::help::GetNearestDc {}),
            "telegram_channel_story_connect_timeout",
        )
        .await?;
        before_send(
            IDENTITY,
            client.invoke(&functions::users::GetUsers {
                id: vec![enums::InputUser::UserSelf],
            }),
            "telegram_channel_story_identity_timeout",
        )
        .await?;
        let sent = Cell::new(false);
        match tokio::time::timeout(SEND, send(client, request, &sent)).await {
            Ok(outcome) => outcome,
            Err(_) if sent.get() => Err(StoryError::Ambiguous(STORY_TIMEOUT.into())),
            Err(_) => Err(StoryError::Refused(STORY_TIMEOUT.into())),
        }
    })
    .await
}

/// A call before `stories.sendStory`: any failure is not sent.
async fn before_send<T>(
    deadline: Duration,
    call: impl Future<Output = Result<T, InvocationError>>,
    timeout: &str,
) -> Result<T, StoryError> {
    match tokio::time::timeout(deadline, call).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(StoryError::Refused(refusal(&error))),
        Err(_) => Err(StoryError::Refused(timeout.into())),
    }
}

/// mtcute's wording for Telegram's refusals, which the error classifier and
/// the publication history have always seen; an account without a valid
/// sign-in names the command that fixes it.
fn refusal(error: &InvocationError) -> String {
    match error {
        InvocationError::Rpc(rpc) if rpc.code == 401 => format!("{NOT_SIGNED_IN} ({})", rpc.name),
        InvocationError::Rpc(rpc) => describe_rpc(rpc),
        other => other.to_string(),
    }
}

fn describe_rpc(rpc: &grammers_client::sender::RpcError) -> String {
    match rpc.value {
        Some(value) => format!("Telegram API error {}: {} ({value})", rpc.code, rpc.name),
        None => format!("Telegram API error {}: {}", rpc.code, rpc.name),
    }
}

async fn send(client: &Client, request: &StoryRequest, sent: &Cell<bool>) -> Result<i64, StoryError> {
    let peer = resolve_channel(client, &request.peer).await?;
    let path = media_path(&request.media);
    let head = file_head(path)
        .await
        .map_err(|error| StoryError::Refused(format!("story_media_unreadable: {}: {error}", path.display())))?;
    let uploaded = client
        .upload_file(path)
        .await
        .map_err(|error| StoryError::Refused(format!("telegram_channel_story_upload: {error}")))?;
    let random_id = random_id().map_err(StoryError::Refused)?;
    let story = send_story_request(
        request,
        peer,
        input_media(&request.media, uploaded.raw, &head),
        random_id,
    );
    sent.set(true);
    let updates = client.invoke(&story).await.map_err(|error| match &error {
        InvocationError::Rpc(rpc) if (300..500).contains(&rpc.code) => StoryError::Refused(describe_rpc(rpc)),
        InvocationError::Rpc(rpc) => StoryError::Ambiguous(describe_rpc(rpc)),
        other => StoryError::Ambiguous(other.to_string()),
    })?;
    posted_story_id(&updates).map(i64::from).ok_or_else(|| {
        StoryError::Ambiguous("telegram_channel_story_unconfirmed: stories.sendStory answered without the Story".into())
    })
}

/// `contacts.resolveUsername`, as mtcute's `resolvePeer` does for a name.
async fn resolve_channel(client: &Client, username: &str) -> Result<enums::InputPeer, StoryError> {
    let resolved = client
        .invoke(&functions::contacts::ResolveUsername {
            username: username.to_owned(),
            referer: None,
        })
        .await
        .map_err(|error| match &error {
            InvocationError::Rpc(rpc) if rpc.name == "USERNAME_NOT_OCCUPIED" || rpc.name == "USERNAME_INVALID" => {
                StoryError::Refused(format!("Peer with username {username} was not found"))
            }
            other => StoryError::Refused(refusal(other)),
        })?;
    let enums::contacts::ResolvedPeer::Peer(resolved) = resolved;
    let enums::Peer::Channel(types::PeerChannel { channel_id }) = resolved.peer else {
        return Err(StoryError::Refused(format!("@{username} is not a channel")));
    };
    resolved
        .chats
        .iter()
        .find_map(|chat| match chat {
            enums::Chat::Channel(channel) if channel.id == channel_id => channel.access_hash,
            enums::Chat::ChannelForbidden(channel) if channel.id == channel_id => Some(channel.access_hash),
            _ => None,
        })
        .map(|access_hash| {
            types::InputPeerChannel {
                channel_id,
                access_hash,
            }
            .into()
        })
        .ok_or_else(|| {
            StoryError::Refused(format!(
                "Peer (channel) with {username} was found, but it has no access hash"
            ))
        })
}

/// The bytes mtcute sniffed the MIME type from.
async fn file_head(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut head = Vec::with_capacity(12);
    tokio::fs::File::open(path)
        .await?
        .take(12)
        .read_to_end(&mut head)
        .await?;
    Ok(head)
}

fn random_id() -> Result<i64, String> {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).map_err(|error| format!("telegram_channel_story_random_id: {error}"))?;
    Ok(i64::from_le_bytes(bytes))
}

/// The uploaded file as mtcute's `_normalizeInputMedia` describes it for a
/// `{type: "photo"}` or `{type: "video", width, height, duration,
/// supportsStreaming: true}` input.
pub fn input_media(media: &StoryUploadMedia, file: enums::InputFile, head: &[u8]) -> enums::InputMedia {
    match media {
        StoryUploadMedia::Photo { .. } => types::InputMediaUploadedPhoto {
            spoiler: false,
            live_photo: false,
            file,
            stickers: None,
            ttl_seconds: None,
            video: None,
        }
        .into(),
        StoryUploadMedia::Video {
            path,
            width,
            height,
            duration,
        } => {
            let file_name = path
                .file_name()
                .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
            types::InputMediaUploadedDocument {
                // mtcute sets it for every video that is not an animation.
                nosound_video: true,
                force_file: false,
                spoiler: false,
                file,
                thumb: None,
                mime_type: video_mime_type(head).into(),
                attributes: vec![
                    types::DocumentAttributeFilename { file_name }.into(),
                    types::DocumentAttributeVideo {
                        round_message: false,
                        supports_streaming: true,
                        nosound: false,
                        duration: *duration,
                        w: *width as i32,
                        h: *height as i32,
                        preload_prefix_size: None,
                        video_start_ts: None,
                        video_codec: None,
                    }
                    .into(),
                ],
                stickers: None,
                video_cover: None,
                video_timestamp: None,
                ttl_seconds: None,
            }
            .into()
        }
    }
}

/// `guessFileMime` of mtcute for what a Story video can be: the ISO media
/// family by its major brand; anything else is untyped.
fn video_mime_type(head: &[u8]) -> &'static str {
    if head.len() < 12 || &head[4..8] != b"ftyp" || head[8] & 0x60 == 0 {
        return "application/octet-stream";
    }
    let brand = String::from_utf8_lossy(&head[8..12]).replace('\0', " ");
    match brand.trim() {
        "qt" => "video/quicktime",
        "M4V" | "M4VH" | "M4VP" => "video/x-m4v",
        brand if brand.starts_with("3g2") => "video/3gpp2",
        brand if brand.starts_with("3g") => "video/3gpp",
        _ => "video/mp4",
    }
}

/// `stories.sendStory` as mtcute's `sendStory` builds it: visible to
/// everyone, not pinned to the profile, for `period_seconds`.
pub fn send_story_request(
    request: &StoryRequest,
    peer: enums::InputPeer,
    media: enums::InputMedia,
    random_id: i64,
) -> functions::stories::SendStory {
    let entities: Vec<enums::MessageEntity> = request
        .caption
        .links
        .iter()
        .map(|link| {
            types::MessageEntityTextUrl {
                offset: link.offset as i32,
                length: link.length as i32,
                url: link.url.clone(),
            }
            .into()
        })
        .collect();
    functions::stories::SendStory {
        pinned: false,
        noforwards: false,
        fwd_modified: false,
        peer,
        media,
        media_areas: None,
        caption: Some(request.caption.text.clone()),
        entities: (!entities.is_empty()).then_some(entities),
        privacy_rules: vec![enums::InputPrivacyRule::InputPrivacyValueAllowAll],
        random_id,
        period: Some(request.period_seconds as i32),
        fwd_from_id: None,
        fwd_from_story: None,
        albums: None,
        music: None,
    }
}

/// mtcute's `_findStoryInUpdate`: the `updateStory` of the answer.
fn posted_story_id(updates: &enums::Updates) -> Option<i32> {
    let updates = match updates {
        enums::Updates::Updates(updates) => &updates.updates,
        enums::Updates::Combined(updates) => &updates.updates,
        _ => return None,
    };
    updates.iter().find_map(|update| match update {
        enums::Update::Story(update) => match &update.story {
            enums::StoryItem::Item(story) => Some(story.id),
            _ => None,
        },
        _ => None,
    })
}
