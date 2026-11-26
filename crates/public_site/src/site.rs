//! `GET /api/public/site` without the HTTP framework: the body the public site
//! renders, its strong ETag, the 304 for a site that already has it and the long
//! poll that holds an unchanged conditional request open.
//!
//! The site is its own service (alexgetman-site) with no access to this
//! Studio's database or disk, so the media it is told about are only those
//! this Studio would actually serve.

use std::cell::RefCell;
use std::collections::HashSet;
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use content::Locale;
use db::BackendDb;
use domain::application::ports::{ApplicationPorts, Clock};
use domain::studio::config::studio_config;
use foundation::config::Config;
use serde_json::{Map, Number, Value, json};
use sha2::{Digest, Sha256};
use tokio::time::Instant;

use crate::feed::{Feed, FeedItem, FeedReader, SiteMedia};
use crate::images::SiteImages;
use crate::paths::{join, public_relative, versioned};

/// Database, schedule and late-media checks share this cadence; a quiet poll
/// inside it reuses the last answer.
const SITE_FEED_REFRESH_MS: f64 = 3_000.0;
/// The longest `Prefer: wait=N` a site may ask for.
const MAX_WAIT_SECONDS: f64 = 25.0;

/// The request headers the route reads.
#[derive(Clone, Copy, Debug, Default)]
pub struct SiteRequest<'a> {
    pub if_none_match: Option<&'a str>,
    pub prefer: Option<&'a str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SiteResponse {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    /// `None` for a 304, which has no body.
    pub body: Option<String>,
}

/// One serialised answer and its strong ETag.
#[derive(Debug, PartialEq, Eq)]
pub struct SiteBody {
    pub body: String,
    pub etag: String,
}

struct LastBody {
    feed: Feed,
    identity: String,
    checked_at: f64,
    value: Rc<SiteBody>,
}

/// The route's state for one database handle: the read model's cache, the
/// image descriptions and the files already seen on disk. Single-threaded,
/// like the Studio's runtime.
#[derive(Default)]
pub struct PublicSite {
    feed: FeedReader,
    images: SiteImages,
    /// Only hits are remembered: a missing file can appear on the next request,
    /// a present one is never deleted while its post is live. Media names carry
    /// a `?v=<hash>` cache key, so a replaced file arrives under a new path.
    served_files: RefCell<HashSet<String>>,
    last: RefCell<Option<LastBody>>,
}

fn not_found() -> SiteResponse {
    SiteResponse {
        status: 404,
        headers: vec![("content-type", "text/plain; charset=utf-8".into())],
        body: Some("not found\n".into()),
    }
}

