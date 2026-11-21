import fs from "node:fs";
import path from "node:path";
import { acceptFlow, backFlow } from "../../apps/backend/src/application/conversation-flow.js";
import type { DraftMessage } from "../../apps/backend/src/content/message.js";
import { openBackendDb, type UnsafeBackendDb, unsafeDb } from "../../apps/backend/src/db/client.js";
import { type BackendConfig, loadConfig, withStudioProfile } from "../../apps/backend/src/foundation/config.js";
import { StudioError } from "../../apps/backend/src/foundation/errors.js";
import { probeMediaMetadata, runFfmpeg } from "../../apps/backend/src/foundation/runtime/ffmpeg.js";
import type { VideoTarget } from "../../apps/backend/src/publishing/video-types.js";
import { createStudioServices } from "../../apps/backend/src/studio/services/index.js";
import {
  replanScheduledPostAfterStoryCardFailure,
  replanScheduledPostAfterStoryCards,
} from "../../apps/backend/src/studio/services/posts.js";
import {
  advanceVideoMetadata,
  firstVideoMetadataStep,
  isVideoWizardStep,
  VIDEO_FLOW,
  type VideoWizardStep,
  videoScheduleDates,
} from "../../apps/backend/src/studio/video-fsm.js";
import { studioConfig } from "../../apps/backend/src/studio.js";
import { dump, resolve } from "./scenario-support.js";

/**
 * The TypeScript side of the Rust Studio service equivalence test
 * (crates/domain/tests/studio_scenarios.rs): every scenario drives the real
 * Studio services (`createStudioServices`) on a fresh in-memory database
 * under a fixed clock, and prints every step's result and a dump of every
 * non-empty table but the `ignoredTables` the spec names.
 *
 *   bun scripts/rust/studio-scenarios.ts crates/domain/tests/studio_scenarios.json
 *
 * `{DATA}` and `{MEDIA}` in the spec name the Studio's data directory and a
 * directory of media fixtures under `_trash-rust/tmp/studio-scenarios`, which
 * this script empties and fills (a one-second 9:16 clip, made with ffmpeg)
 * before it runs. What ffprobe reports for that clip is printed beside the
 * scenarios: it is what the Rust side's prober answers. Zernio is answered
 * from the spec's `zernioAccounts`; nothing reaches a network.
 *
 * A step is
 *   {"clock": "<ISO instant>"} | {"sql": "<statement>"} | {"file": "<path>", "base64": "<bytes>"}
 *   {"call": "<name>", "args": [...], "bind"?: "<name>", "error"?: "any"}
 */

type Step = { clock?: string; sql?: string; file?: string; base64?: string; call?: string; args?: unknown[]; bind?: string; error?: "any" };
type Scenario = { name: string; steps: Step[] };
type Spec = {
  clock: string;
  config: Record<string, string>;
  zernioApiKey: string;
  zernioAccounts: unknown[];
  ignoredTables: string[];
  setup: string[];
  beforeDump: string[];
  scenarios: Scenario[];
};
type Args = unknown[];

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: studio-scenarios.ts <studio_scenarios.json>");
  process.exit(2);
}
const base = path.resolve("_trash-rust/tmp/studio-scenarios");
const dataDir = path.join(base, "data");
const mediaDir = path.join(base, "media");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8").replaceAll("{DATA}", dataDir).replaceAll("{MEDIA}", mediaDir)) as Spec;

fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(mediaDir, { recursive: true });
const clip = path.join(mediaDir, "clip.mp4");
await runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
const probe = await probeMediaMetadata(clip);

let nowMs = Date.parse(spec.clock);
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(nowMs);
    else super(...(args as [string]));
  }
  static override now(): number {
    return nowMs;
  }
}
globalThis.Date = FixedDate as DateConstructor;
globalThis.fetch = (async () => Response.json({ accounts: spec.zernioAccounts })) as unknown as typeof fetch;

const date = (value: unknown) => new Date(value as string);
const dates = (value: unknown) =>
  Object.fromEntries(Object.entries(value as Record<string, string>).map(([key, at]) => [key, new Date(at)]));

