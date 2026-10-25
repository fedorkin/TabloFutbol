-- Игроки. tg_id = NULL для «гостей», которых админ добавил вручную по имени.
CREATE TABLE players (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id         INTEGER UNIQUE,
  first_name    TEXT NOT NULL,
  last_name     TEXT,
  username      TEXT,
  display_name  TEXT,                       -- переопределённое имя (ставит админ)
  rating        REAL NOT NULL DEFAULT 1500, -- понадобится на этапе балансировки
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Одна запись на игровой день.
CREATE TABLE weeks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  game_date     TEXT NOT NULL,              -- YYYY-MM-DD
  player_limit  INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  message_id    INTEGER,                    -- пост с кнопками в группе
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (chat_id, game_date)
);

-- Ответы игроков. Порядок очереди = queue_pos: первые player_limit среди 'in' —
-- основной состав, остальные — лист ожидания. Повторное «Играю» после отказа
-- ставит в конец очереди.
CREATE TABLE registrations (
  week_id    INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  player_id  INTEGER NOT NULL REFERENCES players(id),
  response   TEXT NOT NULL CHECK (response IN ('in', 'out')),
  queue_pos  INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (week_id, player_id)
);

CREATE INDEX idx_registrations_week ON registrations (week_id, response, queue_pos);
