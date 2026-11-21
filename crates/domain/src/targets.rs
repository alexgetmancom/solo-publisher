//! The catalogue of publication targets (`botTargets.ts`): every target id,
//! its label, language and kind, what form of publication it carries, and the
//! on/off record drafts and presets keep their selection in.

use content::Locale;
use serde_json::{Map, Value};

use crate::json;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetKind {
    Telegram,
    Site,
    Social,
}

/// What a target can carry. X carries a post at `x` and an Article at
/// `x_article`; nothing branches on the distinction, callers ask the catalogue
/// for the kind they are publishing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicationForm {
    Post,
    Article,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TargetDefinition {
    pub id: &'static str,
    pub label: &'static str,
    pub locale: Locale,
    pub kind: TargetKind,
    pub carries: PublicationForm,
    /// The connection that delivers this target when it is not its own.
    pub connected_as: Option<&'static str>,
}

const fn target(id: &'static str, label: &'static str, locale: Locale, kind: TargetKind) -> TargetDefinition {
    TargetDefinition {
        id,
        label,
        locale,
        kind,
        carries: PublicationForm::Post,
        connected_as: None,
    }
}

pub const TARGETS: [TargetDefinition; 11] = [
    target("telegram", "Telegram", Locale::Ru, TargetKind::Telegram),
    target("site_ru", "Site RU", Locale::Ru, TargetKind::Site),
    target("site_en", "Site EN", Locale::En, TargetKind::Site),
    target("threads_ru", "Threads RU", Locale::Ru, TargetKind::Social),
    target("threads_en", "Threads EN", Locale::En, TargetKind::Social),
    target("x", "X (Twitter)", Locale::En, TargetKind::Social),
    TargetDefinition {
        carries: PublicationForm::Article,
        connected_as: Some("x"),
        ..target("x_article", "X Article", Locale::En, TargetKind::Social)
    },
    target("discord", "Discord", Locale::En, TargetKind::Social),
    target("telegram_stories", "Telegram Stories", Locale::Ru, TargetKind::Social),
    target(
        "instagram_stories_ru",
        "Instagram Stories RU",
        Locale::Ru,
        TargetKind::Social,
    ),
    target(
        "instagram_stories",
        "Instagram Stories EN",
        Locale::En,
        TargetKind::Social,
    ),
];

/// Routes whose credentials are provisioned separately and whose remaining
/// connection step is enabling the publication target. OAuth account routes
/// are absent because their consent callback registers them itself.
const DIRECT_CONNECT_TARGET_IDS: [&str; 5] = [
    "telegram",
    "discord",
    "telegram_stories",
    "instagram_stories_ru",
    "instagram_stories",
];

pub fn direct_connect_targets() -> Vec<&'static TargetDefinition> {
    TARGETS
        .iter()
        .filter(|target| DIRECT_CONNECT_TARGET_IDS.contains(&target.id))
        .collect()
}

pub const THREADS_TARGETS: [&str; 2] = ["threads_ru", "threads_en"];
pub const INSTAGRAM_STORY_TARGETS: [&str; 2] = ["instagram_stories", "instagram_stories_ru"];
pub const TELEGRAM_STORY_TARGETS: [&str; 1] = ["telegram_stories"];

pub fn target_definition(target: &str) -> Option<&'static TargetDefinition> {
    TARGETS.iter().find(|definition| definition.id == target)
}

/// The connection that delivers a target. A target is its own connection
/// unless it says otherwise: `x_article` rides the X account already connected
/// at `x`, and connecting the same account twice to serve one more of its
/// surfaces is exactly the duplicate this avoids.
pub fn target_connection(target: &str) -> &str {
    match target_definition(target) {
        Some(definition) => definition.connected_as.unwrap_or(definition.id),
        None => target,
    }
}

/// The targets that carry one form of publication.
pub fn targets_for(form: PublicationForm) -> impl Iterator<Item = &'static TargetDefinition> {
    TARGETS.iter().filter(move |target| target.carries == form)
}

pub fn target_locale(target: &str) -> Option<Locale> {
    target_definition(target).map(|definition| definition.locale)
}

pub fn is_known_target(target: &str) -> bool {
    target_definition(target).is_some()
}

pub fn is_site_target(target: &str) -> bool {
    target_definition(target).is_some_and(|definition| definition.kind == TargetKind::Site)
}

/// Story targets take one media item and publish it full-bleed, which is why
/// generated text cards, Story-sized variants and the publish-mode gate all key
/// off this.
pub fn is_story_target(target: &str) -> bool {
    INSTAGRAM_STORY_TARGETS.contains(&target) || TELEGRAM_STORY_TARGETS.contains(&target)
}

/// A target selection: the on/off record a draft keeps in `targets_json`, in
/// the order its keys were written.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TargetMap(Vec<(String, bool)>);

