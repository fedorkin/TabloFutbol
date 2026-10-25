import type { Api } from "grammy";
import { playerName, type Player } from "./db";
import { addDays } from "./dates";
import { mention } from "./render";

/**
 * Правило пропусков: «пропуск» — состоявшаяся (завершённая) игра, в которой человек не играл.
 * Считаются только игры с момента, когда бот узнал игрока, и не попавшие на его паузу.
 * SKIP_LIMIT подряд — удаление из группы (без бана), с SKIP_WARN — «зона риска» в посте записи.
 */
export const SKIP_LIMIT = 10;
export const SKIP_WARN = 7;

export interface AbsenceEntry {
  playerId: number;
  tgId: number;
  name: string;
  streak: number;
  paused: boolean;
}

// Админов группы не трогаем (Telegram и не даст их удалить). Кэш на изолят.
const adminsCache = new Map<number, { ids: Set<number>; until: number }>();

export async function groupAdmins(api: Api, chatId: number): Promise<Set<number>> {
  const hit = adminsCache.get(chatId);
  if (hit && hit.until > Date.now()) return hit.ids;
  let ids = new Set<number>();
  try {
    ids = new Set((await api.getChatAdministrators(chatId)).map((m) => m.user.id));
  } catch {
    // без списка админов просто никого не исключаем
  }
  adminsCache.set(chatId, { ids, until: Date.now() + 10 * 60_000 });
  return ids;
}

export function resetAdminsCache() {
  adminsCache.clear();
}

/** Серии пропусков для всех игроков группы (с Telegram, не выбывших). */
export async function absenceStreaks(db: D1Database, chatId: number, today: string): Promise<AbsenceEntry[]> {
  const [matches, played, players, pauses] = await Promise.all([
    db
      .prepare(
        `SELECT m.id, w.game_date FROM matches m JOIN weeks w ON w.id = m.week_id
         WHERE w.chat_id = ?1 AND m.status = 'finished' ORDER BY w.game_date DESC`,
      )
      .bind(chatId)
      .all<{ id: number; game_date: string }>(),
    db.prepare(`SELECT match_id, player_id FROM rating_changes`).all<{ match_id: number; player_id: number }>(),
    db.prepare(`SELECT * FROM players WHERE tg_id IS NOT NULL AND removed_at IS NULL`).all<Player & { created_at: string }>(),
    db.prepare(`SELECT * FROM player_pauses`).all<{ player_id: number; from_date: string; to_date: string | null }>(),
  ]);

  const playedSet = new Set(played.results.map((r) => `${r.match_id}:${r.player_id}`));
  const pausesBy = new Map<number, { from: string; to: string }[]>();
  for (const p of pauses.results) {
    const list = pausesBy.get(p.player_id) ?? [];
    list.push({ from: p.from_date, to: p.to_date ?? "9999-12-31" });
    pausesBy.set(p.player_id, list);
  }
  const inPause = (pid: number, date: string) => (pausesBy.get(pid) ?? []).some((p) => date >= p.from && date <= p.to);

  return players.results.map((p) => {
    const knownSince = ((p as Player & { active_since?: string | null }).active_since ?? p.created_at).slice(0, 10);
    let streak = 0;
    for (const m of matches.results) {
      if (m.game_date <= knownSince) break; // игры до знакомства (и в тот же день) не считаем
      if (inPause(p.id, m.game_date)) continue; // на паузе — игра не в счёт
      if (playedSet.has(`${m.id}:${p.id}`)) break;
      streak++;
    }
    return { playerId: p.id, tgId: p.tg_id!, name: playerName(p), streak, paused: inPause(p.id, today) };
  });
}

/** «Зона риска» для поста записи: SKIP_WARN..SKIP_LIMIT−1 пропусков, без админов и тех, кто на паузе. */
export async function riskList(api: Api, db: D1Database, chatId: number, today: string): Promise<AbsenceEntry[]> {
  const admins = await groupAdmins(api, chatId);
  return (await absenceStreaks(db, chatId, today))
    .filter((e) => e.streak >= SKIP_WARN && e.streak < SKIP_LIMIT && !e.paused && !admins.has(e.tgId))
    .sort((a, b) => b.streak - a.streak);
}

