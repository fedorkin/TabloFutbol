-- Пересчёт рейтинга по каждому завершённому матчу. Заодно — источник статистики:
-- игры, победы/ничьи/поражения, голы, пасы.
CREATE TABLE rating_changes (
  match_id       INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id      INTEGER NOT NULL REFERENCES players(id),
  team           TEXT NOT NULL CHECK (team IN ('A', 'B')),
  result         TEXT NOT NULL CHECK (result IN ('W', 'D', 'L')),
  goals          INTEGER NOT NULL,
  assists        INTEGER NOT NULL,
  own_goals      INTEGER NOT NULL,
  team_part      REAL NOT NULL,   -- за победу/поражение
  personal_part  REAL NOT NULL,   -- за голы/пасы (после выравнивания по матчу)
  delta          REAL NOT NULL,   -- фактическое изменение (с учётом границ 1..10)
  before         REAL NOT NULL,
  after          REAL NOT NULL,
  PRIMARY KEY (match_id, player_id)
);

CREATE INDEX idx_rating_changes_player ON rating_changes (player_id);
