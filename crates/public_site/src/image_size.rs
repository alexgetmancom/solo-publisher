//! The dimensions `image-size` (2.x, `imageSizeFromFile`) reports, for the
//! formats the Studio writes to the site: JPEG (with its EXIF orientation),
//! PNG, WebP, GIF and HEIF/AVIF. Every read follows the library's bounds: what
//! JavaScript's `DataView` refuses fails the whole call, and a byte read past
//! the end of a `Uint8Array` is `undefined`, which bit operations treat as 0.

use std::fs::File;
use std::io::Read;
use std::path::Path;

/// `imageSizeFromFile` reads at most this much of the file.
const MAX_INPUT_SIZE: u64 = 512 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageSize {
    pub width: i64,
    pub height: i64,
    /// The EXIF orientation tag of a JPEG, when it has a non-zero one.
    pub orientation: Option<i64>,
}

/// `imageSizeFromFile(path)`; `None` wherever the library throws.
pub fn image_size_from_file(path: &Path) -> Option<ImageSize> {
    let file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    if size == 0 {
        return None;
    }
    let mut input = Vec::with_capacity(size.min(MAX_INPUT_SIZE) as usize);
    file.take(MAX_INPUT_SIZE).read_to_end(&mut input).ok()?;
    image_size(&input)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Gif,
    Heif,
    Jpg,
    Png,
    Webp,
}

/// `imageSize(input)`: the type its first byte suggests, else the first type
/// whose signature matches, in the library's order. Formats the Studio never
/// writes (BMP, TIFF, SVG, ICO, …) are not recognised.
pub fn image_size(input: &[u8]) -> Option<ImageSize> {
    let suggested = match input.first()? {
        0x00 => Some(Kind::Heif),
        0x47 => Some(Kind::Gif),
        0x52 => Some(Kind::Webp),
        0x89 => Some(Kind::Png),
        0xff => Some(Kind::Jpg),
        _ => None,
    };
    let kind = match suggested {
        Some(kind) if validate(kind, input)? => kind,
        _ => {
            let mut found = None;
            for kind in [Kind::Gif, Kind::Heif, Kind::Jpg, Kind::Png, Kind::Webp] {
                if validate(kind, input)? {
                    found = Some(kind);
                    break;
                }
            }
            found?
        }
    };
    match kind {
        Kind::Gif => gif(input),
        Kind::Heif => heif(input),
        Kind::Jpg => jpg(input),
        Kind::Png => png(input),
        Kind::Webp => webp(input),
    }
}

/// `Some(matches)`, or `None` where the library's validator throws.
fn validate(kind: Kind, input: &[u8]) -> Option<bool> {
    Some(match kind {
        Kind::Gif => {
            let head = slice(input, 0, 6);
            head.len() == 6 && head.starts_with(b"GIF8") && matches!(head[4], b'7' | b'9') && head[5] == b'a'
        }
        Kind::Heif => {
            slice(input, 4, 8) == b"ftyp"
                && find_box(input, b"ftyp", 0).is_some_and(|ftyp| {
                    let brand = slice(input, ftyp.offset + 8, ftyp.offset + 12);
                    [b"avif", b"mif1", b"msf1", b"heic", b"heix", b"hevc", b"hevx"]
                        .iter()
                        .any(|known| known[..] == *brand)
                })
        }
        Kind::Jpg => slice(input, 0, 2) == [0xff, 0xd8],
        Kind::Png => {
            if slice(input, 1, 8) != b"PNG\r\n\x1a\n" {
                return Some(false);
            }
            let mut chunk = slice(input, 12, 16);
            if chunk == b"CgBI" {
                chunk = slice(input, 28, 32);
            }
            // "Invalid PNG" is thrown, not answered.
            if chunk != b"IHDR" {
                return None;
            }
            true
        }
        Kind::Webp => slice(input, 0, 4) == b"RIFF" && slice(input, 8, 12) == b"WEBP" && slice(input, 12, 15) == b"VP8",
    })
}

/// `Uint8Array.prototype.slice(start, end)`: clamped, never failing.
fn slice(input: &[u8], start: usize, end: usize) -> &[u8] {
    let end = end.min(input.len());
    &input[start.min(end)..end]
}

