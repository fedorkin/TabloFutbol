import { playerName, type Player } from "./db";
import { formatGameDate } from "./dates";
import { esc } from "./render";
import type { Team } from "./teams";

export interface PlayerSeason {
  id: number;
  name: string;
  skill: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  goals: number;
  assists: number;
  ownGoals: number;
}

/** Статистика по завершённым матчам группы (источник — rating_changes). */
export async function seasonStats(db: D1Database, chatId: number): Promise<PlayerSeason[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*, count(*) AS games,
              sum(rc.result = 'W') AS wins, sum(rc.result = 'D') AS draws, sum(rc.result = 'L') AS losses,
              sum(rc.goals) AS goals, sum(rc.assists) AS assists, sum(rc.own_goals) AS own_goals
       FROM rating_changes rc
       JOIN matches m ON m.id = rc.match_id
       JOIN weeks w ON w.id = m.week_id
       JOIN players p ON p.id = rc.player_id
       WHERE w.chat_id = ?1
       GROUP BY p.id`,
    )
    .bind(chatId)
    .all<Player & { skill: number; games: number; wins: number; draws: number; losses: number; goals: number; assists: number; own_goals: number }>();
  return results
    .map((r) => ({
      id: r.id,
      name: playerName(r),
      skill: r.skill,
      games: r.games,
      wins: r.wins,
      draws: r.draws,
      losses: r.losses,
      goals: r.goals,
      assists: r.assists,
      ownGoals: r.own_goals,
    }))
    .sort((a, b) => b.goals + b.assists - (a.goals + a.assists) || b.goals - a.goals || b.wins - a.wins || a.name.localeCompare(b.name, "ru"));
}

export interface MatchListItem {
  id: number;
  date: string;
  title: string;
  status: "open" | "finished";
  started: boolean;
  score: Record<Team, number>;
}

export async function matchList(db: D1Database, chatId: number): Promise<MatchListItem[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.status, m.started_at, w.game_date,
              (SELECT count(*) FROM match_events e WHERE e.match_id = m.id AND e.cancelled_at IS NULL AND e.team = 'A') AS a,
              (SELECT count(*) FROM match_events e WHERE e.match_id = m.id AND e.cancelled_at IS NULL AND e.team = 'B') AS b
       FROM matches m JOIN weeks w ON w.id = m.week_id
       WHERE w.chat_id = ?1
       ORDER BY w.game_date DESC
       LIMIT 200`,
    )
    .bind(chatId)
    .all<{ id: number; status: "open" | "finished"; started_at: string | null; game_date: string; a: number; b: number }>();
  return results.map((r) => ({
    id: r.id,
    date: r.game_date,
    title: formatGameDate(r.game_date),
    status: r.status,
    started: !!r.started_at,
    score: { A: r.a, B: r.b },
  }));
}

export interface PlayerMatchRow {
  matchId: number;
  date: string;
  title: string;
  team: Team;
  result: "W" | "D" | "L";
  score: Record<Team, number>;
  goals: number;
  assists: number;
  ownGoals: number;
  delta: number;
  after: number;
  at: string; // когда завершён матч (ISO, UTC) — для порядка с ручными правками
}

export async function playerMatches(db: D1Database, chatId: number, playerId: number): Promise<PlayerMatchRow[]> {
  const { results } = await db
    .prepare(
      `SELECT rc.*, w.game_date, coalesce(m.finished_at, w.game_date) AS finished_at,
              (SELECT count(*) FROM match_events e WHERE e.match_id = rc.match_id AND e.cancelled_at IS NULL AND e.team = 'A') AS a,
              (SELECT count(*) FROM match_events e WHERE e.match_id = rc.match_id AND e.cancelled_at IS NULL AND e.team = 'B') AS b
       FROM rating_changes rc
       JOIN matches m ON m.id = rc.match_id
       JOIN weeks w ON w.id = m.week_id
       WHERE w.chat_id = ?1 AND rc.player_id = ?2
       ORDER BY w.game_date DESC`,
    )
    .bind(chatId, playerId)
    .all<{
      match_id: number; game_date: string; team: Team; result: "W" | "D" | "L"; goals: number; assists: number;
      own_goals: number; delta: number; after: number; a: number; b: number; finished_at: string;
    }>();
  return results.map((r) => ({
    matchId: r.match_id,
    date: r.game_date,
    title: formatGameDate(r.game_date),
    team: r.team,
    result: r.result,
    score: { A: r.a, B: r.b },
    goals: r.goals,
    assists: r.assists,
    ownGoals: r.own_goals,
    delta: r.delta,
    after: r.after,
    // старый формат «YYYY-MM-DD HH:MM:SS» (UTC) → ISO
    at: r.finished_at.includes("T") ? r.finished_at : r.finished_at.length > 10 ? r.finished_at.replace(" ", "T") + "Z" : r.finished_at,
  }));
}

