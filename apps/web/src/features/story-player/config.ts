/* =============================================================================
 * PLAYER CONSTANTS AND CONFIG
 * -----------------------------------------------------------------------------
 * What lives here: the "desktop" breakpoint, the advance timings.
 * A new constant (a "magic number") goes here with a comment, not into a
 * component.
 * ========================================================================== */

/** How long a post without video is shown before advancing (ms). */
export const storyIntervalMs = 8500;

/** Vertical swipe distance that counts as "next post" (px), and the mouse
 * wheel cooldown (ms). Both navigate along the same axis as the rail. */
export const swipeThresholdPx = 55;
export const wheelCooldownMs = 140;

/** How many posts the home page sends the player at a time. The whole archive
 * used to be serialized into the island's props, which is most of the page's
 * HTML; the rest arrives from /home-posts.json as the reader approaches it. */
export const homePageSize = 12;

/** How many posts ahead of the last loaded one the next page is fetched, so the
 * fetch is already finished by the time the reader gets there. */
export const homePagePrefetch = 4;
