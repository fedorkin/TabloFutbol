-- Отмена игры (поле недоступно, погода…): пост помечается отменённым, матч удаляется,
-- пропуском это не считается (пропуски — только завершённые матчи).
ALTER TABLE weeks ADD COLUMN cancelled_at TEXT;
ALTER TABLE weeks ADD COLUMN cancel_reason TEXT;
