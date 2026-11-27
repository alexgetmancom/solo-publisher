//! Which route to run operations through, and the
//! catalog this build accepts, grouped into the sections an operator reads.

use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::context::OperationContext;
use crate::registry::CatalogEntry;

/// The sections the catalog is read in: what an operator is holding when they
/// ask, not where the code lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Health,
    Delivery,
    Media,
    Channels,
    Studio,
    Host,
}

pub const SECTIONS: [Section; 6] = [
    Section::Health,
    Section::Delivery,
    Section::Media,
    Section::Channels,
    Section::Studio,
    Section::Host,
];

/// `OPERATION_SECTIONS`, as the enum the `guide` schema accepts.
pub const OPERATION_SECTIONS: &[&str] = &["health", "delivery", "media", "channels", "studio", "host"];

impl Section {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Health => "health",
            Self::Delivery => "delivery",
            Self::Media => "media",
            Self::Channels => "channels",
            Self::Studio => "studio",
            Self::Host => "host",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        SECTIONS.into_iter().find(|section| section.as_str() == name)
    }

    /// `SECTION_SUMMARIES`.
    pub fn summary(self) -> &'static str {
        match self {
            Self::Health => "Is this deployment working, and what is wrong with it.",
            Self::Delivery => "One publication: what it is, where it went, and how to move it.",
            Self::Media => "The media processor, one publication's assets, and the stored files behind them.",
            Self::Channels => "Which accounts this Studio publishes through and the state of their credentials.",
            Self::Studio => "What this Studio is, how it is configured, and what it is streaming.",
            Self::Host => "Operations on the deployment's own files. CLI only: they name paths on the host.",
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct GuideView {
    pub section: Option<Section>,
    pub all: bool,
}

/// Node's `path.resolve`: absolute against `cwd`, `.` and `..` folded.
pub fn resolve(cwd: &Path, path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    let mut out = PathBuf::from("/");
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    out
}

/// Node's error message for a failed `stat`/`access` (`CODE: description, call 'path'`).
fn node_error(error: &io::Error, call: &str, path: &Path) -> (bool, String) {
    let code = match error.raw_os_error() {
        Some(2) => "ENOENT: no such file or directory",
        Some(13) => "EACCES: permission denied",
        Some(20) => "ENOTDIR: not a directory",
        Some(36) => "ENAMETOOLONG: name too long",
        Some(40) => "ELOOP: too many symbolic links encountered",
        Some(1) => "EPERM: operation not permitted",
        _ => return (false, error.to_string()),
    };
    (
        error.kind() == io::ErrorKind::NotFound,
        format!("{code}, {call} '{}'", path.display()),
    )
}

fn access(path: &Path) -> io::Result<()> {
    rustix::fs::access(path, rustix::fs::Access::READ_OK | rustix::fs::Access::WRITE_OK).map_err(io::Error::from)
}

fn probe_local(database_path: &Path, cwd: &Path) -> Value {
    let resolved = resolve(cwd, database_path);
    let path = resolved.display().to_string();
    let answer = |state: &str, reason: String| json!({"path": path, "state": state, "reason": reason});
    let metadata = match std::fs::metadata(&resolved) {
        Ok(metadata) => metadata,
        Err(error) => {
            let (missing, message) = node_error(&error, "stat", &resolved);
            return if missing {
                answer("missing", "database file was not found".into())
            } else {
                answer("unusable", message)
            };
        }
    };
    if !metadata.is_file() {
        return answer("unusable", "database path is not a regular file".into());
    }
    let parent = resolved.parent().unwrap_or(Path::new("/")).to_path_buf();
    for checked in [&resolved, &parent] {
        if let Err(error) = access(checked) {
            let (missing, message) = node_error(&error, "access", checked);
            return if missing {
                answer("missing", "database file was not found".into())
            } else {
                answer("unusable", message)
            };
        }
    }
    answer(
        "available",
        "database file and its directory are readable and writable".into(),
    )
}

/// What the launcher said about itself, or the plain local spelling.
fn read_invocation(route: &str, env: &dyn Fn(&str) -> Option<String>) -> Value {
    let given = env("OPS_INVOCATION")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let prefix = given.unwrap_or_else(|| {
        if route == "local" {
            "ops".into()
        } else {
            "cargo xtask ops-prod".into()
        }
    });
    let mut out = Map::new();
    out.insert("prefix".into(), json!(prefix));
    if let Some(instance) = env("OPS_INSTANCE")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        out.insert("instance".into(), json!(instance));
    }
    let instances: Vec<String> = env("OPS_INSTANCES")
        .unwrap_or_default()
        .split(',')
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    if instances.len() > 1 {
        out.insert("instances".into(), json!(instances));
    }
    Value::Object(out)
}

