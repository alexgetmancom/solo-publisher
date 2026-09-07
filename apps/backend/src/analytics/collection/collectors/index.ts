import { TARGET_GROUPS } from "../../../botTargets.js";
import type { BackendDb } from "../../../db/client.js";
import { collectThreadsReplies } from "../../../engagement/threads-replies.js";
import type { BackendConfig } from "../../../foundation/config.js";
import type { MetricTask } from "../metric-schedule.js";
import { collectInstagramStory } from "./meta.js";
import { collectTelegram, collectTelegramStory } from "./telegram.js";
import { collectThreads } from "./threads.js";
import type { MetricCollector } from "./types.js";
import { collectX } from "./x.js";

/**
 * Every target this build knows how to collect. Deliberately static: `createMetricCollectors`
 * drops targets when a flag or credential is absent, and callers that retire schedules must
 * not confuse "off right now" with "gone from the product".
 */
export const SUPPORTED_METRIC_TARGETS = [
  "telegram",
  ...TARGET_GROUPS.threads,
  ...TARGET_GROUPS.instagramStory,
  ...TARGET_GROUPS.telegramStory,
  ...TARGET_GROUPS.x,
] as const;

export function createMetricCollectors(config: BackendConfig, fetchImpl: typeof fetch = fetch): Record<string, MetricCollector> {
  const threads = (task: MetricTask) => collectThreads(task, config, fetchImpl);
  const instagram = (task: MetricTask) => collectInstagramStory(task, config, fetchImpl);
  const telegramStory = (task: MetricTask) => collectTelegramStory(task, config);
  const x = (task: MetricTask) => collectX(task, config, fetchImpl);
  const collectors: Record<string, MetricCollector> = {
    telegram: (task) => collectTelegram(task, config, fetchImpl),
  };
  for (const target of TARGET_GROUPS.threads) collectors[target] = threads;
  for (const target of TARGET_GROUPS.instagramStory) collectors[target] = instagram;
  for (const target of TARGET_GROUPS.telegramStory) collectors[target] = telegramStory;
  if (config.ENABLE_X_METRICS) {
    for (const target of TARGET_GROUPS.x) collectors[target] = x;
  }
  return collectors;
}

/** Reads the audience's replies under one publication, for the targets whose
 * platform lets them be read.
 *
 * A separate map rather than a field on `MetricResult`: only some platforms
 * answer this question, a collector has no database to answer it into, and an
 * optional field that one target fills is a branch on the caller wearing a
 * struct. The cycle asks whether a target has a reader; it never asks which
 * target it is holding. */
export type ReplyReader = (backendDb: BackendDb, task: MetricTask) => Promise<number>;

export function createReplyReaders(config: BackendConfig, fetchImpl: typeof fetch = fetch): Record<string, ReplyReader> {
  const readers: Record<string, ReplyReader> = {};
  for (const target of TARGET_GROUPS.threads)
    readers[target] = (backendDb, task) => collectThreadsReplies(backendDb, config, target, task.externalIds, fetchImpl);
  return readers;
}
