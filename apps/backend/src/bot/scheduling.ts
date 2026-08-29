import { InlineKeyboard } from "grammy";
import type { PublicationKind } from "../application/conversation-flow.js";
import type { PublicationScheduleAxis } from "../application/publication-pipeline.js";
import type { PublicationEffect } from "./effects.js";
import { publicationCallback, versionedCallback } from "./publication-callback.js";

/** The values along which a scheduling screen lets an operator move. */
type ScheduleAxis<T extends string> = {
  values: readonly T[];
  label: (value: T) => string;
  callback: (value: T) => string;
};

type PublicationScheduleEngine<T extends string> = {
  scheduleAxis: PublicationScheduleAxis;
  axisKeys: readonly T[];
  axisLabel: (key: T) => string;
  axis: ScheduleAxis<string>;
  pickCallback: (key: T | undefined, clock: string) => string;
  manualCallback: (key?: T) => string;
  confirmCallback: () => string;
};

/** Creates the shared Telegram schedule protocol for a publication pipeline.
 * The domain supplies its axis keys and labels; all three callback actions are
 * emitted from this one engine. */
export function createPublicationScheduleEngine<T extends string>(options: {
  kind: PublicationKind;
  publicationId: number;
  scheduleAxis: PublicationScheduleAxis;
  axisKeys: readonly T[];
  axisLabel: (key: T) => string;
  slotValues: readonly string[];
}): PublicationScheduleEngine<T> {
  const args = (key: T | undefined, clock?: string): Array<string | number> => {
    const result: Array<string | number> = [options.publicationId];
    if (key !== undefined) result.push(key);
    if (clock !== undefined) result.push(clock.replace(":", ""));
    return result;
  };
  const pickCallback = (key: T | undefined, clock: string) => publicationCallback(options.kind, "sched_pick", args(key, clock));
  return {
    scheduleAxis: options.scheduleAxis,
    axisKeys: options.axisKeys,
    axisLabel: options.axisLabel,
    axis: {
      values: options.slotValues,
      label: (clock) => clock,
      callback: (clock) => pickCallback(options.axisKeys[0], clock),
    },
    pickCallback,
    manualCallback: (key) => publicationCallback(options.kind, "sched_manual", args(key)),
    confirmCallback: () => publicationCallback(options.kind, "sched_confirm", [options.publicationId]),
  };
}

/** Renders an axis as two-column slot rows. The caller owns the surrounding
 * navigation because post and video screens have different footer actions. */
export function appendScheduleAxisButtons<T extends string>(
  keyboard: InlineKeyboard,
  axis: ScheduleAxis<T>,
  revision?: number | null,
): InlineKeyboard {
  for (let index = 0; index < axis.values.length; index += 2) {
    for (const value of axis.values.slice(index, index + 2))
      keyboard.text(axis.label(value), versionedCallback(axis.callback(value), revision));
    if (index + 2 < axis.values.length) keyboard.row();
  }
  return keyboard;
}

/** Shared posting-hour presets used by the flat video schedule axis. */
export const SCHEDULE_SLOT_PRESETS = ["08:00", "11:00", "13:00", "18:00", "20:00", "22:00"] as const;

/** Renders the single confirmation screen shared by locale and target schedules. */
export function scheduleConfirmationEffects<T extends string>(options: {
  kind: PublicationKind;
  publicationId: number;
  intro?: string;
  title: string;
  titlePrefix: string;
  entries: readonly { key: T; value: Date }[];
  label: (key: T) => string;
  formatValue: (value: Date) => string;
  keyboard: InlineKeyboard;
  effects?: readonly PublicationEffect[];
}): PublicationEffect[] {
  const lines = options.entries.map(({ key, value }) => `${options.label(key)}: ${options.formatValue(value)}`);
  const summary = [`${options.titlePrefix} *${options.title}*`, ...lines].join("\n");
  const text = options.intro ? `${options.intro}\n\n${summary}` : summary;
  const keyboard = options.keyboard;
  return [
    ...(options.effects ?? []),
    {
      type: "screen",
      text,
      options: { parse_mode: "Markdown", reply_markup: keyboard },
      card: { kind: options.kind, draftId: options.publicationId },
    },
  ];
}

/** Builds the common video-style time picker: slot presets, manual entry and
 * a versioned cancel action. Domain-specific confirmation remains outside. */
export function scheduleTimeKeyboard<T extends string>(options: {
  axis: ScheduleAxis<T>;
  revision?: number | null;
  manual: { label: string; callback: string };
  cancel: { label: string; callback: string };
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  appendScheduleAxisButtons(keyboard, options.axis, options.revision);
  keyboard.row();
  keyboard.text(options.manual.label, versionedCallback(options.manual.callback, options.revision)).row();
  keyboard.text(options.cancel.label, versionedCallback(options.cancel.callback, options.revision));
  return keyboard;
}
