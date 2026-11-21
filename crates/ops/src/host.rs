//! The CLI process's surface: the database and configuration opened on
//! demand for one command, the boundaries Studio and publishing call (the
//! ported stores; Story derivatives render in this process, as they did in
//! the TypeScript CLI), and the terminal it is attached to.
//!
//! The publish worker's doorbell rings nothing here: the worker lives in the
//! Studio process, which polls the queue, exactly as a `ringWorker` with no
//! registered wake did in a TypeScript CLI process.

use std::cell::OnceCell;
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use adapters::providers::ProviderCalls;
use bot::{Adapters, DynAdapters, Fut};
use channels::connect::ConnectLinks;
use channels::entropy::OsEntropy;
use channels::zernio::ZernioAccounts;
use content::Locale;
use db::BackendDb;
use db::rusqlite::Connection;
use delivery::story_derivatives::DeliveryMedia;
use domain::application::ports::{Clock, StoryPublishMode};
use domain::delivery::VideoCompletionNotice;
use domain::notifications::ReminderJobs;
use domain::observability::auth_circuit::AuthCircuitBreaker;
use domain::observability::capabilities::CapabilityReadiness;
use domain::observability::usage::UsageRecorder;
use domain::publishing::boundaries::{
    MediaMetadata, MediaProbe, ProviderOutcome, StoryCardMedia, StoryCardState, StoryCards, SystemJitter, UsageMeter,
    VideoProvider, WorkerBell,
};
use domain::publishing::{Boundaries, Publishing};
use domain::story_cards::StoryCardStore;
use domain::studio::Studio;
use domain::studio::boundaries::{StudioBoundaries, YoutubeUploads, ZernioAccount, ZernioDirectory};
use foundation::config::{Config, SharedConfig, load_config};
use runtime::ffmpeg::FfmpegMediaProbe;
use runtime::http::HttpClient;
use serde_json::Value;

use crate::cli::CliSurface;
use crate::context::{OpError, Surface, Terminal};

/// The adapters Studio waits on: ffprobe/ffmpeg for media, the platforms for
/// the provider calls, channels' Zernio directory.
pub struct OpsAdapters {
    providers: ProviderCalls,
    zernio: ZernioAccounts,
}

impl OpsAdapters {
    pub fn new(http: HttpClient, config: SharedConfig) -> Self {
        Self {
            providers: ProviderCalls::new(http.clone(), config),
            zernio: ZernioAccounts::new(http),
        }
    }

    pub fn boxed(http: HttpClient, config: SharedConfig) -> DynAdapters {
        DynAdapters(Box::new(Self::new(http, config)))
    }
}

impl Adapters for OpsAdapters {
    fn probe<'a>(&'a self, path: &'a str) -> Fut<'a, Result<MediaMetadata, String>> {
        Box::pin(FfmpegMediaProbe.probe(path))
    }
    fn audio_stats<'a>(&'a self, path: &'a str) -> Fut<'a, Result<String, String>> {
        Box::pin(FfmpegMediaProbe.audio_stats(path))
    }
    fn post_outcome<'a>(
        &'a self,
        provider_post_id: &'a str,
        platform: &'a str,
    ) -> Fut<'a, domain::Result<ProviderOutcome>> {
        Box::pin(self.providers.post_outcome(provider_post_id, platform))
    }
    fn publish_instagram_reel<'a>(
        &'a self,
        account_id: &'a str,
        public_url: &'a str,
        metadata: &'a Value,
        request_id: &'a str,
    ) -> Fut<'a, domain::Result<ProviderOutcome>> {
        Box::pin(
            self.providers
                .publish_instagram_reel(account_id, public_url, metadata, request_id),
        )
    }
    fn keep_youtube_private<'a>(
        &'a self,
        config: &'a Config,
        video_id: &'a str,
        locale: Locale,
    ) -> Fut<'a, domain::Result<()>> {
        Box::pin(self.providers.keep_private(config, video_id, locale))
    }
    fn zernio_accounts<'a>(&'a self, config: &'a Config) -> Fut<'a, domain::Result<Vec<ZernioAccount>>> {
        Box::pin(self.zernio.accounts(config))
    }
}

/// A doorbell with no worker behind it (see the module comment).
struct NoWorker;

impl WorkerBell for NoWorker {
    fn ring_publish(&self) {}
    fn ring_publish_after(&self, _delay_ms: u64) {}
}

/// Studio's and publishing's boundaries over the ported stores.
pub struct OpsHost {
    pub config: SharedConfig,
    auth_circuit: AuthCircuitBreaker<Rc<dyn Clock>>,
    story_cards: StoryCardStore<Rc<dyn Clock>>,
    video_completion: VideoCompletionNotice<Rc<dyn Clock>>,
    reminders: ReminderJobs<Rc<dyn Clock>>,
    readiness: CapabilityReadiness,
    connect_links: ConnectLinks<Rc<dyn Clock>, OsEntropy>,
    media: DeliveryMedia,
    pub adapters: DynAdapters,
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
            adapters: OpsAdapters::boxed(http, config.clone()),
            config,
        }
    }

    pub fn publishing<'a>(&'a self, usage: &'a dyn UsageMeter) -> Boundaries<'a> {
        Boundaries {
            jitter: &SystemJitter,
            bell: &NoWorker,
            auth_circuit: &self.auth_circuit,
            usage,
            story_cards: self,
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

impl StoryCards for OpsHost {
    fn queue(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<()> {
        self.story_cards.queue(sqlite, draft_id)
    }
    fn for_draft(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<Vec<StoryCardState>> {
        self.story_cards.for_draft(sqlite, draft_id)
    }
    fn ready_media(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<Option<StoryCardMedia>> {
        self.story_cards.ready_media(sqlite, draft_id)
    }
    fn set_publish_mode(&self, sqlite: &Connection, draft_id: i64, mode: StoryPublishMode) -> domain::Result<()> {
        self.story_cards.set_publish_mode(sqlite, draft_id, mode)
    }
    fn discard(&self, sqlite: &Connection, draft_id: i64) -> domain::Result<()> {
        self.story_cards.discard(sqlite, draft_id)
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
        channels::credentials::apply_stored_credentials(&shared, sqlite)
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

    fn adapters(&self) -> Result<&DynAdapters, OpError> {
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
            Ok(_) => foundation::js::trim(&line).to_owned(),
        }
    }
}
