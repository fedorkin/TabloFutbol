import { Api } from "grammy";
import { readConfig, type Env } from "./env";
import { getOrCreateWeek, getRoster, getWeekByDate } from "./db";
import { daysBetween, localToday, nextGameDate } from "./dates";
import { postWeek } from "./service";

/**
 * Одна логика на любое расписание из wrangler.toml:
 *  - поста на ближайшую игру ещё нет → публикуем его;
 *  - пост есть, до игры ≤ 1 дня и состав не собран → напоминание в группу.
 */
export async function runScheduled(env: Env, now = new Date(), api = new Api(env.BOT_TOKEN)): Promise<string> {
  const cfg = readConfig(env);
  if (!cfg.groupChatId) return "GROUP_CHAT_ID не задан";

  const date = nextGameDate(now, cfg.timezone, cfg.gameWeekday);
  const existing = await getWeekByDate(env.DB, cfg.groupChatId, date);

  if (!existing?.message_id) {
    const week = existing ?? (await getOrCreateWeek(env.DB, cfg.groupChatId, date, cfg.playerLimit));
    await postWeek(api, env.DB, week, cfg);
    return `posted ${date}`;
  }

  const daysLeft = daysBetween(localToday(now, cfg.timezone).date, date);
  if (daysLeft > 1 || existing.status !== "open") return "nothing to do";

  const roster = await getRoster(env.DB, existing);
  const free = existing.player_limit - roster.main.length;
  if (free <= 0) return "full";

  await api.sendMessage(
    existing.chat_id,
    `⏰ ${daysLeft === 0 ? "Игра сегодня" : "Игра завтра"}, а свободно ещё ${free} ${plural(free, "место", "места", "мест")}. Отметьтесь в посте ⬆️`,
    { reply_parameters: { message_id: existing.message_id, allow_sending_without_reply: true } },
  );
  return `reminded ${free}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
