import { Bot, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { readConfig, type Config, type Env } from "./env";
import {
  changeLimit,
  findOrCreateGuest,
  getCurrentWeek,
  getOrCreateWeek,
  getRoster,
  getWeek,
  removeRegistration,
  setResponse,
  updateWeek,
  upsertTgPlayer,
  type Week,
} from "./db";
import { localToday, nextGameDate } from "./dates";
import { esc, renderRosterText } from "./render";
import { notifyPromoted, postWeek, refreshWeekMessage } from "./service";

const HELP = `<b>Команды</b>
/list — текущий состав
/chatid — id этого чата

<b>Для админов группы</b>
/game — опубликовать (или перепостить вниз) запись на ближайшую игру
/close, /open — закрыть / открыть запись
/limit 12 — изменить число мест
/add Имя — добавить игрока без Telegram (или ответом на сообщение игрока)
/remove 7 — убрать игрока №7 из списка (или ответом на его сообщение)`;

// Telegram шлёт сообщения анонимных админов от имени этого бота.
const GROUP_ANONYMOUS_BOT = 1087968824;

export function createBot(env: Env, botInfo?: UserFromGetMe): Bot {
  const cfg = readConfig(env);
  const db = env.DB;
  const bot = new Bot(env.BOT_TOKEN, { botInfo });

  const today = () => localToday(new Date(), cfg.timezone).date;
  const inGroup = (ctx: Context) => ctx.chat?.id === cfg.groupChatId;

  async function isAdmin(ctx: Context): Promise<boolean> {
    if (!ctx.chat || !ctx.from) return false;
    if (ctx.message?.sender_chat?.id === ctx.chat.id || ctx.from.id === GROUP_ANONYMOUS_BOT) return true;
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    return member.status === "creator" || member.status === "administrator";
  }

  /** Обёртка для админ-команд: только в нашей группе и только от админов. */
  function admin(handler: (ctx: Context, week: Week | null) => Promise<unknown>) {
    return async (ctx: Context) => {
      if (!inGroup(ctx)) return;
      if (!(await isAdmin(ctx))) {
        await ctx.reply("Эта команда только для админов группы.");
        return;
      }
      await handler(ctx, await getCurrentWeek(db, cfg.groupChatId, today()));
    };
  }

  const noGame = (ctx: Context) => ctx.reply("Ближайшей игры нет. Создайте её командой /game.");

  // ---------- общие команды ----------

  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    await ctx.reply(
      "Привет! Я веду запись на футбол в группе. Сюда буду писать, если ты поднимешься из листа ожидания в основной состав.",
    );
  });

  bot.command("help", (ctx) => ctx.reply(HELP, { parse_mode: "HTML" }));

  bot.command("chatid", (ctx) => ctx.reply(`chat id: <code>${ctx.chat.id}</code>`, { parse_mode: "HTML" }));

  bot.command("list", async (ctx) => {
    if (!inGroup(ctx)) return;
    const week = await getCurrentWeek(db, cfg.groupChatId, today());
    if (!week) return noGame(ctx);
    await ctx.reply(renderRosterText(week, await getRoster(db, week), cfg), { parse_mode: "HTML" });
  });

  // ---------- кнопки «Играю / Не играю» ----------

  bot.callbackQuery(/^reg:(\d+):(in|out)$/, async (ctx) => {
    const week = await getWeek(db, Number(ctx.match[1]));
    const response = ctx.match[2] as "in" | "out";
    if (!week) return ctx.answerCallbackQuery({ text: "Игра не найдена" });
    if (week.status !== "open") {
      return ctx.answerCallbackQuery({ text: "🔒 Запись закрыта, напишите админу", show_alert: true });
    }

    const player = await upsertTgPlayer(db, ctx.from);
    const { changed, promoted } = await setResponse(db, week, player.id, response);
    const roster = await getRoster(db, week);

    let toast = "Ок, не играешь";
    if (response === "in") {
      const me = [...roster.main, ...roster.waitlist].find((e) => e.playerId === player.id)!;
      toast = me.pos <= week.player_limit ? "✅ Ты в составе" : `⏳ Ты в листе ожидания (№${me.pos})`;
    }
    await ctx.answerCallbackQuery({ text: changed ? toast : `Уже отмечено. ${toast}` });

    if (changed) {
      await refreshWeekMessage(ctx.api, db, week, cfg);
      await notifyPromoted(ctx.api, db, week, promoted);
    }
  });

  // ---------- админ-команды ----------

  bot.command(
    "game",
    admin(async (ctx) => {
      const date = nextGameDate(new Date(), cfg.timezone, cfg.gameWeekday);
      const week = await getOrCreateWeek(db, cfg.groupChatId, date, cfg.playerLimit);
      await postWeek(ctx.api, db, week, cfg);
    }),
  );

  for (const [cmd, status] of [["close", "closed"], ["open", "open"]] as const) {
    bot.command(
      cmd,
      admin(async (ctx, week) => {
        if (!week) return noGame(ctx);
        await updateWeek(db, week.id, { status });
        await refreshWeekMessage(ctx.api, db, { ...week, status }, cfg);
        await ctx.reply(status === "closed" ? "🔒 Запись закрыта" : "🔓 Запись открыта");
      }),
    );
  }

  bot.command(
    "limit",
    admin(async (ctx, week) => {
      if (!week) return noGame(ctx);
      const limit = Number(ctx.match);
      if (!Number.isInteger(limit) || limit < 2 || limit > 40) return ctx.reply("Пример: /limit 12");
      const { promoted } = await changeLimit(db, week, limit);
      const updated = { ...week, player_limit: limit };
      await refreshWeekMessage(ctx.api, db, updated, cfg);
      await notifyPromoted(ctx.api, db, updated, promoted);
      await ctx.reply(`Мест: ${limit}`);
    }),
  );

  bot.command(
    "add",
    admin(async (ctx, week) => {
      if (!week) return noGame(ctx);
      const replyFrom = ctx.message?.reply_to_message?.from;
      const name = String(ctx.match ?? "").trim();
      let player;
      if (replyFrom && !replyFrom.is_bot) player = await upsertTgPlayer(db, replyFrom);
      else if (name) player = await findOrCreateGuest(db, name.slice(0, 40));
      else return ctx.reply("Пример: /add Вася, или ответьте /add на сообщение игрока");

      await setResponse(db, week, player.id, "in");
      await refreshWeekMessage(ctx.api, db, week, cfg);
      const roster = await getRoster(db, week);
      const me = [...roster.main, ...roster.waitlist].find((e) => e.playerId === player.id)!;
      await ctx.reply(
        `Добавил ${esc(me.name)} — №${me.pos}${me.pos > week.player_limit ? " (лист ожидания)" : ""}`,
        { parse_mode: "HTML" },
      );
    }),
  );

  bot.command(
    "remove",
    admin(async (ctx, week) => {
      if (!week) return noGame(ctx);
      const roster = await getRoster(db, week);
      const all = [...roster.main, ...roster.waitlist];
      const replyFrom = ctx.message?.reply_to_message?.from;
      const target = replyFrom
        ? all.find((e) => e.tgId === replyFrom.id)
        : all.find((e) => e.pos === Number(ctx.match));
      if (!target) return ctx.reply("Пример: /remove 7 (номер из списка), или ответьте /remove на сообщение игрока");

      const { promoted } = await removeRegistration(db, week, target.playerId);
      await refreshWeekMessage(ctx.api, db, week, cfg);
      await notifyPromoted(ctx.api, db, week, promoted);
      await ctx.reply(`Убрал ${esc(target.name)}`, { parse_mode: "HTML" });
    }),
  );

  bot.catch((err) => console.error("bot error", err.error));
  return bot;
}

export const BOT_COMMANDS = [
  { command: "list", description: "Текущий состав" },
  { command: "game", description: "Опубликовать запись на игру (админ)" },
  { command: "close", description: "Закрыть запись (админ)" },
  { command: "open", description: "Открыть запись (админ)" },
  { command: "limit", description: "Число мест, напр. /limit 12 (админ)" },
  { command: "add", description: "Добавить игрока (админ)" },
  { command: "remove", description: "Убрать игрока по номеру (админ)" },
  { command: "help", description: "Справка" },
];

export type { Config };
