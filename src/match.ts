import { getRoster, playerName, type Player, type Week } from "./db";
import { balanceTeams, TEAM_NAMES, type Split, type Team } from "./teams";
import { esc } from "./render";
import { formatGameDate } from "./dates";

export interface Match {
  id: number;
  week_id: number;
  status: "open" | "finished";
  summary_message_id: number | null;
}

export interface MatchEvent {
  id: string;
  type: "goal" | "own_goal";
  team: Team;
  scorer_id: number | null;
  assist_id: number | null;
  created_by: number | null;
  created_at: string;
  cancelled_at: string | null;
}

export interface LineupPlayer {
  id: number;
  name: string;
  skill: number;
  team: Team;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---------- матчи ----------

export async function getMatchByWeek(db: D1Database, weekId: number): Promise<Match | null> {
  return db.prepare(`SELECT * FROM matches WHERE week_id = ?1`).bind(weekId).first<Match>();
}

export async function getMatch(db: D1Database, id: number): Promise<Match | null> {
  return db.prepare(`SELECT * FROM matches WHERE id = ?1`).bind(id).first<Match>();
}

export async function getLineup(db: D1Database, matchId: number): Promise<LineupPlayer[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*, mp.team FROM match_players mp JOIN players p ON p.id = mp.player_id
       WHERE mp.match_id = ?1`,
    )
    .bind(matchId)
    .all<Player & { team: Team; skill: number }>();
  return results
    .map((p) => ({ id: p.id, name: playerName(p), skill: p.skill, team: p.team }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

export async function getEvents(db: D1Database, matchId: number): Promise<MatchEvent[]> {
  const { results } = await db
    .prepare(`SELECT * FROM match_events WHERE match_id = ?1 ORDER BY created_at, id`)
    .bind(matchId)
    .all<MatchEvent>();
  return results;
}

/** Создаёт матч на неделю (или перезаписывает составы, пока не было голов). */
export async function saveTeams(db: D1Database, week: Week, split: Pick<Split, "A" | "B">): Promise<Match> {
  if (new Set([...split.A, ...split.B]).size !== split.A.length + split.B.length) {
    throw new HttpError(400, "Игрок не может быть в двух командах");
  }
  let match = await getMatchByWeek(db, week.id);
  if (!match) {
    match = await db
      .prepare(`INSERT INTO matches (week_id) VALUES (?1) ON CONFLICT (week_id) DO NOTHING RETURNING *`)
      .bind(week.id)
      .first<Match>();
    match ??= await getMatchByWeek(db, week.id);
  }
  if (!match) throw new HttpError(500, "Не удалось создать матч");
  if (match.status === "finished") throw new HttpError(409, "Матч уже завершён");

  const stmts = [db.prepare(`DELETE FROM match_players WHERE match_id = ?1`).bind(match.id)];
  for (const team of ["A", "B"] as const)
    for (const pid of split[team])
      stmts.push(
        db.prepare(`INSERT INTO match_players (match_id, player_id, team) VALUES (?1, ?2, ?3)`).bind(match.id, pid, team),
      );
  await db.batch(stmts);
  return match;
}

/** Делит основной состав недели по рейтингу и сохраняет. Нельзя, если уже забиты голы. */
export async function autoTeams(db: D1Database, week: Week, mode: "best" | "shuffle" = "best"): Promise<Split> {
  const existing = await getMatchByWeek(db, week.id);
  if (existing && (await hasGoals(db, existing.id))) {
    throw new HttpError(409, "Уже есть голы — составы можно менять только вручную");
  }
  const roster = await getRoster(db, week);
  if (roster.main.length < 2) throw new HttpError(400, "В основе меньше двух игроков");
  const { results } = await db.prepare(`SELECT id, skill FROM players`).all<{ id: number; skill: number }>();
  const skills = new Map(results.map((r) => [r.id, r.skill]));
  const split = balanceTeams(roster.main.map((e) => ({ id: e.playerId, skill: skills.get(e.playerId) ?? 5 })), mode);
  await saveTeams(db, week, split);
  return split;
}

export function renderLineups(week: Week, lineup: LineupPlayer[]): string {
  const lines = [`⚽ <b>Составы — ${esc(formatGameDate(week.game_date))}</b>`];
  for (const team of ["A", "B"] as const) {
    const ps = lineup.filter((p) => p.team === team);
    lines.push("", `<b>${TEAM_NAMES[team]}</b> (${ps.length})`, ...ps.map((p) => esc(p.name)));
  }
  lines.push("", "Поправить составы и вести счёт — в табло 👇");
  return lines.join("\n");
}

export async function hasGoals(db: D1Database, matchId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM match_events WHERE match_id = ?1 AND cancelled_at IS NULL LIMIT 1`)
    .bind(matchId)
    .first();
  return !!row;
}

// ---------- события ----------

