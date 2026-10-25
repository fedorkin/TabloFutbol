import { applyMigrations } from "./db";
import { getPlatformProxy } from "wrangler";
import { Api } from "grammy";
import type { Transformer } from "grammy";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBot } from "../src/bot";
import { runScheduled } from "../src/cron";
import { formatGameDate, nextGameDate } from "../src/dates";
import type { Env } from "../src/env";

const GROUP = -1001;
const ADMIN = 1;
const MONDAY = new Date("2026-10-26T07:00:00Z");
const WEDNESDAY = new Date("2026-10-28T15:00:00Z");

// ---------- фейковый Telegram ----------

type Call = { method: string; payload: any };
let calls: Call[] = [];
let msgId = 100;
const blockedDm = new Set<number>(); // эти пользователи не запускали бота

const fakeTelegram: Transformer = async (_prev, method, payload: any) => {
  calls.push({ method, payload });
  const msg = () => ({ message_id: ++msgId, date: 0, chat: { id: payload.chat_id, type: "supergroup" }, text: "" });
  switch (method) {
    case "getChatMember":
      return { ok: true, result: { status: payload.user_id === ADMIN ? "administrator" : "member", user: { id: payload.user_id } } } as any;
    case "sendMessage":
      if (blockedDm.has(payload.chat_id)) {
        return { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" } as any;
      }
      return { ok: true, result: msg() } as any;
    case "editMessageText":
      return { ok: true, result: msg() } as any;
    default:
      return { ok: true, result: true } as any;
  }
};

const botInfo = {
  id: 999, is_bot: true, first_name: "Bot", username: "soccer_test_bot",
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
} as any;

// ---------- окружение ----------

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let env: Env;
let bot: ReturnType<typeof createBot>;
let api: Api;
let updateId = 0;

const user = (id: number) => ({ id, is_bot: false, first_name: `Игрок${id}` });
const chat = { id: GROUP, type: "supergroup" as const, title: "Футбол" };

async function click(userId: number, weekId: number, resp: "in" | "out") {
  calls = [];
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: `q${updateId}`, from: user(userId), chat_instance: "x", data: `reg:${weekId}:${resp}`,
      message: { message_id: 1, date: 0, chat } as any,
    },
  });
  return calls.find((c) => c.method === "answerCallbackQuery")?.payload;
}

async function command(userId: number, text: string, replyTo?: number) {
  calls = [];
  const cmdLen = text.split(" ")[0].length;
  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: ++msgId, date: 0, chat, from: user(userId), text,
      entities: [{ type: "bot_command", offset: 0, length: cmdLen }],
      ...(replyTo ? { reply_to_message: { message_id: 1, date: 0, chat, from: user(replyTo), text: "hi" } } : {}),
    } as any,
  });
  return calls;
}

const lastEditText = () => [...calls].reverse().find((c) => c.method === "editMessageText")?.payload.text as string;
const sentTo = (chatId: number) => calls.filter((c) => c.method === "sendMessage" && c.payload.chat_id === chatId);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Локальная D1 из wrangler.toml, в памяти (persist: false)
  proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: false });
  const db = proxy.env.DB;
  await applyMigrations(db);
  env = {
    DB: db, BOT_TOKEN: "test", WEBHOOK_SECRET: "s", GROUP_CHAT_ID: String(GROUP),
    TIMEZONE: "Asia/Nicosia", PLAYER_LIMIT: "10", GAME_WEEKDAY: "4", GAME_TIME: "20:00", GAME_PLACE: "",
  };
  bot = createBot(env, botInfo);
  bot.api.config.use(fakeTelegram);
  api = new Api("test");
  api.config.use(fakeTelegram);
});

afterAll(async () => {
  vi.useRealTimers();
  await proxy?.dispose();
});

beforeEach(() => vi.setSystemTime(MONDAY));

// ---------- тесты ----------

describe("даты", () => {
  it("ближайший четверг", () => {
    expect(nextGameDate(new Date("2026-10-26T07:00:00Z"), "Asia/Nicosia", 4)).toBe("2026-10-29"); // пн
    expect(nextGameDate(new Date("2026-10-29T10:00:00Z"), "Asia/Nicosia", 4)).toBe("2026-10-29"); // чт
    expect(nextGameDate(new Date("2026-10-30T10:00:00Z"), "Asia/Nicosia", 4)).toBe("2026-11-05"); // пт
    // 23:30 UTC среды — на Кипре уже четверг
    expect(nextGameDate(new Date("2026-10-28T23:30:00Z"), "Asia/Nicosia", 4)).toBe("2026-10-29");
    expect(formatGameDate("2026-10-29")).toBe("четверг, 29 октября");
  });
});

