//! `deploy-agent`: reads its environment (`deploy/deploy-agent.env.example`),
//! listens on `127.0.0.1:<DEPLOY_AGENT_PORT>` and, unless it is the same
//! address, on `<DEPLOY_AGENT_HOST>:<DEPLOY_AGENT_PORT>`, and serves until stopped.
//!
//! The second address is the Docker bridge by default: the agent drives
//! Compose on the host, so it cannot live inside the container CI can reach,
//! and the Studios call it through the bridge instead. That exposes the port to
//! every container on the host, which is why the bearer token is required,
//! compared in constant time, and checked before the body is read. Set
//! `DEPLOY_AGENT_HOST=127.0.0.1` to listen on loopback only where callers reach
//! the host some other way (over SSH, or a tunnel).

use std::process::ExitCode;
use std::sync::Arc;

use deploy_agent::{Agent, Config, System, serve};
use serde_json::json;
use tokio::net::TcpListener;

fn main() -> ExitCode {
    let vars =
        std::env::vars_os().filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)));
    let started = Config::from_env(vars).and_then(|config| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?
            .block_on(run(config))
    });
    match started {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}", json!({"level": "error", "message": error}));
            ExitCode::FAILURE
        }
    }
}

async fn run(config: Config) -> Result<(), String> {
    let port = config.port;
    let mut hosts = vec!["127.0.0.1".to_owned()];
    if config.host != "127.0.0.1" {
        hosts.push(config.host.clone());
    }
    let agent = Agent::new(config, Arc::new(System));
    let mut listeners = Vec::new();
    for host in hosts {
        let listener = TcpListener::bind((host.as_str(), port))
            .await
            .map_err(|error| format!("cannot listen on {host}:{port}: {error}"))?;
        println!(
            "{}",
            json!({"level": "info", "message": "deploy agent listening", "host": host, "port": port})
        );
        listeners.push(tokio::spawn(serve(listener, Arc::clone(&agent))));
    }
    for listener in listeners {
        listener.await.map_err(|error| error.to_string())?;
    }
    Ok(())
}
