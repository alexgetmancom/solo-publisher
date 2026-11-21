import { createStoryClient, storyCredentials } from "./client.js";

/** Signs the Stories account in, once, and leaves the session where the
 * sidecar reads it (`TELEGRAM_CHANNEL_STORIES_SESSION`). Stories are posted by
 * a user, not a bot, so the credential is an MTProto session. Run it inside the
 * container, with a terminal, as the user that owns the data volume:
 * `docker exec -it -u studio <container> bun /app/sidecar/login.js`. */
const ask = (question: string): string => (prompt(question) ?? "").trim();

// mtcute loads its WASM from the working directory once bundled, and the
// bundle carries it beside this file.
process.chdir(import.meta.dir);

const credentials = storyCredentials(process.env);
if (!credentials) {
  console.error(
    "Set TELEGRAM_CHANNEL_STORIES_API_ID, TELEGRAM_CHANNEL_STORIES_API_HASH (https://my.telegram.org, API development tools) and TELEGRAM_CHANNEL_STORIES_SESSION (a writable path, e.g. /data/telegram_channel_stories) first.",
  );
  process.exit(1);
}
const client = createStoryClient(credentials);
try {
  const user = await client.start({
    phone: async () => ask("Phone number (with country code): "),
    code: async () => ask("Code Telegram just sent: "),
    password: async () => ask("Two-factor password (leave empty if unused): "),
    codeSentCallback: async () => console.log("Telegram sent a code to that account."),
    invalidCodeCallback: async (type) => console.log(`That ${type} was not accepted. Try again.`),
  });
  // The account itself, not the channel: a Story is posted by this user on the
  // channel's behalf, and signing in as the wrong one fails much later.
  console.log(
    JSON.stringify({ signedIn: true, user: user.username ? `@${user.username}` : user.displayName, session: credentials.session }),
  );
} finally {
  await client.destroy();
}
