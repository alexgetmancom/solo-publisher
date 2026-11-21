//! The operations CLI (`cli.ts`, `operations/cli-args.ts`): `ops <command>
//! --flag value`, `--db PATH`, `--json`. The dispatch is the registry's; this
//! file only turns argv into an input and the result into terminal output.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use domain::application::ports::Clock;
use foundation::redact::redact_external_secrets;
use runtime::http::HttpClient;
use serde_json::{Map, Value};

use crate::context::{OpError, OperationContext, Surface, Terminal};
use crate::guide::SECTIONS;
use crate::registry::{operation_catalog, operation_def, run_operation};

pub const CLI_ACTOR: &str = "ops-cli";

/// Options the dispatcher owns rather than any operation's schema.
const GLOBAL_OPTIONS: [&str; 2] = ["db", "json"];

/// argv after the program name, as `parseArguments` read it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Arguments {
    pub command: String,
    pub values: HashMap<String, String>,
    pub flags: BTreeSet<String>,
    /// Every option spelled on the line, in first-seen order.
    pub seen: Vec<String>,
}

impl Arguments {
    fn see(&mut self, name: &str) {
        if !self.seen.iter().any(|seen| seen == name) {
            self.seen.push(name.to_owned());
        }
    }
}

/// `parseArguments`. Every argument belongs to an option: a bare word is a
/// value written without its option, and dropping it silently runs a
/// different command.
pub fn parse_arguments(argv: &[String]) -> Result<Arguments, String> {
    let mut args = Arguments {
        command: argv.first().cloned().unwrap_or_else(|| "help".into()),
        ..Arguments::default()
    };
    let mut index = 1;
    while index < argv.len() {
        let token = &argv[index];
        let Some(option) = token.strip_prefix("--") else {
            return Err(format!(
                "{}: unexpected argument {}; options are --name value",
                args.command,
                Value::from(token.as_str())
            ));
        };
        // `indexOf("=") > 2`: a name of at least one character before it.
        if let Some(equals) = option.find('=').filter(|equals| *equals > 0) {
            let name = &option[..equals];
            let value = &option[equals + 1..];
            args.see(name);
            // A boolean field reads from `flags` alone, so `--apply=true`
            // parsed as a value would leave the mutation unarmed.
            match value.to_lowercase().as_str() {
                "true" => {
                    args.flags.insert(name.to_owned());
                }
                "false" => {
                    args.flags.remove(name);
                }
                _ => {
                    args.values.insert(name.to_owned(), value.to_owned());
                }
            }
            index += 1;
            continue;
        }
        args.see(option);
        match argv.get(index + 1) {
            Some(next) if !next.is_empty() && !next.starts_with("--") => {
                args.values.insert(option.to_owned(), next.clone());
                index += 2;
            }
            _ => {
                args.flags.insert(option.to_owned());
                index += 1;
            }
        }
    }
    Ok(args)
}

/// `operationInput`: argv against the operation's own schema. A boolean field
/// is a bare flag and everything else is the last value given; coercion
/// belongs to the schema, and so does rejecting an option no field answers to.
pub fn operation_input(name: &str, args: &Arguments) -> Result<Value, String> {
    let def = operation_def(name).ok_or_else(|| format!("unknown command: {name}"))?;
    let mut input = Map::new();
    for option in &args.seen {
        if GLOBAL_OPTIONS.contains(&option.as_str()) {
            continue;
        }
        let field = option.replace('-', "_");
        let value = args.values.get(option);
        let schema_field = def.schema.field(&field);
        if schema_field.is_some_and(|field| field.is_boolean()) {
            if let Some(value) = value {
                return Err(format!(
                    "{name}: --{option} is a flag; write it alone, not --{option} {value}"
                ));
            }
            input.insert(field, Value::Bool(args.flags.contains(option)));
            continue;
        }
        match value {
            None if schema_field.is_some() => return Err(format!("{name}: --{option} needs a value")),
            None => input.insert(field, Value::Bool(true)),
            Some(value) => input.insert(field, Value::from(value.as_str())),
        };
    }
    Ok(Value::Object(input))
}

