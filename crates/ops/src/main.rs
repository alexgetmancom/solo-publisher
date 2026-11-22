//! `ops`: the operations CLI. One command per
//! process: `ops <command> --flag value`, `--db PATH`, `--json`.

use std::process::ExitCode;
use std::rc::Rc;

use domain::application::ports::{Clock, SystemClock};
use foundation::redact::redact_external_secrets;
use ops::cli::{CliRun, CliSurface, run_cli};
use ops::host::{ProcessSurface, ProcessTerminal};
use runtime::http::{HttpClient, ReqwestTransport};

fn main() -> ExitCode {
    // A variable that is not UTF-8 is none of this Studio's settings.
    let vars: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
        .collect();
    let argv: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let fail = |message: &str| {
        eprintln!("{}", redact_external_secrets(message));
        ExitCode::FAILURE
    };
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => return fail(&error.to_string()),
    };
    let http = match ReqwestTransport::new() {
        Ok(transport) => HttpClient::new(Rc::new(transport)),
        Err(error) => return fail(&error.message),
    };
    let clock: Rc<dyn Clock> = Rc::new(SystemClock);
    let env = |name: &str| vars.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone());
    let cwd = std::env::current_dir().unwrap_or_default();
    let surface = |db_path: &std::path::Path| -> Box<dyn CliSurface> {
        Box::new(ProcessSurface::new(
            db_path,
            vars.clone(),
            Rc::clone(&clock),
            http.clone(),
        ))
    };
    let run = CliRun {
        env: &env,
        cwd,
        clock: &*clock,
        http: http.clone(),
        terminal: &ProcessTerminal,
        surface: &surface,
    };
    let local = tokio::task::LocalSet::new();
    let outcome = local.block_on(&runtime, run_cli(&argv, &run));
    // Work the command started and nobody awaits (a Story render) finishes
    // before the process exits, as it did under Bun.
    runtime.block_on(local);
    if !outcome.stderr.is_empty() {
        eprint!("{}", outcome.stderr);
    }
    ExitCode::from(u8::try_from(outcome.code).unwrap_or(1))
}
