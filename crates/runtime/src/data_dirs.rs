//! The host paths the process writes under (`foundation/runtime/data-dirs.ts`),
//! checked with a real write and, as root before the privilege drop, handed to
//! the app user.

use std::os::unix::fs::MetadataExt as _;
use std::path::{Component, Path, PathBuf};

use foundation::config::Config;
use foundation::js;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataDirectory {
    pub name: &'static str,
    pub path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataDirectoryCheck {
    pub name: &'static str,
    pub path: PathBuf,
    pub writable: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataDirectoryOwnershipFix {
    pub name: &'static str,
    pub path: PathBuf,
    pub changed: bool,
    pub error: Option<String>,
}

/// Every directory the running process must be able to create files under,
/// each once: a bind-mounted path Docker created is owned by root. The site
/// directory is prepared whether or not this Studio serves a site, because
/// ownership is fixed before the database that would say so is readable.
pub fn required_data_directories(config: &Config) -> Vec<DataDirectory> {
    let entries = [
        ("DATA_DIR", PathBuf::from(&config.data_dir)),
        ("STUDIO_MEDIA_DIR", config.studio_media_dir.clone()),
        ("MEDIA_CACHE_DIR", config.media_cache_dir.clone()),
        ("STORY_CARD_DIR", config.story_card_dir.clone()),
        ("REMOTE_MEDIA_PATH", config.remote_media_path.clone()),
        ("SITE_PUBLIC_DIR", config.site_public_dir.clone()),
    ];
    let mut seen = Vec::new();
    let mut directories = Vec::new();
    for (name, path) in entries {
        let resolved = resolve(&path);
        if seen.contains(&resolved) {
            continue;
        }
        seen.push(resolved);
        directories.push(DataDirectory { name, path });
    }
    directories
}

/// `path.resolve`: absolute against the working directory, `.` and `..`
/// folded lexically.
fn resolve(path: &Path) -> PathBuf {
    let absolute = std::env::current_dir().unwrap_or_default().join(path);
    let mut resolved = PathBuf::from("/");
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(part) => resolved.push(part),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    resolved
}

/// Creates each directory if missing and probes it with a real write: a
/// directory Docker created for a bind mount exists yet may still refuse this
/// process, which is the case that bites self-hosters.
pub fn check_data_directories_writable(directories: &[DataDirectory]) -> Vec<DataDirectoryCheck> {
    directories
        .iter()
        .map(|directory| {
            let probe = || -> std::io::Result<()> {
                std::fs::create_dir_all(&directory.path)?;
                let millis = jiff::Timestamp::now().as_millisecond();
                let probe = directory
                    .path
                    .join(format!(".write-check-{}-{millis}", std::process::id()));
                std::fs::write(&probe, "")?;
                match std::fs::remove_file(&probe) {
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
                    _ => Ok(()),
                }
            };
            let outcome = probe();
            DataDirectoryCheck {
                name: directory.name,
                path: directory.path.clone(),
                writable: outcome.is_ok(),
                error: outcome.err().map(|error| error.to_string()),
            }
        })
        .collect()
}

/// Ensures each directory exists and is owned by `uid:gid`, changing ownership
/// only where it differs. Run once, as root, before the privilege drop.
pub fn fix_data_directories_ownership(
    directories: &[DataDirectory],
    uid: u32,
    gid: u32,
) -> Vec<DataDirectoryOwnershipFix> {
    directories
        .iter()
        .map(|directory| {
            let fix = || -> std::io::Result<bool> {
                std::fs::create_dir_all(&directory.path)?;
                let metadata = std::fs::metadata(&directory.path)?;
                if metadata.uid() == uid && metadata.gid() == gid {
                    return Ok(false);
                }
                std::os::unix::fs::chown(&directory.path, Some(uid), Some(gid))?;
                Ok(true)
            };
            let outcome = fix();
            DataDirectoryOwnershipFix {
                name: directory.name,
                path: directory.path.clone(),
                changed: outcome.as_ref().is_ok_and(|changed| *changed),
                error: outcome.err().map(|error| error.to_string()),
            }
        })
        .collect()
}

/// A Unix user's `uid` and `gid`, read from the passwd file.
pub fn resolve_unix_user(username: &str, passwd_file: &Path) -> Result<(u32, u32), String> {
    let passwd = std::fs::read_to_string(passwd_file).map_err(|error| error.to_string())?;
    for line in passwd.split('\n') {
        let mut fields = line.split(':');
        let (name, _, uid, gid) = (fields.next(), fields.next(), fields.next(), fields.next());
        if name != Some(username) {
            continue;
        }
        let id = |text: Option<&str>| {
            let value = text.map_or(f64::NAN, js::number);
            (js::is_integer(value) && (0.0..=f64::from(u32::MAX)).contains(&value)).then_some(value as u32)
        };
        if let (Some(uid), Some(gid)) = (id(uid), id(gid)) {
            return Ok((uid, gid));
        }
    }
    Err(format!("Unix user not found in {}: {username}", passwd_file.display()))
}

/// The supplementary groups to keep when dropping privileges. Compose grants
/// the container groups that exist only in the live process's list (the
/// telegram-bot-api download directory's `group_add`), so they are preserved
/// from it; replacing the list with the user's own gid is what silently broke
/// reading downloaded videos. Group 0 is root's own and never survives.
pub fn retained_supplementary_groups(gid: u32, current_groups: &[u32]) -> Vec<u32> {
    let mut groups = vec![gid];
    for &group in current_groups {
        if group != 0 && !groups.contains(&group) {
            groups.push(group);
        }
    }
    groups
}
