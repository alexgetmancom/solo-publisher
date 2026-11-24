//! `cargo xtask ops-prod`: the operations CLI of a production Studio, run from
//! this machine as `ssh <OPS_SSH_TARGET> docker exec … /app/bin/ops <command>`.

use std::fs::File;
use std::path::Path;
use std::process::Command;

/// The host runs one container per Studio. Naming the deployment is how a
/// command says which one it means; there is no ambient default beyond `alex`.
const DEPLOYMENTS: [Deployment; 2] = [
    Deployment {
        name: "alex",
        container: "alexgetman-backend",
    },
    Deployment {
        name: "maru",
        container: "maru-backend",
    },
];

const LAUNCHER: &str = "cargo xtask ops-prod";

/// The unprivileged user the entrypoint drops the Studio to, by uid, so it
/// keeps meaning that user whatever the image names the account.
const RUNTIME_UID: &str = "1000";

/// A path argument names a file on this machine, and the command runs in a
/// container that cannot see it. Ship it in, run against the copy, remove it.
const FILE_FLAG: &str = "--file";

/// What `logs` accepts. Deliberately three: a window, a fixed-string filter and
/// a tail. Anything more is a shell, and the shell is one ssh away.
const LOG_FLAGS: [&str; 3] = ["--since", "--grep", "--lines"];

#[derive(Clone, Copy, Debug, PartialEq)]
struct Deployment {
    name: &'static str,
    container: &'static str,
}

pub fn main(argv: Vec<String>) -> u8 {
    let (deployment, mut args) = match parse(argv) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("{message}");
            return 1;
        }
    };
    // Bun loaded `.env.local` into the environment by itself; an exported variable still wins.
    let env_file = std::fs::read_to_string(crate::repo_root().join(".env.local")).ok();
    let Some(ssh_target) = ssh_target(std::env::var("OPS_SSH_TARGET").ok(), env_file.as_deref()) else {
        eprintln!("OPS_SSH_TARGET is required; set it in .env.local before using ops-prod");
        return 1;
    };
    // Reading an answer about the wrong Studio is the failure this guards, and it
    // is invisible without a banner. stderr keeps stdout parseable as JSON.
    eprintln!("ops-prod → {} ({})", deployment.name, deployment.container);

    if args[0] == "logs" {
        return match logs_command(deployment, &args) {
            Ok(pipeline) => ssh(&ssh_target, &pipeline, None),
            Err(message) => {
                eprintln!("{message}");
                1
            }
        };
    }

    let mut shipped = Vec::new();
    let mut code = 0;
    for shipment in shipments(&args, |path| Path::new(path).is_file()) {
        let copied = ssh(
            &ssh_target,
            &copy_command(deployment, &shipment.remote),
            Some(&shipment.local),
        );
        if copied != 0 {
            eprintln!("failed to copy {} into {}", shipment.local, deployment.container);
            code = copied;
            break;
        }
        shipment.rewrite(&mut args);
        shipped.push(shipment.remote);
    }
    if code == 0 {
        code = ssh(&ssh_target, &exec_command(deployment, &args), None);
    }
    for remote in shipped {
        ssh(&ssh_target, &remove_command(deployment, &remote), None);
    }
    code
}

fn usage() -> String {
    let names = deployment_names(", ");
    format!(
        "usage: {LAUNCHER} [--as {names}] <command> [arguments]\n       \
         {LAUNCHER} [--as {names}] logs [--since 6h] [--grep TEXT] [--lines N]"
    )
}

fn deployment_names(separator: &str) -> String {
    DEPLOYMENTS.map(|deployment| deployment.name).join(separator)
}

/// Which Studio, and the command for it; only the first argument may be `--as`.
fn parse(mut argv: Vec<String>) -> Result<(Deployment, Vec<String>), String> {
    if argv.is_empty() {
        return Err(usage());
    }
    let mut deployment = DEPLOYMENTS[0];
    if argv[0] == "--as" {
        let requested = argv.get(1).map(String::as_str).unwrap_or_default();
        deployment = DEPLOYMENTS
            .into_iter()
            .find(|candidate| candidate.name == requested)
            .ok_or_else(|| format!("--as takes a deployment name: {}", deployment_names(", ")))?;
        argv.drain(..2);
    }
    if argv.is_empty() || argv.iter().any(|arg| arg == "--as") {
        return Err(usage());
    }
    Ok((deployment, argv))
}

