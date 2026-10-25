-- Журнал ручных правок оценки админами. Серия быстрых правок одного админа
-- (в течение пары минут) схлопывается в одну запись: before — исходное значение.
CREATE TABLE skill_edits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   INTEGER NOT NULL REFERENCES players(id),
  before      REAL NOT NULL,
  after       REAL NOT NULL,
  admin_tg_id INTEGER NOT NULL,
  admin_name  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_skill_edits_player ON skill_edits (player_id, created_at);