export function renderRisk(list: AbsenceEntry[]): string {
  if (!list.length) return "";
  return [
    "",
    `⚠️ <b>Давно не играли</b> — после ${SKIP_LIMIT} пропусков подряд бот удаляет из группы:`,
    ...list.map((e) => `${mention(e)} — ${e.streak} ${plural(e.streak)} подряд, осталось ${SKIP_LIMIT - e.streak}`),
  ].join("\n");
}

function plural(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "пропуск";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "пропуска";
  return "пропусков";
}

/** Вступил (или вернулся) в группу: пропуски считаем заново с сегодняшнего дня. */
export async function markJoined(db: D1Database, playerId: number): Promise<void> {
  await db
    .prepare(`UPDATE players SET removed_at = NULL, active_since = datetime('now') WHERE id = ?1 AND removed_at IS NOT NULL`)
    .bind(playerId)
    .run();
}

export async function markRemoved(db: D1Database, playerId: number): Promise<void> {
  await db.prepare(`UPDATE players SET removed_at = datetime('now') WHERE id = ?1`).bind(playerId).run();
}

/**
 * После завершения матча: удаляет из группы всех с SKIP_LIMIT+ пропусками подряд (кроме админов и тех,
 * кто на паузе) и сообщает об этом в группе. Удаление = бан + сразу разбан: по ссылке можно вернуться.
 */
export async function enforceAbsence(api: Api, db: D1Database, chatId: number, today: string): Promise<string[]> {
  const admins = await groupAdmins(api, chatId);
  const out = (await absenceStreaks(db, chatId, today)).filter(
    (e) => e.streak >= SKIP_LIMIT && !e.paused && !admins.has(e.tgId),
  );
  const removed: string[] = [];
  const failed: string[] = [];
  for (const e of out) {
    try {
      await api.banChatMember(chatId, e.tgId);
      await api.unbanChatMember(chatId, e.tgId, { only_if_banned: true });
      await markRemoved(db, e.playerId);
      removed.push(mention(e));
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      // уже не в группе — просто помечаем
      if (/not a member|user not found|PARTICIPANT_ID_INVALID|USER_NOT_PARTICIPANT/i.test(msg)) {
        await markRemoved(db, e.playerId);
      } else {
        failed.push(mention(e));
      }
    }
  }
  if (removed.length) {
    await api.sendMessage(
      chatId,
      `👋 ${removed.join(", ")} — ${SKIP_LIMIT} игр подряд без участия, удалены из группы. Вернуться можно по ссылке-приглашению.`,
      { parse_mode: "HTML" },
    );
  }
  if (failed.length) {
    await api.sendMessage(
      chatId,
      `Не получилось удалить: ${failed.join(", ")}. Дайте боту право «Блокировка участников» в настройках группы.`,
      { parse_mode: "HTML" },
    );
  }
  return removed;
}

/** Пауза с сегодняшнего дня; повторная пауза ничего не делает. */
export async function startPause(db: D1Database, playerId: number, today: string, by: number, until?: string) {
  const open = await db
    .prepare(`SELECT id FROM player_pauses WHERE player_id = ?1 AND (to_date IS NULL OR to_date >= ?2)`)
    .bind(playerId, today)
    .first<{ id: number }>();
  if (open) {
    await db.prepare(`UPDATE player_pauses SET to_date = ?2 WHERE id = ?1`).bind(open.id, until ?? null).run();
    return;
  }
  await db
    .prepare(`INSERT INTO player_pauses (player_id, from_date, to_date, created_by) VALUES (?1, ?2, ?3, ?4)`)
    .bind(playerId, today, until ?? null, by)
    .run();
}

/** Снять паузу: она действовала до вчерашнего дня включительно. */
export async function endPause(db: D1Database, playerId: number, today: string): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE player_pauses SET to_date = ?2 WHERE player_id = ?1 AND (to_date IS NULL OR to_date >= ?3)`)
    .bind(playerId, addDays(today, -1), today)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function activePauses(db: D1Database, today: string): Promise<{ name: string; to: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*, pp.to_date FROM player_pauses pp JOIN players p ON p.id = pp.player_id
       WHERE pp.from_date <= ?1 AND (pp.to_date IS NULL OR pp.to_date >= ?1)`,
    )
    .bind(today)
    .all<Player & { to_date: string | null }>();
  return results.map((r) => ({ name: playerName(r), to: r.to_date }));
}
