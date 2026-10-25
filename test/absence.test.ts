import { getPlatformProxy } from "wrangler";
import { Api, type Transformer } from "grammy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBot } from "../src/bot";
import { absenceStreaks, enforceAbsence, resetAdminsCache, riskList, SKIP_LIMIT } from "../src/absence";
import { getOrCreateWeek, upsertTgPlayer } from "../src/db";
import { localToday } from "../src/dates";
import { postWeek } from "../src/service";
import { readConfig, type Env } from "../src/env";
import { applyMigrations } from "./db";

const GROUP = -1004;
const ADMIN = 1;
type Call = { method: string; payload: any };
let calls: Call[] = [];
let msgId = 1000;
const fakeTelegram: Transformer = async (_prev, method, payload: any) => {
  calls.push({ method, payload });
  switch (method) {
    case "getChatMember":
      return { ok: true, result: { status: payload.user_id === ADMIN ? "administrator" : "member", user: { id: payload.user_id } } } as any;
    case "getChatAdministrators":
      return { ok: true, result: [{ status: "administrator", user: { id: ADMIN, is_bot: false, first_name: "A" } }] } as any;
    case "sendMessage":
    case "editMessageText":
      return { ok: true, result: { message_id: ++msgId, date: 0, chat: { id: payload.chat_id }, text: "" } } as any;
    default:
      return { ok: true, result: true } as any;
  }
};

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let env: Env;
let bot: ReturnType<typeof createBot>;
const api = new Api("t");
api.config.use(fakeTelegram);
const today = () => localToday(new Date(), "Asia/Nicosia").date;
const pid = new Map<number, number>(); // tg id → player id
let updateId = 0;

async function command(from: number, text: string, replyTo?: number) {
  calls = [];
  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: ++msgId, date: 0, chat: { id: GROUP, type: "supergroup", title: "g" }, from: { id: from, is_bot: false, first_name: `Игрок${from}` }, text,
      entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }],
      ...(replyTo ? { reply_to_message: { message_id: 1, date: 0, chat: { id: GROUP, type: "supergroup" }, from: { id: replyTo, is_bot: false, first_name: `Игрок${replyTo}` }, text: "x" } } : {}),
    } as any,
  });
  return calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);
}

/** Завершённая игра в дату date, в которой играли перечисленные (tg id). */
async function finishedGame(date: string, played: number[]) {
  const week = await getOrCreateWeek(env.DB, GROUP, date, 10);
  const m = await env.DB.prepare(`INSERT INTO matches (week_id, status, finished_at) VALUES (?1, 'finished', ?2) RETURNING id`)
    .bind(week.id, date + "T20:00:00.000Z").first<{ id: number }>();
  for (const tg of played) {
    await env.DB.prepare(
      `INSERT INTO rating_changes (match_id, player_id, team, result, goals, assists, own_goals, team_part, personal_part, delta, before, after)
       VALUES (?1, ?2, 'A', 'W', 0, 0, 0, 0, 0, 0, 5, 5)`,
    ).bind(m!.id, pid.get(tg)).run();
  }
}

const streakOf = async (tg: number) =>
  (await absenceStreaks(env.DB, GROUP, today())).find((e) => e.playerId === pid.get(tg))?.streak;

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: false });
  await applyMigrations(proxy.env.DB);
  env = {
    DB: proxy.env.DB, BOT_TOKEN: "t", WEBHOOK_SECRET: "s", GROUP_CHAT_ID: String(GROUP),
    TIMEZONE: "Asia/Nicosia", PLAYER_LIMIT: "10", GAME_WEEKDAY: "4", GAME_TIME: "18:30", GAME_PLACE: "",
  };
  resetAdminsCache();
  bot = createBot(env, { id: 9, is_bot: true, first_name: "B", username: "b_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as any);
  bot.api.config.use(fakeTelegram);
  for (let tg = 1; tg <= 8; tg++) pid.set(tg, (await upsertTgPlayer(env.DB, { id: tg, first_name: `Игрок${tg}` })).id);
  await env.DB.prepare(`UPDATE players SET created_at = '2026-01-01 00:00:00'`).run(); // бот знает их давно

  // 9 игр по четвергам: Игрок5 и админ не играли ни разу, Игрок6 играл в 3-й с конца,
  // Игрок7 пропустил все, но 4 последние — на паузе; Игрок8 «познакомился» с ботом недавно.
  const dates = ["2026-08-27", "2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22"];
  for (const [i, d] of dates.entries()) await finishedGame(d, [2, 3, 4, ...(i === 6 ? [6] : [])]);
  await env.DB.prepare(`INSERT INTO player_pauses (player_id, from_date, to_date) VALUES (?1, '2026-10-01', NULL)`).bind(pid.get(7)).run();
  await env.DB.prepare(`UPDATE players SET created_at = '2026-10-10 12:00:00' WHERE id = ?1`).bind(pid.get(8)).run();
});

