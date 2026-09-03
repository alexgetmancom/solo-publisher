import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { publicationRef } from "../application/publication-ref.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, postLocales, postMetrics, publicationTargets, publishJobs } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { zonedRollingPeriodBounds } from "../foundation/time.js";
import {
  formatPipelinePosts,
  type PipelineMetricRow,
  type PipelinePostRow,
  type PipelineSampleRow,
  type PipelineTargetRow,
} from "./pipeline-presenter.js";

export type PipelineReadModelOptions = {
  /** Dashboard charts are the only consumers that need immutable samples. */
  includeSamples?: boolean;
  /** Comparison read models only need dates, statuses and metrics, not copy or media. */
  includeContent?: boolean;
  /** Use narrow target/metric projections for dashboard summaries. */
  compact?: boolean;
  /** Hard cap per (post, target, metric) series after time bucketing. */
  sampleLimitPerSeries?: number;
};

type ResolvedPipelineReadModelOptions = {
  includeSamples: boolean;
  includeContent: boolean;
  compact: boolean;
  sampleLimitPerSeries: number;
};

const MAX_SAMPLE_LIMIT_PER_SERIES = 200;

/** Compact post read model used by the overview and publication detail loaders. */
export function pipelineOverviewPayload(
  config: BackendConfig,
  backendDb: BackendDb,
  weekOffset = 0,
  periodDays = 7,
  comparisonOffset = 0,
  offsetDays?: number,
  options: PipelineReadModelOptions = {},
) {
  const readModelOptions = resolvePipelineReadModelOptions(options);
  return { posts: pipelinePosts(backendDb, config, weekOffset, periodDays, comparisonOffset, offsetDays, readModelOptions) };
}

/** One bounded history holding two adjacent dashboard periods, each capped at the public read model's 100 posts. */
export function dashboardPipelineHistoryPayload(config: BackendConfig, backendDb: BackendDb, periodDays: number, offsetDays: number) {
  const options = resolvePipelineReadModelOptions({ includeSamples: true, compact: true });
  return { posts: pipelinePosts(backendDb, config, 0, periodDays, 0, offsetDays, options, 200) };
}

function pipelinePosts(
  backendDb: BackendDb,
  config: BackendConfig,
  weekOffset: number,
  periodDays: number,
  comparisonOffset: number,
  offsetDays?: number,
  options: ResolvedPipelineReadModelOptions = resolvePipelineReadModelOptions({}),
  rowLimit = 100,
): Record<string, unknown>[] {
  const periodOffsetDays = offsetDays ?? (weekOffset + comparisonOffset) * periodDays;
  const [start, end] = zonedRollingPeriodBounds(periodOffsetDays / periodDays, periodDays, config.TIMEZONE);
  const rows = fetchPostRows(backendDb, start, end, options.includeContent, rowLimit);
  const publicationKeys = rows.map((row) => String(row.publication_key ?? "")).filter(Boolean);
  const targetRows = (
    publicationKeys.length
      ? unsafeDb(backendDb)
          .db.select(
            options.compact
              ? {
                  publicationKey: publicationTargets.publicationKey,
                  target: publicationTargets.target,
                  status: publicationTargets.status,
                  url: publicationTargets.url,
                }
              : {
                  publicationKey: publicationTargets.publicationKey,
                  target: publicationTargets.target,
                  status: publicationTargets.status,
                  externalId: publicationTargets.externalId,
                  externalIdsJson: publicationTargets.externalIdsJson,
                  url: publicationTargets.url,
                  error: publicationTargets.error,
                  skipped: publicationTargets.skipped,
                  updatedAt: publicationTargets.updatedAt,
                },
          )
          .from(publicationTargets)
          .where(inArray(publicationTargets.publicationKey, publicationKeys))
          .orderBy(asc(publicationTargets.target))
          .all()
      : []
  ) as PipelineTargetRow[];
  const metricRows = (
    publicationKeys.length
      ? unsafeDb(backendDb)
          .db.select(
            options.compact
              ? {
                  publicationKey: postMetrics.publicationKey,
                  target: postMetrics.target,
                  metricName: postMetrics.metricName,
                  value: postMetrics.value,
                }
              : {
                  publicationKey: postMetrics.publicationKey,
                  target: postMetrics.target,
                  metricName: postMetrics.metricName,
                  value: postMetrics.value,
                  source: postMetrics.source,
                  sampledAt: postMetrics.sampledAt,
                  error: postMetrics.error,
                },
          )
          .from(postMetrics)
          .where(inArray(postMetrics.publicationKey, publicationKeys))
          .orderBy(asc(postMetrics.target), asc(postMetrics.metricName))
          .all()
      : []
  ) as PipelineMetricRow[];
  const sampleRows = options.includeSamples
    ? fetchMetricSamples(backendDb, publicationKeys, start, end, periodDays, options.sampleLimitPerSeries)
    : [];
  return formatPipelinePosts(config, rows, targetRows, metricRows, sampleRows, options.includeContent, options.compact);
}

