import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "../../../tools/layer-checker/node_modules/typescript/lib/typescript.js";
import { publicationAction, publicationActionNames } from "../src/bot/publication-actions.js";
import { parsePublicationCallback, publicationCallback } from "../src/bot/publication-callback.js";
import { createPublicationScheduleEngine } from "../src/bot/scheduling.js";
import { parseScreenCallback } from "../src/bot/screen-callback.js";

type PublicationKind = "post" | "video";

type EmittedCallback = {
  kind: PublicationKind;
  action: string;
  argumentCount: number | null;
  location: string;
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function emittedCallbacks(): EmittedCallback[] {
  const sourceRoot = join(import.meta.dir, "../src");
  const callbacks: EmittedCallback[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "publicationCallback") {
        const [kindNode, actionNode, argsNode] = node.arguments;
        if (!actionNode || !ts.isStringLiteral(actionNode)) throw new Error(`publicationCallback action must be literal in ${file}`);
        const kinds = kindNode && ts.isStringLiteral(kindNode) ? [kindNode.text as PublicationKind] : (["post", "video"] as const);
        const argumentCount = !argsNode ? 0 : ts.isArrayLiteralExpression(argsNode) ? argsNode.elements.length : null;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        for (const kind of kinds)
          callbacks.push({ kind, action: actionNode.text, argumentCount, location: `${relative(sourceRoot, file)}:${line}` });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return callbacks;
}

function expectCallbackShape(data: string, kind: PublicationKind): void {
  const callback = parsePublicationCallback(data);
  expect(callback).not.toBeNull();
  if (!callback) return;
  const definition = publicationAction(kind, callback.action);
  expect(definition).toBeDefined();
  if (!definition) return;
  const payload = definition.entity === "draft" ? callback.args.slice(1) : callback.args;
  expect(payload).toHaveLength(definition.args.length);
}

describe("Telegram publication callback registry", () => {
  it("rejects retired analytics and achievement buttons from old messages", () => {
    for (const callback of [
      "analytics_home",
      "analytics_section:overview:7",
      "analytics_milestones:0",
      "archive_home",
      "analytics_archive:0",
      "analytics_post_archive:0",
      "analytics_video:1",
      "analytics_post:1",
      "analytics_post_media:1",
    ]) {
      expect(parseScreenCallback(callback)).toBeNull();
    }
    expect(parseScreenCallback("menu_home")?.id).toBe("menu_home");
    expect(parseScreenCallback("queue_home")?.id).toBe("queue_home");
  });

  it("declares and emits every action through source call-sites", () => {
    const emitted = emittedCallbacks();
    for (const callback of emitted) {
      const definition = publicationAction(callback.kind, callback.action);
      expect(definition, callback.location).toBeDefined();
      if (!definition || callback.argumentCount === null) continue;
      const payloadCount = definition.entity === "draft" ? callback.argumentCount - 1 : callback.argumentCount;
      expect(payloadCount, callback.location).toBe(definition.args.length);
    }
    for (const kind of ["post", "video"] as const)
      for (const name of publicationActionNames(kind))
        expect(
          emitted.some((callback) => callback.kind === kind && callback.action === name),
          `${kind}:${name}`,
        ).toBe(true);
  });

  it("parses callback arguments by the declaration order", () => {
    const callback = parsePublicationCallback(publicationCallback("post", "toggle", [42, "telegram"]));
    expect(callback).toEqual({ kind: "post", action: "toggle", args: ["42", "telegram"] });
    expect(publicationAction("post", "toggle")?.args).toEqual(["target"]);
  });

  it("rejects an argument containing the separator instead of splitting it in two", () => {
    expect(() => publicationCallback("post", "toggle", ["tele:gram"])).toThrow("action.invalid-callback-argument");
  });

  it("does not require a conversation revision for stateless post schedule pickers", () => {
    expect(publicationAction("post", "sched_pick")?.sessionRevision).toBeUndefined();
    expect(publicationAction("post", "sched_manual")?.sessionRevision).toBeUndefined();
    expect(publicationAction("post", "sched_confirm")?.sessionRevision).toBe(true);
  });

  it("keeps generated callback data under Telegram's 64-byte limit", () => {
    const callbacks = [
      publicationCallback("post", "view", [123456789, "schedule_ru_evening"]),
      publicationCallback("post", "retry", [123456789, "instagram_reels", "notice"]),
      publicationCallback("video", "edit_field", [123456789, "instagram_caption"]),
      publicationCallback("video", "sched_pick", [123456789, "instagram_reels", "2200"], 999),
    ];
    expect(Math.max(...callbacks.map((callback) => callback.length))).toBeLessThanOrEqual(64);
  });

  it("keeps schedule-engine callback arity aligned for both axes", () => {
    const post = createPublicationScheduleEngine({
      kind: "post",
      publicationId: 7,
      scheduleAxis: "locale",
      axisKeys: ["ru"],
      axisLabel: (key) => key,
      slotValues: [],
    });
    const video = createPublicationScheduleEngine({
      kind: "video",
      publicationId: 8,
      scheduleAxis: "target",
      axisKeys: ["youtube_shorts"],
      axisLabel: (key) => key,
      slotValues: [],
    });
    expectCallbackShape(post.pickCallback("ru", "08:00"), "post");
    expectCallbackShape(post.manualCallback("ru"), "post");
    expectCallbackShape(post.confirmCallback(), "post");
    expectCallbackShape(video.pickCallback("youtube_shorts", "08:00"), "video");
    expectCallbackShape(video.manualCallback(), "video");
    expectCallbackShape(video.confirmCallback(), "video");
  });
});
