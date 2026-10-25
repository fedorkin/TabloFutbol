import { Api, GrammyError } from "grammy";
import type { Config } from "./env";
import { getRoster, updateWeek, type Week } from "./db";
import { renderRosterText, weekKeyboard, mention } from "./render";
import { formatGameDate } from "./dates";

function isNotModified(e: unknown): boolean {
  return e instanceof GrammyError && e.description.includes("message is not modified");
}

/** Публикует новый пост с кнопками; старый пост (если был) удаляется. */
export async function postWeek(api: Api, db: D1Database, week: Week, cfg: Config): Promise<Week> {
  const roster = await getRoster(db, week);
  const msg = await api.sendMessage(week.chat_id, renderRosterText(week, roster, cfg), {
    parse_mode: "HTML",
    reply_markup: weekKeyboard(week),
    link_preview_options: { is_disabled: true },
  });
  if (week.message_id) {
    await api.deleteMessage(week.chat_id, week.message_id).catch(() => {});
  }
  await updateWeek(db, week.id, { message_id: msg.message_id });
  return { ...week, message_id: msg.message_id };
}

/** Перерисовывает существующий пост под актуальный состав. */
export async function refreshWeekMessage(api: Api, db: D1Database, week: Week, cfg: Config): Promise<void> {
  if (!week.message_id) return;
  const roster = await getRoster(db, week);
  try {
    await api.editMessageText(week.chat_id, week.message_id, renderRosterText(week, roster, cfg), {
      parse_mode: "HTML",
      reply_markup: weekKeyboard(week),
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    if (!isNotModified(e)) throw e;
  }
}

/**
 * Сообщает поднявшимся из листа ожидания. Сначала в личку; если человек
 * ни разу не писал боту (Telegram не даст написать первым) — упоминанием в группе.
 */
export async function notifyPromoted(
  api: Api,
  db: D1Database,
  week: Week,
  promotedIds: number[],
): Promise<void> {
  if (!promotedIds.length) return;
  const roster = await getRoster(db, week);
  const when = formatGameDate(week.game_date);
  const fallback: string[] = [];

  for (const e of roster.main.filter((e) => promotedIds.includes(e.playerId))) {
    const sent =
      e.tgId &&
      (await api
        .sendMessage(e.tgId, `🎉 Освободилось место — ты в основном составе на ${when}!`)
        .then(() => true)
        .catch(() => false));
    if (!sent) fallback.push(mention(e));
  }

  if (fallback.length) {
    await api.sendMessage(
      week.chat_id,
      `🎉 ${fallback.join(", ")} — освободилось место, вы в основном составе на ${when}!`,
      { parse_mode: "HTML", reply_parameters: week.message_id ? { message_id: week.message_id, allow_sending_without_reply: true } : undefined },
    );
  }
}