async function call(backendDb: UnsafeBackendDb, config: BackendConfig, name: string, args: Args): Promise<unknown> {
  const studio = createStudioServices(backendDb, config);
  const { posts, videos, queue, settings, channels, media, capabilities } = studio;
  const int = (index: number) => args[index] as number;
  const text = (index: number) => args[index] as string;
  const optional = <T>(index: number) => (args[index] ?? undefined) as T | undefined;
  switch (name) {
    // ---- posts
    case "posts.create":
      return posts.create(int(0), args[1] as DraftMessage, optional(2));
    case "posts.get":
      return posts.get(int(0), int(1));
    case "posts.list":
      return posts.list(int(0), optional(1));
    case "posts.validate":
      return posts.validate(int(0), int(1));
    case "posts.preview":
      return posts.preview(int(0), int(1));
    case "posts.progress":
      return posts.progress(int(0), int(1));
    case "posts.history":
      return posts.history(int(0), int(1), optional(2));
    case "posts.mediaAssets":
      return posts.mediaAssets(int(0), optional(1));
    case "posts.attachMediaAssets":
      return posts.attachMediaAssets(int(0), int(1), args[2] as "ru" | "en", args[3] as number[], Boolean(args[4]));
    case "posts.removeMedia":
      return posts.removeMedia(int(0), int(1), args[2] as "ru" | "en", args[3] as number[]);
    case "posts.schedule": {
      const input = args[2] as { ruAt?: string | null; enAt?: string | null; allowPast?: boolean; immediateLocale?: "ru" | "en" };
      return posts.schedule(int(0), int(1), {
        ruAt: input.ruAt ? date(input.ruAt) : null,
        enAt: input.enAt ? date(input.enAt) : null,
        ...(input.allowPast ? { allowPast: true } : {}),
        ...(input.immediateLocale ? { immediateLocale: input.immediateLocale } : {}),
      });
    }
    case "posts.hasLocaleTargets":
      return posts.hasLocaleTargets(int(0), int(1), args[2] as "ru" | "en");
    case "posts.slotTime":
      return posts.slotTime(int(0), text(1));
    case "posts.manualSchedule":
      return posts.manualSchedule(int(0), int(1), args[2] as "ru" | "en" | "both", text(3));
    case "posts.scheduleAt":
      return posts.scheduleAt(int(0), int(1), args[2] as "ru" | "en" | "both", date(args[3]));
    case "posts.cancel":
      return posts.cancel(int(0), int(1));
    case "posts.deliveryPlan":
      return posts.deliveryPlan(int(0), int(1));
    case "posts.pendingTargets":
      return posts.pendingTargets(int(0), int(1));
    case "posts.cancelRemaining":
      return posts.cancelRemaining(int(0), int(1));
    case "posts.setStoryPublishMode":
      return posts.setStoryPublishMode(int(0), int(1), args[2] as "all" | "site_only");
    case "posts.replaceEntityCandidates":
      return posts.replaceEntityCandidates(int(0), int(1), args[2] as Parameters<typeof posts.replaceEntityCandidates>[2]);
    case "posts.acceptEntityCandidates":
      return posts.acceptEntityCandidates(int(0), int(1));
    case "posts.makeThread":
      return posts.makeThread(int(0), int(1));
    case "posts.appendThreadPart":
      return posts.appendThreadPart(int(0), int(1), args[2] as Parameters<typeof posts.appendThreadPart>[2]);
    case "posts.editThreadPart":
      return posts.editThreadPart(int(0), int(1), int(2), args[3] as Parameters<typeof posts.editThreadPart>[3]);
    case "posts.editThreadPartEnglish":
      return posts.editThreadPartEnglish(int(0), int(1), int(2), text(3));
    case "posts.removeThreadPart":
      return posts.removeThreadPart(int(0), int(1), int(2));
    case "posts.publishArticle":
      return posts.publishArticle(int(0), args[1] as Parameters<typeof posts.publishArticle>[1]);
    case "posts.publish":
      return posts.publish(int(0), int(1));
    case "posts.retryTarget":
      return posts.retryTarget(int(0), int(1), optional(2));
    case "posts.resendableTargets":
      return posts.resendableTargets(int(0), int(1));
    case "posts.resendTarget":
      return posts.resendTarget(int(0), int(1), text(2));
    case "posts.skipTarget":
      return posts.skipTarget(int(0), int(1), optional(2));
    case "posts.toggleTarget":
      return posts.toggleTarget(int(0), int(1), text(2));
    case "posts.removeTarget":
      return posts.removeTarget(int(0), int(1), text(2));
    case "posts.cycleMode":
      return posts.cycleMode(int(0), int(1));
    case "posts.edit":
      return posts.edit(int(0), int(1), args[2] as Parameters<typeof posts.edit>[2]);
    case "posts.replanAfterStoryCards":
      return replanScheduledPostAfterStoryCards(backendDb, config, int(0));
    case "posts.replanAfterStoryCardFailure":
      return replanScheduledPostAfterStoryCardFailure(backendDb, config, int(0));
    // ---- videos
    case "videos.create":
      return videos.create(int(0), int(1), optional(2));
    case "videos.get":
      return videos.get(int(0), int(1));
    case "videos.replaceSource":
      return videos.replaceSource(int(0), int(1), int(2));
    case "videos.assetTechnicalCheck":
      return videos.assetTechnicalCheck(int(0), int(1));
    case "videos.sourceReplaceable":
      return videos.sourceReplaceable(int(0), int(1));
    case "videos.metadataEditableTargets":
      return videos.metadataEditableTargets(int(0), int(1));
    case "videos.list":
      return videos.list(int(0), optional(1));
    case "videos.schedule":
      return videos.schedule(int(0), int(1), dates(args[2]));
    case "videos.validate":
      return videos.validate(int(0), int(1));
    case "videos.technicalCheck":
      return videos.technicalCheck(int(0), int(1));
    case "videos.publish":
      return videos.publish(int(0), int(1));
    case "videos.settleTarget":
      return videos.settleTarget(int(0), int(1), args[2] as VideoTarget);
    case "videos.retryTarget":
      return videos.retryTarget(int(0), int(1), args[2] as VideoTarget);
    case "videos.cancel":
      return videos.cancel(int(0), int(1));
    case "videos.preview":
      return videos.preview(int(0), int(1));
    case "videos.status":
      return videos.status(int(0), int(1));
    case "videos.history":
      return videos.history(int(0), int(1), optional(2));
    case "videos.updateMetadata":
      return videos.updateMetadata(int(0), int(1), args[2] as VideoTarget, args[3] as Parameters<typeof videos.updateMetadata>[3]);
    case "videos.editMetadataField":
      return videos.editMetadataField(int(0), int(1), args[2] as VideoWizardStep, args[3]);
    case "videos.completeWizardTarget":
      return videos.completeWizardTarget(
        int(0),
        int(1),
        args[2] as VideoTarget,
        args[3] as Record<string, unknown>,
        args[4] as VideoTarget[],
      );
    case "videos.rename":
      return videos.rename(int(0), int(1), text(2));
    case "videos.setScript":
      return videos.setScript(int(0), int(1), text(2));
    case "videos.replaceTargets":
      return videos.replaceTargets(int(0), int(1), args[2] as VideoTarget[]);
    case "videos.removeTarget":
      return videos.removeTarget(int(0), int(1), args[2] as VideoTarget);
    case "videos.toggleTarget":
      return videos.toggleTarget(int(0), int(1), text(2));
    case "videos.manualSchedule":
      return videos.manualSchedule(int(0), int(1), text(2));
    case "videos.immediateTime":
      return videos.immediateTime();
    case "videos.isImmediate":
      return videos.isImmediate(date(args[0]));
    case "videos.slotTime":
      return videos.slotTime(int(0), text(1));
    // ---- video workflow
    case "fsm.accept": {
      const transition = await acceptFlow(VIDEO_FLOW, text(0), args[1], args[2] as Record<string, unknown>);
      return transition && { data: transition.data, next: transition.next };
    }
    case "fsm.back":
      return backFlow(VIDEO_FLOW, text(0), args[1] as Record<string, unknown>);
    case "fsm.firstMetadataStep":
      return firstVideoMetadataStep(args[0] as VideoTarget[]);
    case "fsm.isWizardStep":
      return isVideoWizardStep(text(0) as VideoWizardStep);
    case "fsm.advanceMetadata":
      return advanceVideoMetadata(args[0] as VideoWizardStep, text(1), args[2] as Record<string, unknown>);
    case "fsm.scheduleDates":
      return videoScheduleDates(args[0] as Record<string, string>);
    // ---- queue
    case "queue.headline":
      return queue.headline(int(0));
    case "queue.snapshot":
      return queue.snapshot(int(0), optional(1));
    // ---- settings
    case "settings.studioProfile":
      return settings.studioProfile();
    case "settings.setStudioProfile":
      return settings.setStudioProfile(args[0] as Parameters<typeof settings.setStudioProfile>[0]);
    case "settings.locale":
      return settings.locale(int(0));
    case "settings.setLocale":
      return settings.setLocale(int(0), args[1] as "en" | "ru");
    case "settings.timezone":
      return settings.timezone(int(0), text(1));
    case "settings.setTimezone":
      return settings.setTimezone(int(0), text(1));
    case "settings.timeConfig":
      return settings.timeConfig(int(0), config);
    case "settings.notifications":
      return settings.notifications(int(0));
    case "settings.setNotifications":
      return settings.setNotifications(int(0), args[1] as Parameters<typeof settings.setNotifications>[1]);
    case "settings.backup":
      return settings.backup();
    case "settings.setBackup":
      return settings.setBackup(args[0] as { enabled: boolean });
    case "settings.youtubeSignature":
      return settings.youtubeSignature();
    case "settings.setYoutubeSignature":
      return settings.setYoutubeSignature(text(0));
    case "settings.clearYoutubeSignature":
      return settings.clearYoutubeSignature();
    case "settings.defaultTargets":
      return settings.defaultTargets();
    case "settings.toggleDefaultTarget":
      return settings.toggleDefaultTarget(text(0));
    case "config.view": {
      const view = studioConfig(backendDb);
      return {
        timezone: view.timezone,
        timezoneLabel: view.timezoneLabel,
        siteEnabled: view.siteEnabled,
        site: { en: view.site("en"), ru: view.site("ru") },
        siteTimezone: { en: view.siteTimezone("en"), ru: view.siteTimezone("ru") },
        video: view.video,
      };
    }
    // ---- channels
    case "channels.list":
      return channels.list(args[0] as boolean);
    case "channels.report":
      return channels.report(args[0] as boolean);
    case "channels.connect":
      return channels.connect(args[0] as Parameters<typeof channels.connect>[0], optional(1));
    case "channels.connectTarget":
      return channels.connectTarget(
        args[0] as Parameters<typeof channels.connectTarget>[0],
        optional(1),
        optional(2),
        optional(3),
        optional(4),
      );
    case "channels.disable":
      return channels.disable(text(0));
    case "channels.nativeConnectUrl":
      return channels.nativeConnectUrl(args[0] as "threads" | "instagram", args[1] as "ru" | "en");
    case "channels.nativeConnectPath":
      return channels.nativeConnectPath(args[0] as "threads" | "instagram", args[1] as "ru" | "en");
    case "channels.startConnect":
      return channels.startConnect(args[0] as Parameters<typeof channels.startConnect>[0], args[1] as "ru" | "en");
    case "channels.xConnectUrl":
      return channels.xConnectUrl();
    case "channels.xConnectPath":
      return channels.xConnectPath();
    case "channels.discoverZernioAccounts":
      return channels.discoverZernioAccounts();
    case "channels.discoverZernioConnections":
      return channels.discoverZernioConnections(args[0] as "ru" | "en");
    case "channels.connectZernio":
      return channels.connectZernio(text(0), args[1] as "ru" | "en", args[2] as Parameters<typeof channels.connectZernio>[2]);
    // ---- media and capabilities
    case "media.import": {
      const input = args[1] as { filename: string; contentType: string; base64: string; source: "http_upload" };
      return media.import(int(0), { ...input, bytes: Buffer.from(input.base64, "base64") });
    }
    case "media.importFile":
      return media.importFile(int(0), args[1] as Parameters<typeof media.importFile>[1]);
    case "capabilities.report":
      return capabilities.report();
    default:
      throw new Error(`unknown call ${name}`);
  }
}