describe("запись на игру", () => {
  let weekId: number;

  it("cron в понедельник публикует пост с кнопками", async () => {
    calls = [];
    expect(await runScheduled(env, MONDAY, api)).toBe("posted 2026-10-29");
    const post = sentTo(GROUP)[0].payload;
    expect(post.text).toContain("четверг, 29 октября, 20:00");
    const data = post.reply_markup.inline_keyboard[0][0].callback_data as string;
    weekId = Number(data.split(":")[1]);
    expect(data).toBe(`reg:${weekId}:in`);
    // повторный запуск в понедельник ничего не делает
    expect(await runScheduled(env, MONDAY, api)).toBe("nothing to do");
  });

  it("10 в основе, 11-й в листе ожидания", async () => {
    for (let id = 1; id <= 10; id++) expect((await click(id, weekId, "in")).text).toBe("✅ Ты в составе");
    expect((await click(11, weekId, "in")).text).toBe("⏳ Ты в листе ожидания (№11)");
    expect(lastEditText()).toContain("Играют (10/10)");
    expect(lastEditText()).toContain("Лист ожидания</b>\n11. Игрок11");
  });

  it("повторное нажатие не меняет очередь", async () => {
    expect((await click(2, weekId, "in")).text).toBe("Уже отмечено. ✅ Ты в составе");
    expect(calls.some((c) => c.method === "editMessageText")).toBe(false);
  });

  it("отказ из основы поднимает первого из листа ожидания и пишет ему в личку", async () => {
    await click(3, weekId, "out");
    expect(lastEditText()).toContain("Играют (10/10)");
    expect(lastEditText()).toContain("Не играют (1): Игрок3");
    expect(sentTo(11)[0].payload.text).toContain("ты в основном составе");
  });

  it("вернувшийся после отказа встаёт в конец очереди", async () => {
    expect((await click(3, weekId, "in")).text).toBe("⏳ Ты в листе ожидания (№11)");
  });

  it("если личка закрыта — упоминание в группе", async () => {
    blockedDm.add(3);
    await click(5, weekId, "out");
    const groupMsg = sentTo(GROUP).at(-1)!.payload;
    expect(groupMsg.text).toContain('<a href="tg://user?id=3">Игрок3</a>');
    blockedDm.delete(3);
  });

  it("админские команды недоступны обычным игрокам", async () => {
    await command(7, "/close");
    expect(sentTo(GROUP)[0].payload.text).toContain("только для админов");
  });

  it("/add гостя и /remove по номеру", async () => {
    await command(ADMIN, "/add Вася");
    expect(sentTo(GROUP)[0].payload.text).toBe("Добавил Вася — №11 (лист ожидания)");
    await command(ADMIN, "/add вася"); // тот же гость (кириллица, другой регистр), не дубль
    expect(sentTo(GROUP)[0].payload.text).toBe("Добавил Вася — №11 (лист ожидания)");
    await command(ADMIN, "/remove 11");
    expect(sentTo(GROUP).at(-1)!.payload.text).toBe("Убрал Вася");
    expect(lastEditText().toLowerCase()).not.toContain("вася");
  });

  it("/limit 12 поднимает людей из листа ожидания", async () => {
    await click(5, weekId, "in"); // №11
    await click(12, weekId, "in"); // №12
    await click(13, weekId, "in"); // №13
    await command(ADMIN, "/limit 12");
    expect(lastEditText()).toContain("Играют (12/12)");
    expect(sentTo(5)[0].payload.text).toContain("основном составе");
    expect(sentTo(12)[0].payload.text).toContain("основном составе");
    expect(sentTo(13)).toHaveLength(0);
  });

  it("закрытая запись не принимает нажатия", async () => {
    await command(ADMIN, "/close");
    expect(lastEditText()).toContain("Запись закрыта");
    const ans = await click(20, weekId, "in");
    expect(ans.show_alert).toBe(true);
    await command(ADMIN, "/open");
  });

  it("напоминание в среду только если есть места", async () => {
    vi.setSystemTime(WEDNESDAY);
    calls = [];
    expect(await runScheduled(env, WEDNESDAY, api)).toBe("full");
    await click(1, weekId, "out");
    await click(2, weekId, "out");
    await click(4, weekId, "out");
    calls = [];
    expect(await runScheduled(env, WEDNESDAY, api)).toBe("reminded 2");
    expect(sentTo(GROUP)[0].payload.text).toBe("⏰ Игра завтра, а свободно ещё 2 места. Отметьтесь в посте ⬆️");
  });

  it("/game перепощивает пост вниз и удаляет старый", async () => {
    await command(ADMIN, "/game");
    expect(calls.map((c) => c.method)).toEqual(expect.arrayContaining(["sendMessage", "deleteMessage"]));
  });
});
