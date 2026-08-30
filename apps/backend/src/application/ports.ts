import type { PublicationKind } from "./conversation-flow.js";

export type DomainEventInput = {
  ref?: string | null;
  type: string;
  severity: "info" | "warn" | "error";
  target?: string | null;
  message: string;
  details?: Record<string, unknown>;
  cooldownSeconds?: number;
};

/** A deterministic time boundary for application use cases and tests. */
export type Clock = { now(): Date };

/** Stable application representation of a draft. Database naming stays at the boundary. */
export type DraftRecord = {
  id: number;
  actor_id: number;
  status: string;
  text_ru: string;
  text_en_machine: string | null;
  text_en_approved: string | null;
  targets_json: string;
  media_ru_json: string | null;
  media_en_json: string | null;
  channel_message_id: number | null;
  scheduled_at: string | null;
  scheduled_en_at: string | null;
  post_id: number | null;
  text_ru_entities_json: string | null;
  text_en_entities_json: string | null;
  threads_chain_approved: number;
  story_publish_mode: string | null;
};

export type NewDraft = {
  actorId: number;
  textRu: string;
  textEnMachine: string | null;
  textEnApproved: string | null;
  targetsJson: string;
  mediaRuJson: string | null;
  textRuEntitiesJson: string;
  storyPublishMode?: "all" | "site_only";
};

export type DraftPatch = Partial<{
  textRu: string;
  textEnApproved: string | null;
  textRuEntitiesJson: string | null;
  textEnEntitiesJson: string | null;
  targetsJson: string;
  mediaRuJson: string | null;
  mediaEnJson: string | null;
  threadsChainApproved: number;
  updatedAt: string;
}>;

export type PostEventRecord = {
  id: number;
  publicationKey: string | null;
  eventType: string;
  severity: string;
  target: string | null;
  message: string;
  detailsJson: string | null;
  createdAt: string;
  ackedAt: string | null;
};

/** A delivery target that did not land: it either failed outright or reached a
 * state only a human can settle. Whether it may be retried or only abandoned is
 * a publishing rule, applied by the caller, not by the query. */
export type FailedPublicationTarget = {
  target: string;
  status: "failed" | "verification_required";
  error: string | null;
};

export type DraftEntityCandidate = {
  kind: string;
  slug: string;
  titleRu: string;
  titleEn: string | null;
};

/** Post-specific persistence port used by Studio command and query use cases. */
export type StudioPostStore = {
  replaceEntityCandidates(draftId: number, candidates: DraftEntityCandidate[], now: string): void;
  acceptEntityCandidates(draftId: number, now: string): void;
  history(draftId: number, postId: number | null, limit: number): PostEventRecord[];
  progress(draftId: number): StudioPostProgress | null;
  failedPublicationTargets(postId: number): FailedPublicationTarget[];
  publicationSource(postId: number): Record<string, unknown>;
};

export type ConversationSessionKind = "intake" | "post" | "video" | "settings" | "stream";

export type ConversationSessionRecord = {
  actorId: number;
  kind: ConversationSessionKind;
  draftId: number | null;
  step: string | null;
  data: Record<string, unknown>;
  controlMessageId: number | null;
  revision: number;
  active: number;
  updatedAt: string;
  expiresAt: string | null;
};

/** Durable conversational state shared by every Telegram workflow. */
export type ConversationSessionStore = {
  get(actorId: number, kind: ConversationSessionKind): ConversationSessionRecord | null;
  save(input: {
    actorId: number;
    kind: ConversationSessionKind;
    draftId: number | null;
    step: string | null;
    data: Record<string, unknown>;
    controlMessageId: number | null;
    active: number;
    expectedRevision?: number | null;
    preserveRevision?: boolean;
    updatedAt: string;
    expiresAt: string | null;
  }): number;
  clearIfCurrent(input: {
    draftId: number | null;
    actorId: number;
    kind: ConversationSessionKind;
    step?: string | null;
    expectedRevision: number | null | undefined;
    updatedAt: string;
  }): boolean;
  retire(actorId: number, kind: ConversationSessionKind, updatedAt: string): void;
};

/** Persistence projection used by the transport-neutral post progress read model. */
type StudioPostProgress = {
  draft: { id: number; actorId: number; postId: number | null; targetsJson: string };
  publishJobs: Array<{ target: string; status: string; lastError: string | null }>;
  siteJobs: Array<{ reason: string; status: string; lastError: string | null }>;
};

/** One thing that needs a human: a publication that failed, or one that reached
 * the audience without a proof we could read back. */
export type ActionableIssue = {
  kind: "post" | "site" | "story" | "video";
  /** Null only for a Story card on a draft that never entered Delivery. */
  publicationKey: string | null;
  draftId: number;
  actorId: number;
  /** Delivery target, site job reason, Story locale — whatever names the half
   * of the publication that is stuck. */
  target: string;
  status: "failed" | "verification_required";
  updatedAt: string;
};

