import type { JsonObject } from "../db/schema.js";

/** Continuation state a delivery adapter left on its job: the external ids it
 * has already published, under the key the adapter itself named. Adapters name
 * their own key because which platform publishes in more than one call is the
 * adapter's business; the underscore says the key belongs to the job rather
 * than to the publication source it was built from.
 *
 * This is the only thing standing between a retry and a second post in front of
 * the audience, and it is the reason a requeue may not rebuild a payload from
 * the source alone: the source cannot know what already went out. */
const RESUME_KEY_PREFIX = "_";

export function resumeState(payload: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => key.startsWith(RESUME_KEY_PREFIX)));
}

export function hasResumeState(payload: JsonObject): boolean {
  return Object.keys(resumeState(payload)).length > 0;
}
