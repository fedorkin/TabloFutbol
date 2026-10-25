import { Hono, type Context } from "hono";
import { Api } from "grammy";
import { readConfig, type Config, type Env } from "./env";
import {
  cleanName,
  getCurrentWeek,
  getRoster,
  playerName,
  setDisplayName,
  upsertTgPlayer,
  type Player,
  type TgUser,
  type Week,
} from "./db";
import { refreshWeekMessage } from "./service";
import { enforceAbsence } from "./absence";
import { editSkill, matchList, playerMatches, seasonStats, skillEdits } from "./stats";
import { localToday, formatGameDate } from "./dates";
import { validateInitData } from "./auth";
import { TEAM_NAMES } from "./teams";
import {
  addEvent,
  autoTeams,
  cancelEvent,
  getEvents,
  getLineup,
  getMatchByWeek,
  HttpError,
  renderSummary,
  saveTeams,
  score,
  finishMatch,
  eventNames,
  reopenMatch,
  setSummaryMessage,
  type Match,
} from "./match";

type Role = "admin" | "member" | "none";
type Vars = { user: TgUser; role: Role; cfg: Config; api: Api };
type C = Context<{ Bindings: Env; Variables: Vars }>;

// Статус в группе кэшируем на изолят, чтобы не дёргать Telegram на каждый поллинг.
const roleCache = new Map<number, { role: Role; until: number }>();

async function roleOf(api: Api, chatId: number, userId: number): Promise<Role> {
  const hit = roleCache.get(userId);
  if (hit && hit.until > Date.now()) return hit.role;
  let role: Role = "none";
  try {
    const m = await api.getChatMember(chatId, userId);
    if (m.status === "creator" || m.status === "administrator") role = "admin";
    else if (m.status === "member" || (m.status === "restricted" && m.is_member)) role = "member";
  } catch {
    role = "none";
  }
  roleCache.set(userId, { role, until: Date.now() + 5 * 60_000 });
  return role;
}