function errorResult(error: unknown, mode: Step["error"]): unknown {
  if (mode === "any") return { error: "<any>" };
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof StudioError && error.params)
    return { error: message, params: Object.fromEntries(Object.entries(error.params).map(([key, value]) => [key, String(value)])) };
  return { error: message };
}

async function run(scenario: Scenario) {
  nowMs = Date.parse(spec.clock);
  const backendDb = openBackendDb(":memory:") as UnsafeBackendDb;
  const { sqlite } = unsafeDb(backendDb);
  const config = withStudioProfile(loadConfig({ ...spec.config, DATA_DIR: dataDir }), backendDb);
  config.ZERNIO_API_KEY = spec.zernioApiKey;
  const vars: Record<string, unknown> = {};
  const results: { call: string; result: unknown }[] = [];
  try {
    for (const statement of spec.setup) sqlite.run(statement);
    for (const step of scenario.steps) {
      if (step.clock !== undefined) nowMs = Date.parse(step.clock);
      else if (step.sql !== undefined) sqlite.run(step.sql);
      else if (step.file !== undefined) fs.writeFileSync(step.file, Buffer.from(step.base64 ?? "", "base64"));
      else if (step.call !== undefined) {
        let result: unknown;
        try {
          const value = await call(backendDb, config, step.call, resolve(step.args ?? [], vars) as Args);
          if (step.bind) vars[step.bind] = value;
          result = value === undefined ? null : value;
        } catch (error) {
          result = errorResult(error, step.error);
        }
        results.push({ call: step.call, result });
      } else throw new Error(`step without clock, sql, file or call in ${scenario.name}`);
    }
    for (const statement of spec.beforeDump) sqlite.run(statement);
    return JSON.parse(JSON.stringify({ name: scenario.name, results, tables: dump(sqlite, spec.ignoredTables) })) as unknown;
  } finally {
    backendDb.close();
  }
}

const scenarios = [];
for (const scenario of spec.scenarios) scenarios.push(await run(scenario));
console.log(JSON.stringify({ probe, scenarios }));