static SSH_TARGET_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*OPS_SSH_TARGET\s*=\s*(.*?)\s*(?:#.*)?$").unwrap());
static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^"(.*)"$|^'(.*)'$"#).unwrap());

fn has_configured_ssh_target(path: &Path) -> bool {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return false;
    };
    for line in contents.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(captures) = SSH_TARGET_LINE.captures(line) else {
            continue;
        };
        let raw = captures.get(1).map_or("", |m| m.as_str()).trim();
        let unquoted = QUOTED
            .captures(raw)
            .and_then(|quoted| quoted.get(1).or_else(|| quoted.get(2)))
            .map_or(raw, |m| m.as_str());
        return !unquoted.trim().is_empty();
    }
    false
}

fn production_launcher_configured(env: &dyn Fn(&str) -> Option<String>, cwd: &Path) -> bool {
    if let Some(target) = env("OPS_SSH_TARGET") {
        return !target.trim().is_empty();
    }
    [
        resolve(cwd, Path::new(".env.local")),
        resolve(cwd, Path::new("../../.env.local")),
    ]
    .iter()
    .any(|path| has_configured_ssh_target(path))
}

/// `buildOperationsGuide`.
pub fn build_guide(context: &OperationContext<'_>, commands: &[CatalogEntry], view: &GuideView) -> Value {
    let local = probe_local(&context.db_path, &context.cwd);
    let route = if local["state"] == "available" {
        "local"
    } else {
        "production"
    };
    let invocation = read_invocation(route, context.env);
    let prefix = invocation["prefix"].as_str().unwrap_or_default().to_owned();
    let command = format!("{prefix} <command>");
    let catalog = json!({
        "source": "this working tree",
        "authoritative": route == "local",
        "reason": if route == "local" {
            "The local route runs this build, so these are the commands it accepts."
        } else {
            "The production container runs its last deployed revision, which may not accept every command listed here."
        },
        "command": format!("{prefix} guide --json"),
    });
    let sections: Vec<Value> = SECTIONS
        .iter()
        .filter_map(|section| {
            let count = commands.iter().filter(|entry| entry.section == *section).count();
            (count > 0).then(|| {
                json!({
                    "name": section.as_str(),
                    "summary": section.summary(),
                    "commandCount": count,
                    "command": format!("{prefix} guide --section {} --json", section.as_str()),
                })
            })
        })
        .collect();
    let selected: Option<Vec<&CatalogEntry>> = if view.all {
        Some(commands.iter().collect())
    } else {
        view.section
            .map(|section| commands.iter().filter(|entry| entry.section == section).collect())
    };
    let mut out = Map::new();
    out.insert("version".into(), json!(3));
    out.insert("local".into(), local);
    out.insert("route".into(), json!(route));
    out.insert("invocation".into(), invocation);
    out.insert(
        "next".into(),
        json!({
            "reason": if route == "local" {
                "The local database is available; run the requested read-only command locally first."
            } else {
                "The local database is unavailable; do not repair local /data and continue with the production route."
            },
            "command": command,
        }),
    );
    out.insert(
        "production".into(),
        json!({"configured": production_launcher_configured(context.env, &context.cwd)}),
    );
    out.insert("catalog".into(), catalog);
    out.insert("sections".into(), Value::Array(sections));
    out.insert(
        "expand".into(),
        json!(format!(
            "{prefix} guide --section <{}>, or --all for every entry",
            OPERATION_SECTIONS.join("|")
        )),
    );
    if let Some(selected) = selected {
        let start_here: Vec<Value> = SECTIONS
            .iter()
            .flat_map(|section| {
                selected
                    .iter()
                    .filter(move |entry| entry.section == *section)
                    .filter_map(|entry| {
                        entry
                            .start_here
                            .map(|symptom| json!({"symptom": symptom, "command": entry.name}))
                    })
            })
            .collect();
        out.insert("startHere".into(), Value::Array(start_here));
        out.insert(
            "commands".into(),
            Value::Array(selected.iter().map(|entry| entry.to_json()).collect()),
        );
    }
    Value::Object(out)
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

/// `formatOperationsGuide`.
pub fn format_guide(guide: &Value) -> String {
    let route_label = if guide["route"] == "local" {
        "LOCAL"
    } else {
        "PRODUCTION"
    };
    let detail: Vec<String> = guide["commands"]
        .as_array()
        .map(|commands| {
            commands
                .iter()
                .flat_map(|command| {
                    let safety = if command["mutates"] == true {
                        "MUTATION"
                    } else {
                        "read-only"
                    };
                    let note = command["note"]
                        .as_str()
                        .map(|note| format!(" ({note})"))
                        .unwrap_or_default();
                    [
                        format!("  [{safety}] {}", text(&command["usage"])),
                        format!("             {}{note}", text(&command["summary"])),
                    ]
                })
                .collect()
        })
        .unwrap_or_default();
    let authoritative = guide["catalog"]["authoritative"] == true;
    let mut lines = vec![
        "operations guide".to_owned(),
        String::new(),
        format!("Local database: {}", text(&guide["local"]["state"]).to_uppercase()),
        format!("Path: {}", text(&guide["local"]["path"])),
        format!("Reason: {}", text(&guide["local"]["reason"])),
        format!("Recommended route: {route_label}"),
    ];
    if let Some(instance) = guide["invocation"]["instance"].as_str() {
        lines.push(format!("Deployment: {instance}"));
    }
    if let Some(instances) = guide["invocation"]["instances"].as_array() {
        let names: Vec<&str> = instances.iter().filter_map(Value::as_str).collect();
        lines.push(format!("Other deployments: {}", names.join(", ")));
    }
    lines.extend([
        String::new(),
        text(&guide["next"]["reason"]).to_owned(),
        format!("Next command: {}", text(&guide["next"]["command"])),
        format!(
            "Production launcher: {}",
            if guide["production"]["configured"] == true {
                "configured"
            } else {
                "not configured"
            }
        ),
        String::new(),
        if authoritative {
            "Catalog: this build.".to_owned()
        } else {
            format!(
                "Catalog below is THIS WORKING TREE, not the deployed one. {}",
                text(&guide["catalog"]["reason"])
            )
        },
        if authoritative {
            String::new()
        } else {
            format!("Read the deployed catalog with: {}", text(&guide["catalog"]["command"]))
        },
        String::new(),
    ]);
    if let Some(start_here) = guide["startHere"].as_array().filter(|entries| !entries.is_empty()) {
        lines.push("Start here:".into());
        for entry in start_here {
            lines.push(format!("  {} → {}", text(&entry["symptom"]), text(&entry["command"])));
        }
        lines.push(String::new());
    }
    lines.push("Sections:".into());
    for section in guide["sections"].as_array().into_iter().flatten() {
        lines.push(format!(
            "  {} ({}) — {}",
            text(&section["name"]),
            section["commandCount"],
            text(&section["summary"])
        ));
        lines.push(format!("    {}", text(&section["command"])));
    }
    lines.push(String::new());
    lines.push(format!("Expand: {}", text(&guide["expand"])));
    if !detail.is_empty() {
        lines.push(String::new());
        lines.push("Commands:".into());
        lines.extend(detail);
    }
    lines.join("\n")
}
