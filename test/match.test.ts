import { getPlatformProxy } from "wrangler";
import { Api, type Transformer } from "grammy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApi, resetRoleCache } from "../src/api";
import { signInitData, validateInitData } from "../src/auth";
import { balanceTeams } from "../src/teams";
import { getOrCreateWeek, setResponse, upsertTgPlayer } from "../src/db";
import type { Env } from "../src/env";
import { applyMigrations } from "./db";

const GROUP = -1002;
const ADMIN = 1;
const OUTSIDER = 99;
const TOKEN = "test-token";

// ---------- фейковый Telegram ----------
type Call = { method: string; payload: any };
let calls: Call[] = [];
const fakeTelegram: Transformer = async (_prev, method, payload: any) => {
  calls.push({ method, payload });
  if (method === "getChatMember") {
    const status = payload.user_id === ADMIN ? "administrator" : payload.user_id === OUTSIDER ? "left" : "member";
    return { ok: true, result: { status, user: { id: payload.user_id } } } as any;
  }
  if (method === "sendMessage") return { ok: true, result: { message_id: 500 + calls.length, date: 0, chat: { id: payload.chat_id } } } as any;
  return { ok: true, result: true } as any;
};
const fakeApi = new Api(TOKEN);
fakeApi.config.use(fakeTelegram);

// ---------- окружение ----------
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let env: Env;
const app = createApi(() => fakeApi);
const auth = new Map<number, string>();

async function req(userId: number, method: string, path: string, body?: unknown) {
  const res = await app.request(
    path,
    {
      method,
      headers: { "X-Init-Data": auth.get(userId) ?? "", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
  return { status: res.status, json: (await res.json()) as any };
}
const state = async (u = ADMIN) => (await req(u, "GET", "/state")).json;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T15:00:00Z")); // четверг, день игры
  proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: false });
  await applyMigrations(proxy.env.DB);
  env = {
    DB: proxy.env.DB, BOT_TOKEN: TOKEN, WEBHOOK_SECRET: "s", GROUP_CHAT_ID: String(GROUP),
    TIMEZONE: "Asia/Nicosia", PLAYER_LIMIT: "10", GAME_WEEKDAY: "4", GAME_TIME: "18:30", GAME_PLACE: "",
  };
  resetRoleCache();
  const now = Math.floor(Date.now() / 1000);
  for (const id of [...Array.from({ length: 11 }, (_, i) => i + 1), OUTSIDER]) {
    auth.set(id, await signInitData({ auth_date: String(now), query_id: "q", user: JSON.stringify({ id, first_name: `Игрок${id}` }) }, TOKEN));
  }
  // запись: 10 игроков в основе
  const week = await getOrCreateWeek(env.DB, GROUP, "2026-10-29", 10);
  for (let id = 1; id <= 10; id++) {
    const p = await upsertTgPlayer(env.DB, { id, first_name: `Игрок${id}` });
    await setResponse(env.DB, week, p.id, "in");
  }
});

afterAll(async () => {
  vi.useRealTimers();
  await proxy?.dispose();
});

describe("initData", () => {
  it("проверяется подпись и срок", async () => {
    const good = auth.get(ADMIN)!;
    expect((await validateInitData(good, TOKEN))?.id).toBe(ADMIN);
    expect(await validateInitData(good, "other-token")).toBeNull();
    expect(await validateInitData(good.replace("%D0%98", "%D0%90"), TOKEN)).toBeNull(); // подменили имя
    expect(await validateInitData(good, TOKEN, 60, Date.now() + 120_000)).toBeNull(); // протух
  });

  it("без подписи — 401, не участник группы — 403", async () => {
    expect((await req(12345, "GET", "/state")).status).toBe(401);
    expect((await req(OUTSIDER, "GET", "/state")).status).toBe(403);
  });
});

describe("деление на команды", () => {
  it("находит самое ровное разбиение", () => {
    const players = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((skill, i) => ({ id: i + 1, skill }));
    const s = balanceTeams(players, "best", () => 0.3);
    expect(s.A).toHaveLength(5);
    expect(s.B).toHaveLength(5);
    expect(s.diff).toBe(1); // сумма 55 — ровнее 27/28 не бывает
  });

  it("нечётный состав и большой состав", () => {
    const odd = balanceTeams([5, 5, 5, 5, 5, 5, 5].map((skill, i) => ({ id: i, skill })));
    expect([odd.A.length, odd.B.length].sort()).toEqual([3, 4]);
    const big = balanceTeams(Array.from({ length: 20 }, (_, i) => ({ id: i, skill: (i % 10) + 1 })));
    expect(big.A.length + big.B.length).toBe(20);
    expect(big.diff).toBeLessThanOrEqual(1);
  });
});

