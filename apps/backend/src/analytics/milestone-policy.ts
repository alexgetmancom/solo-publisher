import type { ApplicationPorts } from "../application/ports.js";
import { DEFAULT_MILESTONE_THRESHOLDS } from "../studio.js";

/** Which audience achievements a Studio announces, and at which counts. The
 * policy lives with the code that applies it; Studio settings only store it. */
export type MilestoneSettings = {
  channelEnabled: boolean;
  groupLocaleEnabled: boolean;
  localeEnabled: boolean;
  projectEnabled: boolean;
  thresholds: number[];
};

/** A Studio that has never opened the screen announces every scope on the
 * default ladder, which is what it did before the screen existed. */
export function milestonePolicy(ports: Pick<ApplicationPorts, "studioSettings">): MilestoneSettings {
  const row = ports.studioSettings.milestones();
  return {
    channelEnabled: row?.channelEnabled !== 0,
    groupLocaleEnabled: row?.groupLocaleEnabled !== 0,
    localeEnabled: row?.localeEnabled !== 0,
    projectEnabled: row?.projectEnabled !== 0,
    thresholds: normalizeMilestoneThresholds(row?.thresholdsJson),
  };
}

/** Ascending, unique, positive and whole: everything downstream compares a
 * follower count against this list and reports the one it crossed. */
export function normalizeMilestoneThresholds(values: readonly number[] | undefined): number[] {
  if (!values) return [...DEFAULT_MILESTONE_THRESHOLDS];
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))].sort((left, right) => left - right);
}