type PublicationQueryRow = {
  postId: number;
  telegramMessageId: number | null;
  createdAt: string;
  updatedAt: string;
  textRu?: string | null;
  mediaRuJson?: unknown;
  siteRu?: number | null;
  slugRu?: string | null;
  textEn?: string | null;
  mediaEnJson?: unknown;
  siteEn?: number | null;
  slugEn?: string | null;
};

/**
 * When a publication happened, as far as a period is concerned.
 *
 * The earliest target that went out, or — for one still ahead — when it is due,
 * and only failing both the row's own creation. Written as one expression so
 * the filter and the ordering cannot drift apart.
 */
const publicationMoment = sql`coalesce(
  (select min(${publicationTargets.publishedAt}) from ${publicationTargets} where ${publicationTargets.publicationKey} = 'post:' || ${drafts.postId}),
  (select min(${publishJobs.publishAt}) from ${publishJobs} where ${publishJobs.publicationKey} = 'post:' || ${drafts.postId}),
  ${drafts.createdAt}
)`;

function fetchPostRows(backendDb: BackendDb, start: string, end: string, includeContent: boolean, rowLimit = 100): PipelinePostRow[] {
  const ru = alias(postLocales, "pipeline_ru");
  const en = alias(postLocales, "pipeline_en");
  const publicationRows = unsafeDb(backendDb)
    .db.select({
      postId: drafts.postId,
      createdAt: drafts.createdAt,
      updatedAt: drafts.updatedAt,
      ...(includeContent
        ? {
            siteRu: ru.siteEnabled,
            slugRu: ru.slug,
            siteEn: en.siteEnabled,
            slugEn: en.slug,
          }
        : {}),
      ...(includeContent
        ? {
            textRu: sql<string>`coalesce(${ru.approvedText}, ${ru.sourceText}, '')`,
            mediaRuJson: ru.siteMediaJson,
            textEn: sql<string>`coalesce(${en.approvedText}, ${en.sourceText}, '')`,
            mediaEnJson: en.siteMediaJson,
          }
        : {}),
    })
    .from(drafts)
    .leftJoin(ru, and(eq(ru.draftId, drafts.id), eq(ru.locale, "ru")))
    .leftJoin(en, and(eq(en.draftId, drafts.id), eq(en.locale, "en")))
    // A publication belongs to the day it reached its audience, not the day its
    // row was made. Filtering on creation hid a post scheduled yesterday and
    // published this morning from today's dashboard, while it sat in the
    // seven-day view — the delivery was fine and the period was lying.
    .where(and(sql`${drafts.postId} is not null`, gte(publicationMoment, start), lte(publicationMoment, end)))
    .orderBy(desc(publicationMoment))
    .limit(rowLimit)
    .all() as PublicationQueryRow[];
  return publicationRows.map((row) => {
    return {
      publication_key: publicationRef("post", row.postId),
      post_id: row.postId,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      text_ru: row.textRu,
      media_ru_json: row.mediaRuJson,
      site_ru: row.siteRu,
      slug_ru: row.slugRu,
      text_en: row.textEn,
      media_en_json: row.mediaEnJson,
      site_en: row.siteEn,
      slug_en: row.slugEn,
      date_msk: row.createdAt,
      telegram_url: null,
    };
  });
}