/// `Prefer: wait=N` in seconds, at most 25; anything else is no wait.
fn requested_wait(prefer: Option<&str>) -> Duration {
    let seconds = prefer
        .and_then(|value| value.strip_prefix("wait="))
        .filter(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
        .map_or(0.0, foundation::js::number);
    Duration::from_millis((seconds.min(MAX_WAIT_SECONDS) * 1000.0) as u64)
}

impl PublicSite {
    pub fn new() -> Self {
        Self::default()
    }

    /// The whole route. A disconnecting client ends a long poll by dropping
    /// the future.
    pub async fn respond(
        &self,
        db: &BackendDb,
        config: &Config,
        clock: &dyn Clock,
        request: SiteRequest<'_>,
    ) -> domain::Result<SiteResponse> {
        if !studio_config(ApplicationPorts::new(db, clock)).site_enabled()? {
            return Ok(not_found());
        }
        let mut value = self.body(db, config, clock)?;
        let known = request.if_none_match;
        // Keep an unchanged conditional request open instead of making the site
        // repeat HTTP work every three seconds.
        let deadline = Instant::now() + requested_wait(request.prefer);
        while known == Some(value.etag.as_str()) && Instant::now() < deadline {
            let refresh = Duration::from_millis(SITE_FEED_REFRESH_MS as u64);
            tokio::time::sleep(refresh.min(deadline - Instant::now())).await;
            value = self.body(db, config, clock)?;
        }
        let headers = vec![
            ("content-type", "application/json; charset=utf-8".into()),
            ("etag", value.etag.clone()),
            ("cache-control", "no-cache".into()),
        ];
        if known == Some(value.etag.as_str()) {
            return Ok(SiteResponse {
                status: 304,
                headers,
                body: None,
            });
        }
        Ok(SiteResponse {
            status: 200,
            headers,
            body: Some(value.body.clone()),
        })
    }

    /// The current answer (`publicSiteBody`). The read model hands back the
    /// same feed while nothing changed, so the answer is rebuilt only when the
    /// feed or the identity changed, or the refresh interval passed and the
    /// media on disk are looked at again.
    pub fn body(&self, db: &BackendDb, config: &Config, clock: &dyn Clock) -> domain::Result<Rc<SiteBody>> {
        let feed = self.feed.load(db, clock)?;
        let now = clock.now().as_millisecond() as f64;
        let identity = site_identity(db, config, clock)?;
        if let Some(last) = self.last.borrow().as_ref()
            && Rc::ptr_eq(&last.feed, &feed)
            && last.identity == identity
            && now - last.checked_at < SITE_FEED_REFRESH_MS
        {
            return Ok(Rc::clone(&last.value));
        }
        let rendered = feed
            .iter()
            .map(|item| self.served_item(config, item))
            .collect::<domain::Result<Vec<_>>>();
        let items = match rendered {
            Ok(items) => items,
            Err(error) => {
                *self.last.borrow_mut() = None;
                return Err(error);
            }
        };
        let body = format!(
            "{{\"site\":{identity},\"items\":{}}}",
            domain::json::stringify(&Value::Array(items))
        );
        let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(body.as_bytes()));
        let etag = format!("\"{}\"", &digest[..27]);
        let value = Rc::new(SiteBody { body, etag });
        *self.last.borrow_mut() = Some(LastBody {
            feed,
            identity,
            checked_at: now,
            value: Rc::clone(&value),
        });
        Ok(value)
    }

    fn served(&self, config: &Config, public_path: Option<&str>) -> bool {
        let Some(public_path) = public_path.filter(|path| !path.is_empty()) else {
            return false;
        };
        let file = join(&site_dir(config), public_relative(public_path));
        if self.served_files.borrow().contains(&file) {
            return true;
        }
        if !Path::new(&file).exists() {
            return false;
        }
        self.served_files.borrow_mut().insert(file);
        true
    }

    /// `withServedMedia`: the item as the site receives it.
    fn served_item(&self, config: &Config, item: &FeedItem) -> domain::Result<Value> {
        let mut media = Vec::new();
        for entry in &item.media {
            media.extend(self.served_media(config, entry)?);
        }
        let mut media_en = Vec::new();
        for entry in &item.media_en {
            media_en.extend(self.served_media(config, entry)?);
        }
        let image = if self.served(config, item.image.as_deref()) {
            item.image.clone()
        } else {
            first_served_image(&media)
        };
        let image_en = if self.served(config, item.image_en.as_deref()) {
            item.image_en.clone()
        } else {
            first_served_image(&media_en)
        };
        let text = |value: &Option<String>| value.clone().map_or(Value::Null, Value::String);
        let entities: Vec<Value> = item
            .entities
            .iter()
            .map(|entity| {
                json!({
                    "kind": entity.kind, "slug": entity.slug, "title_ru": entity.title_ru,
                    "title_en": entity.title_en, "link_role": entity.link_role,
                })
            })
            .collect();
        let number = |value: f64| Number::from_f64(value).map_or(Value::Null, Value::Number);
        Ok(json!({
            "id": item.id,
            "post_id": number(item.post_id),
            "date": item.date,
            "updated_at_ru": text(&item.updated_at_ru),
            "updated_at_en": text(&item.updated_at_en),
            "text": item.text,
            "text_ru": item.text_ru,
            "text_en": item.text_en,
            "html": item.html,
            "html_en": item.html_en,
            "slug_ru": text(&item.slug_ru),
            "slug_en": text(&item.slug_en),
            "seo_title_ru": text(&item.seo_title_ru),
            "seo_title_en": text(&item.seo_title_en),
            "has_ru": item.has_ru,
            "has_en": item.has_en,
            "media": media.into_iter().map(Value::Object).collect::<Vec<_>>(),
            "media_en": media_en.into_iter().map(Value::Object).collect::<Vec<_>>(),
            "image": text(&image),
            "image_en": text(&image_en),
            "entities": entities,
            "views": number(item.views),
        }))
    }

    /// `servedMedia`: nothing for a file that is not on disk yet, no poster
    /// for a missing one, and the served image's dimensions and responsive
    /// variants when it can be read.
    fn served_media(&self, config: &Config, stored: &SiteMedia) -> domain::Result<Option<SiteMedia>> {
        // The publication manifest also carries worker-only upload ids and disk
        // paths. Only the fields the public renderer consumes cross this boundary,
        // always in this order (absent ones are left out of the JSON).
        let mut entry = MEDIA_FIELDS.map(|key| (key, stored.get(key).cloned()));
        let path = stored.get("path").and_then(Value::as_str).unwrap_or_default();
        let poster = stored.get("poster").and_then(Value::as_str).unwrap_or_default();
        let video = stored.get("type").and_then(Value::as_str) == Some("video");
        let exists = self.served(config, Some(path));
        let poster_exists = poster.is_empty() || self.served(config, Some(poster));
        let image = if exists && poster_exists {
            let root = site_dir(config);
            self.images.site_image(&root, if video { poster } else { path })?
        } else {
            None
        };
        // The version keys are tested here for the cache, and a URL that does not
        // parse fails the answer.
        if exists && poster_exists && versioned(path)? && !poster.is_empty() {
            versioned(poster)?;
        }
        if !exists {
            return Ok(None);
        }
        if !poster_exists {
            entry[3].1 = None;
        } else if let Some(image) = image {
            let responsive: Vec<Value> = image
                .responsive
                .iter()
                .map(|variant| json!({"path": variant.path, "width": variant.width, "height": variant.height}))
                .collect();
            entry[4].1 = Some(image.width.into());
            entry[5].1 = Some(image.height.into());
            entry[if video { 7 } else { 6 }].1 = Some(Value::Array(responsive));
        }
        Ok(Some(
            entry
                .into_iter()
                .filter_map(|(key, value)| Some((key.to_owned(), value?)))
                .collect(),
        ))
    }
}

