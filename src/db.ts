export interface Player {
  id: number;
  tg_id: number | null;
  first_name: string;
  last_name: string | null;
  username: string | null;
  display_name: string | null;
}

export interface Week {
  id: number;
  chat_id: number;
  game_date: string;
  player_limit: number;
  status: "open" | "closed";
  message_id: number | null;
}

export interface RosterEntry {
  playerId: number;
  tgId: number | null;
  name: string;
  /** Сквозной номер: 1..limit — основа, дальше — лист ожидания. Для отказавшихся 0. */
  pos: number;
}

export interface Roster {
  main: RosterEntry[];
  waitlist: RosterEntry[];
  out: RosterEntry[];
}

export type Response = "in" | "out";

export interface TgUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export function playerName(p: Pick<Player, "display_name" | "first_name" | "last_name">): string {
  return p.display_name || [p.first_name, p.last_name].filter(Boolean).join(" ");
}

// ---------- players ----------

export async function upsertTgPlayer(db: D1Database, u: TgUser): Promise<Player> {
  const row = await db
    .prepare(
      `INSERT INTO players (tg_id, first_name, last_name, username) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (tg_id) DO UPDATE SET
         first_name = excluded.first_name,
         last_name  = excluded.last_name,
         username   = excluded.username
       RETURNING *`,
    )
    .bind(u.id, u.first_name, u.last_name ?? null, u.username ?? null)
    .first<Player>();
  return row!;
}

/** Гость без Telegram: ищем по имени (без учёта регистра), иначе создаём. */
export async function findOrCreateGuest(db: D1Database, name: string): Promise<Player> {
  // lower() в SQLite понимает только ASCII, поэтому сравниваем без учёта регистра в JS.
  const norm = (s: string) => s.trim().toLocaleLowerCase("ru").replace(/ё/g, "е");
  const { results: guests } = await db.prepare(`SELECT * FROM players WHERE tg_id IS NULL`).all<Player>();
  const existing = guests.find((g) => norm(playerName(g)) === norm(name));
  if (existing) return existing;
  const row = await db
    .prepare(`INSERT INTO players (first_name, display_name) VALUES (?1, ?1) RETURNING *`)
    .bind(name)
    .first<Player>();
  return row!;
}

// ---------- weeks ----------

export async function getWeek(db: D1Database, id: number): Promise<Week | null> {
  return db.prepare(`SELECT * FROM weeks WHERE id = ?1`).bind(id).first<Week>();
}

export async function getWeekByDate(db: D1Database, chatId: number, date: string): Promise<Week | null> {
  return db
    .prepare(`SELECT * FROM weeks WHERE chat_id = ?1 AND game_date = ?2`)
    .bind(chatId, date)
    .first<Week>();
}

/** Ближайшая игра, начиная с today (включительно). */
export async function getCurrentWeek(db: D1Database, chatId: number, today: string): Promise<Week | null> {
  return db
    .prepare(`SELECT * FROM weeks WHERE chat_id = ?1 AND game_date >= ?2 ORDER BY game_date LIMIT 1`)
    .bind(chatId, today)
    .first<Week>();
}

export async function getOrCreateWeek(
  db: D1Database,
  chatId: number,
  date: string,
  limit: number,
): Promise<Week> {
  await db
    .prepare(
      `INSERT INTO weeks (chat_id, game_date, player_limit) VALUES (?1, ?2, ?3)
       ON CONFLICT (chat_id, game_date) DO NOTHING`,
    )
    .bind(chatId, date, limit)
    .run();
  return (await getWeekByDate(db, chatId, date))!;
}

