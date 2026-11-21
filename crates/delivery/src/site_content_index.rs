//! `delivery/site-content-index.ts`: the public pages a site cycle changed.

use std::collections::BTreeSet;

use db::BackendDb;
use domain::application::ports::Clock;
use foundation::config::Config;
use public_site::FeedReader;

/// `siteUrlsForIndexNow`: the canonical, visible pages of the publications
/// completed in this site cycle.
///
/// A reader of its own: the feed just changed under these publications, so a
/// cached one would be rebuilt anyway.
pub fn site_urls_for_index_now(
    db: &BackendDb,
    config: &Config,
    clock: &dyn Clock,
    publication_keys: &BTreeSet<String>,
) -> domain::Result<Vec<String>> {
    if publication_keys.is_empty() {
        return Ok(Vec::new());
    }
    let base = config
        .public_base_url
        .strip_suffix('/')
        .unwrap_or(&config.public_base_url);
    let feed = FeedReader::default().load(db, clock)?;
    Ok(feed
        .iter()
        .filter(|post| publication_keys.contains(&post.id))
        .flat_map(|post| {
            let id = foundation::js::number_to_string(post.post_id);
            let en = post
                .slug_en
                .as_deref()
                .filter(|slug| post.has_en && !slug.is_empty())
                .map(|slug| format!("{base}/{id}/{slug}/"));
            let ru = post
                .slug_ru
                .as_deref()
                .filter(|slug| post.has_ru && !slug.is_empty())
                .map(|slug| format!("{base}/ru/{id}/{slug}/"));
            [en, ru]
        })
        .flatten()
        .collect())
}