fn u16_be(input: &[u8], offset: usize) -> Option<i64> {
    let bytes = input.get(offset..offset.checked_add(2)?)?;
    Some(i64::from(u16::from_be_bytes([bytes[0], bytes[1]])))
}

fn u16_le(input: &[u8], offset: usize) -> Option<i64> {
    let bytes = input.get(offset..offset.checked_add(2)?)?;
    Some(i64::from(u16::from_le_bytes([bytes[0], bytes[1]])))
}

fn i16_le(input: &[u8], offset: usize) -> Option<i64> {
    let bytes = input.get(offset..offset.checked_add(2)?)?;
    Some(i64::from(i16::from_le_bytes([bytes[0], bytes[1]])))
}

fn u24_le(input: &[u8], offset: usize) -> Option<i64> {
    let bytes = input.get(offset..offset.checked_add(3)?)?;
    Some(i64::from(bytes[0]) | i64::from(bytes[1]) << 8 | i64::from(bytes[2]) << 16)
}

fn u32_be(input: &[u8], offset: usize) -> Option<i64> {
    let bytes = input.get(offset..offset.checked_add(4)?)?;
    Some(i64::from(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])))
}

fn u32_le(input: &[u8], offset: usize) -> Option<i64> {
    let bytes = input.get(offset..offset.checked_add(4)?)?;
    Some(i64::from(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])))
}

/// `input[index]` inside a bit operation: `undefined` counts as 0.
fn byte(input: &[u8], index: usize) -> i64 {
    input.get(index).map_or(0, |b| i64::from(*b))
}

fn sized(width: i64, height: i64) -> Option<ImageSize> {
    Some(ImageSize {
        width,
        height,
        orientation: None,
    })
}

fn gif(input: &[u8]) -> Option<ImageSize> {
    let height = u16_le(input, 8)?;
    sized(u16_le(input, 6)?, height)
}

fn png(input: &[u8]) -> Option<ImageSize> {
    if slice(input, 12, 16) == b"CgBI" {
        let height = u32_be(input, 36)?;
        return sized(u32_be(input, 32)?, height);
    }
    let height = u32_be(input, 20)?;
    sized(u32_be(input, 16)?, height)
}

fn webp(whole: &[u8]) -> Option<ImageSize> {
    let chunk = slice(whole, 12, 16);
    let input = slice(whole, 20, 30);
    if chunk == b"VP8X" {
        let header = byte(input, 0);
        if header & 0xc0 == 0 && header & 0x01 == 0 {
            let height = 1 + u24_le(input, 7)?;
            return sized(1 + u24_le(input, 4)?, height);
        }
        return None;
    }
    if chunk == b"VP8 " && input.first() != Some(&0x2f) {
        let height = i16_le(input, 8)? & 0x3fff;
        return sized(i16_le(input, 6)? & 0x3fff, height);
    }
    if chunk == b"VP8L" && slice(input, 3, 6) != [0x9d, 0x01, 0x2a] {
        let height = 1 + (((byte(input, 4) & 0xf) << 10) | (byte(input, 3) << 2) | ((byte(input, 2) & 0xc0) >> 6));
        let width = 1 + (((byte(input, 2) & 0x3f) << 8) | byte(input, 1));
        return sized(width, height);
    }
    None
}

fn jpg(whole: &[u8]) -> Option<ImageSize> {
    let mut input = slice(whole, 4, whole.len());
    let mut orientation = None;
    while !input.is_empty() {
        let i = u16_be(input, 0)? as usize;
        // "Corrupt JPG, exceeded buffer limits".
        if i > input.len() {
            return None;
        }
        if input.get(i) != Some(&0xff) {
            input = &input[1..];
            continue;
        }
        if slice(input, 2, 6) == b"Exif" {
            orientation = exif_orientation(input, i)?;
        }
        if let Some(0xc0..=0xc2) = input.get(i + 1) {
            let height = u16_be(input, i + 5)?;
            let width = u16_be(input, i + 7)?;
            return Some(ImageSize {
                width,
                height,
                orientation: orientation.filter(|value| *value != 0),
            });
        }
        input = slice(input, i + 2, input.len());
    }
    None
}