impl TargetMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// `parseTargets`: the complete target map persisted by draft creation.
    /// Anything but a JSON object reads as no targets; every value is read
    /// for its truthiness.
    pub fn parse(value: Option<&str>) -> Self {
        match value.filter(|text| !text.is_empty()).map(serde_json::from_str::<Value>) {
            Some(Ok(Value::Object(object))) => Self::from_json(&object),
            _ => Self::default(),
        }
    }

    pub fn from_json(object: &Map<String, Value>) -> Self {
        Self(
            json::object_entries(object)
                .map(|(key, value)| (key.clone(), json::truthy(value)))
                .collect(),
        )
    }

    pub fn get(&self, target: &str) -> bool {
        self.0.iter().any(|(key, enabled)| key == target && *enabled)
    }

    /// `{ ...targets, [target]: enabled }`: an existing key keeps its place.
    pub fn set(&mut self, target: &str, enabled: bool) {
        match self.0.iter_mut().find(|(key, _)| key == target) {
            Some(entry) => entry.1 = enabled,
            None => self.0.push((target.to_owned(), enabled)),
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, bool)> {
        self.0.iter().map(|(key, enabled)| (key.as_str(), *enabled))
    }

    pub fn enabled(&self) -> impl Iterator<Item = &str> {
        self.iter().filter(|(_, enabled)| *enabled).map(|(key, _)| key)
    }

    pub fn any_enabled(&self) -> bool {
        self.enabled().next().is_some()
    }

    /// The same keys, each value replaced.
    pub fn map(&self, mut enabled: impl FnMut(&str, bool) -> bool) -> Self {
        Self(
            self.0
                .iter()
                .map(|(key, value)| (key.clone(), enabled(key, *value)))
                .collect(),
        )
    }

    pub fn to_json_value(&self) -> Map<String, Value> {
        self.0
            .iter()
            .map(|(key, enabled)| (key.clone(), Value::Bool(*enabled)))
            .collect()
    }

    /// `JSON.stringify(targets)`.
    pub fn to_json(&self) -> String {
        json::stringify_object(&self.to_json_value())
    }
}

/// As the object `JSON.stringify` writes.
impl serde::Serialize for TargetMap {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_map(self.0.iter().map(|(key, enabled)| (key, enabled)))
    }
}

impl FromIterator<(String, bool)> for TargetMap {
    fn from_iter<I: IntoIterator<Item = (String, bool)>>(iter: I) -> Self {
        let mut map = Self::default();
        for (key, enabled) in iter {
            map.set(&key, enabled);
        }
        map
    }
}

/// A selection of target ids as the on/off record every draft and preset uses.
/// Ids the catalogue does not know are dropped, so a target retired after a
/// Studio saved its defaults degrades to "off" instead of a broken record.
pub fn targets_record(selected: &[&str], form: PublicationForm) -> TargetMap {
    targets_for(form)
        .map(|target| (target.id.to_owned(), selected.contains(&target.id)))
        .collect()
}

/// The named target presets, in the order `presetName` tries them.
pub fn preset(name: &str) -> Option<TargetMap> {
    let select = |enabled: fn(&TargetDefinition) -> bool| -> TargetMap {
        targets_for(PublicationForm::Post)
            .map(|target| (target.id.to_owned(), enabled(target)))
            .collect()
    };
    match name {
        "full" => Some(select(|_| true)),
        "ru" => Some(select(|target| target.locale == Locale::Ru)),
        "en" => Some(select(|target| target.locale == Locale::En)),
        "tg" => Some(select(|target| target.id == "telegram")),
        _ => None,
    }
}

const PRESET_NAMES: [&str; 4] = ["full", "ru", "en", "tg"];

/// Names the preset a target selection matches, or `manual` when it matches none.
pub fn preset_name(targets: &TargetMap) -> &'static str {
    PRESET_NAMES
        .into_iter()
        .find(|name| {
            let preset = preset(name).expect("every listed preset exists");
            TARGETS
                .iter()
                .all(|target| targets.get(target.id) == preset.get(target.id))
        })
        .unwrap_or("manual")
}

/// Whether anything this Studio publishes to carries a Story. Callers pass
/// the selection already narrowed by the registry.
pub fn story_targets_enabled(targets: &TargetMap) -> bool {
    targets.enabled().any(is_story_target)
}

/// What a generated Story card would be for, given a target selection: the
/// Stories that would carry it, and the site that would illustrate with it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoryCardUse {
    pub stories: bool,
    pub site: bool,
}

pub fn story_card_use(targets: &TargetMap) -> StoryCardUse {
    StoryCardUse {
        stories: story_targets_enabled(targets),
        site: targets.enabled().any(is_site_target),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_and_routing_match_the_typescript_catalogue() {
        assert_eq!(target_connection("x_article"), "x");
        assert_eq!(target_connection("telegram"), "telegram");
        assert_eq!(target_connection("unknown"), "unknown");
        assert_eq!(
            targets_for(PublicationForm::Article)
                .map(|target| target.id)
                .collect::<Vec<_>>(),
            ["x_article"]
        );
        let ru = preset("ru").unwrap();
        assert_eq!(preset_name(&ru), "ru");
        assert!(!ru.get("x_article"));
        assert_eq!(preset_name(&targets_record(&["telegram"], PublicationForm::Post)), "tg");
        assert_eq!(preset_name(&TargetMap::parse(Some(r#"{"x":true}"#))), "manual");
        assert_eq!(TargetMap::parse(Some("[1]")), TargetMap::default());
        assert_eq!(
            TargetMap::parse(Some(r#"{"telegram":1,"x":0,"discord":"yes"}"#)).to_json(),
            r#"{"telegram":true,"x":false,"discord":true}"#
        );
    }
}