export function createApi(makeApi: (env: Env) => Api = (env) => new Api(env.BOT_TOKEN)) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    console.error("api error", err);
    return c.json({ error: "Внутренняя ошибка" }, 500);
  });

  app.use("*", async (c, next) => {
    const user = await validateInitData(c.req.header("X-Init-Data") ?? "", c.env.BOT_TOKEN);
    if (!user) return c.json({ error: "Откройте табло из Telegram" }, 401);
    const cfg = readConfig(c.env);
    const api = makeApi(c.env);
    const role = await roleOf(api, cfg.groupChatId, user.id);
    if (role === "none") return c.json({ error: "Табло доступно только участникам группы" }, 403);
    c.set("user", user);
    c.set("role", role);
    c.set("cfg", cfg);
    c.set("api", api);
    await next();
  });

  const requireAdmin = (c: C) => {
    if (c.var.role !== "admin") throw new HttpError(403, "Только для админов группы");
  };

  const currentWeek = async (c: C): Promise<Week> => {
    const week = await getCurrentWeek(c.env.DB, c.var.cfg.groupChatId, localToday(new Date(), c.var.cfg.timezone).date);
    if (!week) throw new HttpError(404, "Ближайшей игры нет — создайте запись командой /game");
    return week;
  };

  const currentMatch = async (c: C): Promise<Match> => {
    const match = await getMatchByWeek(c.env.DB, (await currentWeek(c)).id);
    if (!match) throw new HttpError(404, "Составы ещё не собраны");
    return match;
  };

  // ---------- состояние для экрана ----------

  app.get("/state", async (c) => {
    const db = c.env.DB;
    const isAdmin = c.var.role === "admin";
    const me = await ensurePlayer(db, c.var.user);
    const week = await getCurrentWeek(db, c.var.cfg.groupChatId, localToday(new Date(), c.var.cfg.timezone).date);
    const base = { me: { playerId: me.id, name: playerName(me), isAdmin }, teamNames: TEAM_NAMES };
    if (!week) return c.json({ ...base, game: null, roster: [], match: null });

    const roster = await getRoster(db, week);
    const skills = isAdmin ? await skillMap(db) : new Map<number, number>();
    const match = await getMatchByWeek(db, week.id);
    let matchDto = null;
    if (match) {
      const [lineup, events] = await Promise.all([getLineup(db, match.id), getEvents(db, match.id)]);
      matchDto = {
        id: match.id,
        status: match.status,
        players: lineup.map((p) => ({ id: p.id, name: p.name, team: p.team, ...(isAdmin ? { skill: p.skill } : {}) })),
        events: events.map((e) => ({
          id: e.id,
          type: e.type,
          team: e.team,
          scorerId: e.scorer_id,
          assistId: e.assist_id,
          createdAt: e.created_at,
          cancelled: !!e.cancelled_at,
        })),
        score: score(events),
        names: Object.fromEntries(await eventNames(db, events)),
      };
    }
    return c.json({
      ...base,
      game: { weekId: week.id, date: week.game_date, title: formatGameDate(week.game_date), time: c.var.cfg.gameTime },
      roster: roster.main.map((e) => ({ id: e.playerId, name: e.name, ...(isAdmin ? { skill: skills.get(e.playerId) ?? 5 } : {}) })),
      match: matchDto,
    });
  });

  // ---------- составы ----------

  app.post("/teams/auto", async (c) => {
    requireAdmin(c);
    const { mode } = await c.req.json<{ mode?: "best" | "shuffle" }>().catch(() => ({ mode: undefined }));
    const split = await autoTeams(c.env.DB, await currentWeek(c), mode === "shuffle" ? "shuffle" : "best");
    return c.json({ ok: true, diff: split.diff });
  });

  app.put("/teams", async (c) => {
    requireAdmin(c);
    const body = await c.req.json<{ A: number[]; B: number[] }>();
    if (!Array.isArray(body?.A) || !Array.isArray(body?.B)) throw new HttpError(400, "Ожидаются списки A и B");
    await saveTeams(c.env.DB, await currentWeek(c), { A: body.A.map(Number), B: body.B.map(Number) });
    return c.json({ ok: true });
  });

  // ---------- голы ----------

  app.post("/events", async (c) => {
    const body = await c.req.json<{ id: string; type: "goal" | "own_goal"; scorerId: number; assistId?: number | null }>();
    await addEvent(c.env.DB, await currentMatch(c), body, c.var.user.id);
    return c.json({ ok: true });
  });

  app.post("/events/:id/cancel", async (c) => {
    await cancelEvent(c.env.DB, await currentMatch(c), c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---------- завершение ----------

  app.post("/finish", async (c) => {
    requireAdmin(c);
    const week = await currentWeek(c);
    const match = await currentMatch(c);
    const ratings = await finishMatch(c.env.DB, match);
    // после «открыть снова» → «завершить» старый итог заменяем новым
    if (match.summary_message_id) await c.var.api.deleteMessage(week.chat_id, match.summary_message_id).catch(() => {});
    const [lineup, events] = await Promise.all([getLineup(c.env.DB, match.id), getEvents(c.env.DB, match.id)]);
    const names = await eventNames(c.env.DB, events);
    const msg = await c.var.api.sendMessage(week.chat_id, renderSummary(week, lineup, events, ratings, names), {
      parse_mode: "HTML",
    });
    await setSummaryMessage(c.env.DB, match.id, msg.message_id);
    // правило 10 пропусков подряд — после каждой завершённой игры
    const today = localToday(new Date(), c.var.cfg.timezone).date;
    await enforceAbsence(c.var.api, c.env.DB, week.chat_id, today).catch((e) => console.error("absence", e));
    return c.json({ ok: true });
  });

  app.post("/reopen", async (c) => {
    requireAdmin(c);
    await reopenMatch(c.env.DB, await currentMatch(c));
    return c.json({ ok: true });
  });

  // ---------- история и статистика ----------

  app.get("/history", async (c) => {
    const [matches, stats] = await Promise.all([
      matchList(c.env.DB, c.var.cfg.groupChatId),
      seasonStats(c.env.DB, c.var.cfg.groupChatId),
    ]);
    const isAdmin = c.var.role === "admin";
    return c.json({ matches, stats: stats.map(({ skill, ...s }) => (isAdmin ? { ...s, skill } : s)) });
  });

  app.get("/history/:id", async (c) => {
    const db = c.env.DB;
    const id = Number(c.req.param("id"));
    const row = await db
      .prepare(`SELECT m.*, w.game_date, w.chat_id FROM matches m JOIN weeks w ON w.id = m.week_id WHERE m.id = ?1`)
      .bind(id)
      .first<Match & { game_date: string; chat_id: number }>();
    if (!row || row.chat_id !== c.var.cfg.groupChatId) throw new HttpError(404, "Матч не найден");
    const isAdmin = c.var.role === "admin";
    const [lineup, events, ratings] = await Promise.all([
      getLineup(db, id),
      getEvents(db, id),
      db.prepare(`SELECT * FROM rating_changes WHERE match_id = ?1`).bind(id).all<{
        player_id: number; delta: number; before: number; after: number;
      }>(),
    ]);
    const names = await eventNames(db, events);
    return c.json({
      names: Object.fromEntries(names), // авторы голов, которых убрали из составов по ходу игры
      id,
      title: formatGameDate(row.game_date),
      status: row.status,
      score: score(events),
      players: lineup.map((p) => ({ id: p.id, name: p.name, team: p.team })),
      events: events
        .filter((e) => !e.cancelled_at)
        .map((e) => ({ id: e.id, type: e.type, team: e.team, scorerId: e.scorer_id, assistId: e.assist_id, createdAt: e.created_at })),
      ratings: ratings.results.map((r) => ({
        playerId: r.player_id,
        delta: r.delta,
        ...(isAdmin ? { before: r.before, after: r.after } : {}),
      })),
    });
  });

  app.get("/players/:id/history", async (c) => {
    const db = c.env.DB;
    const id = Number(c.req.param("id"));
    const player = await db.prepare(`SELECT * FROM players WHERE id = ?1`).bind(id).first<Player & { skill: number }>();
    if (!player) throw new HttpError(404, "Игрок не найден");
    const isAdmin = c.var.role === "admin";
    const rows = await playerMatches(db, c.var.cfg.groupChatId, id);
    return c.json({
      id,
      name: playerName(player),
      ...(isAdmin ? { skill: player.skill } : {}),
      matches: rows.map(({ after, at, ...r }) => (isAdmin ? { ...r, after, at } : r)),
      ...(isAdmin ? { edits: await skillEdits(db, id) } : {}),
    });
  });

  // ---------- рейтинги ----------

  app.get("/players", async (c) => {
    requireAdmin(c);
    const { results } = await c.env.DB.prepare(`SELECT * FROM players`).all<Player & { skill: number }>();
    return c.json({
      players: results
        .map((p) => ({
          id: p.id,
          name: playerName(p),
          skill: p.skill,
          guest: p.tg_id == null,
          // как игрок подписан в Telegram — чтобы понять, кто это, при переименовании
          tgName: p.tg_id == null ? null : [p.first_name, p.last_name].filter(Boolean).join(" "),
          username: p.username,
          renamed: p.tg_id != null && !!p.display_name,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, "ru")),
    });
  });

  app.put("/players/:id/name", async (c) => {
    requireAdmin(c);
    const { name } = await c.req.json<{ name: string | null }>();
    const id = Number(c.req.param("id"));
    const player = await c.env.DB.prepare(`SELECT * FROM players WHERE id = ?1`).bind(id).first<Player>();
    if (!player) throw new HttpError(404, "Игрок не найден");
    const clean = cleanName(String(name ?? ""));
    // у гостя нет имени из Telegram — сбросить нельзя
    if (!clean && player.tg_id == null) throw new HttpError(400, "Введите имя");
    await setDisplayName(c.env.DB, id, clean);
    await refreshCurrentPost(c);
    return c.json({ ok: true, name: clean ?? playerName({ ...player, display_name: null }) });
  });

  /** Пост записи в группе показывает имена — перерисовываем после переименования. */
  const refreshCurrentPost = async (c: C) => {
    const week = await getCurrentWeek(c.env.DB, c.var.cfg.groupChatId, localToday(new Date(), c.var.cfg.timezone).date);
    if (week) await refreshWeekMessage(c.var.api, c.env.DB, week, c.var.cfg).catch(() => {});
  };

  app.put("/players/:id/skill", async (c) => {
    requireAdmin(c);
    const body = await c.req.json<{ skill: number | string }>();
    const skill = Math.round(Number(String(body?.skill ?? "").replace(",", ".")) * 100) / 100;
    if (!(skill >= 1 && skill <= 10)) throw new HttpError(400, "Оценка от 1 до 10");
    const u = c.var.user;
    await editSkill(c.env.DB, Number(c.req.param("id")), skill, {
      id: u.id,
      name: [u.first_name, u.last_name].filter(Boolean).join(" "),
    });
    return c.json({ ok: true, skill });
  });

  return app;
}

/** Без записи в БД, если игрок уже есть и имя не менялось (state опрашивается каждые пару секунд). */
async function ensurePlayer(db: D1Database, u: TgUser): Promise<Player> {
  const p = await db.prepare(`SELECT * FROM players WHERE tg_id = ?1`).bind(u.id).first<Player>();
  if (p && p.first_name === u.first_name && p.last_name === (u.last_name ?? null) && p.username === (u.username ?? null)) return p;
  return upsertTgPlayer(db, u);
}

async function skillMap(db: D1Database): Promise<Map<number, number>> {
  const { results } = await db.prepare(`SELECT id, skill FROM players`).all<{ id: number; skill: number }>();
  return new Map(results.map((r) => [r.id, r.skill]));
}

/** Сбросить кэш ролей (для тестов). */
export function resetRoleCache() {
  roleCache.clear();
}
