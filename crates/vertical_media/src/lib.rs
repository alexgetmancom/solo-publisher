//! The vertical (1080×1920) media recipe: one source into the Story shapes —
//! a standard render and, for a video, a Telegram variant that fits its upload
//! ceiling — and the site's single standard render.
//!
//! There is one recipe and two executors: the Studio's local one encodes on
//! the CPU, the remote media processor (`crates/media_processor`) on a VAAPI
//! render node. [`Encoder`] is that capability, and it is the only thing the
//! argv branches on; the cadence, the blur, the overlay and the rate ladder
//! are the same for both.

use std::path::Path;

/// AAC packets can extend the muxed duration a few milliseconds past the
/// cutoff; the margin keeps the finished MP4 within the 59-second Story
/// contract.
pub const STORY_MAX_DURATION_SECONDS: f64 = 58.9;
const VERTICAL_ASPECT_RATIO: f64 = 9.0 / 16.0;
/// Within five percent of 9:16, a plain contain render.
const VERTICAL_ASPECT_TOLERANCE: f64 = 0.05;
const VERTICAL_SCALE_FILTER: &str =
    "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black";
const VERTICAL_FOREGROUND_FILTER: &str = "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2";
/// The backdrop is blurred at 540×960 and only then scaled up: the ten-pass
/// blur over every full-resolution frame cost four times the encode.
const VERTICAL_VIDEO_BACKGROUND_FILTER: &str = "scale=540:960:force_original_aspect_ratio=increase:force_divisible_by=2,crop=540:960,boxblur=10:4,eq=brightness=-0.10:saturation=0.82,scale=1080:1920";
const VERTICAL_IMAGE_BACKGROUND_FILTER: &str = "scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2,crop=1080:1920,boxblur=20:10,eq=brightness=-0.10:saturation=0.82";
/// The site and Story standard renders share one ladder; Telegram gets its
/// own ceiling and rides it flat, because the cap is the delivery limit rather
/// than headroom for a peak.
const STANDARD_RATE: Rate = Rate {
    kbps: 3150,
    max_kbps: 3300,
};
/// One keyframe every 50 frames on every Story leg.
const STORY_GOP: &str = "50";
/// The render node [`Encoder::Vaapi`] opens.
pub const VAAPI_DEVICE: &str = "/dev/dri/renderD128";

/// Where the frames are encoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoder {
    /// `libx264` on the CPU.
    Software,
    /// `h264_vaapi` on the Intel render node, which needs the device opened
    /// before the input and the frames uploaded to it before the split.
    Vaapi,
}

impl Encoder {
    /// Everything before `-i`.
    fn device_args(self) -> Vec<String> {
        match self {
            Self::Software => vec!["-y".to_owned()],
            Self::Vaapi => vec![
                "-init_hw_device".to_owned(),
                format!("vaapi=va:{VAAPI_DEVICE}"),
                "-filter_hw_device".to_owned(),
                "va".to_owned(),
                "-y".to_owned(),
            ],
        }
    }

    /// The filter that hands the finished frames to the encoder.
    fn upload_filter(self) -> &'static str {
        match self {
            Self::Software => "",
            Self::Vaapi => "format=nv12,hwupload,",
        }
    }

    /// `-c:v` and what the codec needs spelled out: VAAPI receives frames
    /// already on the device, libx264 needs the pixel format and a preset.
    fn codec_args(self) -> &'static [&'static str] {
        match self {
            Self::Software => &["-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p"],
            Self::Vaapi => &["-c:v", "h264_vaapi"],
        }
    }
}

#[derive(Clone, Copy)]
struct Rate {
    kbps: u64,
    max_kbps: u64,
}

/// A source not within tolerance of 9:16 gets the blurred backdrop instead
/// of black bars; an unmeasured one (zero) does not.
pub fn needs_vertical_blur(width: f64, height: f64) -> bool {
    if !(width > 0.0 && height > 0.0) {
        return false;
    }
    (width / height / VERTICAL_ASPECT_RATIO - 1.0).abs() > VERTICAL_ASPECT_TOLERANCE
}

/// 8.5 MiB for the video after the copied audio and the container's overhead:
/// a real margin below the 9.5 MiB Story upload limit, since VAAPI rate
/// control can overshoot on very short clips.
pub fn telegram_video_kbps(duration: f64, audio_bitrate: f64) -> u64 {
    let target_bits = 8.5 * 1024.0 * 1024.0 * 8.0;
    ((target_bits / duration - audio_bitrate - 24_000.0) / 1000.0)
        .floor()
        .max(150.0) as u64
}

/// The Story pair off one filter graph: `standard` and the Telegram variant
/// at `telegram_kbps`, both cut at [`STORY_MAX_DURATION_SECONDS`].
pub fn story_ffmpeg_args(
    encoder: Encoder,
    input: &Path,
    standard_output: &Path,
    telegram_output: &Path,
    telegram_kbps: u64,
    blur: bool,
) -> Vec<String> {
    let mut args = video_input(encoder, input, vertical_video_filter(encoder, true, blur, 2));
    let story = Some(STORY_MAX_DURATION_SECONDS);
    args.extend(output_leg(encoder, "[out0]", STANDARD_RATE, story, standard_output));
    let telegram = Rate {
        kbps: telegram_kbps,
        max_kbps: telegram_kbps,
    };
    args.extend(output_leg(encoder, "[out1]", telegram, story, telegram_output));
    args
}

