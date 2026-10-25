import type { Team } from "./teams";

/**
 * Изменение рейтинга за матч = командная часть + личная часть.
 *
 * Командная часть (Эло): K · (результат − ожидание) · множитель разницы мячей
 *   ожидание   = 1 / (1 + 10^(−(среднее A − среднее B) · 5 / 8))  — при равных составах 0,5
 *   результат  = 1 победа / 0,5 ничья / 0 поражение
 *   множитель  = 1 + min(|разница мячей|, 5) / 5                    — от 1 до 2
 *   K          = 0,3; первые 5 игр игрока — 0,6
 *
 * Личная часть: 0,05 за гол + 0,04 за пас (не больше 0,25 за матч) − 0,03 за автогол,
 * затем из всех вычитается средняя личная часть по матчу — «общий котёл», чтобы рейтинги
 * не ползли вверх у всех сразу.
 *
 * Рейтинг держится в границах 1..10.
 */
export const RATING = {
  K: 0.3,
  K_NEWCOMER: 0.6,
  NEWCOMER_GAMES: 5,
  SCALE: 8, // разница сумм оценок 5×5, при которой фаворит выигрывает в ~10 раз чаще
  MARGIN_CAP: 5,
  GOAL: 0.05,
  ASSIST: 0.04,
  PERSONAL_CAP: 0.25,
  OWN_GOAL: 0.03,
  MIN: 1,
  MAX: 10,
};

export interface RatingInput {
  playerId: number;
  team: Team;
  skill: number;
  gamesBefore: number; // сколько завершённых матчей было до этого
  goals: number;
  assists: number;
  ownGoals: number;
}

export interface RatingResult extends RatingInput {
  result: "W" | "D" | "L";
  teamPart: number;
  personalPart: number;
  delta: number;
  before: number;
  after: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

export function expectedA(meanA: number, meanB: number): number {
  return 1 / (1 + Math.pow(10, (-(meanA - meanB) * 5) / RATING.SCALE));
}

export function computeRatingChanges(players: RatingInput[], score: Record<Team, number>): RatingResult[] {
  const skillsOf = (t: Team) => players.filter((p) => p.team === t).map((p) => p.skill);
  const eA = expectedA(mean(skillsOf("A")), mean(skillsOf("B")));
  const sA = score.A > score.B ? 1 : score.A < score.B ? 0 : 0.5;
  const margin = 1 + Math.min(Math.abs(score.A - score.B), RATING.MARGIN_CAP) / RATING.MARGIN_CAP;

  const rawPersonal = players.map(
    (p) => Math.min(RATING.PERSONAL_CAP, RATING.GOAL * p.goals + RATING.ASSIST * p.assists) - RATING.OWN_GOAL * p.ownGoals,
  );
  const pot = mean(rawPersonal);

  return players.map((p, i) => {
    const k = p.gamesBefore < RATING.NEWCOMER_GAMES ? RATING.K_NEWCOMER : RATING.K;
    const s = p.team === "A" ? sA : 1 - sA;
    const e = p.team === "A" ? eA : 1 - eA;
    const teamPart = k * (s - e) * margin;
    const personalPart = rawPersonal[i] - pot;
    const after = round2(Math.min(RATING.MAX, Math.max(RATING.MIN, p.skill + teamPart + personalPart)));
    return {
      ...p,
      result: s === 1 ? "W" : s === 0 ? "L" : "D",
      teamPart: round2(teamPart),
      personalPart: round2(personalPart),
      delta: round2(after - p.skill),
      before: p.skill,
      after,
    };
  });
}
