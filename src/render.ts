import { InlineKeyboard } from "grammy";
import type { Config } from "./env";
import type { Roster, RosterEntry, Week } from "./db";
import { formatGameDate } from "./dates";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function mention(e: Pick<RosterEntry, "tgId" | "name">): string {
  return e.tgId ? `<a href="tg://user?id=${e.tgId}">${esc(e.name)}</a>` : esc(e.name);
}

function title(week: Week, cfg: Config): string {
  const when = [formatGameDate(week.game_date), cfg.gameTime].filter(Boolean).join(", ");
  return `⚽ <b>Футбол — ${esc(when)}</b>` + (cfg.gamePlace ? `\n📍 ${esc(cfg.gamePlace)}` : "");
}

export function renderRosterText(week: Week, roster: Roster, cfg: Config, extra = ""): string {
  const lines = [title(week, cfg), ""];

  lines.push(`✅ <b>Играют (${roster.main.length}/${week.player_limit})</b>`);
  lines.push(...(roster.main.length ? roster.main.map((e) => `${e.pos}. ${esc(e.name)}`) : ["— пока никого"]));

  if (roster.waitlist.length) {
    lines.push("", "⏳ <b>Лист ожидания</b>");
    lines.push(...roster.waitlist.map((e) => `${e.pos}. ${esc(e.name)}`));
  }

  if (roster.out.length) {
    lines.push("", `❌ Не играют (${roster.out.length}): ${roster.out.map((e) => esc(e.name)).join(", ")}`);
  }

  lines.push("");
  if (week.status === "closed") {
    lines.push("🔒 Запись закрыта");
  } else {
    const free = week.player_limit - roster.main.length;
    lines.push(free > 0 ? `Свободно мест: ${free}` : "Состав собран 🎉 Дальше — в лист ожидания");
  }
  if (extra) lines.push(extra);
  return lines.join("\n");
}

export function weekKeyboard(week: Week): InlineKeyboard | undefined {
  if (week.status !== "open") return undefined;
  return new InlineKeyboard()
    .text("✅ Играю", `reg:${week.id}:in`)
    .text("❌ Не играю", `reg:${week.id}:out`);
}
