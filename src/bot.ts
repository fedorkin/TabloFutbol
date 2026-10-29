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
  cancelWeek,
  CancelError,
  restoreWeek,
  cleanName,
  playerName,
  setDisplayName,
  type Player,
  type Week,
} from "./db";
import { formatGameDate, localToday, nextGameDate } from "./dates";
import { esc, mention, renderRosterText } from "./render";
import { announceKickoff, notifyPromoted, postWeek, refreshWeekMessage } from "./service";
import { matchList, renderStats, seasonStats } from "./stats";
import { absenceStreaks, activePauses, endPause, markJoined, markRemoved, SKIP_LIMIT, SKIP_WARN, startPause } from "./absence";
import { startMatch, autoTeams, getLineup, getMatchByWeek, HttpError, renderLineups } from "./match";
import { InlineKeyboard } from "grammy";

const HELP = `<b>Команды</b>
/list — текущий состав
/chatid — id этого чата
/name Имя — как вас показывать в списках
/stats — голы, пасы и результаты за сезон
/skips — кто сколько игр пропустил подряд (после 10 — удаление из группы)

<b>Для админов группы</b>
/game — опубликовать (или перепостить вниз) запись на ближайшую игру
/close, /open — закрыть / открыть запись
/limit 12 — изменить число мест
/add Имя — добавить игрока без Telegram (или ответом на сообщение игрока)
/remove 7 — убрать игрока №7 из списка (или ответом на его сообщение)
/name 7 Вася — переименовать игрока №7 (или ответом на его сообщение)
/pause 7 до 15.11 — пауза (отпуск, травма): игры не считаются пропусками; /unpause 7 — снять
/cancel причина — отменить игру (пост помечается, записавшимся — уведомление, пропуском не считается); вернуть — /game
/teams — поделить основу на две команды по рейтингу (до старта — сколько угодно раз)
/kickoff — начать игру: включается табло, запись закрывается
/tablo — кнопка открытия табло (счёт, составы, рейтинги)`;

// Telegram шлёт сообщения анонимных админов от имени этого бота.
const GROUP_ANONYMOUS_BOT = 1087968824;

