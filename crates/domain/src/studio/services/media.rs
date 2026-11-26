//! Content media ingress through the Studio boundary.
//! Adapters hand over
//! bytes or a temporary file, whichever their transport provides; validation,
//! hashing, deduplication and ownership happen here.
//!
//! The file work is synchronous: a caller on an async runtime runs it on a
//! blocking thread.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use content::assets::{MediaKind, check_studio_media_size, media_extension, media_kind, safe_filename};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::application::ports::{DomainEventInput, NewStudioMediaAsset, Severity, StudioMediaAssetRecord};
use crate::publishing::publication_status::object;
use crate::repositories::random_uuid;
use crate::studio::Studio;
use crate::{Error, Result};

/// Which transport an upload came through.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaSource {
    HttpUpload,
    TelegramUpload,
    OpsUpload,
}

impl MediaSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HttpUpload => "http_upload",
            Self::TelegramUpload => "telegram_upload",
            Self::OpsUpload => "ops_upload",
        }
    }
}

pub struct ImportedMedia<'a> {
    pub filename: &'a str,
    pub content_type: &'a str,
    pub bytes: &'a [u8],
    pub source: MediaSource,
}

/// A file already on disk; the caller keeps ownership of it.
pub struct ImportedMediaFile<'a> {
    pub filename: &'a str,
    pub content_type: &'a str,
    pub local_path: &'a Path,
    /// The size the transport reported; the file's own size otherwise.
    pub byte_size: Option<u64>,
    pub source: MediaSource,
}

fn io(error: std::io::Error) -> Error {
    Error::message(error.to_string())
}

fn file_sha256(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).map_err(io)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = file.read(&mut buffer).map_err(io)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[derive(Clone, Copy)]
pub struct MediaService<'a> {
    studio: Studio<'a>,
}

impl<'a> MediaService<'a> {
    pub fn new(studio: Studio<'a>) -> Self {
        Self { studio }
    }

    pub fn import(&self, actor_id: i64, input: &ImportedMedia<'_>) -> Result<StudioMediaAssetRecord> {
        self.studio.track("studio.media.import", || {
            check_studio_media_size(input.bytes.len() as u64)?;
            let temporary = self
                .studio
                .config
                .studio_media_dir
                .join(".incoming")
                .join(random_uuid());
            fs::create_dir_all(temporary.parent().expect("joined under a directory")).map_err(io)?;
            fs::write(&temporary, input.bytes).map_err(io)?;
            let imported = self.import_stored(
                actor_id,
                &ImportedMediaFile {
                    filename: input.filename,
                    content_type: input.content_type,
                    local_path: &temporary,
                    byte_size: Some(input.bytes.len() as u64),
                    source: input.source,
                },
            );
            let _ = fs::remove_file(&temporary);
            imported
        })
    }

    pub fn import_file(&self, actor_id: i64, input: &ImportedMediaFile<'_>) -> Result<StudioMediaAssetRecord> {
        self.studio
            .track("studio.media.import", || self.import_stored(actor_id, input))
    }

    /// Copies, never links or renames, into Content storage: the caller keeps
    /// ownership of its file, and the chmod below would otherwise reach
    /// through a shared inode into a file that is not ours.
    fn import_stored(&self, actor_id: i64, input: &ImportedMediaFile<'_>) -> Result<StudioMediaAssetRecord> {
        let size = fs::metadata(input.local_path).map_err(io)?.len();
        let byte_size = input.byte_size.unwrap_or(size);
        check_studio_media_size(byte_size)?;
        let kind = media_kind(input.content_type, input.filename)
            .ok_or_else(|| Error::message("Only image and MP4 video uploads are supported."))?;
        let extension = media_extension(kind, input.content_type, input.filename);
        let sha256 = file_sha256(input.local_path)?;
        let filename = format!("{}{extension}", &sha256[..24]);
        let local_path: PathBuf = self
            .studio
            .config
            .studio_media_dir
            .join(actor_id.to_string())
            .join(&filename);
        let assets = self.studio.ports().studio_media_assets();
        let existing = assets.find_by_owner_hash(actor_id, &sha256)?;
        let stored_path = existing
            .as_ref()
            .map_or_else(|| path_text(&local_path), |asset| asset.asset.local_path.clone());
        let stored = Path::new(&stored_path);
        fs::create_dir_all(stored.parent().unwrap_or(Path::new("."))).map_err(io)?;
        if !stored.exists() {
            fs::copy(input.local_path, stored).map_err(io)?;
            restrict(stored)?;
        }
        // The insert is guarded by the unique (actor_id, sha256) index rather
        // than by the lookup above: two concurrent imports of one file both
        // miss the select, and the loser adopts the winner's row.
        let inserted = match existing {
            Some(_) => None,
            None => {
                let safe = safe_filename(input.filename);
                let mime_type = if !input.content_type.is_empty() {
                    input.content_type.to_owned()
                } else if let Some(implied) = foundation::media_types::media_content_type(&filename) {
                    implied.to_owned()
                } else if kind == MediaKind::Video {
                    "video/mp4".into()
                } else {
                    "image/jpeg".into()
                };
                assets.insert_if_absent(&NewStudioMediaAsset {
                    actor_id,
                    kind: kind.as_str().into(),
                    mime_type,
                    filename: if safe.is_empty() { filename.clone() } else { safe },
                    local_path: stored_path.clone(),
                    byte_size: byte_size as i64,
                    sha256: sha256.clone(),
                    source: input.source.as_str().into(),
                    created_at: foundation::time::to_iso_string(self.studio.now()),
                })?
            }
        };
        let was_new = existing.is_none();
        let asset = match existing.or_else(|| inserted.clone()) {
            Some(asset) => asset,
            None => assets
                .find_by_owner_hash(actor_id, &sha256)?
                .ok_or_else(|| Error::message("Media asset could not be stored."))?,
        };
        // A concurrent import with another extension may have won the unique
        // hash race. Remove only our deterministic candidate, never the
        // winner's path.
        if was_new && asset.asset.local_path != path_text(&local_path) {
            let _ = fs::remove_file(&local_path);
        }
        // Only the import that created the row announces it: a lost race and
        // a plain re-upload are both "this asset already exists".
        if inserted.is_some() {
            self.studio.ports().events().record(&DomainEventInput {
                publication_ref: Some(format!("asset:{}", asset.id)),
                event_type: "content.media.imported".into(),
                severity: Severity::Info,
                target: None,
                message: format!("Studio media asset #{} imported", asset.id),
                details: Some(object(json!({
                    "owner_id": actor_id, "kind": kind.as_str(), "byte_size": byte_size, "source": input.source.as_str(),
                }))),
                cooldown_seconds: None,
            })?;
        }
        Ok(asset)
    }
}

fn restrict(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o640)).map_err(io)
}
