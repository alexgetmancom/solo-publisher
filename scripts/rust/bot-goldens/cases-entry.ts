import { type Case, STRANGER } from "./harness.ts";

/** Commands, text triggers, the main menu and the admin gate (spec §1.3, §2, §4.1). */
export const ENTRY_CASES: Case[] = [
  {
    id: "bootstrap",
    area: "entry",
    specRef: "§1.1 setMyCommands",
    run: async () => {},
  },
  {
    id: "start",
    area: "entry",
    specRef: "§10 #1, #2; §2 /start",
    run: async (h) => {
      await h.text("/start");
    },
  },
  {
    id: "menu-button",
    area: "entry",
    specRef: "§10 #2; §2 ☰ Меню",
    run: async (h) => {
      await h.text("☰ Меню");
      await h.text("☰ Menu");
    },
  },
  {
    id: "admin-gate",
    area: "entry",
    specRef: "§1.3 #2 admin gate",
    run: async (h) => {
      await h.text("/start", { from: STRANGER });
      await h.text("Привет", { from: STRANGER });
      const message = h.telegram.inject(STRANGER, "Старое сообщение", {
        inline_keyboard: [[{ text: "← Меню", callback_data: "menu_home" }]],
      });
      h.note("A message with a [← Меню → menu_home] button is placed in the stranger's chat.");
      await h.callback("menu_home", { from: STRANGER, messageId: message.message_id });
    },
  },
];
