import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { attachXActivityToPosts, X_ANALYTICS_SOURCE } from "./x-activity-linking.js";

type CsvRow = Record<string, string>;
type ParsedCsv = { headers: string[]; rows: CsvRow[] };

const METRICS: Array<{ column: string; name: string }> = [
  { column: "Показы", name: "views" },
  { column: "Нравится", name: "likes" },
  { column: "Взаимодействия", name: "interactions" },
  { column: "Закладки", name: "saves" },
  { column: "Поделились", name: "shares" },
  { column: "Новые читатели", name: "follows" },
  { column: "Ответы", name: "replies" },
  { column: "Репосты", name: "reposts" },
  { column: "Посещения профиля", name: "profile_visits" },
  { column: "Разворачивания подробных сведений", name: "detail_expands" },
  { column: "Клики по URL-адресам", name: "link_clicks" },
  { column: "Клики по хештегам", name: "hashtag_clicks" },
  { column: "Клики по постоянным ссылкам", name: "permalink_clicks" },
];

export type XCsvImportResult = {
  rows: number;
  activityItems: number;
  activitySamples: number;
  skippedCells: number;
  linkedByExternalId: number;
  linkedByText: number;
  insertedSamples: number;
  updatedMetrics: number;
  importId: number;
  duplicateImport: boolean;
};

/** Imports an X Analytics content export as account-wide activity, then hands
 * the whole table to the linker: an export knows X post ids, not editorial
 * posts, and attaching the two is one job wherever the rows came from. */
