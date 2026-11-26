//! `stories.sendStory` as this crate builds it against what mtcute 0.32.1
//! sent for the same Story (`send_story.golden.json`, recorded from the
//! mtcute sidecar's own `sendStoryParams` before it was deleted). The
//! recorded wire bytes are read back with grammers' layer-233 definitions and
//! compared constructor by constructor and field by field, then byte for
//! byte. The upload itself is grammers' (`upload.saveFilePart`, 512 KiB parts,
//! an MD5 where mtcute sent an empty one), so the recorded `InputFile` is used
//! as uploaded.

use std::path::{Path, PathBuf};

use grammers_client::tl::{Deserializable as _, Identifiable as _, Serializable as _, functions, types};
use mtproto::stories::{input_media, send_story_request};
use providers::adapters::telegram_stories::{CaptionLink, StoryCaption, StoryRequest, StoryUploadMedia};
use serde_json::Value;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
        .collect()
}

fn long(value: &Value) -> i64 {
    value.as_str().unwrap().parse().unwrap()
}

/// What the adapter hands over for the recorded sidecar request.
fn story_request(recorded: &Value) -> StoryRequest {
    let media = &recorded["media"];
    let path = fixtures().join(media["path"].as_str().unwrap());
    let media = match media["type"].as_str().unwrap() {
        "photo" => StoryUploadMedia::Photo { path },
        _ => {
            // The adapter always asks for a streamable video.
            assert_eq!(media["supportsStreaming"], true);
            StoryUploadMedia::Video {
                path,
                width: media["width"].as_f64().unwrap(),
                height: media["height"].as_f64().unwrap(),
                duration: media["duration"].as_f64().unwrap(),
            }
        }
    };
    StoryRequest {
        peer: recorded["peer"].as_str().unwrap().into(),
        media,
        caption: StoryCaption {
            text: recorded["caption"]["text"].as_str().unwrap().into(),
            links: recorded["caption"]["links"]
                .as_array()
                .unwrap()
                .iter()
                .map(|link| CaptionLink {
                    offset: link["offset"].as_u64().unwrap(),
                    length: link["length"].as_u64().unwrap(),
                    url: link["url"].as_str().unwrap().into(),
                })
                .collect(),
        },
        period_seconds: recorded["periodSeconds"].as_u64().unwrap(),
    }
}

#[test]
fn send_story_is_the_request_mtcute_sent() {
    let golden: Value = serde_json::from_str(
        &std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/send_story.golden.json")).unwrap(),
    )
    .unwrap();
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 2);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let request = story_request(&case["request"]);
        let sent = case["calls"]
            .as_array()
            .unwrap()
            .iter()
            .find(|call| call["_"] == "stories.sendStory")
            .unwrap();
        let peer = types::InputPeerChannel {
            channel_id: sent["peer"]["channel_id"].as_i64().unwrap(),
            access_hash: long(&sent["peer"]["access_hash"]),
        };
        let file = &sent["media"]["file"];
        let uploaded = types::InputFile {
            id: long(&file["id"]),
            parts: file["parts"].as_i64().unwrap() as i32,
            name: file["name"].as_str().unwrap().into(),
            md5_checksum: file["md5_checksum"].as_str().unwrap().into(),
        };
        let media_path = fixtures().join(case["request"]["media"]["path"].as_str().unwrap());
        let head: Vec<u8> = std::fs::read(&media_path).unwrap().into_iter().take(12).collect();

        let built = send_story_request(
            &request,
            peer.into(),
            input_media(&request.media, uploaded.into(), &head),
            1,
        );

        let wire = hex(case["sendStoryWire"].as_str().unwrap());
        // A bare function body follows its constructor id.
        let (id, body) = wire.split_at(4);
        assert_eq!(
            id,
            functions::stories::SendStory::CONSTRUCTOR_ID.to_le_bytes(),
            "{name}"
        );
        let recorded = functions::stories::SendStory::from_bytes(body).unwrap();
        assert_eq!(built, recorded, "{name}");
        assert_eq!(built.to_bytes(), wire, "{name}");
    }
}