/** The one definition of "needs attention", shared by Studio and Operations. */
export type ActionableIssueStore = {
  /** Every open issue, newest first; scoped to those actors when given. */
  list(actorIds?: number[]): ActionableIssue[];
};

/** Queue projection used by every Studio interface. */
export type StudioQueueStore = {
  posts(actorIds: number[], limit: number): StudioQueuePost[];
  videos(actorIds: number[], limit: number): StudioQueueVideo[];
  latestPublished(actorIds: number[]): StudioQueuePublished | null;
  videoTargets(publicationIds: number[]): StudioQueueVideoTarget[];
};

export type StudioQueuePublished = {
  id: number;
  label: string;
  kind: "post" | "video";
  publishedAt: string;
};

export type StudioQueuePost = {
  id: number;
  actorId: number;
  status: string;
  textRu: string;
  targetsJson: string;
  updatedAt: string;
  scheduledAt: string | null;
  scheduledEnAt: string | null;
  postId: number | null;
};

export type StudioQueueVideo = {
  id: number;
  actorId: number;
  status: string;
  label: string;
  updatedAt: string;
};

export type StudioQueueVideoTarget = {
  publicationId: number;
  status: string;
  scheduledAt: string | null;
};

export type StudioSettingsStore = {
  /** What this Studio is and how its deployment behaves. Always present: the
   * migration that created the table inserted the fresh-install row with it. */
  profile(): StudioProfileRecord;
  saveProfile(input: Partial<Omit<StudioProfileRecord, "id">> & { updatedAt: string }): void;
  notifications(actorId: number): StudioNotificationSettingsRecord | null;
  locale(actorId: number): string | null;
  timezone(actorId: number): string | null;
  weeklyDigest(): StudioWeeklyDigestSettingsRecord | null;
  saveWeeklyDigest(input: { enabled: number; weekday: number; updatedAt: string }): void;
  backup(): StudioBackupSettingsRecord | null;
  saveBackup(input: { enabled: number; updatedAt: string }): void;
  radar(): StudioRadarSettingsRecord | null;
  milestones(): StudioMilestoneSettingsRecord | null;
  saveMilestones(input: {
    channelEnabled: number;
    groupLocaleEnabled: number;
    localeEnabled: number;
    projectEnabled: number;
    thresholdsJson: number[];
    updatedAt: string;
  }): void;
  saveRadar(input: { enabled: number; hour: number; minute: number; prompt: string; effort: string; updatedAt: string }): void;
  saveNotifications(input: {
    actorId: number;
    videoRemindersEnabled: number;
    postRemindersEnabled: number;
    reminderMinutes: number;
    completionEnabled: number;
    updatedAt: string;
  }): void;
  cancelQueuedReminders(actorId: number, publicationKind: PublicationKind, now: string): number;
  youtubeSettings(): StudioYoutubeSettingsRecord | null;
  saveYoutubeSettings(input: { signature: string; updatedAt: string }): void;
  saveLocale(input: { actorId: number; locale: string; updatedAt: string }): void;
  saveTimezone(input: { actorId: number; timezone: string; updatedAt: string }): void;
};

/** A string this Studio publishes about itself, in each language it serves. */
export type LocalizedText = { en: string; ru: string };
export type StudioSocialProfile = { label: string; url: string };
export type LocalizedProfiles = { en: StudioSocialProfile[]; ru: StudioSocialProfile[] };

export type StudioProfileRecord = {
  id: number;
  timezone: string;
  timezoneLabel: string;
  siteEnabled: number;
  videoPrepareLeadMinutes: number;
  videoRetentionHours: number;
  nameJson: LocalizedText;
  taglineJson: LocalizedText;
  aboutJson: LocalizedText;
  profilesJson: LocalizedProfiles;
  defaultTargetsJson: string[];
  updatedAt: string;
};

type StudioNotificationSettingsRecord = {
  actorId: number;
  videoRemindersEnabled: number;
  postRemindersEnabled: number;
  reminderMinutes: number;
  completionEnabled: number;
  updatedAt: string;
};

type StudioBackupSettingsRecord = {
  id: number;
  enabled: number;
  updatedAt: string;
};

type StudioWeeklyDigestSettingsRecord = {
  id: number;
  enabled: number;
  weekday: number;
  updatedAt: string;
};

type StudioMilestoneSettingsRecord = {
  id: number;
  channelEnabled: number;
  groupLocaleEnabled: number;
  localeEnabled: number;
  projectEnabled: number;
  thresholdsJson: number[];
  updatedAt: string;
};

type StudioRadarSettingsRecord = {
  id: number;
  enabled: number;
  hour: number;
  minute: number;
  prompt: string;
  effort: string;
  updatedAt: string;
};

type StudioYoutubeSettingsRecord = {
  id: number;
  signature: string;
  updatedAt: string;
};

