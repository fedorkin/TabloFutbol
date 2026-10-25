-- Участник вышел или удалён из группы (NULL — в группе). Выбывшие не участвуют в правиле пропусков.
ALTER TABLE players ADD COLUMN removed_at TEXT;

-- С какого момента считать пропуски (после возвращения в группу — с даты возвращения).
ALTER TABLE players ADD COLUMN active_since TEXT;

-- Паузы (отпуск, травма): игры в эти даты не считаются пропусками.
CREATE TABLE player_pauses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   INTEGER NOT NULL REFERENCES players(id),
  from_date   TEXT NOT NULL,      -- YYYY-MM-DD включительно
  to_date     TEXT,               -- YYYY-MM-DD включительно; NULL — пока не снимут
  created_by  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_player_pauses_player ON player_pauses (player_id);
