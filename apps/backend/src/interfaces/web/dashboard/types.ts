type DashboardQueueDraft = {
  id?: number | string | null;
  status?: string | null;
  textRu?: string | null;
  scheduledAt?: string | null;
  scheduledEnAt?: string | null;
  updatedAt?: string | null;
};

type DashboardQueueJob = {
  jobId?: string | number | null;
  publicationKey?: string | null;
  target?: string | null;
  status?: string | null;
  attemptCount?: number | null;
  publishAt?: string | null;
  nextAttemptAt?: string | null;
  lastError?: string | null;
  updatedAt?: string | null;
};

type DashboardCredential = {
  target?: string | null;
  status?: string | null;
  missingEnvJson?: string | null;
  lastError?: string | null;
  lastCheckedAt?: string | null;
};

type DashboardMetricIssue = {
  messageId?: string | number | null;
  target?: string | null;
  status?: string | null;
  error?: string | null;
};

export type OpsPayload = {
  drafts?: DashboardQueueDraft[];
  jobs?: DashboardQueueJob[];
  credentials?: DashboardCredential[];
  pipeline?: {
    metrics?: {
      recent?: DashboardMetricIssue[];
    };
  };
};
