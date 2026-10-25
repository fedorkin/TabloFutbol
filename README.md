# soccer-bot

Telegram-бот для записи на футбол. Работает на Cloudflare Workers + D1 (бесплатный тариф).

**Что умеет сейчас (этап 1 — запись на игру):**
- в понедельник сам публикует пост «кто играет в четверг» с кнопками **✅ Играю / ❌ Не играю**;
- лимит мест (по умолчанию 10), остальные — в лист ожидания;
- если кто-то из основы отказался — первый из листа ожидания поднимается автоматически и получает сообщение в личку (или упоминание в группе, если боту в личку ещё не писал);
- в среду напоминает в группе, если состав не собран;
- админ-команды: `/game`, `/close`, `/open`, `/limit 12`, `/add Имя`, `/remove 7`;
- админы = админы Telegram-группы, отдельно настраивать не нужно.

## Деплой через GitHub Actions (основной способ)

Каждый push в `main` прогоняет тесты, создаёт D1 (если её нет), применяет миграции, деплоит воркер и регистрирует webhook.

В репозитории: **Settings → Secrets and variables → Actions**
- Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `BOT_TOKEN`
- Variables: `GROUP_CHAT_ID` (после того как бот ответит на `/chatid` в группе)

Токен Cloudflare: My Profile → API Tokens → Create Token → шаблон «Edit Cloudflare Workers» → добавить право **Account · D1 · Edit**.

## Ручной деплой (≈10 минут)

Нужны Node.js 20+ и бесплатный аккаунт Cloudflare.

### 1. Бот в Telegram
1. В [@BotFather](https://t.me/BotFather): `/newbot` → сохраните токен.
2. Добавьте бота в группу и сделайте **админом** (нужно право удалять сообщения — чтобы при `/game` убирать старый пост).

### 2. Cloudflare
```bash
npm install
npx wrangler login
npx wrangler d1 create soccer
```
Скопируйте `database_id` из вывода в `wrangler.toml`. Затем:
```bash
npm run db:migrate
npx wrangler secret put BOT_TOKEN        # токен от BotFather
npx wrangler secret put WEBHOOK_SECRET   # любая длинная строка, напр. `openssl rand -hex 24`
npm run deploy
```
Wrangler выведет адрес вида `https://soccer-bot.<ваш-аккаунт>.workers.dev`.

### 3. Подключить webhook
Откройте в браузере:
```
https://soccer-bot.<ваш-аккаунт>.workers.dev/setup?secret=<WEBHOOK_SECRET>
```
Должно вернуться `"ok": true`.

### 4. Привязать к группе
1. Напишите в группе `/chatid` — бот ответит id (вида `-100…`).
2. Впишите его в `GROUP_CHAT_ID` в `wrangler.toml` и снова `npm run deploy`.
3. В группе: `/game` — появится пост с кнопками. Готово.

Каждому игроку стоит один раз написать боту `/start` в личку — тогда уведомления о подъёме из листа ожидания придут лично, а не упоминанием в группе.

## Настройки (`wrangler.toml` → `[vars]`)
| Переменная | По умолчанию | |
|---|---|---|
| `PLAYER_LIMIT` | `10` | мест в основе (на конкретную игру можно поменять `/limit`) |
| `GAME_WEEKDAY` | `4` | день игры, 1 = пн … 7 = вс |
| `GAME_TIME` | `20:00` | показывается в посте |
| `GAME_PLACE` | — | место, показывается в посте |
| `TIMEZONE` | `Asia/Nicosia` | |

Расписание — `[triggers] crons` (время в UTC). Логика не завязана на конкретные дни: если поста на ближайшую игру нет — бот его публикует; если пост есть, до игры ≤ 1 дня и есть свободные места — напоминает.

Проверить расписание вручную: `GET /cron?secret=<WEBHOOK_SECRET>`.

## Разработка
```bash
npm test           # сценарии на локальной D1 с замоканным Telegram API
npm run typecheck
npx wrangler tail  # живые логи продакшена
```

## Структура
```
src/index.ts    HTTP: /webhook, /setup, /cron + обработчик cron
src/bot.ts      команды и кнопки
src/db.ts       работа с D1, очередь и лист ожидания
src/service.ts  публикация/обновление поста, уведомления
src/render.ts   текст поста и кнопки
src/cron.ts     понедельничный пост и напоминание
migrations/     схема БД
```

## Дальше
2. Учёт голов: Mini App у ворот, Durable Object на матч (синхронизация двух телефонов по WebSocket).
3. Итоги матча в группу, статистика за сезон.
4. Рейтинг (командный Elo с учётом разницы мячей) и автоделение на команды.