/// The media fields the public renderer reads, in the order it receives them.
const MEDIA_FIELDS: [&str; 8] = [
    "type",
    "path",
    "alt",
    "poster",
    "width",
    "height",
    "responsive",
    "poster_responsive",
];

fn site_dir(config: &Config) -> String {
    config.site_public_dir.to_string_lossy().into_owned()
}

fn first_served_image(media: &[SiteMedia]) -> Option<String> {
    media
        .iter()
        .find(|entry| entry.get("type").and_then(Value::as_str) != Some("video"))
        .and_then(|entry| entry.get("path").and_then(Value::as_str))
        .map(str::to_owned)
}

/// `JSON.stringify({en: siteIdentity("en"), ru: siteIdentity("ru")})`: what the
/// Studio says the site is, in both languages.
fn site_identity(db: &BackendDb, config: &Config, clock: &dyn Clock) -> domain::Result<String> {
    let studio = studio_config(ApplicationPorts::new(db, clock));
    let mut identity = Map::new();
    for locale in [Locale::En, Locale::Ru] {
        let site = studio.site(locale)?;
        // An install that has not named itself is named by its own domain, which is
        // true and belongs to nobody else.
        let name = if site.name.is_empty() {
            base_url_host(&config.public_base_url)?
        } else {
            site.name
        };
        let profiles: Vec<Value> = site
            .profiles
            .iter()
            .map(|profile| json!({"label": profile.label, "url": profile.url}))
            .collect();
        identity.insert(
            locale.as_str().into(),
            json!({
                "name": name, "tagline": site.tagline, "about": site.about, "bio": site.bio,
                "profiles": profiles, "timezone": studio.site_timezone(locale)?,
            }),
        );
    }
    Ok(domain::json::stringify(&Value::Object(identity)))
}

/// `new URL(PUBLIC_BASE_URL).host`: the host and a non-default port.
fn base_url_host(base: &str) -> domain::Result<String> {
    let url = url::Url::parse(base).map_err(|_| domain::Error::message(format!("Invalid URL: {base}")))?;
    let host = url.host_str().unwrap_or_default();
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wait_follows_the_prefer_header() {
        assert_eq!(requested_wait(None), Duration::ZERO);
        assert_eq!(requested_wait(Some("wait=3")), Duration::from_secs(3));
        assert_eq!(requested_wait(Some("wait=007")), Duration::from_secs(7));
        assert_eq!(
            requested_wait(Some("wait=99999999999999999999999")),
            Duration::from_secs(25)
        );
        assert_eq!(requested_wait(Some("wait=1.5")), Duration::ZERO);
        assert_eq!(requested_wait(Some(" wait=3")), Duration::ZERO);
        assert_eq!(requested_wait(Some("wait=")), Duration::ZERO);
    }

    #[test]
    fn names_an_unnamed_install_by_its_host() {
        assert_eq!(
            base_url_host("https://studio.example.com/x").unwrap(),
            "studio.example.com"
        );
        assert_eq!(base_url_host("http://127.0.0.1:3000").unwrap(), "127.0.0.1:3000");
        assert_eq!(base_url_host("https://example.com:443").unwrap(), "example.com");
    }
}
