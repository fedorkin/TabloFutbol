export type Team = "A" | "B";

export const TEAM_NAMES: Record<Team, string> = { A: "🟢 Зелёные", B: "🟠 Оранжевые" };

export interface SkilledPlayer {
  id: number;
  skill: number;
}

export interface Split {
  A: number[];
  B: number[];
  diff: number; // |сумма A − сумма B|
}

const sum = (xs: SkilledPlayer[]) => xs.reduce((s, p) => s + p.skill, 0);

/** Все разбиения на две команды (размеры отличаются максимум на 1), по возрастанию разницы. */
function allSplits(players: SkilledPlayer[]): Split[] {
  const n = players.length;
  const k = Math.floor(n / 2);
  const total = sum(players);
  const out: Split[] = [];
  for (let mask = 0; mask < 1 << n; mask++) {
    // при чётном n разбиения A/B симметричны — фиксируем игрока 0 в A
    if (n % 2 === 0 && !(mask & 1)) continue;
    let bits = 0;
    let sA = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) (bits++, (sA += players[i].skill));
    if (bits !== k && bits !== n - k) continue;
    if (n % 2 === 1 && bits !== k) continue; // нечётное: в A всегда меньшая половина
    const A: number[] = [];
    const B: number[] = [];
    for (let i = 0; i < n; i++) (mask & (1 << i) ? A : B).push(players[i].id);
    out.push({ A, B, diff: Math.abs(total - 2 * sA) });
  }
  return out.sort((a, b) => a.diff - b.diff);
}

/** Для больших составов: «змейка» по убыванию + жадные обмены. */
function greedySplit(players: SkilledPlayer[], rnd: () => number): Split {
  const sorted = [...players].sort((a, b) => b.skill - a.skill || rnd() - 0.5);
  const A: SkilledPlayer[] = [];
  const B: SkilledPlayer[] = [];
  sorted.forEach((p, i) => ((i % 4 === 0 || i % 4 === 3) ? A : B).push(p));
  let improved = true;
  while (improved) {
    improved = false;
    const d = sum(A) - sum(B);
    for (let i = 0; i < A.length && !improved; i++)
      for (let j = 0; j < B.length && !improved; j++) {
        const nd = d - 2 * (A[i].skill - B[j].skill);
        if (Math.abs(nd) < Math.abs(d)) ([A[i], B[j]] = [B[j], A[i]], (improved = true));
      }
  }
  return { A: A.map((p) => p.id), B: B.map((p) => p.id), diff: Math.abs(sum(A) - sum(B)) };
}

/**
 * best — самое ровное разбиение (случайное среди равных);
 * shuffle — случайное среди почти лучших (разница не больше лучшей + 1), чтобы составы не повторялись.
 */
export function balanceTeams(
  players: SkilledPlayer[],
  mode: "best" | "shuffle" = "best",
  rnd: () => number = Math.random,
): Split {
  if (players.length < 2) return { A: players.map((p) => p.id), B: [], diff: sum(players) };
  if (players.length > 16) return greedySplit(players, rnd);

  const splits = allSplits(players);
  const limit = splits[0].diff + (mode === "shuffle" ? 1 : 0);
  const pool = splits.filter((s) => s.diff <= limit + 1e-9).slice(0, mode === "shuffle" ? 40 : 1000);
  const pick = pool[Math.floor(rnd() * pool.length)];
  // случайно меняем цвета, чтобы «Зелёные» не были всегда с одним и тем же игроком
  return rnd() < 0.5 ? pick : { A: pick.B, B: pick.A, diff: pick.diff };
}