export interface SkillEdit {
  at: string;
  before: number;
  after: number;
  by: string;
}

export async function skillEdits(db: D1Database, playerId: number): Promise<SkillEdit[]> {
  const { results } = await db
    .prepare(`SELECT * FROM skill_edits WHERE player_id = ?1 ORDER BY created_at DESC`)
    .bind(playerId)
    .all<{ before: number; after: number; admin_name: string; updated_at: string }>();
  return results.map((r) => ({ at: r.updated_at, before: r.before, after: r.after, by: r.admin_name }));
}

/**
 * Ручная правка оценки. Серия правок одного админа за 3 минуты — одна запись в журнале
 * (иначе кнопки −/+ насыпали бы десяток строк). Вернули как было — запись удаляется.
 */
export async function editSkill(
  db: D1Database,
  playerId: number,
  skill: number,
  admin: { id: number; name: string },
): Promise<void> {
  const current = await db.prepare(`SELECT skill FROM players WHERE id = ?1`).bind(playerId).first<{ skill: number }>();
  if (!current) return;
  const last = await db
    .prepare(
      `SELECT * FROM skill_edits WHERE player_id = ?1 AND admin_tg_id = ?2
         AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 minutes')
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(playerId, admin.id)
    .first<{ id: number; before: number }>();
  // матч, завершённый после начала серии, разрывает её — иначе в журнале смешается правка и пересчёт
  const matchSince = last
    ? await db
        .prepare(
          `SELECT 1 AS x FROM rating_changes rc JOIN matches m ON m.id = rc.match_id
           WHERE rc.player_id = ?1 AND m.finished_at > (SELECT created_at FROM skill_edits WHERE id = ?2)`,
        )
        .bind(playerId, last.id)
        .first()
    : null;

  const stmts = [db.prepare(`UPDATE players SET skill = ?2 WHERE id = ?1`).bind(playerId, skill)];
  if (last && !matchSince) {
    stmts.push(
      Math.abs(last.before - skill) < 0.001
        ? db.prepare(`DELETE FROM skill_edits WHERE id = ?1`).bind(last.id)
        : db
            .prepare(`UPDATE skill_edits SET after = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1`)
            .bind(last.id, skill),
    );
  } else if (Math.abs(current.skill - skill) >= 0.001) {
    stmts.push(
      db
        .prepare(`INSERT INTO skill_edits (player_id, before, after, admin_tg_id, admin_name) VALUES (?1, ?2, ?3, ?4, ?5)`)
        .bind(playerId, current.skill, skill, admin.id, admin.name),
    );
  }
  await db.batch(stmts);
}

export function renderStats(stats: PlayerSeason[], matches: number): string {
  if (!stats.length) return "Статистика появится после первого завершённого матча.";
  const top = stats.slice(0, 10);
  const lines = [`📊 <b>Статистика</b> — матчей: ${matches}`, ""];
  top.forEach((p, i) => {
    const wr = p.games ? Math.round((100 * p.wins) / p.games) : 0;
    lines.push(
      `${i + 1}. ${esc(p.name)} — ${p.goals} ⚽ ${p.assists} 🅰️ · ${p.games} игр, ${p.wins}-${p.draws}-${p.losses} (${wr}%)`,
    );
  });
  lines.push("", "Подробнее — в табло, вкладка «История».");
  return lines.join("\n");
}