/// The variable if it is set at all, otherwise `.env.local`'s value; blank is absent.
fn ssh_target(from_env: Option<String>, env_file: Option<&str>) -> Option<String> {
    let value = from_env.or_else(|| env_file.and_then(|text| env_file_value(text, "OPS_SSH_TARGET")))?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

/// `KEY=value` lines, optionally `export`ed; a quoted value is taken verbatim,
/// an unquoted one ends at ` #`. The last assignment wins.
fn env_file_value(text: &str, key: &str) -> Option<String> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let (name, value) = line.strip_prefix("export ").unwrap_or(line).split_once('=')?;
            (name.trim() == key).then(|| unquote(value.trim()))
        })
        .next_back()
}

fn unquote(value: &str) -> String {
    if let Some(quote) = value.chars().next().filter(|first| matches!(first, '"' | '\'' | '`'))
        && let Some(end) = value[1..].find(quote)
    {
        return value[1..1 + end].to_owned();
    }
    value.split(" #").next().unwrap_or_default().trim_end().to_owned()
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// One string for the remote shell, every word single-quoted.
fn remote_command<S: AsRef<str>>(parts: &[S]) -> String {
    parts
        .iter()
        .map(|part| shell_quote(part.as_ref()))
        .collect::<Vec<_>>()
        .join(" ")
}

fn exec_command(deployment: Deployment, args: &[String]) -> String {
    let mut parts: Vec<String> = vec![
        "docker".into(),
        "exec".into(),
        "-i".into(),
        "-u".into(),
        RUNTIME_UID.into(),
    ];
    // The container is reached through this launcher and cannot see it, so
    // every command it prints for the operator to run next is written in the
    // coordinates of a shell that is one ssh away. Hand it the spelling that
    // actually got here, and the deployments it could have gone to.
    for variable in [
        format!("OPS_INVOCATION={LAUNCHER} --as {}", deployment.name),
        format!("OPS_INSTANCE={}", deployment.name),
        format!("OPS_INSTANCES={}", deployment_names(",")),
    ] {
        parts.extend(["-e".into(), variable]);
    }
    parts.extend([deployment.container.into(), "/app/bin/ops".into()]);
    parts.extend(args.iter().cloned());
    remote_command(&parts)
}

fn copy_command(deployment: Deployment, remote_path: &str) -> String {
    let write = format!("cat > {}", shell_quote(remote_path));
    remote_command(&[
        "docker",
        "exec",
        "-i",
        "-u",
        RUNTIME_UID,
        deployment.container,
        "sh",
        "-c",
        &write,
    ])
}

fn remove_command(deployment: Deployment, remote_path: &str) -> String {
    remote_command(&[
        "docker",
        "exec",
        "-u",
        RUNTIME_UID,
        deployment.container,
        "rm",
        "-f",
        remote_path,
    ])
}

/// The container's own stdout, which no operation can reach.
///
/// Every other command here is `docker exec` into the Studio, and the operations
/// registry is the catalogue of what the Studio can do to itself. Reading its log
/// is not one of those things: the log is a file Docker keeps on the host, and
/// the container has no way to see it. So this lives beside the ssh rather than
/// behind an operation, and `guide` does not list it.
///
/// It is worth the exception because the timing lines are the only record of how
/// long a tap, a publish or a render actually took, and every question about them
/// is asked after the fact. Note what that costs: `docker compose up` on a new
/// image builds a new container, and the replaced one's log goes with it, so this
/// reads back to the last deployment and no further -- not the couple of weeks
/// the retention in `studio.compose.yaml` sizes for.
fn logs_command(deployment: Deployment, args: &[String]) -> Result<String, String> {
    let mut since = "1h";
    let mut filter = None;
    let mut lines = "200";
    for pair in args[1..].chunks(2) {
        let [flag, value] = pair else {
            return Err(log_flags_error());
        };
        match flag.as_str() {
            "--since" => since = value,
            "--grep" => filter = Some(value),
            "--lines" => lines = value,
            _ => return Err(log_flags_error()),
        }
    }
    // One pipeline on the host, so the whole log never crosses the wire to be
    // filtered here: a fortnight of a busy Studio is hundreds of megabytes.
    let mut pipeline = vec![
        remote_command(&["docker", "logs", "--since", since, deployment.container]),
        "2>&1".into(),
    ];
    if let Some(filter) = filter {
        pipeline.extend(["|".into(), remote_command(&["grep", "-F", "--", filter])]);
    }
    pipeline.extend(["|".into(), remote_command(&["tail", "-n", lines])]);
    Ok(pipeline.join(" "))
}

fn log_flags_error() -> String {
    format!("logs takes {}, each with a value", LOG_FLAGS.join(", "))
}

/// A local file named by `--file PATH` or `--file=PATH`, and where it goes in the container.
#[derive(Debug, PartialEq)]
struct Shipment {
    /// The argument that carries the path: the flag's own for `--file=PATH`, the next one otherwise.
    index: usize,
    inline: bool,
    local: String,
    remote: String,
}

impl Shipment {
    fn rewrite(&self, args: &mut [String]) {
        args[self.index] = if self.inline {
            format!("{FILE_FLAG}={}", self.remote)
        } else {
            self.remote.clone()
        };
    }
}

/// A path that is not a file here travels untouched: it may name one in the container.
fn shipments(args: &[String], is_file: impl Fn(&str) -> bool) -> Vec<Shipment> {
    let mut out = Vec::new();
    for (index, value) in args.iter().enumerate() {
        // Both spellings the CLI parser accepts: `--file=PATH` used to travel
        // through untouched and the container looked for a path on this machine.
        let (index, inline, local) = match value.split_once('=') {
            Some((flag, local)) if flag == FILE_FLAG => (index, true, local),
            _ if value == FILE_FLAG => match args.get(index + 1) {
                Some(local) => (index + 1, false, local.as_str()),
                None => continue,
            },
            _ => continue,
        };
        if local.is_empty() || !is_file(local) {
            continue;
        }
        let name = Path::new(local)
            .file_name()
            .map(|name| name.to_string_lossy())
            .unwrap_or_default();
        out.push(Shipment {
            index,
            inline,
            local: local.to_owned(),
            remote: format!("/tmp/{name}"),
        });
    }
    out
}

/// `ssh <target> <remote>` with this process's streams, or with `stdin_file` as its input.
fn ssh(target: &str, remote: &str, stdin_file: Option<&str>) -> u8 {
    let mut command = Command::new("ssh");
    command.arg(target).arg(remote);
    if let Some(path) = stdin_file {
        match File::open(path) {
            Ok(file) => command.stdin(file),
            Err(error) => {
                eprintln!("cannot read {path}: {error}");
                return 1;
            }
        };
    }
    match command.status() {
        Ok(status) => crate::exit_code(status),
        Err(error) => {
            eprintln!("cannot run ssh: {error}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    const ALEX: Deployment = DEPLOYMENTS[0];
    const MARU: Deployment = DEPLOYMENTS[1];

    #[test]
    fn no_as_means_alex() {
        assert_eq!(
            parse(args(&["status", "--json"])),
            Ok((ALEX, args(&["status", "--json"])))
        );
        assert_eq!(ALEX.container, "alexgetman-backend");
    }

    #[test]
    fn as_names_the_deployment() {
        assert_eq!(
            parse(args(&["--as", "maru", "guide", "--json"])),
            Ok((MARU, args(&["guide", "--json"])))
        );
        assert_eq!(MARU.container, "maru-backend");
    }

    #[test]
    fn as_refuses_anything_but_a_deployment_name() {
        let refusal = Err("--as takes a deployment name: alex, maru".to_owned());
        assert_eq!(parse(args(&["--as", "bob", "status"])), refusal);
        assert_eq!(parse(args(&["--as"])), refusal);
    }

    #[test]
    fn no_command_or_a_second_as_prints_the_usage() {
        assert_eq!(parse(args(&[])), Err(usage()));
        assert_eq!(parse(args(&["--as", "maru"])), Err(usage()));
        assert_eq!(parse(args(&["status", "--as", "maru"])), Err(usage()));
        assert!(usage().starts_with("usage: cargo xtask ops-prod [--as alex, maru] <command> [arguments]\n"));
    }

    #[test]
    fn alex_runs_the_cli_as_uid_1000_with_its_own_invocation() {
        assert_eq!(
            exec_command(ALEX, &args(&["status", "--details"])),
            "'docker' 'exec' '-i' '-u' '1000' \
             '-e' 'OPS_INVOCATION=cargo xtask ops-prod --as alex' '-e' 'OPS_INSTANCE=alex' '-e' 'OPS_INSTANCES=alex,maru' \
             'alexgetman-backend' '/app/bin/ops' 'status' '--details'"
        );
    }

    #[test]
    fn maru_runs_in_its_own_container() {
        assert_eq!(
            exec_command(MARU, &args(&["guide", "--json"])),
            "'docker' 'exec' '-i' '-u' '1000' \
             '-e' 'OPS_INVOCATION=cargo xtask ops-prod --as maru' '-e' 'OPS_INSTANCE=maru' '-e' 'OPS_INSTANCES=alex,maru' \
             'maru-backend' '/app/bin/ops' 'guide' '--json'"
        );
    }

    #[test]
    fn every_word_is_single_quoted_for_the_remote_shell() {
        assert_eq!(shell_quote("it's $HOME; rm -rf /"), r#"'it'"'"'s $HOME; rm -rf /'"#);
        assert!(
            exec_command(ALEX, &args(&["recent", "--grep", "a b'c"])).ends_with(r#"'recent' '--grep' 'a b'"'"'c'"#)
        );
    }

    #[test]
    fn a_local_file_is_shipped_to_tmp_and_the_argument_rewritten() {
        let mut argv = args(&["restore", "--file", "/Users/me/backups/pipeline.db", "--apply"]);
        let planned = shipments(&argv, |path| path == "/Users/me/backups/pipeline.db");
        assert_eq!(
            planned,
            [Shipment {
                index: 2,
                inline: false,
                local: "/Users/me/backups/pipeline.db".into(),
                remote: "/tmp/pipeline.db".into()
            }]
        );
        planned[0].rewrite(&mut argv);
        assert_eq!(argv, args(&["restore", "--file", "/tmp/pipeline.db", "--apply"]));
    }

    #[test]
    fn the_inline_spelling_is_shipped_too() {
        let mut argv = args(&["format-record", "--file=notes/it's.json"]);
        let planned = shipments(&argv, |_| true);
        assert_eq!(planned[0].remote, "/tmp/it's.json");
        planned[0].rewrite(&mut argv);
        assert_eq!(argv, args(&["format-record", "--file=/tmp/it's.json"]));
    }

    #[test]
    fn a_path_that_is_not_a_local_file_travels_untouched() {
        assert_eq!(
            shipments(&args(&["restore", "--file", "/data/backups/x.db"]), |_| false),
            []
        );
        assert_eq!(shipments(&args(&["restore", "--file"]), |_| true), []);
        assert_eq!(shipments(&args(&["restore", "--file="]), |_| true), []);
        assert_eq!(shipments(&args(&["restore", "--files=x"]), |_| true), []);
    }

    #[test]
    fn copy_and_removal_run_as_uid_1000() {
        assert_eq!(
            copy_command(ALEX, "/tmp/it's.db"),
            r#"'docker' 'exec' '-i' '-u' '1000' 'alexgetman-backend' 'sh' '-c' 'cat > '"'"'/tmp/it'"'"'"'"'"'"'"'"'s.db'"'"''"#
        );
        assert_eq!(
            remove_command(MARU, "/tmp/x.db"),
            "'docker' 'exec' '-u' '1000' 'maru-backend' 'rm' '-f' '/tmp/x.db'"
        );
    }

    #[test]
    fn logs_is_one_pipeline_on_the_host() {
        assert_eq!(
            logs_command(ALEX, &args(&["logs"])),
            Ok("'docker' 'logs' '--since' '1h' 'alexgetman-backend' 2>&1 | 'tail' '-n' '200'".into())
        );
        assert_eq!(
            logs_command(MARU, &args(&["logs", "--grep", "publish done", "--since", "6h", "--lines", "50"])),
            Ok("'docker' 'logs' '--since' '6h' 'maru-backend' 2>&1 | 'grep' '-F' '--' 'publish done' | 'tail' '-n' '50'"
                .into())
        );
    }

    #[test]
    fn logs_takes_three_flags_each_with_a_value() {
        let refusal = Err("logs takes --since, --grep, --lines, each with a value".to_owned());
        assert_eq!(logs_command(ALEX, &args(&["logs", "--since"])), refusal);
        assert_eq!(logs_command(ALEX, &args(&["logs", "--follow", "x"])), refusal);
    }

    #[test]
    fn the_variable_wins_over_env_local() {
        let file = "OPS_SSH_TARGET=deploy@from-file\n";
        assert_eq!(
            ssh_target(Some(" deploy@host ".into()), Some(file)),
            Some("deploy@host".into())
        );
        assert_eq!(ssh_target(None, Some(file)), Some("deploy@from-file".into()));
        // Set but blank is set: the file does not fill it in, as Bun did not.
        assert_eq!(ssh_target(Some("  ".into()), Some(file)), None);
        assert_eq!(ssh_target(None, None), None);
    }

    #[test]
    fn env_local_lines() {
        let file = "# OPS_SSH_TARGET=commented@out\n\
                    OTHER=1\n\
                    export OPS_SSH_TARGET = \"deploy@quoted # not a comment\" # a comment\n";
        assert_eq!(
            env_file_value(file, "OPS_SSH_TARGET"),
            Some("deploy@quoted # not a comment".into())
        );
        assert_eq!(
            env_file_value("OPS_SSH_TARGET=a\nOPS_SSH_TARGET='b'\n", "OPS_SSH_TARGET"),
            Some("b".into())
        );
        assert_eq!(
            env_file_value("OPS_SSH_TARGET=deploy@host # vps\n", "OPS_SSH_TARGET"),
            Some("deploy@host".into())
        );
        assert_eq!(env_file_value("OPS_SSH_TARGET_X=a\n", "OPS_SSH_TARGET"), None);
    }
}
