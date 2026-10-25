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
  score: Record<Team, number>;
}

export async function matchList(db: D1Database, chatId: number): Promise<MatchListItem[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.status, w.game_date,
              (SELECT count(*) FROM match_events e WHERE e.match_id = m.id AND e.cancelled_at IS NULL AND e.team = 'A') AS a,
              (SELECT count(*) FROM match_events e WHERE e.match_id = m.id AND e.cancelled_at IS NULL AND e.team = 'B') AS b
       FROM matches m JOIN weeks w ON w.id = m.week_id
       WHERE w.chat_id = ?1
       ORDER BY w.game_date DESC
       LIMIT 200`,
    )
    .bind(chatId)
    .all<{ id: number; status: "open" | "finished"; game_date: string; a: number; b: number }>();
  return results.map((r) => ({
    id: r.id,
    date: r.game_date,
    title: formatGameDate(r.game_date),
    status: r.status,
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
}

export async function playerMatches(db: D1Database, chatId: number, playerId: number): Promise<PlayerMatchRow[]> {
  const { results } = await db
    .prepare(
      `SELECT rc.*, w.game_date,
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
      own_goals: number; delta: number; after: number; a: number; b: number;
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
  }));
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