/// The site's one standard render: the whole source, no keyframe interval.
pub fn site_video_ffmpeg_args(encoder: Encoder, input: &Path, output: &Path, blur: bool) -> Vec<String> {
    let mut args = video_input(encoder, input, vertical_video_filter(encoder, false, blur, 1));
    args.extend(output_leg(encoder, "[out0]", STANDARD_RATE, None, output));
    args
}

/// One still: no video encoder, so the same on every executor.
pub fn vertical_image_ffmpeg_args(input: &Path, output: &Path, blur: bool) -> Vec<String> {
    let mut args = vec!["-y".to_owned(), "-i".to_owned(), path(input)];
    args.push(if blur { "-filter_complex" } else { "-vf" }.to_owned());
    args.push(vertical_image_filter(blur));
    args.extend(["-frames:v", "1", "-q:v", "2"].map(str::to_owned));
    args.push(path(output));
    args
}

fn video_input(encoder: Encoder, input: &Path, filter: String) -> Vec<String> {
    let mut args = encoder.device_args();
    args.extend(["-i".to_owned(), path(input), "-filter_complex".to_owned(), filter]);
    args
}

/// The source cadence is kept for both site and Stories: a 24/30 FPS input
/// does not become duplicate frames, and real 60 FPS motion is not dropped.
fn vertical_video_filter(encoder: Encoder, story: bool, blur: bool, split_outputs: usize) -> String {
    let trim = if story {
        format!("trim=duration={STORY_MAX_DURATION_SECONDS},")
    } else {
        String::new()
    };
    let labels: String = (0..split_outputs).map(|index| format!("[out{index}]")).collect();
    let split = format!("{}split={split_outputs}{labels}", encoder.upload_filter());
    if !blur {
        return format!("[0:v:0]{trim}{VERTICAL_SCALE_FILTER},{split}");
    }
    format!(
        "[0:v:0]{trim}split=2[background-source][foreground-source];[background-source]{VERTICAL_VIDEO_BACKGROUND_FILTER}[background];[foreground-source]{VERTICAL_FOREGROUND_FILTER}[foreground];[background][foreground]overlay=(W-w)/2:(H-h)/2,{split}"
    )
}

fn vertical_image_filter(blur: bool) -> String {
    if !blur {
        return VERTICAL_SCALE_FILTER.into();
    }
    format!(
        "[0:v:0]split=2[background-source][foreground-source];[background-source]{VERTICAL_IMAGE_BACKGROUND_FILTER}[background];[foreground-source]{VERTICAL_FOREGROUND_FILTER}[foreground];[background][foreground]overlay=(W-w)/2:(H-h)/2"
    )
}

/// One encoded output off a filter-graph label. A Story leg has the keyframe
/// interval and the cut; the site leg has neither.
fn output_leg(encoder: Encoder, label: &str, rate: Rate, story: Option<f64>, output: &Path) -> Vec<String> {
    let mut leg: Vec<String> = ["-map", label, "-map", "0:a?"].map(str::to_owned).to_vec();
    leg.extend(encoder.codec_args().iter().map(|arg| (*arg).to_owned()));
    leg.extend([
        "-b:v".to_owned(),
        format!("{}k", rate.kbps),
        "-maxrate".to_owned(),
        format!("{}k", rate.max_kbps),
        "-bufsize".to_owned(),
        format!("{}k", rate.max_kbps * 2),
    ]);
    if story.is_some() {
        leg.extend(["-g", STORY_GOP].map(str::to_owned));
    }
    // Copied rather than re-encoded: telegram_video_kbps budgets the video
    // around the source audio's own bitrate, and an encoder that decided its
    // own would spend that budget without telling anyone.
    leg.extend(["-c:a", "copy", "-tag:v", "avc1", "-movflags", "+faststart"].map(str::to_owned));
    if let Some(duration) = story {
        leg.extend(["-t".to_owned(), duration.to_string()]);
    }
    leg.push(path(output));
    leg
}

fn path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The local executor's argv, as it was before the recipe was shared.
    #[test]
    fn software_story_and_image_argv() {
        assert!(!needs_vertical_blur(1080.0, 1920.0));
        assert!(needs_vertical_blur(1920.0, 1080.0));
        assert!(!needs_vertical_blur(0.0, 1080.0));
        assert_eq!(telegram_video_kbps(10.0, 128_000.0), 6_978);
        assert_eq!(telegram_video_kbps(10_000.0, 0.0), 150);
        let args = story_ffmpeg_args(
            Encoder::Software,
            Path::new("/in.mp4"),
            Path::new("/s.mp4"),
            Path::new("/t.mp4"),
            900,
            false,
        );
        assert_eq!(
            args.join(" "),
            "-y -i /in.mp4 -filter_complex [0:v:0]trim=duration=58.9,scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,split=2[out0][out1] \
             -map [out0] -map 0:a? -c:v libx264 -preset medium -pix_fmt yuv420p -b:v 3150k -maxrate 3300k -bufsize 6600k -g 50 -c:a copy -tag:v avc1 -movflags +faststart -t 58.9 /s.mp4 \
             -map [out1] -map 0:a? -c:v libx264 -preset medium -pix_fmt yuv420p -b:v 900k -maxrate 900k -bufsize 1800k -g 50 -c:a copy -tag:v avc1 -movflags +faststart -t 58.9 /t.mp4"
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        );
        assert_eq!(
            vertical_image_ffmpeg_args(Path::new("/in.jpg"), Path::new("/o.jpg"), false).join(" "),
            "-y -i /in.jpg -vf scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black -frames:v 1 -q:v 2 /o.jpg"
        );
    }
}
