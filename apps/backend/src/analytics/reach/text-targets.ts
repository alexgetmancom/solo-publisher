/** Every text destination, in the order the overview reads them.
 *
 * The order is a property of the destinations, not of the screen drawing them:
 * the reach read model needs the same list to know which series to fold, and a
 * second copy of it beside the icons would be a second answer to "what are the
 * text destinations".
 */
export const ORDERED_TEXT_TARGET_IDS = [
  "site_en",
  "site_ru",
  "threads_en",
  "threads_ru",
  "instagram_stories",
  "instagram_stories_ru",
  "telegram",
  "x",
  "discord",
  "telegram_stories",
] as const;
