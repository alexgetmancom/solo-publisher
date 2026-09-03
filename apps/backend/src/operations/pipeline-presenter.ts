import { publicationRef } from "../application/publication-ref.js";
import { TARGETS } from "../botTargets.js";
import type { BackendConfig } from "../foundation/config.js";
import { formatZonedSortable } from "../foundation/time.js";
import { jsonArray } from "../json.js";

export type PipelineTargetRow = {
  publicationKey: string;
  target: string;
  status: string;
  externalId?: string | null;
  externalIdsJson?: string[] | null;
  url?: string | null;
  error?: string | null;
  skipped?: number;
  updatedAt?: string | null;
};

export type PipelineMetricRow = {
  publicationKey: string;
  target: string;
  metricName: string;
  value: number | null;
  source?: string | null;
  sampledAt?: string | null;
  error?: string | null;
};

export type PipelineSampleRow = {
  publicationKey: string;
  target: string;
  metricName: string;
  value: number | null;
  sampledAt: string;
  bucket: number;
};

export type PipelinePostRow = {
  publication_key: string;
  post_id: number;
  created_at: string;
  updated_at: string;
  text_ru: string | null | undefined;
  media_ru_json: unknown;
  site_ru: number | null | undefined;
  slug_ru: string | null | undefined;
  text_en: string | null | undefined;
  media_en_json: unknown;
  site_en: number | null | undefined;
  slug_en: string | null | undefined;
  date_msk: string | null | undefined;
  telegram_url: string | null | undefined;
};

/** Converts persistence rows into the stable dashboard payload. */
export function formatPipelinePosts(
  config: BackendConfig,
  rows: PipelinePostRow[],
  targetRows: PipelineTargetRow[],
  metricRows: PipelineMetricRow[],
  sampleRows: PipelineSampleRow[],
  includeContent: boolean,
  compact = false,
): Record<string, unknown>[] {
  const targetsByPost = groupBy(targetRows, (target) => target.publicationKey);
  const metricsByPost = groupBy(metricRows, (metric) => metric.publicationKey);
  const samplesByMetric = groupBy(sampleRows, (sample) => `${sample.publicationKey}\u0000${sample.target}\u0000${sample.metricName}`);
  return rows.map((row) => {
    const postId = row.post_id == null ? null : Number(row.post_id);
    const publicationKey = row.publication_key ?? (postId == null ? "" : publicationRef("post", postId));
    const targets = Object.fromEntries(
      (targetsByPost.get(publicationKey) ?? []).map((target) => [
        target.target,
        compact
          ? { status: target.status, url: target.url ?? null }
          : {
              status: target.status,
              ok: target.status === "published",
              external_id: target.externalId,
              external_ids: target.externalIdsJson ?? [],
              url: target.url,
              error: target.error,
              skipped: Boolean(target.skipped),
              updated_at: target.updatedAt,
            },
      ]),
    );
    const metrics: Record<string, Record<string, unknown>> = {};
    for (const metric of metricsByPost.get(publicationKey) ?? []) {
      const targetMetrics = metrics[metric.target] ?? {};
      metrics[metric.target] = targetMetrics;
      const samples = samplesByMetric.get(`${publicationKey}\u0000${metric.target}\u0000${metric.metricName}`);
      targetMetrics[metric.metricName] = {
        value: metric.value,
        // Samples are fetched only when a caller asked for them, so `compact`
        // has no second say here — it narrows metadata, not the series.
        ...(samples ? { samples: samples.map((sample) => ({ value: sample.value, sampled_at: sample.sampledAt })) } : {}),
        ...(compact ? {} : { sampled_at: metric.sampledAt, source: metric.source, error: metric.error }),
      };
    }
    const mediaRu = jsonArray(row.media_ru_json);
    const mediaEn = jsonArray(row.media_en_json);
    const textRu = String(row.text_ru ?? "");
    const textEn = String(row.text_en ?? "");
    const contentLoaded =
      row.text_ru !== undefined || row.media_ru_json !== undefined || row.text_en !== undefined || row.media_en_json !== undefined;
    const includeRowContent = includeContent && (!compact || contentLoaded);
    const telegramUrl = typeof row.telegram_url === "string" && row.telegram_url ? row.telegram_url : null;
    const result: Record<string, unknown> = {
      post_id: postId,
      date: row.created_at,
      date_msk: row.date_msk ?? formatZonedSortable(String(row.created_at), config.TIMEZONE),
      ...(includeRowContent
        ? {
            text_ru: shortText(textRu),
            text_en: shortText(textEn),
            full_text_ru: textRu,
            full_text_en: textEn,
            text: shortText(textRu),
            media_ru_json: row.media_ru_json,
            media_en_json: row.media_en_json,
          }
        : {}),
      media_count: (mediaEn.length ? mediaEn : mediaRu).length,
      media_types: [
        ...new Set(
          (mediaEn.length ? mediaEn : mediaRu)
            .map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>).type ?? "") : ""))
            .filter(Boolean),
        ),
      ],
      ...(includeRowContent
        ? {
            slug_en: row.slug_en,
            slug_ru: row.slug_ru,
            site_url: Number(row.site_ru) ? `/ru/${postId}/${row.slug_ru}/` : Number(row.site_en) ? `/${postId}/${row.slug_en}/` : null,
          }
        : {}),
      telegram_url: telegramUrl,
      targets,
      metrics,
      ...(includeRowContent
        ? { locales_map: { ru: { site_enabled: Number(row.site_ru ?? 0) }, en: { site_enabled: Number(row.site_en ?? 0) } } }
        : {}),
    };
    if (!compact) {
      for (const { id: target } of TARGETS) {
        const record = targets[target] as { status?: unknown } | undefined;
        result[target] =
          record?.status === "published" ||
          (target === "telegram" && Boolean(telegramUrl)) ||
          (target === "site_ru" && Boolean(row.site_ru)) ||
          (target === "site_en" && Boolean(row.site_en));
      }
    }
    return result;
  });
}

function shortText(value: string): string {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words.length <= 7 ? words.join(" ") : `${words.slice(0, 7).join(" ")}...`;
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const values = grouped.get(groupKey) ?? [];
    values.push(row);
    grouped.set(groupKey, values);
  }
  return grouped;
}
