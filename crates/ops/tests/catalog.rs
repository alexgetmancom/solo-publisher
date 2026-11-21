//! The registry's projections against `parity/ops/catalog.json`
//! (`bun scripts/rust/ops-goldens.ts`): the catalog, every input schema, the
//! MCP tool list, and the `ops` binary as a process — `--help`, every `guide`
//! view, the dispatcher's refusals — byte for byte, with the exit code.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn goldens() -> Value {
    let path = repo().join("parity/ops/catalog.json");
    serde_json::from_str(&std::fs::read_to_string(&path).expect("parity/ops/catalog.json")).unwrap()
}

#[test]
fn catalog_entries_match() {
    let goldens = goldens();
    let rust: Vec<Value> = ops::registry::operation_catalog()
        .iter()
        .map(|entry| entry.to_json())
        .collect();
    let expected = goldens["catalog"].as_array().unwrap();
    assert_eq!(rust.len(), expected.len(), "operation count");
    for (rust, expected) in rust.iter().zip(expected) {
        assert_eq!(
            serde_json::to_string(rust).unwrap(),
            serde_json::to_string(expected).unwrap()
        );
    }
    assert_eq!(
        serde_json::to_value(ops::registry::operation_usage_keys()).unwrap(),
        goldens["usageKeys"]
    );
}

#[test]
fn input_schemas_match_key_for_key() {
    let goldens = goldens();
    let expected = goldens["schemas"].as_object().unwrap();
    for def in ops::registry::operation_defs() {
        let rust = serde_json::to_string(&def.schema.json_schema()).unwrap();
        let want = serde_json::to_string(&expected[def.name]).unwrap();
        assert_eq!(rust, want, "schema of {}", def.name);
    }
}

#[test]
fn tools_list_matches() {
    let goldens = goldens();
    let tools = |authenticated: bool| serde_json::to_string(&ops::mcp::tools(authenticated)).unwrap();
    let want = |key: &str| serde_json::to_string(&goldens[key]["result"]["tools"]).unwrap();
    assert_eq!(tools(false), want("toolsListAnonymous"));
    let rust: Vec<Value> = ops::mcp::tools(true);
    let expected = goldens["toolsList"]["result"]["tools"].as_array().unwrap();
    assert_eq!(rust.len(), expected.len(), "tool count");
    for (rust, expected) in rust.iter().zip(expected) {
        assert_eq!(
            serde_json::to_string(rust).unwrap(),
            serde_json::to_string(expected).unwrap()
        );
    }
}

/// The scratch layout the recorder ran in: `data/pipeline.db`, `dir.db/`, `cwd/`.
fn scratch() -> PathBuf {
    let base = repo().join(format!("_trash-rust/tmp/ops-catalog-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("dir.db")).unwrap();
    std::fs::create_dir_all(base.join("cwd")).unwrap();
    db::BackendDb::open(base.join("data/pipeline.db"))
        .unwrap()
        .close()
        .unwrap();
    base.canonicalize().unwrap()
}

#[test]
fn the_binary_answers_like_the_typescript_cli() {
    let goldens = goldens();
    let base = scratch();
    let tmp = base.display().to_string();
    let mut failures = Vec::new();
    for run in goldens["runs"].as_array().unwrap() {
        let argv: Vec<String> = run["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|arg| arg.as_str().unwrap().replace("$TMP", &tmp))
            .collect();
        let mut command = Command::new(env!("CARGO_BIN_EXE_ops"));
        command
            .args(&argv)
            .current_dir(base.join("cwd"))
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", std::env::var("HOME").unwrap_or_default())
            .env("DATA_DIR", base.join("data"));
        for (key, value) in run["env"].as_object().unwrap() {
            command.env(key, value.as_str().unwrap());
        }
        let output = command.output().unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout).replace(&tmp, "$TMP");
        let stderr = String::from_utf8_lossy(&output.stderr).replace(&tmp, "$TMP");
        let code = output.status.code().map(i64::from);
        if stdout != run["stdout"].as_str().unwrap()
            || stderr != run["stderr"].as_str().unwrap()
            || code != run["code"].as_i64()
        {
            failures.push(format!(
                "{:?}\n  stdout {}\n  stderr {:?} (want {:?})\n  code {code:?} (want {})",
                run["argv"],
                first_difference(&stdout, run["stdout"].as_str().unwrap()),
                stderr,
                run["stderr"],
                run["code"]
            ));
        }
    }
    let _ = std::fs::remove_dir_all(&base);
    assert!(
        failures.is_empty(),
        "{} runs differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

fn first_difference(rust: &str, want: &str) -> String {
    if rust == want {
        return "same".into();
    }
    let at = rust.chars().zip(want.chars()).take_while(|(a, b)| a == b).count();
    let window = |text: &str| text.chars().skip(at.saturating_sub(40)).take(120).collect::<String>();
    format!(
        "differs at char {at}:\n    rust: {:?}\n    want: {:?}",
        window(rust),
        window(want)
    )
}
