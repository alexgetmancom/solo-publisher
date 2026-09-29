import { eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { platformTokens } from "../db/schema.js";

type PlatformTokenRow = Omit<typeof platformTokens.$inferInsert, "target">;

export function platformToken(backendDb: BackendDb, target: string): typeof platformTokens.$inferSelect | null {
  return unsafeDb(backendDb).db.select().from(platformTokens).where(eq(platformTokens.target, target)).get() ?? null;
}

export function storePlatformToken(backendDb: BackendDb, target: string, row: PlatformTokenRow): void {
  unsafeDb(backendDb)
    .db.insert(platformTokens)
    .values({ target, ...row })
    .onConflictDoUpdate({ target: platformTokens.target, set: row })
    .run();
}

/** The largest attachment each connected channel accepts, as the platform
 * reported it when the channel was connected. Preflight reads it so a file the
 * platform will refuse is refused here, before seven other platforms publish. */
export function channelUploadLimits(backendDb: BackendDb): Record<string, number> {
  return Object.fromEntries(
    unsafeDb(backendDb)
      .db.select({ target: platformTokens.target, bytes: platformTokens.uploadLimitBytes })
      .from(platformTokens)
      .all()
      .flatMap((row) => (row.bytes == null ? [] : [[row.target, row.bytes] as const])),
  );
}
