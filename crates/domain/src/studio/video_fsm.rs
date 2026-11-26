//! The transport-neutral video workflow: every step a
//! video publication passes through, what each expects and where it leads.
//! Telegram renders the step-specific questions itself.

use std::convert::Infallible;

use content::message::fix_url_slashes;
use foundation::errors::StudioError;
use jiff::Timestamp;
use serde_json::{Map, Value, json};

use crate::application::conversation_flow::{Flow, FlowAcceptance, FlowStep, FlowStepInput, PublicationKind};
use crate::application::ports::JsonObject;
use crate::json::js_string;
use crate::publishing::video_metadata_limits::{
    assert_instagram_caption, assert_youtube_description, assert_youtube_tags, assert_youtube_title,
};
use crate::publishing::video_types::VideoTarget;
use crate::{Error, Result};

/// The metadata questions, in the order the wizard asks them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoWizardStep {
    YoutubeTitle,
    YoutubeDescription,
    YoutubeGameUrl,
    YoutubeTags,
    InstagramCaption,
}

impl VideoWizardStep {
    pub const ALL: [Self; 5] = [
        Self::YoutubeTitle,
        Self::YoutubeDescription,
        Self::YoutubeGameUrl,
        Self::YoutubeTags,
        Self::InstagramCaption,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::YoutubeTitle => "youtube_title",
            Self::YoutubeDescription => "youtube_description",
            Self::YoutubeGameUrl => "youtube_game_url",
            Self::YoutubeTags => "youtube_tags",
            Self::InstagramCaption => "instagram_caption",
        }
    }

    pub fn parse(step: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|candidate| candidate.as_str() == step)
    }
}

pub fn is_video_wizard_step(step: &str) -> bool {
    VideoWizardStep::parse(step).is_some()
}

type VideoStep = FlowStep<JsonObject, Value, Infallible>;
type Accepted = Result<FlowAcceptance<JsonObject, Infallible>>;

fn with(mut data: JsonObject, key: &str, value: Value) -> JsonObject {
    data.insert(key.to_owned(), value);
    data
}

/// `data.selectedTargets ?? []`.
fn selected_targets(data: &JsonObject) -> Vec<VideoTarget> {
    data.get("selectedTargets")
        .and_then(Value::as_array)
        .map(|targets| {
            targets
                .iter()
                .filter_map(|target| target.as_str().and_then(VideoTarget::parse))
                .collect()
        })
        .unwrap_or_default()
}

fn selects(data: &JsonObject, target: &str) -> bool {
    data.get("selectedTargets")
        .and_then(Value::as_array)
        .is_some_and(|targets| targets.iter().any(|selected| selected.as_str() == Some(target)))
}

