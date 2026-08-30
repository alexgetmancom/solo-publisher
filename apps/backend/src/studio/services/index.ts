import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { analyticsService } from "./analytics.js";
import { studioCapabilityService } from "./capabilities.js";
import { channelService } from "./channels.js";
import { mediaService } from "./media.js";
import { postService } from "./posts.js";
import { queueService } from "./queue.js";
import { settingsService } from "./settings.js";
import { streamService } from "./streams.js";
import { videoService } from "./videos.js";

export type StudioServices = {
  posts: ReturnType<typeof postService>;
  media: ReturnType<typeof mediaService>;
  channels: ReturnType<typeof channelService>;
  videos: ReturnType<typeof videoService>;
  queue: ReturnType<typeof queueService>;
  analytics: ReturnType<typeof analyticsService>;
  capabilities: ReturnType<typeof studioCapabilityService>;
  settings: ReturnType<typeof settingsService>;
  streams: ReturnType<typeof streamService>;
};

/**
 * Single application entry point for every Studio interface.
 * Telegram, the future Web Studio and MCP receive the same capability set;
 * only rendering and transport live outside this boundary.
 */
export function createStudioServices(backendDb: BackendDb, config: BackendConfig): StudioServices {
  const posts = postService(backendDb, config);
  const videos = videoService(backendDb, config);
  return {
    posts,
    media: mediaService(backendDb, config),
    channels: channelService(backendDb, config),
    videos,
    queue: queueService(backendDb, config),
    analytics: analyticsService(backendDb, config),
    capabilities: studioCapabilityService(config, backendDb),
    settings: settingsService(backendDb),
    streams: streamService(backendDb, config),
  };
}