describe("матч через API", () => {
  let A: number[] = [];
  let B: number[] = [];

  it("рейтинги видит и меняет только админ", async () => {
    expect((await req(2, "GET", "/players")).status).toBe(403);
    const { json } = await req(ADMIN, "GET", "/players");
    expect(json.players).toHaveLength(10);
    const ids = json.players.map((p: any) => p.id);
    for (const [i, id] of ids.entries()) {
      expect((await req(ADMIN, "PUT", `/players/${id}/skill`, { skill: (i % 10) + 1 })).status).toBe(200);
    }
    expect((await req(ADMIN, "PUT", `/players/${ids[0]}/skill`, { skill: 11 })).status).toBe(400);
    expect((await state(2)).roster[0].skill).toBeUndefined(); // игроки не видят оценок
  });

  it("админ переименовывает игрока, сброс возвращает имя из Telegram", async () => {
    const { json } = await req(ADMIN, "GET", "/players");
    const p3 = json.players.find((p: any) => p.name === "Игрок3");
    expect((await req(2, "PUT", `/players/${p3.id}/name`, { name: "Вася" })).status).toBe(403);
    const r = await req(ADMIN, "PUT", `/players/${p3.id}/name`, { name: "  Вася   Пупкин \n" });
    expect(r.json.name).toBe("Вася Пупкин");
    const after = (await req(ADMIN, "GET", "/players")).json.players.find((p: any) => p.id === p3.id);
    expect(after).toMatchObject({ name: "Вася Пупкин", tgName: "Игрок3", renamed: true });
    expect((await state()).roster.find((p: any) => p.id === p3.id).name).toBe("Вася Пупкин");
    // новый вход из Telegram не затирает заданное имя
    await req(3, "GET", "/state");
    expect((await state()).roster.find((p: any) => p.id === p3.id).name).toBe("Вася Пупкин");
    expect((await req(ADMIN, "PUT", `/players/${p3.id}/name`, { name: null })).json.name).toBe("Игрок3");
  });

  it("админ собирает команды 5×5 с минимальной разницей", async () => {
    expect((await req(2, "POST", "/teams/auto", { mode: "best" })).status).toBe(403);
    const r = await req(ADMIN, "POST", "/teams/auto", { mode: "best" });
    expect(r.status).toBe(200);
    expect(r.json.diff).toBe(1);
    const m = (await state()).match;
    A = m.players.filter((p: any) => p.team === "A").map((p: any) => p.id);
    B = m.players.filter((p: any) => p.team === "B").map((p: any) => p.id);
    expect([A.length, B.length]).toEqual([5, 5]);
  });

  it("голы, пас, идемпотентность, автогол, отмена", async () => {
    const goal = { id: "goal-0001", type: "goal", scorerId: A[0], assistId: A[1] };
    expect((await req(2, "POST", "/events", goal)).status).toBe(200);
    expect((await req(3, "POST", "/events", goal)).status).toBe(200); // повтор с другого телефона
    expect((await state()).match.score).toEqual({ A: 1, B: 0 });

    const bad = await req(2, "POST", "/events", { id: "goal-0002", type: "goal", scorerId: A[0], assistId: B[0] });
    expect(bad.status).toBe(400);

    await req(2, "POST", "/events", { id: "own-00001", type: "own_goal", scorerId: B[0] });
    await req(2, "POST", "/events", { id: "goal-0003", type: "goal", scorerId: B[1], assistId: null });
    expect((await state()).match.score).toEqual({ A: 2, B: 1 });

    await req(2, "POST", "/events/goal-0003/cancel");
    const s = await state();
    expect(s.match.score).toEqual({ A: 2, B: 0 });
    expect(s.match.events.find((e: any) => e.id === "goal-0003").cancelled).toBe(true);
  });

  it("после голов автодележка запрещена, ручная правка — можно", async () => {
    expect((await req(ADMIN, "POST", "/teams/auto", { mode: "shuffle" })).status).toBe(409);
    const moved = { A: A.slice(1), B: [...B, A[0]] };
    expect((await req(ADMIN, "PUT", "/teams", moved)).status).toBe(200);
    expect((await req(ADMIN, "PUT", "/teams", { A: [A[1]], B: [A[1]] })).status).toBe(400);
    // счёт не меняется: гол засчитан команде на момент гола
    expect((await state()).match.score).toEqual({ A: 2, B: 0 });
  });

  it("завершение отправляет итог в группу и закрывает матч", async () => {
    calls = [];
    expect((await req(2, "POST", "/finish")).status).toBe(403);
    expect((await req(ADMIN, "POST", "/finish")).status).toBe(200);
    const msg = calls.find((c) => c.method === "sendMessage")!.payload;
    expect(msg.chat_id).toBe(GROUP);
    expect(msg.text).toContain("Итог — четверг, 29 октября");
    expect(msg.text).toContain("🔵 Синие 2 : 0 Оранжевые 🟠");
    expect(msg.text).toContain(`Игрок${A[0]} — 1 ⚽`);
    expect(msg.text).toContain("Автоголы:");
    expect((await state()).match.status).toBe("finished");
    expect((await req(2, "POST", "/events", { id: "late-0001", type: "goal", scorerId: B[1] })).status).toBe(409);

    expect((await req(ADMIN, "POST", "/reopen")).status).toBe(200);
    expect((await state()).match.status).toBe("open");
    calls = [];
    await req(ADMIN, "POST", "/finish");
    expect(calls.map((c) => c.method)).toEqual(expect.arrayContaining(["deleteMessage", "sendMessage"])); // старый итог заменён
  });
});
