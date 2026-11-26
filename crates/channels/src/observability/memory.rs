//! What this process holds in memory and the container ceiling it runs
//! under, read from `/proc` and the cgroup files. The
//! JavaScript heap figures have no counterpart in a Rust process.

use std::sync::LazyLock;

use domain::observability::runtime_health::ProcessBoot;
use jiff::Timestamp;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MemorySnapshot {
    pub rss_bytes: u64,
    pub cgroup_current_bytes: Option<u64>,
    pub cgroup_peak_bytes: Option<u64>,
    pub cgroup_limit_bytes: Option<u64>,
    pub cgroup_anon_bytes: Option<u64>,
    pub cgroup_file_bytes: Option<u64>,
}

const CGROUP_CURRENT: [&str; 2] = [
    "/sys/fs/cgroup/memory.current",
    "/sys/fs/cgroup/memory/memory.usage_in_bytes",
];
const CGROUP_PEAK: [&str; 2] = [
    "/sys/fs/cgroup/memory.peak",
    "/sys/fs/cgroup/memory/memory.max_usage_in_bytes",
];
const CGROUP_LIMIT: [&str; 2] = [
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
];
const CGROUP_STAT: [&str; 2] = ["/sys/fs/cgroup/memory.stat", "/sys/fs/cgroup/memory/memory.stat"];
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// The first readable file's positive byte count; `max` is no limit.
fn cgroup_bytes(paths: &[&str]) -> Option<u64> {
    for path in paths {
        let Ok(raw) = std::fs::read_to_string(path) else {
            continue;
        };
        let raw = raw.trim();
        if raw.is_empty() || raw == "max" {
            return None;
        }
        if let Ok(bytes) = raw.parse::<u64>()
            && bytes > 0
            && bytes <= MAX_SAFE_INTEGER
        {
            return Some(bytes);
        }
    }
    None
}

fn cgroup_stat_bytes() -> (Option<u64>, Option<u64>) {
    for path in CGROUP_STAT {
        let Ok(raw) = std::fs::read_to_string(path) else {
            continue;
        };
        let values: Vec<(&str, &str)> = raw
            .trim()
            .lines()
            .filter_map(|line| line.trim().split_once(char::is_whitespace))
            .collect();
        let bytes = |keys: &[&str]| {
            keys.iter().find_map(|key| {
                values
                    .iter()
                    .rev()
                    .find(|(name, _)| name == key)
                    .and_then(|(_, value)| value.trim().parse::<u64>().ok())
                    .filter(|value| *value <= MAX_SAFE_INTEGER)
            })
        };
        return (
            bytes(&["anon", "total_rss", "rss"]),
            bytes(&["file", "total_cache", "cache"]),
        );
    }
    (None, None)
}

/// Resident set size from `/proc/self/status` (`VmRSS`, in kB); 0 where
/// there is no procfs.
pub fn resident_bytes() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find_map(|line| line.strip_prefix("VmRSS:"))
                .and_then(|value| value.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
        })
        .map_or(0, |kilobytes| kilobytes * 1024)
}

/// `readMemorySnapshot`.
pub fn read_memory_snapshot() -> MemorySnapshot {
    let (anon, file) = cgroup_stat_bytes();
    MemorySnapshot {
        rss_bytes: resident_bytes(),
        cgroup_current_bytes: cgroup_bytes(&CGROUP_CURRENT),
        cgroup_peak_bytes: cgroup_bytes(&CGROUP_PEAK),
        cgroup_limit_bytes: cgroup_bytes(&CGROUP_LIMIT),
        cgroup_anon_bytes: anon,
        cgroup_file_bytes: file,
    }
}

/// `cgroupMemoryLimitBytes`: the container ceiling, or `None` without one.
/// cgroup v1 reports "no limit" as a near-`i64` sentinel, which is skipped.
pub fn cgroup_memory_limit_bytes() -> Option<u64> {
    for path in CGROUP_LIMIT {
        let Ok(raw) = std::fs::read_to_string(path) else {
            continue;
        };
        let raw = raw.trim();
        if raw == "max" {
            return None;
        }
        match raw.parse::<f64>() {
            Ok(bytes) if bytes.is_finite() && bytes > 0.0 && bytes < MAX_SAFE_INTEGER as f64 => {
                return Some(bytes as u64);
            }
            _ => continue,
        }
    }
    None
}

static BOOT: LazyLock<(String, Timestamp)> = LazyLock::new(|| (random_uuid(), Timestamp::now()));

/// This process's identity and start (`BOOT_ID`, `Date.now() -
/// process.uptime()`): fixed the first time it is asked, which the binary does
/// as it starts.
pub fn process_boot() -> ProcessBoot<'static> {
    ProcessBoot {
        id: &BOOT.0,
        booted_at: BOOT.1,
    }
}

/// `crypto.randomUUID()`.
fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("the operating system has no randomness source");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}
