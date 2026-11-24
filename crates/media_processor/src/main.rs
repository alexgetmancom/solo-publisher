//! `media-processor`: reads the `MEDIA_PROCESSOR_*` environment, binds
//! `0.0.0.0:8787`, prunes the work directory hourly, and stops on SIGTERM
//! (it is the container's PID 1, which has no default signal handling).

use std::process::ExitCode;
use std::time::SystemTime;

use media_processor::{HostCommands, Options, PORT, PRUNE_INTERVAL, Processor, log, serve};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};

fn main() -> ExitCode {
    let vars =
        std::env::vars_os().filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)));
    let started = Options::from_env(vars).and_then(|options| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        runtime.block_on(run(options))
    });
    match started {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            log("error", &error, json!({}));
            ExitCode::FAILURE
        }
    }
}

async fn run(options: Options) -> Result<(), String> {
    let processor = Processor::new(options, HostCommands)?;
    let listener = TcpListener::bind(("0.0.0.0", PORT))
        .await
        .map_err(|error| format!("cannot listen on port {PORT}: {error}"))?;
    let mut terminate = signal(SignalKind::terminate()).map_err(|error| error.to_string())?;
    let pruner = processor.clone();
    tokio::spawn(async move {
        let first = tokio::time::Instant::now() + PRUNE_INTERVAL;
        let mut interval = tokio::time::interval_at(first, PRUNE_INTERVAL);
        loop {
            interval.tick().await;
            pruner.prune(SystemTime::now());
        }
    });
    tokio::select! {
        () = serve(listener, processor) => {}
        _ = terminate.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
    Ok(())
}