export type StudioMediaAssetRecord = {
  id: number;
  actorId: number;
  kind: string;
  mimeType: string;
  filename: string;
  localPath: string;
  byteSize: number;
  sha256: string;
  source: string;
  createdAt: string;
};

export type StudioMediaAssetStore = {
  findByOwnerHash(actorId: number, sha256: string): StudioMediaAssetRecord | null;
  insertIfAbsent(input: Omit<StudioMediaAssetRecord, "id">): StudioMediaAssetRecord | null;
  get(id: number): StudioMediaAssetRecord | null;
  list(actorIds: number[], limit: number): StudioMediaAssetRecord[];
  require(actorIds: number[], assetIds: number[]): StudioMediaAssetRecord[];
};

type StudioVideoDraftRecord = {
  id: number;
  actorId: number;
  locale: string;
  label: string;
  studioMediaAssetId: number;
  status: string;
  scheduledAt: string | null;
  retentionUntil: string | null;
  sourcePrunedAt: string | null;
  controlChatId: number | null;
  controlMessageId: number | null;
  createdAt: string;
  updatedAt: string;
};

type StudioVideoTargetRecord = {
  id: number;
  publicationId: number;
  target: string;
  metadataJson: Record<string, unknown>;
  scheduledAt: string | null;
  status: string;
  deliveryProvider: string;
  providerAccountId: string | null;
  providerPostId: string | null;
  externalId: string | null;
  externalUrl: string | null;
  preparedAt: string | null;
  publishedAt: string | null;
  confirmationSource: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

type StudioVideoJobRecord = {
  id: number;
  publicationId: number;
  videoTargetId: number | null;
  kind: string;
  runAt: string;
  status: string;
  reconcileAttemptCount: number;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  lockedBy: string | null;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Read-side video persistence used by Studio interfaces and previews. */
export type StudioVideoStore = {
  get(publicationId: number): StudioVideoDraftRecord | null;
  list(actorIds: number[], limit: number): StudioVideoDraftRecord[];
  targets(publicationId: number): StudioVideoTargetRecord[];
  jobs(publicationId: number): StudioVideoJobRecord[];
  history(publicationKey: string, limit: number): PostEventRecord[];
};

export type EntityEnrichmentStore = {
  locales(draftId: number): Array<{ locale: string; text: string | null }>;
  entities(): Array<{ id: number; kind: string; parentEntityId: number | null; slug: string; titleRu: string; titleEn: string | null }>;
  aliases(): Array<{ entityId: number; alias: string }>;
  link(draftId: number, entityId: number, linkRole: "focus" | "mention", createdAt: string): void;
};

export type ChannelConnectionRecord = {
  id: string;
  platform: string;
  locale: string;
  provider: string;
  providerAccountId: string | null;
  targetId: string | null;
  label: string;
  enabled: number;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type ChannelStore = {
  list(enabledOnly: boolean): ChannelConnectionRecord[];
  get(id: string): ChannelConnectionRecord | null;
  upsert(input: Omit<ChannelConnectionRecord, "createdAt" | "updatedAt">, now: string): void;
  disable(id: string, now: string): void;
  find(platform: string, locale: string): ChannelConnectionRecord | null;
};

/** Persistence port used by content and Studio use cases. */
export type DraftStore = {
  create(input: NewDraft): number;
  get(id: number): DraftRecord | null;
  list(actorIds: number[], limit: number): DraftRecord[];
  update(id: number, patch: DraftPatch): void;
};

/** Durable event port. Consumers can remain independent from the event table. */
export type EventStore = { record(input: DomainEventInput): boolean };

/** Story-card generation is a content side effect, not a database concern. */
export type StoryPublishMode = "all" | "site_only";

/** Story cards as an application service uses them: the queue, the two reads a
 * post screen needs, and the publish mode. Only the fields a caller reads — the
 * adapter selects rows, and the row type is not the port's business. */
type StoryCardStore = {
  queue(draftId: number): void;
  forDraft(draftId: number): Array<{ locale: string; status: string; localPath: string | null }>;
  readyMedia(draftId: number): Record<"ru" | "en", Record<string, unknown>> | null;
  setPublishMode(draftId: number, mode: StoryPublishMode): void;
};

/** Composition-root dependencies passed into application use cases. */
export type ApplicationPorts = {
  clock: Clock;
  drafts: DraftStore;
  events: EventStore;
  studioPosts: StudioPostStore;
  conversationSessions: ConversationSessionStore;
  studioQueue: StudioQueueStore;
  actionableIssues: ActionableIssueStore;
  studioSettings: StudioSettingsStore;
  studioMediaAssets: StudioMediaAssetStore;
  studioVideos: StudioVideoStore;
  entityEnrichment: EntityEnrichmentStore;
  channels: ChannelStore;
  storyCards: StoryCardStore;
};
