//! The public site's read side (the body of `GET /api/public/site`): the published-post read model, the description of
//! served images, the video asset lookup, and the route logic — status,
//! headers and body for a request's `If-None-Match` and `Prefer: wait=N` —
//! ready for the HTTP layer to mount.

mod feed;
mod image_size;
mod images;
pub mod paths;
mod site;
mod video_asset;

pub use feed::{Feed, FeedEntity, FeedItem, FeedReader, SiteMedia};
pub use image_size::{ImageSize, image_size, image_size_from_file};
pub use images::{ImageDescription, SiteImages, Variant};
pub use site::{PublicSite, SiteBody, SiteRequest, SiteResponse};
pub use video_asset::{VideoAsset, public_video_asset};