export function importXAnalyticsCsv(
  backendDb: BackendDb,
  sourcePath: string,
  sampledAt: string,
  // What the export was called where it came from. A file that arrived over
  // Telegram is stored under a name Telegram chose, and the export's own name
  // is the only thing carrying the window it covers.
  sourceName = path.basename(sourcePath),
): XCsvImportResult {
  if (Number.isNaN(Date.parse(sampledAt))) throw new Error("--sampled-at must be an ISO timestamp");
  const { headers, rows } = parseCsv(fs.readFileSync(sourcePath, "utf8"));
  if (!rows.length || !rows[0]?.["Идентификатор поста"]) throw new Error("Expected an X Analytics CSV with the column Идентификатор поста");
  // A column this export does not carry is missing data, not a zero. Writing 0
  // for it would overwrite the live post_metrics value — which is what an
  // export in another interface language used to do to every metric at once.
  const presentHeaders = new Set(headers);
  const metrics = METRICS.filter((metric) => presentHeaders.has(metric.column));
  if (!metrics.length) throw new Error("Expected an X Analytics CSV with at least one known metric column");
  const sourceBytes = fs.readFileSync(sourcePath);
  const checksum = crypto.createHash("sha256").update(sourceBytes).digest("hex");
  const existingImport = unsafeDb(backendDb).sqlite.prepare("SELECT id FROM x_activity_imports WHERE checksum=?").get(checksum) as {
    id: number;
  } | null;
  if (existingImport)
    return {
      rows: rows.length,
      activityItems: 0,
      activitySamples: 0,
      skippedCells: 0,
      linkedByExternalId: 0,
      linkedByText: 0,
      insertedSamples: 0,
      updatedMetrics: 0,
      importId: existingImport.id,
      duplicateImport: true,
    };
  const [periodStart, periodEnd] = exportPeriod(sourceName);
  const importedAt = new Date().toISOString();
  unsafeDb(backendDb)
    .sqlite.prepare(
      `INSERT OR IGNORE INTO x_activity_imports
       (checksum,source_file,period_start,period_end,sampled_at,imported_at,row_count)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(checksum, sourceName, periodStart, periodEnd, sampledAt, importedAt, rows.length);
  const importRow = unsafeDb(backendDb).sqlite.prepare("SELECT id FROM x_activity_imports WHERE checksum=?").get(checksum) as {
    id: number;
  };
  const upsertActivity = unsafeDb(backendDb).sqlite.prepare(
    `INSERT INTO x_activity_items
     (x_post_id,kind,published_at,text,url,linked_publication_key,first_seen_at,last_seen_at,raw_json)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(x_post_id) DO UPDATE SET
       kind=excluded.kind,
       published_at=coalesce(excluded.published_at,x_activity_items.published_at),
       text=excluded.text,
       url=excluded.url,
       linked_publication_key=coalesce(excluded.linked_publication_key,x_activity_items.linked_publication_key),
       last_seen_at=excluded.last_seen_at,
       raw_json=excluded.raw_json`,
  );
  const insertActivitySample = unsafeDb(backendDb).sqlite.prepare(
    `INSERT OR IGNORE INTO x_activity_metric_snapshots
     (x_post_id,metric_name,value,sampled_at,import_id,raw_json)
     VALUES (?,?,?,?,?,?)`,
  );
  let activityItems = 0;
  let activitySamples = 0;
  let skippedCells = 0;
  unsafeDb(backendDb).sqlite.transaction(() => {
    for (const row of rows) {
      const externalId = row["Идентификатор поста"]?.trim();
      if (!externalId) continue;
      const text = row["Текст поста"]?.trim() ?? "";
      upsertActivity.run(
        externalId,
        activityKind(text),
        xPublishedAt(row.Дата),
        text,
        row["Ссылка на пост"]?.trim() || `https://x.com/i/web/status/${externalId}`,
        null,
        sampledAt,
        sampledAt,
        JSON.stringify({ source: X_ANALYTICS_SOURCE, import_id: importRow.id }),
      );
      activityItems += 1;
      for (const metric of metrics) {
        const value = integer(row[metric.column]);
        // Same reasoning as the header filter above, per cell: a blank or
        // unparseable value is absent, and absent is not zero.
        if (value == null) {
          skippedCells += 1;
          continue;
        }
        const inserted = insertActivitySample.run(
          externalId,
          metric.name,
          value,
          sampledAt,
          importRow.id,
          JSON.stringify({ x_column: metric.column }),
        );
        activitySamples += Number(inserted.changes);
      }
    }
  })();
  const attached = attachXActivityToPosts(backendDb, true);
  return {
    rows: rows.length,
    activityItems,
    activitySamples,
    skippedCells,
    linkedByExternalId: attached.links.filter((link) => link.matchedBy === "external_id").length,
    linkedByText: attached.links.filter((link) => link.matchedBy === "direct_text").length,
    insertedSamples: attached.insertedSamples,
    updatedMetrics: attached.updatedMetrics,
    importId: importRow.id,
    duplicateImport: false,
  };
}

function activityKind(text: string): "reply" | "repost" | "standalone" {
  if (/^RT\s+@/iu.test(text)) return "repost";
  return /^@[\p{L}\p{N}_]+/u.test(text) ? "reply" : "standalone";
}

function xPublishedAt(value: string | undefined): string | null {
  const parsed = new Date(value ?? "");
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function exportPeriod(sourceName: string): [string | null, string | null] {
  const match = sourceName.match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv$/u);
  return [match?.[1] ?? null, match?.[2] ?? null];
}

/** null means "this export says nothing about the metric" — never zero. */
function integer(value: string | undefined): number | null {
  const text = (value ?? "").replace(/,/g, "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Minimal RFC 4180 parser: X exports quote text fields with commas and newlines. */
function parseCsv(input: string): ParsedCsv {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field.replace(/\r$/, ""));
      records.push(record);
      record = [];
      field = "";
    } else field += char;
  }
  if (field || record.length) {
    record.push(field.replace(/\r$/, ""));
    records.push(record);
  }
  const [headers, ...data] = records;
  if (!headers) return { headers: [], rows: [] };
  return {
    headers,
    rows: data
      .filter((values) => values.some(Boolean))
      .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]))),
  };
}
