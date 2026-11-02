import { asc } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { games, videoDrafts, videoTargets } from "../db/schema.js";

/** The authored corpus, without delivery internals, credentials or media paths. */
export function videoLibrary(backendDb: BackendDb) {
  return unsafeDb(backendDb).db.transaction((db) => {
    const targets = db
      .select({
        id: videoTargets.id,
        video_draft_id: videoTargets.videoDraftId,
        target: videoTargets.target,
        status: videoTargets.status,
        external_id: videoTargets.externalId,
        external_url: videoTargets.externalUrl,
        published_at: videoTargets.publishedAt,
      })
      .from(videoTargets)
      .orderBy(asc(videoTargets.id))
      .all();
    const byDraft = new Map<number, typeof targets>();
    for (const target of targets) {
      const copies = byDraft.get(target.video_draft_id) ?? [];
      copies.push(target);
      byDraft.set(target.video_draft_id, copies);
    }
    return {
      exported_at: new Date().toISOString(),
      videos: db
        .select({
          id: videoDrafts.id,
          locale: videoDrafts.locale,
          label: videoDrafts.label,
          status: videoDrafts.status,
          game: videoDrafts.game,
          script: videoDrafts.script,
          script_source: videoDrafts.scriptSource,
          opening_line: videoDrafts.openingLine,
          updated_at: videoDrafts.updatedAt,
        })
        .from(videoDrafts)
        .orderBy(asc(videoDrafts.id))
        .all()
        .map((video) => ({ ...video, targets: byDraft.get(video.id) ?? [] })),
      games: db
        .select({
          name: games.name,
          steam_app_id: games.steamAppId,
          genres: games.genres,
          player_modes: games.playerModes,
          release_date: games.releaseDate,
          developer: games.developer,
          source: games.source,
          captured_at: games.capturedAt,
        })
        .from(games)
        .orderBy(asc(games.name))
        .all(),
    };
  });
}