/// Grouped by section, because 68 usage lines in one column is a list nobody
/// reads to the end.
pub fn help_text() -> String {
    let catalog = operation_catalog();
    let mut lines = vec!["solo-publisher backend operations".to_owned()];
    for section in SECTIONS {
        let members: Vec<_> = catalog.iter().filter(|entry| entry.section == section).collect();
        if members.is_empty() {
            continue;
        }
        lines.push(String::new());
        lines.push(format!("{} — {}", section.as_str(), section.summary()));
        for entry in members {
            let marker = if entry.mutates { "[MUTATION] " } else { "           " };
            lines.push(format!("  {marker}{}", entry.usage));
        }
    }
    lines.push(String::new());
    lines.push("--db PATH overrides the database; --json prints the raw result.".into());
    lines.join("\n")
}

/// What one CLI run needs from its process.
pub struct CliRun<'a> {
    pub env: &'a dyn Fn(&str) -> Option<String>,
    pub cwd: PathBuf,
    pub clock: &'a dyn Clock,
    pub http: HttpClient,
    pub terminal: &'a dyn Terminal,
    /// Opens the database and configuration for a database path.
    pub surface: &'a dyn Fn(&Path) -> Box<dyn CliSurface + 'a>,
}

/// A surface the CLI owns: it flushes usage and closes what it opened.
pub trait CliSurface: Surface {
    fn finish(self: Box<Self>);
}

/// What a run printed and how it ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub stderr: String,
    pub code: i32,
}

/// `main()`: one command, its output on the terminal, its error on stderr.
pub async fn run_cli(argv: &[String], run: &CliRun<'_>) -> Outcome {
    match dispatch(argv, run).await {
        Ok(code) => Outcome {
            stderr: String::new(),
            code,
        },
        Err(message) => Outcome {
            stderr: format!("{}\n", redact_external_secrets(&message)),
            code: 1,
        },
    }
}

async fn dispatch(argv: &[String], run: &CliRun<'_>) -> Result<i32, String> {
    let args = parse_arguments(argv)?;
    if ["help", "--help", "-h"].contains(&args.command.as_str()) {
        run.terminal
            .print_line(&help_text())
            .map_err(|error| error.to_string())?;
        return Ok(0);
    }
    let db_path = match args.values.get("db") {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from((run.env)("DATA_DIR").unwrap_or_else(|| "/data".into())).join("pipeline.db"),
    };
    let def = operation_def(&args.command).ok_or_else(|| format!("unknown command: {}", args.command))?;
    let surface = (run.surface)(&db_path);
    let result = {
        let context = OperationContext {
            db_path,
            actor_type: CLI_ACTOR,
            http: run.http.clone(),
            clock: run.clock,
            env: run.env,
            cwd: run.cwd.clone(),
            terminal: Some(run.terminal),
            surface: &*surface,
        };
        match operation_input(&args.command, &args) {
            Ok(input) => run_operation(&args.command, &context, &input)
                .await
                .map_err(|error| match error {
                    OpError::Input(message) | OpError::Failed(message) => message,
                }),
            Err(message) => Err(message),
        }
    };
    let outcome = result.and_then(|result| {
        // A streaming operation has already written its bytes to stdout.
        if !def.streams {
            let output = match def.format {
                Some(format) if !args.flags.contains("json") => format(&result),
                _ => serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?,
            };
            run.terminal
                .print_line(&redact_external_secrets(&output))
                .map_err(|error| error.to_string())?;
        }
        let failed_doctor = args.command == "doctor" && result.get("ok") == Some(&Value::Bool(false));
        Ok(if failed_doctor { 1 } else { 0 })
    });
    // Usage is buffered; a process that runs one command flushes it on exit.
    surface.finish();
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn the_last_spelling_of_a_flag_wins() {
        let args = parse_arguments(&argv(&["retry", "--apply=true", "--apply=false"])).unwrap();
        assert!(!args.flags.contains("apply"));
        let args = parse_arguments(&argv(&["retry", "--apply=TRUE"])).unwrap();
        assert!(args.flags.contains("apply"));
    }

    #[test]
    fn a_bare_word_is_refused() {
        assert_eq!(
            parse_arguments(&argv(&["recent", "10"])).unwrap_err(),
            "recent: unexpected argument \"10\"; options are --name value"
        );
    }
}
