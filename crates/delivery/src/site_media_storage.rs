//! `delivery/site-media-storage.ts`: files are replaced by rename, never
//! written in place, and stable public URLs are hard links to
//! content-addressed blobs — so a new version cannot mutate a sibling URL
//! sharing the same inode, and a half-written file never sits under the name
//! that means "ready".

use std::io;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};

use sha2::{Digest as _, Sha256};
use tokio::io::AsyncReadExt as _;

/// Node's `path.extname` of a file name: from the last `.` that is not the
/// first character, or empty.
pub fn extname(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or_default();
    match name.rfind('.') {
        Some(index) if index > 0 => &name[index..],
        _ => "",
    }
}

/// `path.basename(path, extname(path))`.
fn stem(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or_default();
    &name[..name.len() - extname(name).len()]
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `temporaryPath`: `.<stem>.tmp-<pid>-<uuid><ext>` beside the target.
pub fn temporary_path(target: &Path) -> PathBuf {
    let name = text(target);
    let directory = target.parent().map_or_else(|| PathBuf::from("."), Path::to_path_buf);
    directory.join(format!(
        ".{}.tmp-{}-{}{}",
        stem(&name),
        std::process::id(),
        domain::repositories::random_uuid(),
        extname(&name)
    ))
}

/// `copyFileAtomically`: a copy beside the target, renamed over it.
pub async fn copy_file_atomically(source: &Path, target: &Path) -> io::Result<()> {
    let temporary = temporary_path(target);
    let copied = async {
        tokio::fs::copy(source, &temporary).await?;
        tokio::fs::rename(&temporary, target).await
    }
    .await;
    let _ = tokio::fs::remove_file(&temporary).await;
    copied
}

/// `sha256File`: the hex digest of the file's bytes.
pub async fn sha256_file(file: &Path) -> io::Result<String> {
    let mut hash = Sha256::new();
    let mut reader = tokio::fs::File::open(file).await?;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// `isSiteMediaExtension`.
pub fn is_site_media_extension(file: &str) -> bool {
    let extension = extname(file).to_ascii_lowercase();
    matches!(
        extension.as_str(),
        ".avif" | ".gif" | ".jpg" | ".jpeg" | ".mp4" | ".png" | ".webp"
    )
}

fn failure(message: &str) -> io::Error {
    io::Error::other(message.to_owned())
}

/// `deduplicateSiteMediaFile`: the file becomes a hard link to the blob named
/// by its content, made from it if it is the first of its bytes.
pub async fn deduplicate_site_media_file(media_root: &Path, file: &Path) -> io::Result<()> {
    let root = public_site::paths::resolve(&text(media_root), "");
    let source = public_site::paths::resolve(&text(file), "");
    if !is_inside(&root, &source) {
        return Err(failure("site media file escapes media root"));
    }
    let source = PathBuf::from(source);
    if !tokio::fs::metadata(&source).await?.is_file() {
        return Err(failure("site media file must be a regular file"));
    }
    let extension = extname(&text(&source)).to_ascii_lowercase();
    if extension.is_empty() {
        return Err(failure("site media file requires an extension"));
    }
    let blob_directory = Path::new(&root).join(".blobs");
    let blob = blob_directory.join(format!("{}{extension}", sha256_file(&source).await?));
    tokio::fs::create_dir_all(&blob_directory).await?;
    match tokio::fs::hard_link(&source, &blob).await {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let (source_stat, blob_stat) = (tokio::fs::metadata(&source).await?, tokio::fs::metadata(&blob).await?);
    if source_stat.dev() == blob_stat.dev() && source_stat.ino() == blob_stat.ino() {
        return Ok(());
    }
    let temporary = temporary_path(&source);
    let linked = async {
        tokio::fs::hard_link(&blob, &temporary).await?;
        tokio::fs::rename(&temporary, &source).await
    }
    .await;
    let _ = tokio::fs::remove_file(&temporary).await;
    linked
}

/// `path.relative(root, candidate)` names something strictly below `root`.
fn is_inside(root: &str, candidate: &str) -> bool {
    let root = root.trim_end_matches('/');
    candidate
        .strip_prefix(root)
        .and_then(|rest| rest.strip_prefix('/'))
        .is_some_and(|relative| !relative.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_path_pieces() {
        assert_eq!(extname("/a/b.c.jpg"), ".jpg");
        assert_eq!(extname("/a/.hidden"), "");
        assert_eq!(extname("/a/name"), "");
        assert_eq!(stem("/a/b.c.jpg"), "b.c");
        assert!(is_inside("/root/media", "/root/media/posts/a.jpg"));
        assert!(!is_inside("/root/media", "/root/media"));
        assert!(!is_inside("/root/media", "/root/mediax/a.jpg"));
        let temporary = temporary_path(Path::new("/x/y/file.mp4"));
        let name = text(&temporary);
        assert!(name.starts_with(&format!("/x/y/.file.tmp-{}-", std::process::id())));
        assert!(name.ends_with(".mp4"));
    }
}
