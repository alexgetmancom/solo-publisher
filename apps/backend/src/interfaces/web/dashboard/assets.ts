import { ORDERED_TEXT_TARGET_IDS } from "../../../analytics/reach/text-targets.js";
import { TARGETS } from "../../../botTargets.js";
import { type Html, raw } from "../../../foundation/html.js";

type TargetInfo = { id: string; label: string; locale: string; kind: string };

/** Static presentation metadata for the Operations dashboard. */
export const ORDERED_TARGETS: TargetInfo[] = ORDERED_TEXT_TARGET_IDS.map((id) => {
  const found = TARGETS.find((target) => target.id === id);
  return found ? { id: found.id, label: found.label, locale: found.locale, kind: found.kind } : null;
}).filter((target) => target !== null) as TargetInfo[];

export const PLATFORM_ICONS: Record<string, Html> = {
  site: raw(
    `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
  ),
  threads: raw(
    `<svg viewBox="0 0 192 192" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M141.537 88.9883C140.71 88.5919 139.87 88.2104 139.019 87.8451C137.537 60.5382 122.616 44.905 97.5619 44.745C97.4484 44.7443 97.3355 44.7443 97.222 44.7443C82.2364 44.7443 69.7731 51.1409 62.102 62.7807L75.881 72.2328C81.6116 63.5383 90.6052 61.6848 97.2286 61.6848C97.3051 61.6848 97.3819 61.6848 97.4576 61.6855C105.707 61.7381 111.932 64.1366 115.961 68.814C118.893 72.2193 120.854 76.925 121.825 82.8638C114.511 81.6207 106.601 81.2385 98.145 81.7233C74.3247 83.0954 59.0111 96.9879 60.0396 116.292C60.5615 126.084 65.4397 134.508 73.775 140.011C80.8224 144.663 89.899 146.938 99.3323 146.423C111.79 146.423 121.563 140.987 128.381 132.296C133.559 125.696 136.834 117.143 138.28 106.366C144.217 109.949 148.617 114.664 151.047 120.332C155.179 129.967 155.42 145.8 142.501 158.708C131.182 170.016 117.576 174.908 97.0135 175.059C74.2042 174.89 56.9538 167.575 45.7381 153.317C35.2355 139.966 29.8077 120.682 29.6052 96C29.8077 71.3178 35.2355 52.0336 45.7381 38.6827C56.9538 24.4249 74.2039 17.11 97.0132 16.9405C119.988 17.1113 137.539 24.4614 149.184 38.788C154.894 45.8136 159.199 54.6488 162.037 64.9503L178.184 60.6422C174.744 47.9622 169.331 37.0357 161.965 27.974C147.036 9.60668 125.202 0.195148 97.0695 0H96.9569C68.8816 0.19447 47.2921 9.6418 32.7883 28.0793C19.8819 44.4864 13.2244 67.3157 13.0007 95.9325L13 96L13.0007 96.0675C13.2244 124.684 19.8819 147.514 32.7883 163.921C47.2921 182.358 68.8816 191.806 96.9569 192H97.0695C122.03 191.827 139.624 185.292 154.118 170.811C173.081 151.866 172.51 128.119 166.26 113.541C161.776 103.087 153.227 94.5962 141.537 88.9883ZM98.4405 129.507C88.0005 130.095 77.1544 125.409 76.6196 115.372C76.2232 107.93 81.9158 99.626 99.0812 98.6368C101.047 98.5234 102.976 98.468 104.871 98.468C111.106 98.468 116.939 99.0737 122.242 100.233C120.264 124.935 108.662 128.946 98.4405 129.507Z"/></svg>`,
  ),
  telegram: raw(
    `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.11.02-1.93 1.23-5.46 3.62-.51.35-.98.53-1.39.51-.46-.01-1.35-.26-2.01-.48-.8-.27-1.44-.42-1.39-.89.03-.25.38-.51 1.06-.78 4.15-1.81 6.91-3 8.28-3.57 3.94-1.63 4.76-1.91 5.3-.13z"></path></svg>`,
  ),
  telegram_stories: raw(
    `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M12 2 14.9 8.3 22 9.1l-5.3 4.7 1.5 6.9L12 17.2 5.8 20.7l1.5-6.9L2 9.1l7.1-.8L12 2Z"></path></svg>`,
  ),
  instagram: raw(
    `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><rect x="3" y="3" width="18" height="18" rx="5"></rect><circle cx="12" cy="12" r="4"></circle><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"></circle></svg>`,
  ),
  x: raw(
    `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path></svg>`,
  ),
  discord: raw(
    `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M8.5 4.5 7.2 4.9C4.9 5.6 3.6 7.9 3.2 10.4l-.5 3.4c-.2 1.5.6 3 2 3.6l1.6.7 1.1-1.9"></path><path d="M15.5 4.5l1.3.4c2.3.7 3.6 3 4 5.5l.5 3.4c.2 1.5-.6 3-2 3.6l-1.6.7-1.1-1.9"></path><path d="M7.6 16.6c2.9 1.1 5.9 1.1 8.8 0"></path><circle cx="9.3" cy="11.6" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="14.7" cy="11.6" r="1.3" fill="currentColor" stroke="none"></circle></svg>`,
  ),
  // Video platforms are drawn in the same monochrome 16px stroke idiom as the
  // text ones. Brand-coloured logos here would be the loudest thing on a screen
  // whose whole point is that the numbers are what you read first.
  youtube: raw(
    `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><rect x="2" y="5" width="20" height="14" rx="4"></rect><path d="M10.2 9.3v5.4l4.6-2.7z" fill="currentColor" stroke="none"></path></svg>`,
  ),
  tiktok: raw(
    `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M14.1 2h2.6c.2 1.4.9 2.6 2 3.4.7.5 1.6.8 2.5.9v2.7c-1.7 0-3.3-.5-4.6-1.5v6.6c0 3.4-2.7 6.1-6.1 6.1S4.4 17.5 4.4 14.1 7.1 8 10.5 8c.3 0 .6 0 .9.1v2.8c-.3-.1-.6-.2-.9-.2-1.9 0-3.4 1.5-3.4 3.4s1.5 3.4 3.4 3.4 3.4-1.5 3.4-3.4V2z"></path></svg>`,
  ),
};

/** Video targets map onto the same monochrome icon set. Keyed by the values of
 * VIDEO_TARGETS so a newly added platform shows an icon instead of a gap. */
export const VIDEO_PLATFORM_ICON_KEYS: Record<string, string> = {
  youtube_shorts: "youtube",
  instagram_reels: "instagram",
  tiktok: "tiktok",
};

export function platformKey(targetId: string): string {
  if (targetId.startsWith("site_")) return "site";
  if (targetId.startsWith("threads_")) return "threads";
  if (targetId.startsWith("instagram_stories")) return "instagram";
  if (targetId === "telegram_stories") return "telegram_stories";
  return targetId;
}