/// The ISO schedule accumulated so far by the per-target chain.
fn current_schedule(data: &JsonObject) -> JsonObject {
    data.get("schedule")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn pending_schedule_target(selected: &[VideoTarget], schedule: &JsonObject) -> Option<VideoTarget> {
    selected
        .iter()
        .copied()
        .find(|target| !schedule.get(target.as_str()).is_some_and(crate::json::truthy))
}

/// `new Date(String(input)).toISOString()`: a time the transport resolved.
fn iso_time(input: &Value) -> Result<String> {
    foundation::time::parse_iso_instant(&js_string(input))
        .map(foundation::time::to_iso_string)
        .map_err(|_| Error::message("Invalid time value"))
}

fn require_schedule_target(data: &JsonObject) -> Result<VideoTarget> {
    data.get("target")
        .and_then(Value::as_str)
        .and_then(VideoTarget::parse)
        .filter(|target| selected_targets(data).contains(target))
        .ok_or_else(|| StudioError::new("err.video-reopen-publish").into())
}

fn accept_metadata(step: VideoWizardStep, input: Value, data: JsonObject) -> Accepted {
    Ok(FlowAcceptance::data(advance_video_metadata(
        step,
        &js_string(&input),
        data,
    )?))
}

static VIDEO_STEPS: [VideoStep; 12] = [
    FlowStep {
        name: "asset",
        input: Some(FlowStepInput::Media),
        accept: Some(|input, data| Ok(FlowAcceptance::data(with(data, "assetId", input)))),
        next: |_| Some("script"),
        back: None,
    },
    // Renaming a finished draft, and nothing else: the wizard takes every
    // connected platform and goes straight from the upload to its metadata,
    // so this step is only ever entered from "Edit" and nothing follows it.
    FlowStep {
        name: "label",
        input: Some(FlowStepInput::Text),
        accept: Some(|input, data| Ok(FlowAcceptance::data(with(data, "label", input)))),
        next: |_| None,
        back: None,
    },
    // Asked once, right after the upload, and skippable in one tap: the
    // script is written in a file beside the video, so it is at hand exactly
    // here. It stays in the edit menu too, for writing one in afterwards.
    FlowStep {
        name: "script",
        input: Some(FlowStepInput::TextFile),
        accept: Some(|input, data| Ok(FlowAcceptance::data(with(data, "script", input)))),
        next: |data| Some(first_video_metadata_step(&selected_targets(data)).as_str()),
        back: None,
    },
    FlowStep {
        name: "schedule_choice",
        input: None,
        accept: Some(|input, data| Ok(FlowAcceptance::data(with(data, "scheduleMode", input)))),
        next: |data| {
            Some(if data.get("scheduleMode").and_then(Value::as_str) == Some("common") {
                "schedule_common"
            } else {
                "schedule_target"
            })
        },
        back: None,
    },
    // One typed or picked time answers for every selected platform at once,
    // so the step writes the whole schedule rather than a single value the
    // caller would have to fan out again.
    FlowStep {
        name: "schedule_common",
        input: Some(FlowStepInput::Text),
        accept: Some(|input, data| {
            let mut schedule = Map::new();
            for target in selected_targets(&data) {
                schedule.insert(target.as_str().to_owned(), Value::String(iso_time(&input)?));
            }
            Ok(FlowAcceptance::data(with(data, "schedule", Value::Object(schedule))))
        }),
        next: |_| Some("schedule_confirm"),
        back: None,
    },
    // Both the schedule and the platform still waiting for a time come from
    // the accumulated schedule itself. Nothing outside the step recomputes them.
    FlowStep {
        name: "schedule_target",
        input: Some(FlowStepInput::Text),
        accept: Some(|input, data| {
            let target = require_schedule_target(&data)?;
            let mut schedule = current_schedule(&data);
            schedule.insert(target.as_str().to_owned(), Value::String(iso_time(&input)?));
            let next = pending_schedule_target(&selected_targets(&data), &schedule);
            let mut data = with(data, "schedule", Value::Object(schedule));
            if let Some(next) = next {
                data.insert("target".into(), json!(next.as_str()));
            }
            Ok(FlowAcceptance::data(data))
        }),
        next: |data| {
            Some(
                if pending_schedule_target(&selected_targets(data), &current_schedule(data)).is_some() {
                    "schedule_target"
                } else {
                    "schedule_confirm"
                },
            )
        },
        back: None,
    },
    FlowStep {
        name: "schedule_confirm",
        input: None,
        accept: None,
        next: |_| None,
        back: None,
    },
    FlowStep {
        name: "youtube_title",
        input: Some(FlowStepInput::Text),
        accept: Some(metadata_step_accept::<0>),
        next: |_| Some("youtube_description"),
        back: None,
    },
    FlowStep {
        name: "youtube_description",
        input: Some(FlowStepInput::Text),
        accept: Some(metadata_step_accept::<1>),
        next: |_| Some("youtube_game_url"),
        back: Some(|_| Some("youtube_title")),
    },
    FlowStep {
        name: "youtube_game_url",
        input: Some(FlowStepInput::Text),
        accept: Some(metadata_step_accept::<2>),
        next: |_| Some("youtube_tags"),
        back: Some(|_| Some("youtube_description")),
    },
    FlowStep {
        name: "youtube_tags",
        input: Some(FlowStepInput::Text),
        accept: Some(metadata_step_accept::<3>),
        next: |data| {
            Some(if selects(data, "instagram_reels") {
                "instagram_caption"
            } else {
                "schedule_choice"
            })
        },
        back: Some(|_| Some("youtube_game_url")),
    },
    FlowStep {
        name: "instagram_caption",
        input: Some(FlowStepInput::Text),
        accept: Some(metadata_step_accept::<4>),
        next: |_| Some("schedule_choice"),
        back: Some(|data| selects(data, "youtube_shorts").then_some("youtube_tags")),
    },
];

/// The accept of the metadata step at `STEP` in [`VideoWizardStep::ALL`].
fn metadata_step_accept<const STEP: usize>(input: Value, data: JsonObject) -> Accepted {
    accept_metadata(VideoWizardStep::ALL[STEP], input, data)
}

/// The complete video workflow.
pub static VIDEO_FLOW: Flow<JsonObject, Value, Infallible> = Flow {
    kind: PublicationKind::Video,
    steps: &VIDEO_STEPS,
};

pub fn first_video_metadata_step(selected: &[VideoTarget]) -> VideoWizardStep {
    if selected.contains(&VideoTarget::YoutubeShorts) {
        VideoWizardStep::YoutubeTitle
    } else {
        VideoWizardStep::InstagramCaption
    }
}

/// One metadata answer, checked here rather than at publication: this is the
/// moment the operator can still decide what to cut. A rejection that
/// arrives when the video is due is a slot missed for two characters.
pub fn advance_video_metadata(step: VideoWizardStep, text: &str, data: JsonObject) -> Result<JsonObject> {
    let dash_empty = |text: &str| if text == "-" { String::new() } else { text.to_owned() };
    Ok(match step {
        VideoWizardStep::YoutubeTitle => {
            assert_youtube_title(text)?;
            with(data, "youtube_title", json!(text))
        }
        VideoWizardStep::YoutubeDescription => {
            let description = dash_empty(text);
            assert_youtube_description(&description)?;
            with(data, "youtube_description", json!(description))
        }
        VideoWizardStep::YoutubeGameUrl => {
            let url = if text == "-" {
                String::new()
            } else {
                fix_url_slashes(text)
            };
            with(data, "youtube_game_url", json!(url))
        }
        VideoWizardStep::YoutubeTags => {
            let tags: Vec<String> = if text == "-" {
                Vec::new()
            } else {
                text.split(',')
                    .map(|tag| foundation::js::trim(tag).to_owned())
                    .filter(|tag| !tag.is_empty())
                    .collect()
            };
            assert_youtube_tags(&tags)?;
            with(data, "youtube_tags", json!(tags))
        }
        VideoWizardStep::InstagramCaption => {
            let caption = dash_empty(text);
            assert_instagram_caption(&caption)?;
            with(data, "instagram_caption", json!(caption))
        }
    })
}

/// A schedule the flow accumulated, as the instants a schedule call takes.
pub fn video_schedule_dates(schedule: &JsonObject) -> Result<Vec<(VideoTarget, Timestamp)>> {
    schedule
        .iter()
        .filter_map(|(target, at)| VideoTarget::parse(target).map(|target| (target, at)))
        .map(|(target, at)| {
            foundation::time::parse_iso_instant(&js_string(at))
                .map(|at| (target, at))
                .map_err(|_| Error::message("Invalid time value"))
        })
        .collect()
}
