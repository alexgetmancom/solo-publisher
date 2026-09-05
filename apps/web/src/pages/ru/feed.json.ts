import type { APIContext } from "astro";
import { publicJsonFeedResponse } from "../../server/public-feed";

export const prerender = false;

export function GET(context: APIContext) {
  return publicJsonFeedResponse(context, "ru");
}
