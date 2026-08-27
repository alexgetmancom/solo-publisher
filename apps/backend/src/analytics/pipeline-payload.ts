/**
 * The shape the pipeline read payload has, as every reader of it sees it.
 *
 * These types used to live beside the dashboard that renders them, which made
 * the reach read model -- core analytics, not presentation -- reachable only
 * from the interface layer.
 */

export type DashboardMetricName = "views" | "likes" | "replies" | "reposts";

type TargetMetric = {
  value?: unknown;
  sampled_at?: string | null;
  source?: string | null;
  error?: string | null;
  raw?: unknown;
  samples?: MetricSample[];
};

/** Immutable observations, ordered by their actual collection time. */
type MetricSample = {
  value?: unknown;
  sampled_at?: string | null;
};

type TargetRecord = {
  status?: string | null;
  ok?: boolean;
  external_id?: string | null;
  external_ids?: unknown;
  url?: string | null;
  error?: string | null;
  skipped?: boolean;
  updated_at?: string | null;
  raw?: unknown;
};

export type PipelinePost = {
  post_id?: number | string | null;
  message_id?: number | string | null;
  telegram_message_id?: number | string | null;
  publication_key?: string | null;
  date?: string | null;
  date_msk?: string | null;
  text_ru?: string | null;
  text_en?: string | null;
  full_text_ru?: string | null;
  full_text_en?: string | null;
  media_json?: unknown;
  media_ru_json?: unknown;
  media_en_json?: unknown;
  slug_en?: string | null;
  slug_ru?: string | null;
  site_url?: string | null;
  telegram_url?: string | null;
  site_ru?: unknown;
  site_en?: unknown;
  targets?: Record<string, TargetRecord | undefined>;
  metrics?: Record<string, Record<string, TargetMetric | undefined> | undefined>;
};

export type PipelineData = {
  posts?: PipelinePost[];
  feed?: { items?: number | null };
  social_worker?: {
    processed_count?: number | null;
    last_update_id?: unknown;
  };
  updated_at?: string | null;
};
