-- Явный старт игры: до старта (NULL) — подготовка составов, голы не принимаются;
-- после — табло работает, автоперетасовка составов закрыта.
ALTER TABLE matches ADD COLUMN started_at TEXT;

-- Матчи, где уже есть голы, считаем начавшимися.
UPDATE matches SET started_at = created_at
WHERE started_at IS NULL AND EXISTS (SELECT 1 FROM match_events e WHERE e.match_id = matches.id);