/// `validateExifBlock`: `Some(None)` when the block names no orientation,
/// `None` where the library throws.
fn exif_orientation(input: &[u8], index: usize) -> Option<Option<i64>> {
    const EXIF_HEADER_BYTES: usize = 6;
    const ENTRY_BYTES: usize = 12;
    let block = slice(input, 2, index);
    let big_endian = match slice(block, EXIF_HEADER_BYTES, EXIF_HEADER_BYTES + 2) {
        b"MM" => true,
        b"II" => false,
        _ => return Some(None),
    };
    let read16 = |data: &[u8], offset| {
        if big_endian {
            u16_be(data, offset)
        } else {
            u16_le(data, offset)
        }
    };
    let read32 = |data: &[u8], offset| {
        if big_endian {
            u32_be(data, offset)
        } else {
            u32_le(data, offset)
        }
    };
    let offset = EXIF_HEADER_BYTES + 8;
    let entries = read16(block, offset)?;
    for entry in 0..entries as usize {
        let start = offset + 2 + entry * ENTRY_BYTES;
        if start > block.len() {
            return Some(None);
        }
        let tag = slice(block, start, start + ENTRY_BYTES);
        if read16(tag, 0)? == 274 {
            if read16(tag, 2)? != 3 || read32(tag, 4)? != 1 {
                return Some(None);
            }
            return Some(Some(read16(tag, 8)?));
        }
    }
    Some(None)
}

#[derive(Clone, Copy)]
struct BoxHeader {
    offset: usize,
    size: usize,
}

/// `findBox`: the first ISO-BMFF box named `name` at or after `start`.
fn find_box(input: &[u8], name: &[u8], start: usize) -> Option<BoxHeader> {
    let mut offset = start;
    while offset < input.len() {
        if input.len() - offset < 4 {
            break;
        }
        let size = u32_be(input, offset)? as usize;
        if size < 8 {
            offset += 8;
            continue;
        }
        if input.len() - offset < 8 || input.len() - offset < size {
            break;
        }
        if slice(input, offset + 4, offset + 8) == name {
            return Some(BoxHeader { offset, size });
        }
        offset += size;
    }
    None
}

fn heif(input: &[u8]) -> Option<ImageSize> {
    let meta = find_box(input, b"meta", 0)?;
    let iprp = find_box(input, b"iprp", meta.offset + 12)?;
    let ipco = find_box(input, b"ipco", iprp.offset + 8)?;
    let end = ipco.offset + ipco.size;
    let mut images: Vec<(i64, i64)> = Vec::new();
    let mut offset = ipco.offset + 8;
    while offset < end {
        let Some(ispe) = find_box(input, b"ispe", offset) else {
            break;
        };
        if ispe.size < 20 {
            return None;
        }
        let raw_width = u32_be(input, ispe.offset + 12)?;
        let height = u32_be(input, ispe.offset + 16)?;
        let mut width = raw_width;
        if let Some(clap) = find_box(input, b"clap", offset)
            && clap.size >= 16
            && clap.offset < end
        {
            width = raw_width - u32_be(input, clap.offset + 12)?;
        }
        images.push((width, height));
        let next = ispe.offset + ispe.size;
        if next <= offset {
            return None;
        }
        offset = next;
    }
    let first = *images.first()?;
    // `lookup.js`: of several, the largest by area (a JavaScript number
    // product); ties keep the earlier one.
    let area = |(width, height): (i64, i64)| width as f64 * height as f64;
    let (width, height) = images.iter().skip(1).fold(first, |largest, current| {
        if area(*current) > area(largest) {
            *current
        } else {
            largest
        }
    });
    sized(width, height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_bytes_are_not_images() {
        for input in [&b"bytes"[..], b"0123456789", b"x", b"\0\0\0\0"] {
            assert_eq!(image_size(input), None);
        }
    }

    #[test]
    fn reads_png_and_gif_headers() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&[0, 0, 1, 0, 0, 0, 0, 200]);
        assert_eq!(image_size(&png), sized(256, 200));
        assert_eq!(image_size(b"GIF89a\x10\0\x20\0"), sized(16, 32));
    }
}