export interface NewEvent {
  id: string;
  type: "goal" | "own_goal";
  scorerId: number;
  assistId?: number | null;
}

/** Проверяет событие по составам и сохраняет. Повтор того же id ничего не делает. */
export async function addEvent(db: D1Database, match: Match, e: NewEvent, createdBy: number): Promise<void> {
  if (match.status !== "open") throw new HttpError(409, "Матч завершён");
  if (!/^[\w-]{8,64}$/.test(e.id)) throw new HttpError(400, "Некорректный id события");

  const lineup = await getLineup(db, match.id);
  const teamOf = new Map(lineup.map((p) => [p.id, p.team]));
  const scorerTeam = teamOf.get(e.scorerId);
  if (!scorerTeam) throw new HttpError(400, "Автор гола не в составах");

  let team: Team;
  let assist: number | null = e.assistId ?? null;
  if (e.type === "goal") {
    team = scorerTeam;
    if (assist !== null && (assist === e.scorerId || teamOf.get(assist) !== scorerTeam)) {
      throw new HttpError(400, "Ассистент должен быть из команды автора гола");
    }
  } else if (e.type === "own_goal") {
    team = scorerTeam === "A" ? "B" : "A";
    assist = null;
  } else {
    throw new HttpError(400, "Неизвестный тип события");
  }

  await db
    .prepare(
      `INSERT INTO match_events (id, match_id, type, team, scorer_id, assist_id, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (id) DO NOTHING`,
    )
    .bind(e.id, match.id, e.type, team, e.scorerId, assist, createdBy)
    .run();
}

export async function cancelEvent(db: D1Database, match: Match, eventId: string): Promise<void> {
  if (match.status !== "open") throw new HttpError(409, "Матч завершён");
  await db
    .prepare(
      `UPDATE match_events SET cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?1 AND match_id = ?2 AND cancelled_at IS NULL`,
    )
    .bind(eventId, match.id)
    .run();
}

export async function setMatchStatus(db: D1Database, matchId: number, status: Match["status"]): Promise<void> {
  await db
    .prepare(
      `UPDATE matches SET status = ?2,
         finished_at = CASE WHEN ?2 = 'finished' THEN datetime('now') ELSE NULL END
       WHERE id = ?1`,
    )
    .bind(matchId, status)
    .run();
}

export async function setSummaryMessage(db: D1Database, matchId: number, messageId: number | null): Promise<void> {
  await db.prepare(`UPDATE matches SET summary_message_id = ?2 WHERE id = ?1`).bind(matchId, messageId).run();
}

// ---------- итоги ----------

export function score(events: MatchEvent[]): Record<Team, number> {
  const s = { A: 0, B: 0 };
  for (const e of events) if (!e.cancelled_at) s[e.team]++;
  return s;
}

export function renderSummary(week: Week, lineup: LineupPlayer[], events: MatchEvent[]): string {
  const live = events.filter((e) => !e.cancelled_at);
  const s = score(live);
  const name = new Map(lineup.map((p) => [p.id, p.name]));
  const stats = new Map<number, { g: number; a: number; og: number }>();
  const st = (id: number) => stats.get(id) ?? (stats.set(id, { g: 0, a: 0, og: 0 }), stats.get(id)!);
  for (const e of live) {
    if (e.scorer_id == null) continue;
    if (e.type === "own_goal") st(e.scorer_id).og++;
    else st(e.scorer_id).g++;
    if (e.assist_id != null) st(e.assist_id).a++;
  }

  const lines = [
    `🏁 <b>Итог — ${esc(formatGameDate(week.game_date))}</b>`,
    "",
    `<b>${TEAM_NAMES.A} ${s.A} : ${s.B} ${TEAM_NAMES.B.split(" ").reverse().join(" ")}</b>`,
  ];

  const scorers = [...stats.entries()]
    .filter(([, v]) => v.g || v.a)
    .sort(([, x], [, y]) => y.g + y.a - (x.g + x.a) || y.g - x.g);
  if (scorers.length) {
    lines.push("", "<b>Голы и пасы</b>");
    for (const [id, v] of scorers) {
      const parts = [v.g ? `${v.g} ⚽` : "", v.a ? `${v.a} 🅰️` : ""].filter(Boolean).join(" ");
      lines.push(`${esc(name.get(id) ?? "?")} — ${parts}`);
    }
  }
  const og = [...stats.entries()].filter(([, v]) => v.og);
  if (og.length) lines.push("", `Автоголы: ${og.map(([id, v]) => `${esc(name.get(id) ?? "?")}${v.og > 1 ? ` (${v.og})` : ""}`).join(", ")}`);

  for (const team of ["A", "B"] as const) {
    lines.push("", `${TEAM_NAMES[team]}: ${lineup.filter((p) => p.team === team).map((p) => esc(p.name)).join(", ")}`);
  }
  return lines.join("\n");
}
