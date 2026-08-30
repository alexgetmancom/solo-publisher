export function formatMetricValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const num = Number(value);
  if (Number.isNaN(num)) return "";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}m`.replace(".0m", "m");
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`.replace(".0k", "k");
  return String(num);
}

export function shortPipelineText(value: string | null | undefined, wordLimit = 7): string {
  if (!value) return "";
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= wordLimit) return words.join(" ");
  return `${words.slice(0, wordLimit).join(" ")}...`;
}