function resolvePipelineReadModelOptions(options: PipelineReadModelOptions): ResolvedPipelineReadModelOptions {
  return {
    includeSamples: options.includeSamples === true,
    includeContent: options.includeContent !== false,
    compact: options.compact === true,
    sampleLimitPerSeries: Math.max(
      1,
      Math.min(MAX_SAMPLE_LIMIT_PER_SERIES, Math.floor(options.sampleLimitPerSeries ?? MAX_SAMPLE_LIMIT_PER_SERIES)),
    ),
  };
}

function fetchMetricSamples(
  backendDb: BackendDb,
  publicationKeys: string[],
  start: string,
  end: string,
  periodDays: number,
  limitPerSeries: number,
): PipelineSampleRow[] {
  if (publicationKeys.length === 0) return [];
  const placeholders = publicationKeys.map(() => "?").join(",");
  const bucketSeconds = periodDays <= 7 ? 60 * 60 : 24 * 60 * 60;
  // The cap keeps the newest buckets, not the oldest: a series longer than the
  // cap is one whose recent days are the point of asking.
  const totalBuckets = Math.ceil((Date.parse(end) - Date.parse(start)) / (bucketSeconds * 1_000));
  const firstBucket = Math.max(0, totalBuckets - limitPerSeries);
  // One row per (post, target, metric, bucket), carrying that bucket's last
  // reading. SQLite hands back the row that produced max(sampled_at), which is
  // what a window function was doing here at twice the cost.
  return unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT publication_key AS publicationKey, target, metric_name AS metricName, value, max(sampled_at) AS sampledAt, bucket
         FROM (
           SELECT publication_key, target, metric_name, value, sampled_at,
                  CAST((unixepoch(sampled_at) - unixepoch(?)) / ? AS INTEGER) AS bucket
             FROM metric_samples
            WHERE publication_key IN (${placeholders}) AND sampled_at >= ? AND sampled_at <= ?
         )
        WHERE bucket >= ?
        GROUP BY publicationKey, target, metricName, bucket
        ORDER BY publicationKey ASC, target ASC, metricName ASC, bucket ASC`,
    )
    .all(start, bucketSeconds, ...publicationKeys, start, end, firstBucket) as PipelineSampleRow[];
}

/** The newest metric samples with the post they belong to. Both the pipeline
 * read model and the Command Center payload report this same list, and it was
 * written out twice, identically. */
export function recentPostMetrics(backendDb: BackendDb) {
  return unsafeDb(backendDb)
    .db.select({
      publicationKey: postMetrics.publicationKey,
      target: postMetrics.target,
      metricName: postMetrics.metricName,
      value: postMetrics.value,
      source: postMetrics.source,
      sampledAt: postMetrics.sampledAt,
      error: postMetrics.error,
      postId: drafts.postId,
      postUrl: sql<string | null>`(
        select ${publicationTargets.url} from ${publicationTargets}
        where ${publicationTargets.publicationKey} = ${postMetrics.publicationKey}
          and ${publicationTargets.url} is not null
        order by ${publicationTargets.publishedAt} asc limit 1
      )`,
    })
    .from(postMetrics)
    .leftJoin(drafts, sql`${postMetrics.publicationKey} = 'post:' || ${drafts.postId}`)
    .orderBy(desc(postMetrics.sampledAt), asc(postMetrics.publicationKey), asc(postMetrics.target), asc(postMetrics.metricName))
    .limit(100)
    .all();
}