export async function updateWeek(
  db: D1Database,
  id: number,
  patch: Partial<Pick<Week, "status" | "player_limit" | "message_id">>,
): Promise<void> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = ?${i + 2}`).join(", ");
  await db
    .prepare(`UPDATE weeks SET ${sets} WHERE id = ?1`)
    .bind(id, ...keys.map((k) => patch[k] ?? null))
    .run();
}

// ---------- registrations ----------

interface RosterRow {
  player_id: number;
  tg_id: number | null;
  first_name: string;
  last_name: string | null;
  display_name: string | null;
  response: Response;
}

export async function getRoster(db: D1Database, week: Week): Promise<Roster> {
  const { results } = await db
    .prepare(
      `SELECT r.player_id, r.response, p.tg_id, p.first_name, p.last_name, p.display_name
       FROM registrations r JOIN players p ON p.id = r.player_id
       WHERE r.week_id = ?1
       ORDER BY r.queue_pos`,
    )
    .bind(week.id)
    .all<RosterRow>();

  const roster: Roster = { main: [], waitlist: [], out: [] };
  let pos = 0;
  for (const r of results) {
    const entry: RosterEntry = { playerId: r.player_id, tgId: r.tg_id, name: playerName(r), pos: 0 };
    if (r.response === "out") {
      roster.out.push(entry);
      continue;
    }
    entry.pos = ++pos;
    (pos <= week.player_limit ? roster.main : roster.waitlist).push(entry);
  }
  return roster;
}

export interface MutationResult {
  changed: boolean;
  /** Игроки, которые в результате изменения попали из листа ожидания в основу. */
  promoted: number[];
}

const MAIN_IDS_SQL = `SELECT player_id FROM registrations
  WHERE week_id = ?1 AND response = 'in' ORDER BY queue_pos LIMIT ?2`;

/**
 * Выполняет изменение и атомарно (D1 batch = одна транзакция) снимает
 * основной состав до и после — так видно, кто поднялся из листа ожидания.
 */
async function mutateWithDiff(
  db: D1Database,
  week: Week,
  stmt: D1PreparedStatement,
  actorId: number,
): Promise<MutationResult> {
  const mainBefore = db.prepare(MAIN_IDS_SQL).bind(week.id, week.player_limit);
  const mainAfter = db.prepare(MAIN_IDS_SQL).bind(week.id, week.player_limit);
  const [before, change, after] = await db.batch<{ player_id: number }>([mainBefore, stmt, mainAfter]);
  const beforeIds = new Set(before.results.map((r) => r.player_id));
  const promoted = after.results
    .map((r) => r.player_id)
    .filter((id) => !beforeIds.has(id) && id !== actorId);
  return { changed: (change.meta.changes ?? 0) > 0, promoted };
}

/**
 * Ответ игрока. Смена ответа ставит в конец очереди; повтор того же ответа ничего не меняет.
 */
export function setResponse(
  db: D1Database,
  week: Week,
  playerId: number,
  response: Response,
): Promise<MutationResult> {
  const stmt = db
    .prepare(
      `INSERT INTO registrations (week_id, player_id, response, queue_pos)
       VALUES (?1, ?2, ?3, (SELECT coalesce(max(queue_pos), 0) + 1 FROM registrations WHERE week_id = ?1))
       ON CONFLICT (week_id, player_id) DO UPDATE SET
         response   = excluded.response,
         queue_pos  = excluded.queue_pos,
         updated_at = datetime('now')
       WHERE registrations.response <> excluded.response`,
    )
    .bind(week.id, playerId, response);
  return mutateWithDiff(db, week, stmt, playerId);
}

export function removeRegistration(db: D1Database, week: Week, playerId: number): Promise<MutationResult> {
  const stmt = db
    .prepare(`DELETE FROM registrations WHERE week_id = ?1 AND player_id = ?2`)
    .bind(week.id, playerId);
  return mutateWithDiff(db, week, stmt, playerId);
}

/** Изменение лимита тоже может поднять людей из листа ожидания. */
export function changeLimit(db: D1Database, week: Week, limit: number): Promise<MutationResult> {
  const stmt = db.prepare(`UPDATE weeks SET player_limit = ?2 WHERE id = ?1`).bind(week.id, limit);
  // «после» считаем уже с новым лимитом
  const before = db.prepare(MAIN_IDS_SQL).bind(week.id, week.player_limit);
  const after = db.prepare(MAIN_IDS_SQL).bind(week.id, limit);
  return db.batch<{ player_id: number }>([before, stmt, after]).then(([b, , a]) => {
    const beforeIds = new Set(b.results.map((r) => r.player_id));
    return { changed: true, promoted: a.results.map((r) => r.player_id).filter((id) => !beforeIds.has(id)) };
  });
}
