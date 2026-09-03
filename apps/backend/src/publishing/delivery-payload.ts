import type { JsonObject, JsonValue } from "../db/schema.js";

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

declare const deliveryPayloadBrand: unique symbol;

/** The payload of a publish job, which no one can write by hand.
 *
 * Every duplicate publication this system has produced was an object literal
 * assigned to `payloadJson`, built from the publication source by code that had
 * no reason to think about what the delivery had already sent. Comments did not
 * stop it and neither did review. So the column takes a type that only the
 * constructors below can produce, and each of them is a different answer to the
 * one question that matters: has this delivery already put something in front
 * of an audience, and is this write continuing it or replacing it?
 *
 * A new call site does not have to be told the rule. It cannot compile without
 * choosing. */
export type DeliveryPayload = JsonObject & { readonly [deliveryPayloadBrand]: "delivery-payload" };

function branded(fields: JsonObject): DeliveryPayload {
  return fields as DeliveryPayload;
}

/** In-flight adapter state carries no answer to that question and so must not
 * wear the resume prefix: a container being processed has reached nobody, and a
 * job holding only that is an ordinary first delivery -- its media still has to
 * be prepared, and a replan may still replace it. */
const PROGRESS_KEY_PREFIX_FORBIDDEN = RESUME_KEY_PREFIX;

export function resumeState(payload: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => key.startsWith(RESUME_KEY_PREFIX)));
}

export function hasResumeState(payload: JsonObject): boolean {
  return Object.keys(resumeState(payload)).length > 0;
}

/** A delivery that has published nothing yet: a publication being planned for
 * the first time, or a target that has never had a job. */
export function newDeliveryPayload(fields: JsonObject): DeliveryPayload {
  return branded(fields);
}

/** A delivery that is being finished. Whatever the previous job had already
 * published travels with it, so the adapter writes only the remainder. */
export function continuedDeliveryPayload(previous: JsonObject | null, fields: JsonObject): DeliveryPayload {
  return branded({ ...fields, ...resumeState(previous ?? {}) });
}

/** A delivery being sent again from the beginning, which is only correct when
 * what it published before is gone -- an operator removed it, or the edit path
 * took it down to replace it. The reason is required because there is no safe
 * default: continuing onto a deleted post and republishing a live one are the
 * same mistake pointing in opposite directions. */
export function restartedDeliveryPayload(fields: JsonObject, reason: "posts_removed" | "operator_republish"): DeliveryPayload {
  void reason;
  return branded(fields);
}

/** A delivery that is mid-flight at the provider: the adapter's own progress
 * state, plus -- only once something has actually reached the audience -- the
 * ids it must never publish again. */
export function deferredDeliveryPayload(
  previous: JsonObject,
  progressKey: string,
  progress: JsonValue,
  published?: { key: string; ids: JsonValue },
): DeliveryPayload {
  if (progressKey.startsWith(PROGRESS_KEY_PREFIX_FORBIDDEN))
    throw new Error(`progress key ${progressKey} claims to be resume state: it says nothing reached an audience`);
  if (published && !published.key.startsWith(RESUME_KEY_PREFIX))
    throw new Error(`resume key ${published.key} must carry the ${RESUME_KEY_PREFIX} prefix`);
  return branded({ ...previous, [progressKey]: progress, ...(published ? { [published.key]: published.ids } : {}) });
}

/** A delivery pointed at the ids it is to continue from, named rather than
 * inherited: the queue recording what an attempt just published, or an operator
 * saying which post survived. */
export function resumedDeliveryPayload(previous: JsonObject, resumeKey: string, value: JsonValue): DeliveryPayload {
  return branded({ ...previous, [resumeKey]: value });
}
