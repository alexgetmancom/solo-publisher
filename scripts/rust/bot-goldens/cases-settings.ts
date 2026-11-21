import { VIDEO_CHANNELS } from "./cases-video.ts";
import { type Case, fileDownload, type Harness, setHttp } from "./harness.ts";

/** ☰ Menu → ⚙️ Settings: the settings root is the last message. */
async function openSettings(h: Harness): Promise<void> {
  await h.text("☰ Меню");
  await h.tap(/^⚙️/);
}

export const SETTINGS_CASES: Case[] = [
  {
    id: "settings-root",
    area: "settings",
    specRef: "§10 #67; §4.10.1; §2 ⚙️ text trigger",
    run: async (h) => {
      await openSettings(h);
      await h.tap(/^← /);
      await h.text("⚙️");
    },
  },
  {
    id: "settings-publishing-channels",
    area: "settings",
    specRef: "§10 #68, #69, #70, #71; §4.10.2, §4.10.3 list, card, disable",
    run: async (h) => {
      await openSettings(h);
      await h.tap(/^📡/);
      await h.tap(/^🔌/);
      await h.tap(/Telegram RU$/);
      await h.tap(/^🗑/);
      await h.tap(/^← /);
      await h.tap(/^🗑/);
      await h.tap(/^🗑/);
      await h.tap(/Threads RU$/);
      await h.tap(/^← /);
      await h.tap(/^← /);
      await h.tap(/^← /);
    },
  },
  {
    id: "settings-connect",
    area: "settings",
    specRef: "§10 #72; §4.10.3 connect menu (YouTube start, direct targets)",
    channels: ["threads_ru", "youtube_ru"],
    env: {
      TOKEN_ENCRYPTION_KEY: "11".repeat(32),
      X_CLIENT_ID: "x-client",
      X_CLIENT_SECRET: "x-secret",
      INSTAGRAM_APP_ID: "instagram-app",
      INSTAGRAM_APP_SECRET: "instagram-secret",
      THREADS_APP_ID: "threads-app",
      THREADS_APP_SECRET: "threads-secret",
      PUBLIC_BASE_URL: "https://studio.example.invalid",
    },
    run: async (h) => {
      await openSettings(h);
      await h.tap(/^📡/);
      await h.tap(/^🔌/);
      await h.tap(/^＋ /);
      await h.tap(/YouTube RU/);
      await h.tap(/^＋ Telegram$/);
      await h.tap(/^← /);
    },
  },
  {
    id: "settings-connect-zernio",
    area: "settings",
    specRef: "§10 #72 (Zernio buttons); §4.10.3 step 6 (discovery failure)",
    channels: ["telegram"],
    run: async (h) => {
      h.config.ZERNIO_API_KEY = "zernio-test-key";
      h.note("ZERNIO_API_KEY is set on the config (as a stored API key would be); GET https://zernio.com/api/v1/accounts answers 503.");
      setHttp((url) => (url.startsWith("https://zernio.com/") ? new Response("unavailable", { status: 503 }) : fileDownload(url)));
      await openSettings(h);
      await h.tap(/^📡/);
      await h.tap(/^🔌/);
      await h.tap(/^＋ /);
      await h.tap("➕ Zernio · RU");
    },
  },
  {
    id: "settings-connect-zernio-accounts",
    area: "settings",
    specRef: "§10 #72 (discovered accounts); §4.10.3 steps 1 and 6",
    channels: ["telegram"],
    run: async (h) => {
      h.config.ZERNIO_API_KEY = "zernio-test-key";
      const accounts = [
        { _id: "acc-threads", platform: "threads", username: "studio.threads" },
        { _id: "acc-instagram", platform: "instagram", username: "studio.insta" },
        { _id: "acc-tiktok", platform: "tiktok", username: "studio.tiktok" },
      ];
      h.note(`ZERNIO_API_KEY is set on the config; GET https://zernio.com/api/v1/accounts answers ${JSON.stringify({ accounts })}.`);
      setHttp((url) => (url.startsWith("https://zernio.com/") ? Response.json({ accounts }) : fileDownload(url)));
      await openSettings(h);
      await h.tap(/^📡/);
      await h.tap(/^🔌/);
      await h.tap(/^＋ /);
      await h.tap("➕ Zernio · RU");
      await h.tap(/^Threads RU · @studio\.threads$/);
      await h.tap(/^← /);
    },
  },
  {
    id: "settings-default-targets",
    area: "settings",
    specRef: "§10 #73; §4.10.4",
    run: async (h) => {
      await openSettings(h);
      await h.tap(/^📡/);
      await h.tap(/^🌐/);
      await h.tap(/X \(Twitter\)$/);
      await h.tap(/Telegram$/);
      await h.tap(/^← /);
    },
  },
  {
    id: "settings-youtube-signature",
    area: "settings",
    specRef: "§10 #74, #82 (signature saved); §4.10.5; §6.6 youtube_signature",
    channels: VIDEO_CHANNELS,
    run: async (h) => {
      await openSettings(h);
      await h.tap(/^📡/);
      await h.tap(/^▶️/);
      await h.tap(/^✏️/);
      await h.text("Подписывайтесь на канал *игры*");
      await h.tap(/^🗑/);
      await h.tap(/^✏️/);
      await h.text("/cancel");
      await h.tap(/^← /);
    },
  },
  {
    id: "settings-notifications",
    area: "settings",
    specRef: "§10 #75, #76; §4.10.7",
    run: async (h) => {
      await openSettings(h);
      await h.tap(/^🔔/);
      await h.tap(/^🔔/);
      await h.tap(/^✅ .*видео|^⬜ .*видео/i);
      await h.tap(/^[✅⬜] .*текст/i);
      await h.tap(/^[✅⬜] Завершение$/);
      await h.tap(/^○ 15/);
      await h.tap(/^● 15/);
      await h.tap(/^← /);
      await h.tap(/^← /);
    },
  },
  {
    id: "settings-system-timezone",
    area: "settings",
    specRef: "§10 #77, #78, #82 (tz set / invalid); §4.10.6 time zone; §6.6 timezone",
    run: async (h) => {
      await openSettings(h);
      await h.tap(/^⚙️/);
      await h.tap(/^🕒/);
      await h.tap(/Asia\/Tokyo$/);
      await h.tap(/^✏️/);
      await h.text("Mars/Olympus");
      await h.tap(/^✏️/);
      await h.text("Asia/Kathmandu");
      await h.tap(/^← /);
    },
  },
  {
    id: "settings-system-backup",
    area: "settings",
    specRef: "§10 #77, #81; §4.10.6 backup",
    run: async (h) => {
      await openSettings(h);
      await h.tap(/^⚙️/);
      await h.tap(/^🗄/);
      await h.tap(/^[✅⬜] /);
      await h.tap(/^[✅⬜] /);
      await h.tap(/^← /);
      await h.tap(/^← /);
    },
  },
];
