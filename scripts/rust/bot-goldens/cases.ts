import { CALLBACK_CASES } from "./cases-callbacks.ts";
import { ENTRY_CASES } from "./cases-entry.ts";
import { INTAKE_CASES } from "./cases-intake.ts";
import { NOTICE_CASES } from "./cases-notices.ts";
import { OPS_CASES } from "./cases-ops.ts";
import { POST_CASES } from "./cases-post.ts";
import { QUEUE_CASES } from "./cases-queue.ts";
import { SETTINGS_CASES } from "./cases-settings.ts";
import { SETTLED_CASES } from "./cases-settled.ts";
import { VIDEO_CASES } from "./cases-video.ts";
import type { Case } from "./harness.ts";

/** Every recorded case, in recording order. */
export const CASES: Case[] = [
  ...ENTRY_CASES,
  ...INTAKE_CASES,
  ...POST_CASES,
  ...SETTLED_CASES,
  ...VIDEO_CASES,
  ...QUEUE_CASES,
  ...SETTINGS_CASES,
  ...NOTICE_CASES,
  ...OPS_CASES,
  ...CALLBACK_CASES,
];
