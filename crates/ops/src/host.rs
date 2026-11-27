//! The CLI process's surface: the database and configuration opened on
//! demand for one command, the boundaries Studio and publishing call (the
//! stores; Story derivatives render in this process), and the terminal it is
//! attached to.
//!
//! The publish worker's doorbell rings nothing here: the worker lives in the
//! Studio process, which polls the queue, exactly as a ring with no
//! registered wake does in a CLI process.

use std::cell::OnceCell;
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use db::BackendDb;
use delivery::story_derivatives::DeliveryMedia;
use domain::application::ports::Clock;
use domain::delivery::VideoCompletionNotice;
use domain::notifications::ReminderJobs;
use domain::observability::auth_circuit::AuthCircuitBreaker;
use domain::observability::capabilities::CapabilityReadiness;
use domain::observability::usage::UsageRecorder;
use domain::publishing::boundaries::{NoWorker, SystemJitter, UsageMeter};
use domain::publishing::{Boundaries, Publishing};
use domain::story_cards::StoryCardStore;
use domain::studio::Studio;
use domain::studio::boundaries::StudioBoundaries;
use foundation::config::{Config, SharedConfig, load_config};
use providers::adapters::ProviderCalls;
use providers::channels::connect::ConnectLinks;
use providers::channels::entropy::OsEntropy;
use runtime::http::HttpClient;

use crate::cli::CliSurface;
use crate::context::{OpError, Surface, Terminal};

/// Studio's and publishing's boundaries over the stores.
pub struct OpsHost {
    pub config: SharedConfig,
    auth_circuit: AuthCircuitBreaker<Rc<dyn Clock>>,
    story_cards: StoryCardStore<Rc<dyn Clock>>,
    video_completion: VideoCompletionNotice<Rc<dyn Clock>>,
    reminders: ReminderJobs<Rc<dyn Clock>>,
    readiness: CapabilityReadiness,
    connect_links: ConnectLinks<Rc<dyn Clock>, OsEntropy>,
    media: DeliveryMedia,
    pub adapters: ProviderCalls,
}

impl OpsHost {
    pub fn new(config: SharedConfig, clock: Rc<dyn Clock>, http: HttpClient) -> Self {
        Self {
            auth_circuit: AuthCircuitBreaker::new(Rc::clone(&clock)),
            story_cards: StoryCardStore::new(Rc::clone(&clock)),
            video_completion: VideoCompletionNotice::new(Rc::clone(&clock)),
            reminders: ReminderJobs::new(Rc::clone(&clock)),
            readiness: CapabilityReadiness::new(config.clone()),
            connect_links: ConnectLinks::new(Rc::clone(&clock), OsEntropy),
            media: DeliveryMedia::new(http.clone(), config.clone(), clock),
            adapters: ProviderCalls::new(http, config.clone()),
            config,
        }
    }

    pub fn publishing<'a>(&'a self, usage: &'a dyn UsageMeter) -> Boundaries<'a> {
        Boundaries {
            jitter: &SystemJitter,
            bell: &NoWorker,
            auth_circuit: &self.auth_circuit,
            usage,
            story_cards: &self.story_cards,
            video_completion: &self.video_completion,
        }
    }

    pub fn studio(&self) -> StudioBoundaries<'_> {
        StudioBoundaries {
            reminders: &self.reminders,
            story_derivatives: &self.media,
            readiness: &self.readiness,
            connect_links: &self.connect_links,
        }
    }
}

/// One CLI command's process: the database at `--db`, opened on first use,
/// and the configuration read from the environment and that database.
pub struct ProcessSurface {
    db_path: PathBuf,
    vars: Vec<(String, String)>,
    clock: Rc<dyn Clock>,
    http: HttpClient,
    db: OnceCell<BackendDb>,
    host: OnceCell<OpsHost>,
    usage: UsageRecorder<Rc<dyn Clock>>,
}

impl ProcessSurface {
    /// `vars` is the whole environment `loadConfig` reads.
    pub fn new(db_path: &Path, vars: Vec<(String, String)>, clock: Rc<dyn Clock>, http: HttpClient) -> Self {
        Self {
            db_path: db_path.to_path_buf(),
            vars,
            usage: UsageRecorder::new(Rc::clone(&clock)),
            clock,
            http,
            db: OnceCell::new(),
            host: OnceCell::new(),
        }
    }

    fn host(&self) -> Result<&OpsHost, OpError> {
        if let Some(host) = self.host.get() {
            return Ok(host);
        }
        // The Studio's own settings live in its database, so asking for the
        // configuration opens it.
        let sqlite = db::unsafe_db(self.db()?);
        let mut config = load_config(self.vars.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .map_err(|error| OpError::Failed(error.to_string()))?;
        config.pipeline_db = self.db_path.clone();
        let shared = SharedConfig::new(config);
        providers::channels::credentials::apply_stored_credentials(&shared, sqlite)
            .map_err(|error| OpError::Failed(error.to_string()))?;
        Ok(self
            .host
            .get_or_init(|| OpsHost::new(shared, Rc::clone(&self.clock), self.http.clone())))
    }
}

impl Surface for ProcessSurface {
    fn db(&self) -> Result<&BackendDb, OpError> {
        if let Some(db) = self.db.get() {
            return Ok(db);
        }
        let db = BackendDb::open(&self.db_path)?;
        Ok(self.db.get_or_init(|| db))
    }

    fn config(&self) -> Result<Arc<Config>, OpError> {
        Ok(self.host()?.config.load())
    }

    fn studio<'s>(&'s self, config: &'s Config) -> Result<Studio<'s>, OpError> {
        let host = self.host()?;
        let sqlite = db::unsafe_db(self.db()?);
        Ok(Studio::new(
            Publishing::new(sqlite, &*self.clock, host.publishing(&self.usage)),
            config,
            host.studio(),
        ))
    }

    fn adapters(&self) -> Result<&ProviderCalls, OpError> {
        Ok(&self.host()?.adapters)
    }

    fn usage(&self) -> &dyn UsageMeter {
        &self.usage
    }
}

impl CliSurface for ProcessSurface {
    fn finish(self: Box<Self>) {
        if let Some(db) = self.db.into_inner() {
            self.usage.flush(db::unsafe_db(&db));
            let _ = db.close();
        }
    }
}

/// The real terminal: this process's stdin and stdout.
pub struct ProcessTerminal;

impl Terminal for ProcessTerminal {
    fn write(&self, bytes: &[u8]) -> io::Result<()> {
        let mut stdout = io::stdout().lock();
        stdout.write_all(bytes)?;
        stdout.flush()
    }

    fn stdout_is_tty(&self) -> bool {
        io::stdout().is_terminal()
    }

    fn child_stdout(&self) -> io::Result<std::process::Stdio> {
        Ok(std::process::Stdio::inherit())
    }

    fn read_stdin(&self) -> io::Result<String> {
        let mut text = String::new();
        io::stdin().read_to_string(&mut text)?;
        Ok(text)
    }

    fn ask(&self, question: &str) -> String {
        let _ = self.write(question.as_bytes());
        let mut line = String::new();
        match io::stdin().read_line(&mut line) {
            Ok(0) | Err(_) => String::new(),
            Ok(_) => line.trim().to_owned(),
        }
    }
}
