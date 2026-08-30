import type { DashboardMetricName, PipelinePost } from "../../../analytics/pipeline-payload.js";

const DASHBOARD_METRICS = ["views", "likes", "replies", "reposts"] as const satisfies readonly DashboardMetricName[];

export function getTargetStatus(post: PipelinePost, target: string): string | null {
  const record = post.targets?.[target];
  if (record?.status && record.status !== "unknown") return record.status;
  if (target === "telegram" && post.telegram_url) return "published";
  if (target === "site_ru" && post.site_ru) return "published";
  if (target === "site_en" && post.site_en) return "published";
  return null;
}

type TargetMetricName = DashboardMetricName | "bot_views";

export function getTargetMetric(post: PipelinePost, target: string, metricName: TargetMetricName): number {
  const status = getTargetStatus(post, target);
  if (status !== "published") return 0;
  const val = post.metrics?.[target]?.[metricName]?.value;
  if (val === undefined || val === null) return 0;
  const num = Number(val);
  return Number.isNaN(num) ? 0 : num;
}

function emptyTotals(): Record<DashboardMetricName, number> {
  return { views: 0, likes: 0, replies: 0, reposts: 0 };
}

export function postMetricTotals(post: PipelinePost, targetIds: string[]): Record<DashboardMetricName, number> {
  const totals = emptyTotals();
  for (const targetId of targetIds) {
    for (const metric of DASHBOARD_METRICS) totals[metric] += getTargetMetric(post, targetId, metric);
  }
  return totals;
}