export function createBot(env: Env, botInfo?: UserFromGetMe): Bot {
  const cfg = readConfig(env);
  const db = env.DB;
  const bot = new Bot(env.BOT_TOKEN, { botInfo });

  const today = () => localToday(new Date(), cfg.timezone).date;
  const inGroup = (ctx: Context) => ctx.chat?.id === cfg.groupChatId;

  /** В нашей группе — true. В чужом/ненастроенном чате подсказывает, какой id прописать. */
  async function checkGroup(ctx: Context): Promise<boolean> {
    if (inGroup(ctx)) return true;
    if (ctx.chat && ctx.chat.type !== "private") {
      await ctx.reply(
        `Бот привязан к другому чату (GROUP_CHAT_ID = <code>${cfg.groupChatId}</code>).\n` +
          `id этого чата: <code>${ctx.chat.id}</code> — пропишите его в GROUP_CHAT_ID.`,
        { parse_mode: "HTML" },
      );
    }
    return false;
  }

  async function isAdmin(ctx: Context): Promise<boolean> {
    if (!ctx.chat || !ctx.from) return false;
    if (ctx.message?.sender_chat?.id === ctx.chat.id || ctx.from.id === GROUP_ANONYMOUS_BOT) return true;
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    return member.status === "creator" || member.status === "administrator";
  }

  /** Обёртка для админ-команд: только в нашей группе и только от админов. */
  function admin(handler: (ctx: Context, week: Week | null) => Promise<unknown>) {
    return async (ctx: Context) => {
      if (!(await checkGroup(ctx))) return;
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
    if (!(await checkGroup(ctx))) return;
    const week = await getCurrentWeek(db, cfg.groupChatId, today());
    if (!week) return noGame(ctx);
    await ctx.reply(renderRosterText(week, await getRoster(db, week), cfg), { parse_mode: "HTML" });
  });

  // ---------- кнопки «Играю / Не играю» ----------

  bot.callbackQuery(/^reg:(\d+):(in|out)$/, async (ctx) => {
    const week = await getWeek(db, Number(ctx.match[1]));
    const response = ctx.match[2] as "in" | "out";
    if (!week) return ctx.answerCallbackQuery({ text: "Игра не найдена" });
    if (week.cancelled_at) return ctx.answerCallbackQuery({ text: "❌ Эта игра отменена", show_alert: true });
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
      let week = await getOrCreateWeek(db, cfg.groupChatId, date, cfg.playerLimit);
      if (week.cancelled_at) {
        // отменили по ошибке — /game возвращает игру, запись сохранилась
        await restoreWeek(db, week.id);
        week = { ...week, status: "open", cancelled_at: null, cancel_reason: null };
      }
      await postWeek(ctx.api, db, week, cfg);
    }),
  );

  bot.command(
    "cancel",
    admin(async (ctx, week) => {
      if (!week) return noGame(ctx);
      if (week.cancelled_at) return ctx.reply("Эта игра уже отменена. Вернуть — /game");
      const reason = String(ctx.match ?? "").trim().slice(0, 200) || null;
      const roster = await getRoster(db, week);
      try {
        await cancelWeek(db, week, reason);
      } catch (e) {
        if (e instanceof CancelError) return ctx.reply(e.message);
        throw e;
      }
      const cancelled = { ...week, status: "closed" as const, cancelled_at: "now", cancel_reason: reason };
      await refreshWeekMessage(ctx.api, db, cancelled, cfg).catch(() => {});
      const who = [...roster.main, ...roster.waitlist];
      await ctx.reply(
        `❌ <b>Игра ${esc(formatGameDate(week.game_date))} отменена</b>${reason ? `: ${esc(reason)}` : ""}.\n` +
          `Пропуском не считается.` +
          (who.length ? `\n\n${who.map((e) => mention(e)).join(", ")}` : ""),
        { parse_mode: "HTML" },
      );
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

  /**
   * /name Вася — своё имя;
   * админ: ответом на сообщение игрока «/name Вася» или «/name 7 Вася» (номер из списка);
   * /name без имени (ответом или с номером — у админа) — вернуть имя из Telegram.
   */
  bot.command("name", async (ctx) => {
    if (!(await checkGroup(ctx))) return;
    const text = String(ctx.match ?? "").trim();
    const replyFrom = ctx.message?.reply_to_message?.from;
    const byNumber = /^(\d{1,3})(?:\s+(.*))?$/.exec(text);
    const targetsOther = (replyFrom && !replyFrom.is_bot && replyFrom.id !== ctx.from?.id) || byNumber;

    let playerId: number | undefined;
    let newName: string | null;
    if (targetsOther) {
      if (!(await isAdmin(ctx))) return ctx.reply("Переименовывать других могут только админы. Своё имя: /name Имя");
      if (replyFrom && !byNumber) {
        playerId = (await upsertTgPlayer(db, replyFrom)).id;
        newName = cleanName(text);
      } else {
        const week = await getCurrentWeek(db, cfg.groupChatId, today());
        const roster = week ? await getRoster(db, week) : null;
        playerId = (roster && [...roster.main, ...roster.waitlist].find((e) => e.pos === Number(byNumber![1]))?.playerId) ?? undefined;
        if (!playerId) return ctx.reply("Нет игрока с таким номером в текущем списке.");
        newName = cleanName(byNumber![2] ?? "");
      }
    } else {
      if (!ctx.from || !text) {
        return ctx.reply(
          "Как поменять имя в списках:\n/name Павел — своё\nАдмины: ответом на сообщение игрока /name Павел, или /name 7 Павел — по номеру в списке.\nБез имени — вернуть имя из Telegram.",
        );
      }
      playerId = (await upsertTgPlayer(db, ctx.from)).id;
      newName = cleanName(text);
    }

    const player = await db.prepare(`SELECT * FROM players WHERE id = ?1`).bind(playerId).first<Player>();
    if (!player) return;
    if (!newName && player.tg_id == null) return ctx.reply("У гостя нет имени в Telegram — укажите новое имя.");
    await setDisplayName(db, player.id, newName);
    const shown = playerName({ ...player, display_name: newName });
    const week = await getCurrentWeek(db, cfg.groupChatId, today());
    if (week) await refreshWeekMessage(ctx.api, db, week, cfg);
    await ctx.reply(newName ? `Теперь в списках: ${esc(shown)}` : `Вернул имя из Telegram: ${esc(shown)}`, { parse_mode: "HTML" });
  });

  bot.command("stats", async (ctx) => {
    if (!(await checkGroup(ctx))) return;
    const [stats, matches] = await Promise.all([seasonStats(db, cfg.groupChatId), matchList(db, cfg.groupChatId)]);
    await ctx.reply(renderStats(stats, matches.filter((m) => m.status === "finished").length), {
      parse_mode: "HTML",
      reply_markup: tabloKeyboard(ctx),
    });
  });

  // ---------- пропуски и паузы ----------

  // Кто вступил/вышел — чтобы правило пропусков знало, кто сейчас в группе.
  bot.on("chat_member", async (ctx) => {
    if (ctx.chat.id !== cfg.groupChatId) return;
    const m = ctx.chatMember.new_chat_member;
    if (m.user.is_bot) return;
    const inChat =
      m.status === "member" || m.status === "administrator" || m.status === "creator" || (m.status === "restricted" && m.is_member);
    const player = await upsertTgPlayer(db, m.user);
    if (inChat) await markJoined(db, player.id);
    else await markRemoved(db, player.id);
  });

  /** Кого имеет в виду админ: ответ на сообщение, номер из списка записи или @username. */
  async function resolveTarget(ctx: Context, arg: string): Promise<Player | null> {
    const replyFrom = ctx.message?.reply_to_message?.from;
    if (replyFrom && !replyFrom.is_bot) return upsertTgPlayer(db, replyFrom);
    if (/^\d{1,3}$/.test(arg)) {
      const week = await getCurrentWeek(db, cfg.groupChatId, today());
      const roster = week ? await getRoster(db, week) : null;
      const e = roster && [...roster.main, ...roster.waitlist].find((x) => x.pos === Number(arg));
      return e ? db.prepare(`SELECT * FROM players WHERE id = ?1`).bind(e.playerId).first<Player>() : null;
    }
    if (arg.startsWith("@")) {
      return db.prepare(`SELECT * FROM players WHERE lower(username) = lower(?1)`).bind(arg.slice(1)).first<Player>();
    }
    return null;
  }

  /** «15.11» → ближайшая такая дата не раньше сегодняшней. */
  function parseUntil(s: string): string | null | undefined {
    const m = /^(?:до\s+)?(\d{1,2})\.(\d{1,2})$/i.exec(s.trim());
    if (!m) return s.trim() ? null : undefined;
    const t = today();
    let y = Number(t.slice(0, 4));
    const mk = (yy: number) => `${yy}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    if (mk(y) < t) y++;
    return mk(y);
  }

  const PAUSE_HELP =
    "Пауза (отпуск, травма) — игры не считаются пропусками.\n" +
    "Ответом на сообщение игрока: /pause или /pause до 15.11\n" +
    "По номеру из списка или @нику: /pause 7, /pause @nick до 15.11\n" +
    "Снять: /unpause 7 (или ответом)";

  bot.command(
    "pause",
    admin(async (ctx) => {
      const parts = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
      const hasReply = !!ctx.message?.reply_to_message?.from;
      const who = hasReply ? "" : parts.shift() ?? "";
      const player = await resolveTarget(ctx, who);
      if (!player) return ctx.reply(PAUSE_HELP);
      const until = parseUntil(parts.join(" "));
      if (until === null) return ctx.reply("Не понял дату. Пример: /pause 7 до 15.11");
      await startPause(db, player.id, today(), ctx.from!.id, until);
      const week = await getCurrentWeek(db, cfg.groupChatId, today());
      if (week) await refreshWeekMessage(ctx.api, db, week, cfg);
      const [, mm, dd] = (until ?? "").split("-");
      await ctx.reply(
        `⏸ ${esc(playerName(player))} на паузе${until ? ` до ${dd}.${mm}` : " — до /unpause"}. Игры в это время не считаются пропусками.`,
        { parse_mode: "HTML" },
      );
    }),
  );

  bot.command(
    "unpause",
    admin(async (ctx) => {
      const player = await resolveTarget(ctx, String(ctx.match ?? "").trim());
      if (!player) return ctx.reply(PAUSE_HELP);
      const ok = await endPause(db, player.id, today());
      const week = await getCurrentWeek(db, cfg.groupChatId, today());
      if (ok && week) await refreshWeekMessage(ctx.api, db, week, cfg);
      await ctx.reply(ok ? `▶️ ${esc(playerName(player))} снова в игре.` : `${esc(playerName(player))} не на паузе.`, {
        parse_mode: "HTML",
      });
    }),
  );

  bot.command("skips", async (ctx) => {
    if (!(await checkGroup(ctx))) return;
    const all = (await absenceStreaks(db, cfg.groupChatId, today())).filter((e) => e.streak > 0);
    const pauses = await activePauses(db, today());
    const lines = [`📋 <b>Пропуски подряд</b> (удаление после ${SKIP_LIMIT}):`];
    if (!all.length) lines.push("ни у кого нет 🎉");
    for (const e of all.sort((a, b) => b.streak - a.streak).slice(0, 20)) {
      lines.push(`${e.streak >= SKIP_WARN ? "⚠️ " : ""}${esc(e.name)} — ${e.streak}${e.paused ? " ⏸" : ""}`);
    }
    if (pauses.length) {
      lines.push("", "⏸ <b>На паузе</b>");
      for (const p of pauses) {
        const [, mm, dd] = (p.to ?? "").split("-");
        lines.push(`${esc(p.name)}${p.to ? ` — до ${dd}.${mm}` : ""}`);
      }
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command(
    "kickoff",
    admin(async (ctx, week) => {
      if (!week) return noGame(ctx);
      const match = await getMatchByWeek(db, week.id);
      if (!match) return ctx.reply("Сначала соберите команды: /teams");
      try {
        await startMatch(db, match);
      } catch (e) {
        if (e instanceof HttpError) return ctx.reply(e.message);
        throw e;
      }
      await announceKickoff(ctx.api, db, week, match.id, cfg, ctx.me.username);
    }),
  );

  const tabloKeyboard = (ctx: Context) =>
    new InlineKeyboard().url("📲 Открыть табло", `https://t.me/${ctx.me.username}?startapp=tablo`);

  bot.command("tablo", async (ctx) => {
    if (!(await checkGroup(ctx))) return;
    await ctx.reply("Табло: счёт, составы и рейтинги", { reply_markup: tabloKeyboard(ctx) });
  });

  bot.command(
    "teams",
    admin(async (ctx, week) => {
      if (!week) return noGame(ctx);
      try {
        await autoTeams(db, week, "best");
      } catch (e) {
        if (e instanceof HttpError) return ctx.reply(e.message);
        throw e;
      }
      const match = (await getMatchByWeek(db, week.id))!;
      await ctx.reply(renderLineups(week, await getLineup(db, match.id)), {
        parse_mode: "HTML",
        reply_markup: tabloKeyboard(ctx),
      });
    }),
  );

  bot.catch((err) => console.error("bot error", err.error));
  return bot;
}

export const BOT_COMMANDS = [
  { command: "list", description: "Текущий состав" },
  { command: "game", description: "Опубликовать запись на игру (админ)" },
  { command: "close", description: "Закрыть запись (админ)" },
  { command: "cancel", description: "Отменить игру (админ)" },
  { command: "open", description: "Открыть запись (админ)" },
  { command: "limit", description: "Число мест, напр. /limit 12 (админ)" },
  { command: "add", description: "Добавить игрока (админ)" },
  { command: "remove", description: "Убрать игрока по номеру (админ)" },
  { command: "name", description: "Своё имя в списках, напр. /name Павел" },
  { command: "tablo", description: "Открыть табло" },
  { command: "stats", description: "Статистика: голы, пасы, победы" },
  { command: "skips", description: "Пропуски подряд и паузы" },
  { command: "pause", description: "Пауза игроку (админ)" },
  { command: "unpause", description: "Снять паузу (админ)" },
  { command: "teams", description: "Поделить на команды (админ)" },
  { command: "kickoff", description: "Начать игру (админ)" },
  { command: "help", description: "Справка" },
];

export type { Config };