afterAll(async () => {
  await proxy?.dispose();
});

describe("правило пропусков", () => {
  it("считает пропуски подряд с учётом пауз и даты знакомства с ботом", async () => {
    expect(await streakOf(5)).toBe(9);
    expect(await streakOf(2)).toBe(0);
    expect(await streakOf(6)).toBe(2); // играл 3-ю с конца
    expect(await streakOf(7)).toBe(5); // 4 игры на паузе не считаются
    expect(await streakOf(8)).toBe(2); // только игры после знакомства
  });

  it("зона риска в посте записи — без админов и тех, кто на паузе", async () => {
    const risk = await riskList(api, env.DB, GROUP, today());
    expect(risk.map((e) => e.name)).toEqual(["Игрок5"]); // админ (9 пропусков) и Игрок7 (пауза) не попадают
    calls = [];
    const week = await getOrCreateWeek(env.DB, GROUP, "2026-12-31", 10);
    await postWeek(api, env.DB, week, readConfig(env));
    const text = calls.find((c) => c.method === "sendMessage")!.payload.text as string;
    expect(text).toContain("Давно не играли");
    expect(text).toContain(`<a href="tg://user?id=5">Игрок5</a> — 9 пропусков подряд, осталось 1`);
  });

  it(`после ${SKIP_LIMIT}-го пропуска — удаление из группы без бана`, async () => {
    await finishedGame(today(), [2, 3, 4, 6]);
    calls = [];
    const removed = await enforceAbsence(api, env.DB, GROUP, today());
    expect(removed).toHaveLength(1);
    const ban = calls.find((c) => c.method === "banChatMember")!.payload;
    expect(ban.user_id).toBe(5);
    expect(calls.find((c) => c.method === "unbanChatMember")!.payload).toMatchObject({ user_id: 5, only_if_banned: true });
    expect(calls.some((c) => c.method === "banChatMember" && c.payload.user_id === ADMIN)).toBe(false); // админа не трогаем
    expect(calls.find((c) => c.method === "sendMessage")!.payload.text).toContain("удалены из группы");
    expect(await streakOf(5)).toBeUndefined(); // выбыл — больше не считается

    calls = [];
    expect(await enforceAbsence(api, env.DB, GROUP, today())).toHaveLength(0); // повторно не удаляет
  });

  it("вернулся в группу — пропуски с нуля", async () => {
    await bot.handleUpdate({
      update_id: ++updateId,
      chat_member: {
        chat: { id: GROUP, type: "supergroup", title: "g" }, from: { id: 5, is_bot: false, first_name: "Игрок5" }, date: 0,
        old_chat_member: { status: "left", user: { id: 5, is_bot: false, first_name: "Игрок5" } },
        new_chat_member: { status: "member", user: { id: 5, is_bot: false, first_name: "Игрок5" } },
      } as any,
    });
    expect(await streakOf(5)).toBe(0);
  });

  it("/pause и /unpause — только админ; /skips показывает серии и паузы", async () => {
    expect((await command(3, "/pause", 6)).at(-1)).toContain("только для админов");
    expect((await command(ADMIN, "/pause до 15.11", 6)).at(-1)).toMatch(/Игрок6 на паузе до 15\.11/);
    const skips = (await command(4, "/skips")).at(-1)!;
    expect(skips).toContain("Пропуски подряд");
    expect(skips).toContain("На паузе");
    expect(skips).toContain("Игрок6 — до 15.11");
    expect((await command(ADMIN, "/unpause", 6)).at(-1)).toContain("снова в игре");
    expect((await command(ADMIN, "/unpause", 6)).at(-1)).toContain("не на паузе");
  });
});
