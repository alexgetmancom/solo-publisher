import { type BackendDb, unsafeDb } from "../db/client.js";
import { games } from "../db/schema.js";
import { requestJson } from "../foundation/http.js";

/** Steam answers with everything the store page shows, so the only fields
 * taken here are the ones a content decision is made on. */
type SteamAppDetails = Record<
  string,
  {
    success?: boolean;
    data?: {
      name?: string;
      genres?: Array<{ description?: string }>;
      categories?: Array<{ description?: string }>;
      release_date?: { date?: string };
      developers?: string[];
    };
  }
>;

/** The categories that say how a game is played. Steam's list also carries
 * store plumbing ("Family Sharing", "Stereo Sound"), which describes the
 * storefront rather than the game. */
const PLAYER_MODES = [
  "Single-player",
  "Multi-player",
  "Co-op",
  "Online Co-op",
  "LAN Co-op",
  "Shared/Split Screen Co-op",
  "PvP",
  "Online PvP",
];

const STEAM_APP_ID = /store\.steampowered\.com\/app\/(\d+)/u;

/** Steam asks for a pause between calls; a hundred and fifty lookups run once
 * and are never on a request path. */
const REQUEST_PAUSE_MS = 250;

type Candidate = { game: string; steamAppId: string | null; videos: number };

/**
 * Fills the game dimension from the store page each video already links to.
 *
 * The publishing copy carries `gameUrl`, so the genre does not have to be
 * guessed or searched for: it is read from Steam itself, which is also why the
 * source is recorded. A game with no store link is reported and left for
 * someone who can look it up.
 */
export async function enrichGames(
  backendDb: BackendDb,
  fetchImpl: typeof fetch,
  input: { apply: boolean; refresh: boolean; limit: number },
): Promise<Record<string, unknown>> {
  const candidates = loadCandidates(backendDb, input.refresh);
  const withLink = candidates.filter((candidate) => candidate.steamAppId);
  const plan = withLink.slice(0, input.limit);
  const enriched: Array<Record<string, unknown>> = [];
  const failed: Array<{ game: string; reason: string }> = [];
  if (input.apply)
    for (const candidate of plan) {
      try {
        const details = await requestJson<SteamAppDetails>(
          fetchImpl,
          `https://store.steampowered.com/api/appdetails?appids=${candidate.steamAppId}&l=english`,
        );
        const app = details[String(candidate.steamAppId)];
        if (!app?.success || !app.data) {
          failed.push({ game: candidate.game, reason: "Steam has no details for this app id" });
          continue;
        }
        const row = {
          name: candidate.game,
          steamAppId: candidate.steamAppId,
          genres: (app.data.genres ?? []).map((genre) => genre.description ?? "").filter(Boolean),
          playerModes: (app.data.categories ?? [])
            .map((category) => category.description ?? "")
            .filter((description) => PLAYER_MODES.includes(description)),
          releaseDate: app.data.release_date?.date ?? null,
          developer: app.data.developers?.[0] ?? null,
          source: `steam:${candidate.steamAppId}`,
          capturedAt: new Date().toISOString(),
        };
        unsafeDb(backendDb).db.insert(games).values(row).onConflictDoUpdate({ target: games.name, set: row }).run();
        enriched.push({ game: candidate.game, genres: row.genres, playerModes: row.playerModes });
      } catch (error) {
        failed.push({ game: candidate.game, reason: (error instanceof Error ? error.message : String(error)).slice(0, 160) });
      }
      await new Promise((resolve) => setTimeout(resolve, REQUEST_PAUSE_MS));
    }
  return {
    applied: input.apply,
    games: candidates.length,
    withStoreLink: withLink.length,
    planned: plan.length,
    enriched: enriched.length,
    failed,
    withoutStoreLink: candidates.filter((candidate) => !candidate.steamAppId).map((candidate) => candidate.game),
    sample: input.apply ? enriched.slice(0, 5) : plan.slice(0, 5),
  };
}

/** Games this Studio has published about, with what is known about each. */
export function gamesReport(backendDb: BackendDb): Record<string, unknown> {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT d.game AS game, COUNT(*) AS videos, g.genres AS genres, g.player_modes AS playerModes,
              g.release_date AS releaseDate, g.developer AS developer, g.steam_app_id AS steamAppId
         FROM video_drafts d
         LEFT JOIN games g ON g.name = d.game
        WHERE d.game IS NOT NULL
        GROUP BY d.game
        ORDER BY COUNT(*) DESC, d.game`,
    )
    .all() as Array<{
    game: string;
    videos: number;
    genres: string | null;
    playerModes: string | null;
    releaseDate: string | null;
    developer: string | null;
    steamAppId: string | null;
  }>;
  const described = rows.filter((row) => row.genres);
  return {
    games: rows.length,
    described: described.length,
    videos: rows.reduce((total, row) => total + row.videos, 0),
    list: rows.map((row) => ({
      game: row.game,
      videos: row.videos,
      genres: parseList(row.genres),
      playerModes: parseList(row.playerModes),
      releaseDate: row.releaseDate,
      developer: row.developer,
      steamAppId: row.steamAppId,
    })),
    reading: [
      "A game is a dimension, not a result: `video-report` groups performance by genre and player mode, and this is where those values come from.",
      "Genres and player modes are Steam's own words for the game, read from the store page the publishing copy links to.",
      "A game with no genre either has no store link in its copy or was published before the link was recorded.",
    ],
  };
}

function loadCandidates(backendDb: BackendDb, refresh: boolean): Candidate[] {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT d.game AS game, COUNT(*) AS videos,
              (SELECT group_concat(t.metadata_json, char(30)) FROM video_targets t WHERE t.video_draft_id IN
                 (SELECT id FROM video_drafts WHERE game = d.game)) AS metadata
         FROM video_drafts d
         LEFT JOIN games g ON g.name = d.game
        WHERE d.game IS NOT NULL ${refresh ? "" : "AND g.name IS NULL"}
        GROUP BY d.game
        ORDER BY COUNT(*) DESC, d.game`,
    )
    .all() as Array<{ game: string; videos: number; metadata: string | null }>;
  return rows.map((row) => ({
    game: row.game,
    videos: row.videos,
    steamAppId: STEAM_APP_ID.exec(row.metadata ?? "")?.[1] ?? null,
  }));
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
