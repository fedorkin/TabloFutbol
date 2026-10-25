-- Оценка игрока 1..10 для деления на команды (выставляют админы).
ALTER TABLE players ADD COLUMN skill REAL NOT NULL DEFAULT 5;

-- Один матч на игровой вечер.
CREATE TABLE matches (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id             INTEGER NOT NULL UNIQUE REFERENCES weeks(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finished')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at         TEXT,
  summary_message_id  INTEGER
);

CREATE TABLE match_players (
  match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id  INTEGER NOT NULL REFERENCES players(id),
  team       TEXT NOT NULL CHECK (team IN ('A', 'B')),
  PRIMARY KEY (match_id, player_id)
);

-- События матча. id генерирует телефон (uuid) — повторная отправка не создаёт дубль.
-- Отмена — проставление cancelled_at, строки не удаляются.
CREATE TABLE match_events (
  id            TEXT PRIMARY KEY,
  match_id      INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('goal', 'own_goal')),
  team          TEXT NOT NULL CHECK (team IN ('A', 'B')),  -- кому засчитан гол
  scorer_id     INTEGER REFERENCES players(id),
  assist_id     INTEGER REFERENCES players(id),
  created_by    INTEGER,                                    -- tg id того, кто отметил
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  cancelled_at  TEXT
);

CREATE INDEX idx_match_events_match ON match_events (match_id, created_at);
