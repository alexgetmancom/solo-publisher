//! The VAAPI recipe against `remote_recipe.golden.json`, recorded from the
//! media processor's builder before it was deleted: what VM-106 ran must stay
//! byte-identical.

use std::path::Path;

use serde_json::Value;
use vertical_media::{
    Encoder, needs_vertical_blur, site_video_ffmpeg_args, story_ffmpeg_args, telegram_video_kbps,
    vertical_image_ffmpeg_args,
};

fn golden() -> Value {
    serde_json::from_str(include_str!("remote_recipe.golden.json")).unwrap()
}

fn path<'a>(inputs: &'a Value, name: &str) -> &'a Path {
    Path::new(inputs[name].as_str().unwrap())
}

#[test]
fn vaapi_argv_is_the_typescript_argv() {
    let golden = golden();
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 8);
    for case in cases {
        let inputs = &case["inputs"];
        let blur = inputs["blur"].as_bool().unwrap();
        let argv = match case["recipe"].as_str().unwrap() {
            "story" => story_ffmpeg_args(
                Encoder::Vaapi,
                path(inputs, "input"),
                path(inputs, "standard"),
                path(inputs, "telegram"),
                inputs["telegramKbps"].as_u64().unwrap(),
                blur,
            ),
            "site_video" => site_video_ffmpeg_args(Encoder::Vaapi, path(inputs, "input"), path(inputs, "output"), blur),
            "image" => vertical_image_ffmpeg_args(path(inputs, "input"), path(inputs, "output"), blur),
            other => panic!("unknown recipe {other}"),
        };
        let expected: Vec<&str> = case["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|arg| arg.as_str().unwrap())
            .collect();
        assert_eq!(argv, expected, "{} {inputs}", case["recipe"]);
    }
}

#[test]
fn bitrate_and_blur_are_the_typescript_arithmetic() {
    let golden = golden();
    for row in golden["telegramKbps"].as_array().unwrap() {
        let kbps = telegram_video_kbps(row["duration"].as_f64().unwrap(), row["audioBitrate"].as_f64().unwrap());
        assert_eq!(kbps, row["kbps"].as_u64().unwrap(), "{row}");
    }
    for row in golden["verticalBlur"].as_array().unwrap() {
        let blur = needs_vertical_blur(row["width"].as_f64().unwrap(), row["height"].as_f64().unwrap());
        assert_eq!(blur, row["blur"].as_bool().unwrap(), "{row}");
    }
}
