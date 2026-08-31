import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function sourceFiles(relativeDirectory: string): string[] {
  return readdirSync(join(root, relativeDirectory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relativePath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [relativePath] : [];
  });
}

/** This reads the text of the application files themselves and deliberately
 * does not follow imports: Studio calling `publishDraftToQueue` is allowed —
 * Publishing owns its transactions — and a transitive check would call that a
 * violation. What must stay true is that these files hold no persistence of
 * their own.
 *
 * Keep exceptions explicit and shrinking. New application files are covered
 * automatically. */
const applicationPersistenceExceptions = new Set<string>();

/** The text of one function declaration, up to the next top-level one. Enough
 * to say what a function does and does not call, without a parser. */
function functionBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`architecture rule names a function that does not exist: ${name}`);
  const next = text.indexOf("\nfunction ", start + 1);
  const nextExported = text.indexOf("\nexport function ", start + 1);
  const ends = [next, nextExported].filter((index) => index > 0);
  return ends.length ? text.slice(start, Math.min(...ends)) : text.slice(start);
}

describe("architecture fitness", () => {
  it("keeps application ports and domain event policy independent from infrastructure", () => {
    for (const file of ["apps/backend/src/application/ports.ts", "apps/backend/src/content/drafts.ts"]) {
      const text = source(file);
      expect(text).not.toMatch(/from ["'][^"']*\/db\//);
      expect(text).not.toMatch(/from ["']drizzle-orm/);
    }
    for (const file of ["apps/backend/src/studio/services/posts.ts"]) {
      const text = source(file);
      expect(text).not.toMatch(/from ["'][^"']*\/db\/schema/);
      expect(text).not.toMatch(/from ["']drizzle-orm/);
    }
  });

  it("keeps Studio and content application services behind persistence ports", () => {
    // The rule is that this set is empty, so the set being empty is the
    // assertion: an exception added later would otherwise pass silently.
    expect([...applicationPersistenceExceptions]).toEqual([]);
    const files = ["apps/backend/src/studio", "apps/backend/src/content"].flatMap(sourceFiles);
    for (const file of files) {
      if (applicationPersistenceExceptions.has(file)) continue;
      const text = source(file);
      expect(text).not.toContain("backendDb.db");
      expect(text).not.toContain("backendDb.sqlite");
      expect(text).not.toContain("unsafeDb(");
      expect(text).not.toMatch(/from ["'][^"']*\/db\/schema/);
      expect(text).not.toMatch(/from ["']drizzle-orm/);
    }
  });

  it("keeps Telegram conversation state behind one persistence port", () => {
    const text = source("apps/backend/src/bot/conversation-state.ts");
    expect(text).not.toContain("unsafeDb(");
    expect(text).not.toMatch(/from ["'][^"']*\/db\/schema/);
    expect(text).toContain("conversationSessions");
  });

  it("routes domain events through the durable event port", () => {
    const producerFiles = [
      "apps/backend/src/content/assets.ts",
      "apps/backend/src/content/drafts.ts",
      "apps/backend/src/delivery/publish-workflow.ts",
      "apps/backend/src/delivery/video-worker.ts",
      "apps/backend/src/publishing/publication-workflow.ts",
      "apps/backend/src/studio/services/posts.ts",
      "apps/backend/src/studio/services/videos.ts",
    ];
    // The port is the only way in: a producer reaching for the events table
    // itself would bypass the cooldown and the clock the store owns.
    for (const file of producerFiles) {
      const text = source(file);
      expect(text).toContain(".events.record(");
      expect(text).not.toContain("publicationEvents");
    }
  });

  /** The publish job's payload is where a delivery keeps what it has already
   * put in front of the audience -- the ids of a chain's published messages,
   * under the key the adapter named. Every incident of a post reaching the
   * audience twice has been a write to this column that rebuilt it from the
   * publication source and dropped that state: a retry did it, and so did
   * replanning a post after an edit.
   *
   * So the column has a short list of writers, and they are the files where the
   * question "what has this delivery already published?" is asked out loud. A
   * new one is not forbidden -- it is required to answer that question, and
   * adding itself here is how it says it did. */
  it("keeps the writers of a publish job's payload to the ones that reason about what it already published", () => {
    const writers = sourceFiles("apps/backend/src")
      .filter((file) => !file.includes("/db/schema/"))
      .filter((file) => {
        const text = source(file);
        return text.includes("payloadJson") && text.includes("publishJobs");
      })
      .sort();
    expect(writers).toEqual([
      "apps/backend/src/operations/resume-from.ts",
      "apps/backend/src/publishing/publication-writer.ts",
      "apps/backend/src/publishing/queue.ts",
      "apps/backend/src/publishing/requeue.ts",
    ]);
    // And each of them names the resume state rather than assuming there is
    // none. `job-policy.ts` is the column set they all write through and takes
    // the finished payload as an argument, so it never sees the question.
    for (const file of writers) expect(source(file)).toMatch(/resumeState|hasResumeState|resumeKey/);
  });

  /** `publication_targets` and `video_targets` are the rows that say what the
   * audience has: a status, a platform id, a link. Delivery, Publishing and the
   * operator commands that answer for a delivery write them; nothing else does.
   *
   * Analytics used to, in its own hand-written upsert -- an X export listing a
   * post the queue never delivered, a collector handed a canonical permalink.
   * Both were careful, and both were a second spelling of a write whose
   * conditions live somewhere else. They go through
   * delivery/observed-publication.ts now, which is what an area that *learns*
   * something about a publication is allowed to do to one.
   *
   * Adding a file here is allowed and is how it says it belongs. Adding one
   * under analytics/, bot/, interfaces/ or studio/ is not: those surfaces ask
   * Delivery, they do not answer for it. */
  it("keeps the writers of what the audience has to Delivery, Publishing and Operations", () => {
    const writersOf = (orm: string, table: string): string[] => {
      const write = new RegExp(`(?:insert|update|delete)\\(${orm}\\)|(?:UPDATE|INSERT INTO|DELETE FROM)\\s+${table}\\b`);
      return sourceFiles("apps/backend/src")
        .filter((file) => !file.includes("/db/schema/"))
        .filter((file) => write.test(source(file)))
        .sort();
    };

    expect(writersOf("publicationTargets", "publication_targets")).toEqual([
      "apps/backend/src/delivery/external-removals.ts",
      "apps/backend/src/delivery/observed-publication.ts",
      "apps/backend/src/delivery/publication-reconciliation.ts",
      "apps/backend/src/operations/maintenance.ts",
      "apps/backend/src/operations/settle.ts",
      "apps/backend/src/publishing/abandon.ts",
      "apps/backend/src/publishing/queue-state.ts",
      "apps/backend/src/publishing/requeue.ts",
    ]);
    expect(writersOf("videoTargets", "video_targets")).toEqual([
      "apps/backend/src/delivery/publication-reconciliation.ts",
      "apps/backend/src/delivery/video-worker.ts",
      "apps/backend/src/operations/maintenance.ts",
      "apps/backend/src/publishing/video-service.ts",
      "apps/backend/src/publishing/video-settle.ts",
    ]);
  });

  /** Three surfaces report the same delivery -- the bot's card, `ops recent`,
   * `ops verify` -- and each one that spelled "half published" itself gave a
   * different answer. They ask one function now, and this is what keeps them
   * asking it. */
  it("keeps every delivery surface reading partial publication from one place", () => {
    for (const file of [
      "apps/backend/src/interfaces/telegram/video-notifications.ts",
      "apps/backend/src/operations/recent.ts",
      "apps/backend/src/operations/verify.ts",
    ]) {
      expect(source(file)).toContain("isPartialDelivery");
      // The expression itself, written out again, is the drift this prevents.
      expect(source(file)).not.toMatch(/!==\s*"published"\s*&&\s*Boolean/);
    }
  });

  /** The compiler already refuses a payload that was not built by one of the
   * four constructors, which is the real guard. This says the same thing about
   * the constructors themselves: they are the only place allowed to assert the
   * brand, so a fifth way to make one cannot appear quietly. */
  it("keeps the delivery payload's brand assertable in one file", () => {
    const asserting = sourceFiles("apps/backend/src").filter((file) => source(file).includes("as DeliveryPayload"));
    expect(asserting).toEqual(["apps/backend/src/publishing/delivery-payload.ts"]);
  });

  /** The overview draws several windows of the same data side by side -- the
   * period, the one before it, yesterday, the 30-day median, and the history
   * behind the chart. Each half loads its history once and cuts every window
   * from it: `pipelineForDates`, `xActivityForDates` and the video read model's
   * `periodReachByRow` all slice, none re-derive.
   *
   * Video was the one that did not, and it cost 60-85% of the read model in
   * production: five windows, each rebuilding every clip's series and re-running
   * the daily spread over it. The spreading primitives are what makes that
   * mistake expensive, so they stay inside the file that owns the single pass.
   *
   * The rule is that this set is empty, so the set being empty is the
   * assertion. */
  const windowSpreadingExceptions = new Set<string>();

  it("cuts every overview comparison window from one loaded history", () => {
    expect([...windowSpreadingExceptions]).toEqual([]);
    const owner = "apps/backend/src/interfaces/web/dashboard/video-overview-data.ts";
    for (const file of sourceFiles("apps/backend/src/interfaces/web/dashboard")) {
      if (file === owner || windowSpreadingExceptions.has(file)) continue;
      const text = source(file);
      expect(text).not.toMatch(/\bdailyReach\(/);
      expect(text).not.toMatch(/\bperiodReach\(/);
    }
    // Inside the owner the rule is narrower, and this is where it first failed:
    // exempting the whole file let a second, larger per-window spread sit next
    // to the one that had just been removed, and production did not move. Every
    // window function slices; only the single pass spreads.
    const ownerText = source(owner);
    // Each window function reaches the history through a slicer, never through
    // the spread itself.
    const slicesVia: Record<string, string> = {
      periodReachByRow: "historyDailyReach(",
      dailyReachForWindow: "historyDailyReach(",
      aggregateDailyMetrics: "dailyReachForWindow(",
    };
    for (const [windowFunction, required] of Object.entries(slicesVia)) {
      expect(functionBody(ownerText, windowFunction)).toContain(required);
    }
    expect(functionBody(ownerText, "historyDailyReach")).toMatch(/\bdailyReach\(/);
  });

  it("keeps infrastructure adapters behind the composition root", () => {
    const client = source("apps/backend/src/db/client.ts");
    expect(client).toContain("createDraftStore(db, clock)");
    expect(client).toContain("createEventStore(db, clock)");
    expect(client).toContain("queue: (draftId) => queueDraftStoryCards(db, draftId)");
  });
});
