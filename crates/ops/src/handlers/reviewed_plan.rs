//! The reviewed plans `site-display-repair` and `site-metadata` read back
//! from a file: their exact shape, an unknown field refused (serde names the
//! line and column), then what the types cannot say. Text limits count UTF-16
//! units, as the plans' first validator did.

use content::Locale;
use foundation::text::{TrimText, utf16_len};
use foundation::time::is_iso_instant;
use serde::Deserialize;
use serde::de::DeserializeOwned;

use crate::context::OpError;

/// `site-display-repair`'s plan: modification dates to restore.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DisplayPlan {
    version: u64,
    pub(crate) dates: Vec<DateRestoration>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DateRestoration {
    pub(crate) post_id: i64,
    #[serde(with = "domain::json::locale")]
    pub(crate) locale: Locale,
    pub(crate) expected_updated_at: String,
    /// Required, and `null` clears the date.
    #[serde(deserialize_with = "Option::deserialize")]
    pub(crate) restore_updated_at: Option<String>,
    pub(crate) content_sha256: String,
}

/// `site-metadata`'s plan: search titles and image descriptions.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MetadataPlan {
    version: u64,
    pub(crate) items: Vec<MetadataItem>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MetadataItem {
    pub(crate) post_id: i64,
    #[serde(with = "domain::json::locale")]
    pub(crate) locale: Locale,
    pub(crate) text_sha256: String,
    /// Trimmed.
    #[serde(default)]
    pub(crate) seo_title: Option<String>,
    /// Absent: the title must still be empty. `null`: it must still be unset.
    #[serde(default, deserialize_with = "domain::json::double_option")]
    pub(crate) expected_seo_title: Option<Option<String>>,
    #[serde(default)]
    pub(crate) images: Vec<PlanImage>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PlanImage {
    pub(crate) path: String,
    /// Trimmed.
    pub(crate) alt: String,
    #[serde(default)]
    pub(crate) expected_alt: Option<String>,
}

impl DisplayPlan {
    pub(crate) fn parse(file: &[u8]) -> Result<Self, OpError> {
        let plan: Self = deserialize(file)?;
        require(plan.version == 1, "version", "must be 1")?;
        for (index, date) in plan.dates.iter().enumerate() {
            let at = |field: &str| format!("dates[{index}].{field}");
            require(date.post_id > 0, &at("post_id"), "must be a positive integer")?;
            require(
                is_iso_instant(&date.expected_updated_at),
                &at("expected_updated_at"),
                ISO,
            )?;
            require(
                date.restore_updated_at.as_deref().is_none_or(is_iso_instant),
                &at("restore_updated_at"),
                ISO,
            )?;
            require(is_sha256(&date.content_sha256), &at("content_sha256"), SHA256)?;
        }
        Ok(plan)
    }
}

impl MetadataPlan {
    pub(crate) fn parse(file: &[u8]) -> Result<Self, OpError> {
        let mut plan: Self = deserialize(file)?;
        require(plan.version == 1, "version", "must be 1")?;
        require(!plan.items.is_empty(), "items", "must name at least one locale")?;
        for (index, item) in plan.items.iter_mut().enumerate() {
            let at = |field: &str| format!("items[{index}].{field}");
            require(item.post_id > 0, &at("post_id"), "must be a positive integer")?;
            require(is_sha256(&item.text_sha256), &at("text_sha256"), SHA256)?;
            if let Some(title) = &mut item.seo_title {
                *title = title.trim_text().to_owned();
                require(
                    (1..=65).contains(&utf16_len(title)),
                    &at("seo_title"),
                    "must have 1 to 65 characters",
                )?;
            }
            if let Some(Some(expected)) = &item.expected_seo_title {
                require(
                    utf16_len(expected) <= 65,
                    &at("expected_seo_title"),
                    "must have at most 65 characters",
                )?;
            }
            for (image_index, image) in item.images.iter_mut().enumerate() {
                let at = |field: &str| format!("items[{index}].images[{image_index}].{field}");
                require(!image.path.is_empty(), &at("path"), "must not be empty")?;
                image.alt = image.alt.trim_text().to_owned();
                require(
                    (1..=500).contains(&utf16_len(&image.alt)),
                    &at("alt"),
                    "must have 1 to 500 characters",
                )?;
                if let Some(expected) = &image.expected_alt {
                    require(
                        utf16_len(expected) <= 500,
                        &at("expected_alt"),
                        "must have at most 500 characters",
                    )?;
                }
            }
        }
        Ok(plan)
    }
}

const ISO: &str = "must be an ISO timestamp with an offset";
const SHA256: &str = "must be a lowercase hex SHA-256";

fn deserialize<T: DeserializeOwned>(file: &[u8]) -> Result<T, OpError> {
    serde_json::from_slice(file).map_err(|error| OpError::Failed(format!("Invalid plan: {error}")))
}

fn require(holds: bool, field: &str, rule: &str) -> Result<(), OpError> {
    if holds {
        Ok(())
    } else {
        Err(OpError::Failed(format!("Invalid plan: {field} {rule}")))
    }
}

fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}
