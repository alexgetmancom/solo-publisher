import { newPost, RU_CHANNELS } from "./cases-post.ts";
import { ADMIN, type Case, type Harness } from "./harness.ts";

/** A promise and the function that settles it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Holds the next call of `method` until the returned function is called, so
 * the chat stays busy while other updates arrive. */
function holdNext(h: Harness, method: string): () => void {
  const { wait, open } = gate();
  h.telegram.hold = { method, release: wait };
  return open;
}

export const CALLBACK_CASES: Case[] = [
  {
    id: "callback-unknown",
    area: "callbacks",
    specRef: "§10 #93 Unknown action; §1.6; §5.1 grammar (unknown id, wrong arity, bad numbers)",
    channels: RU_CHANNELS,
    run: async (h) => {
      await h.text("/start");
      const menu = h.telegram.last(ADMIN)?.message_id;
      for (const data of [
        "analytics_post",
        "queue_page",
        "queue_page:x",
        "queue_page:-1",
        "progress:0",
        "intake_kind:nonsense",
        "noop:extra",
      ])
        await h.callback(data, { messageId: menu });
    },
  },
  {
    id: "callback-publication-stale",
    area: "callbacks",
    specRef: "§10 #45, #93; §5.2 steps 1-5 (unknown action, invalid id, arity, missing and wrong session revision)",
    channels: RU_CHANNELS,
    run: async (h) => {
      await newPost(h);
      const card = h.telegram.last(ADMIN)?.message_id;
      for (const data of [
        "p:post:frobnicate:1",
        "p:video:frobnicate:1",
        "p:post:view:abc:overview",
        "p:video:view:0:overview",
        "p:post:toggle:1",
        "p:post:cancel_dialog",
      ])
        await h.callback(data, { messageId: card });
      await h.tapData("p:post:edit_ru:1");
      for (const data of ["sv99|p:post:cancel_dialog", "p:post:view:999:overview", "progress:999"])
        await h.callback(data, { messageId: card });
    },
  },
  {
    id: "callback-stale-card",
    area: "callbacks",
    specRef: "§10 #45; §5.2 step 7; §5.5 freshCard (superseded card re-sent and re-bound)",
    channels: RU_CHANNELS,
    run: async (h) => {
      await newPost(h);
      const oldCard = h.button("p:post:cycle_mode:1", undefined, true).messageId;
      await h.tapData("p:post:edit_ru:1");
      await h.text("Новый текст поста");
      await h.callback("p:post:cycle_mode:1", { messageId: oldCard });
      await h.tapData("p:post:cycle_mode:1");
    },
  },
  {
    id: "callback-duplicate",
    area: "callbacks",
    specRef: "§5.6 rule 2 (redelivered callback id answered, not processed)",
    channels: RU_CHANNELS,
    run: async (h) => {
      await h.text("☰ Меню");
      const update = h.callbackUpdate("queue_home");
      await h.feed(update);
      await h.feed(update);
    },
  },
  {
    id: "callback-superseded",
    area: "callbacks",
    specRef: "§5.4 supersession (older tap on the same button of the same message dropped)",
    channels: RU_CHANNELS,
    run: async (h) => {
      await h.text("☰ Меню");
      await h.tap(/^📋/);
      const menu = h.telegram.last(ADMIN)?.message_id;
      // The chat is busy with a held screen edit while three taps arrive.
      const release = holdNext(h, "editMessageText");
      h.note("The first editMessageText of the burst is held until all four updates have arrived.");
      const busy = h.callbackUpdate("menu_home", { messageId: menu });
      const taps = [h.callbackUpdate("queue_home", { messageId: menu }), h.callbackUpdate("queue_home", { messageId: menu })];
      const queued = h.callbackUpdate("queue_attention", { messageId: menu });
      const burst = h.feedTogether([busy, ...taps, queued]);
      await Bun.sleep(50);
      release();
      await burst;
    },
  },
  {
    id: "callback-action-lock",
    area: "callbacks",
    specRef: "§10 #93 Already running…; §1.8 action lock",
    channels: RU_CHANNELS,
    run: async (h) => {
      await newPost(h);
      const card = h.button("p:post:cycle_mode:1", undefined, true).messageId;
      // The same control tapped from a second chat (a group the operator also uses)
      // while the first tap's screen edit is still in flight: same actor, same lock key.
      const release = holdNext(h, "editMessageText");
      h.note("The first tap's editMessageText is held until the second chat's tap has been handled.");
      const first = h.callbackUpdate("p:post:view:1:platforms", { messageId: card });
      const second = h.callbackUpdate("p:post:view:1:platforms", { messageId: card });
      const message = (second.callback_query as { message: { chat: Record<string, unknown> } }).message;
      message.chat = { id: -1001234567890, type: "supergroup", title: "Studio" };
      const burst = h.feedTogether([first, second]);
      await Bun.sleep(50);
      release();
      await burst;
    },
  },
  {
    id: "callback-menu-legacy",
    area: "callbacks",
    specRef: "§5.7 menu-plugin format: outdated hash, unknown menu, malformed position",
    channels: RU_CHANNELS,
    run: async (h) => {
      await h.text("☰ Меню");
      const menu = h.telegram.last(ADMIN)?.message_id;
      for (const data of [
        "main-menu/0/0//h0000",
        "main-menu/1/0//fold",
        "settings-menu/0/0//hxyz",
        "analytics-menu/0/0//h1234",
        "main-menu/zz/0//f1",
      ])
        await h.callback(data, { messageId: menu });
    },
  },
];
