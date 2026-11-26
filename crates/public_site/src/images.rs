//! What a served image is: the dimensions of the file on disk, not of the
//! upload it was made from, and the responsive variants the publication worker
//! has generated for it so far.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::rc::Rc;
use std::time::UNIX_EPOCH;

use content::site_media_naming::RESPONSIVE_WIDTHS;
use foundation::js::number_to_string;
use sha2::{Digest, Sha256};

use crate::image_size::image_size_from_file;
use crate::paths::{join, public_relative, resolve, url_search};

#[derive(Clone, Copy, Debug, PartialEq)]
struct ImageInfo {
    width: i64,
    height: i64,
    /// `stat.mtimeMs`.
    modified: f64,
    size: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Variant {
    pub path: String,
    pub width: i64,
    pub height: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageDescription {
    pub width: i64,
    pub height: i64,
    pub responsive: Vec<Variant>,
    /// Every publication size exists, so the description never changes again.
    pub complete: bool,
}

/// The process-wide image caches, held by whoever serves the feed.
#[derive(Default)]
pub struct SiteImages {
    images: RefCell<HashMap<String, ImageInfo>>,
    descriptions: RefCell<HashMap<String, Rc<ImageDescription>>>,
}

/// `stat.mtimeMs` as Node computes it.
fn mtime_ms(metadata: &fs::Metadata) -> Option<f64> {
    let modified = metadata.modified().ok()?;
    Some(match modified.duration_since(UNIX_EPOCH) {
        Ok(after) => after.as_secs() as f64 * 1000.0 + f64::from(after.subsec_nanos()) / 1_000_000.0,
        Err(before) => {
            let before = before.duration();
            -(before.as_secs() as f64 * 1000.0 + f64::from(before.subsec_nanos()) / 1_000_000.0)
        }
    })
}

impl SiteImages {
    /// `siteImage(root, publicPath)`. Missing derivatives are not cached: the
    /// publication worker may still write them.
    pub fn site_image(&self, root: &str, public_path: &str) -> domain::Result<Option<Rc<ImageDescription>>> {
        let relative = public_relative(public_path);
        let file = resolve(root, relative);
        if !file.starts_with(&format!("{}/", resolve(root, ""))) {
            return Ok(None);
        }
        let query = url_search(public_path)?;
        let Some(source) = self.image_info(&file, &query) else {
            return Ok(None);
        };
        let version = if query.is_empty() {
            let stamp = format!("{}:{}", number_to_string(source.modified), source.size);
            let digest = Sha256::digest(stamp.as_bytes());
            let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
            format!("?v={}", &hex[..12])
        } else {
            query
        };
        let key = format!("{file}{version}");
        if let Some(cached) = self.descriptions.borrow().get(&key)
            && cached.complete
        {
            return Ok(Some(Rc::clone(cached)));
        }
        let basename = strip_extension(&relative.replace(['\\', '/'], "-")).to_owned();
        let mut responsive: Vec<(Variant, u32)> = Vec::new();
        let mut current = 0;
        for width in RESPONSIVE_WIDTHS {
            let url = format!("/generated/responsive/{basename}-{width}.webp");
            let variant_file = join(root, &url);
            let Some(variant) = self.image_info(&variant_file, &version) else {
                continue;
            };
            if variant.modified < source.modified {
                self.images.borrow_mut().remove(&format!("{variant_file}{version}"));
                continue;
            }
            current += 1;
            responsive.push((
                Variant {
                    path: format!("{url}{version}"),
                    width: variant.width,
                    height: variant.height,
                },
                width,
            ));
        }
        // Small sources can produce equal actual widths at several nominal sizes.
        // Keep the smallest name deterministically so the ETag cannot churn.
        responsive.sort_by(|(a, a_nominal), (b, b_nominal)| a.width.cmp(&b.width).then(a_nominal.cmp(b_nominal)));
        responsive.dedup_by(|(next, _), (kept, _)| next.width == kept.width);
        let description = Rc::new(ImageDescription {
            width: source.width,
            height: source.height,
            complete: current == RESPONSIVE_WIDTHS.len(),
            responsive: responsive.into_iter().map(|(variant, _)| variant).collect(),
        });
        self.descriptions.borrow_mut().insert(key, Rc::clone(&description));
        Ok(Some(description))
    }

    /// `imageInfo(file, version)`. Historical URLs have no content version:
    /// their timestamp is part of the key, so a later replacement is read anew.
    fn image_info(&self, file: &str, version: &str) -> Option<ImageInfo> {
        let key = if version.is_empty() {
            let stat = fs::metadata(file).ok();
            let mtime = stat
                .as_ref()
                .and_then(mtime_ms)
                .map_or_else(|| "undefined".into(), number_to_string);
            let size = stat.map_or_else(|| "undefined".into(), |stat| stat.len().to_string());
            format!("{file}?mtime={mtime}&size={size}")
        } else {
            format!("{file}{version}")
        };
        if let Some(cached) = self.images.borrow().get(&key) {
            return Some(*cached);
        }
        let size = image_size_from_file(Path::new(file))?;
        let stat = fs::metadata(file).ok()?;
        // EXIF orientation can exchange the displayed axes.
        let rotated = size.orientation.is_some_and(|orientation| orientation >= 5);
        let info = ImageInfo {
            width: if rotated { size.height } else { size.width },
            height: if rotated { size.width } else { size.height },
            modified: mtime_ms(&stat)?,
            size: stat.len(),
        };
        self.images.borrow_mut().insert(key, info);
        Some(info)
    }
}

/// `.replace(/\.[a-z0-9]+$/i, "")`.
fn strip_extension(name: &str) -> &str {
    match name.rfind('.') {
        Some(dot) if dot + 1 < name.len() && name[dot + 1..].bytes().all(|b| b.is_ascii_alphanumeric()) => &name[..dot],
        _ => name,
    }
}

#[cfg(test)]
mod tests {
    use super::strip_extension;

    #[test]
    fn strips_only_a_trailing_alphanumeric_extension() {
        assert_eq!(strip_extension("media-posts-1-en-0.jpg"), "media-posts-1-en-0");
        assert_eq!(strip_extension("media-posts-a.b-c"), "media-posts-a.b-c");
        assert_eq!(strip_extension("media-posts-a."), "media-posts-a.");
        assert_eq!(strip_extension("archive.tar.GZ"), "archive.tar");
    }
}
