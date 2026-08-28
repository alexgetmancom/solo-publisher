import type { BackendDb } from "../../db/client.js";
import { milestoneScopes, milestoneState } from "../audience-milestones.js";
import { milestonePolicy } from "../milestone-policy.js";

/** What every audience scope holds today and what it will announce next.
 * Without it the only way to explain a missing achievement was to read the
 * database by hand. */
export function audienceMilestoneReport(backendDb: BackendDb) {
  const settings = milestonePolicy(backendDb);
  return {
    thresholds: settings.thresholds,
    scopes: milestoneScopes(backendDb).map((scope) => {
      const state = milestoneState(backendDb, scope.id);
      const followers = scope.entries.reduce((sum, entry) => sum + entry.followers, 0);
      const reachedThrough = state?.reachedThrough ?? 0;
      return {
        scope: scope.id,
        label: scope.label,
        announces: scope.announce,
        followers,
        reachedThrough,
        next: settings.thresholds.find((threshold) => threshold > reachedThrough) ?? null,
        pending: settings.thresholds.filter((threshold) => threshold > reachedThrough && threshold <= followers),
        members: scope.entries.map((entry) => entry.id),
      };
    }),
  };
}
