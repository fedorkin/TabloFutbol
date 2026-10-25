import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { getPlatformProxy } from "wrangler";
import { Api, type Transformer } from "grammy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, resetRoleCache } from "../src/api";
import { signInitData } from "../src/auth";
import { getOrCreateWeek, setResponse, upsertTgPlayer } from "../src/db";
import { localToday } from "../src/dates";
import type { Env } from "../src/env";
import { applyMigrations } from "./db";

/**
 * Смоук-тест Mini App: настоящий index.html в jsdom, запросы идут в настоящий API на локальной D1.
 */
const GROUP = -1003;
const TOKEN = "ui-token";

const fakeTelegram: Transformer = async (_prev, method, payload: any) => {
  if (method === "getChatMember") {
    return { ok: true, result: { status: payload.user_id === 1 ? "administrator" : "member", user: { id: payload.user_id } } } as any;
  }
  if (method === "sendMessage") return { ok: true, result: { message_id: 1, date: 0, chat: { id: payload.chat_id } } } as any;
  return { ok: true, result: true } as any;
};
const fakeApi = new Api(TOKEN);
fakeApi.config.use(fakeTelegram);
const api = createApi(() => fakeApi);

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let env: Env;

async function openApp(userId: number) {
  const initData = await signInitData(
    { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: `Игрок${userId}` }) },
    TOKEN,
  );
  const html = readFileSync("public/app/index.html", "utf8").replace(/<script src="https:\/\/telegram\.org[^>]*><\/script>/, "");
  const dom = new JSDOM(html, {
    url: "https://tablo.test/app/",
    runScripts: "dangerously",
    beforeParse(window: any) {
      window.Telegram = { WebApp: { initData, ready() {}, expand() {}, HapticFeedback: { notificationOccurred() {}, impactOccurred() {} } } };
      window.confirm = () => true;
      window.fetch = (url: string, init: RequestInit) => api.request(String(url).replace(/^\/api/, ""), init, env);
    },
  });
  const w = dom.window as any;
  const $ = (sel: string) => w.document.querySelector(sel) as HTMLElement | null;
  const $$ = (sel: string) => [...w.document.querySelectorAll(sel)] as HTMLElement[];
  const text = () => ["app", "sheet", "toast"].map((id) => w.document.getElementById(id).textContent).join(" ") as string;
  const until = async (cond: () => unknown, what: string) => {
    for (let i = 0; i < 100; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Не дождался: ${what}\n---\n${text().replace(/\s+/g, " ").slice(0, 600)}`);
  };
  const click = (el: HTMLElement | null) => {
    if (!el) throw new Error("нет элемента для клика");
    el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  };
  return { dom, w, $, $$, text, until, click };
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: false });
  await applyMigrations(proxy.env.DB);
  env = {
    DB: proxy.env.DB, BOT_TOKEN: TOKEN, WEBHOOK_SECRET: "s", GROUP_CHAT_ID: String(GROUP),
    TIMEZONE: "Asia/Nicosia", PLAYER_LIMIT: "10", GAME_WEEKDAY: "4", GAME_TIME: "18:30", GAME_PLACE: "",
  };
  resetRoleCache();
  // игра сегодня, 10 человек в основе
  const week = await getOrCreateWeek(env.DB, GROUP, localToday(new Date(), "Asia/Nicosia").date, 10);
  for (let id = 1; id <= 10; id++) {
    const p = await upsertTgPlayer(env.DB, { id, first_name: `Игрок${id}` });
    await setResponse(env.DB, week, p.id, "in");
  }
});

afterAll(async () => {
  await proxy?.dispose();
});

describe("Mini App", () => {
  it("админ собирает команды, отмечает гол с пасом и автогол, отменяет гол, завершает матч", async () => {
    const ui = await openApp(1);
    await ui.until(() => ui.text().includes("Составы ещё не собраны"), "экран без составов");

    ui.click(ui.$('[data-a="auto"]'));
    await ui.until(() => ui.$$(".col.A .chip").length === 5 && ui.$$(".col.B .chip").length === 5, "составы 5×5");
    expect(ui.$(".tabs .on")!.textContent).toBe("Составы");

    // вкладка «Табло», телефон у ворот синих → кнопки игроков оранжевых
    ui.click(ui.$('[data-tab="board"]'));
    ui.click(ui.$('[data-side="A"]'));
    await ui.until(() => ui.$$('.pbtn.B[data-a="scorer"]').length === 5, "кнопки авторов гола");

    ui.click(ui.$$('[data-a="scorer"]')[0]);
    await ui.until(() => ui.$(".sheet"), "шторка выбора паса");
    expect(ui.$$('.sheet [data-a="assist"]')).toHaveLength(5); // 4 партнёра + «Без паса»
    ui.click(ui.$$('.sheet .pbtn[data-a="assist"]')[0]);
    await ui.until(() => ui.$$(".score .n").map((n) => n.textContent).join(":") === "0:1", "счёт 0:1");
    await ui.until(() => !ui.text().includes("Не отправлено"), "очередь отправлена");
    expect(ui.$(".feed li .sub")!.textContent).toContain("пас:");

    // автогол защитника синих → гол оранжевым
    ui.click(ui.$('[data-a="own"]'));
    await ui.until(() => ui.$$('.sheet [data-a="ownby"]').length === 5, "шторка автогола");
    ui.click(ui.$$('.sheet [data-a="ownby"]')[0]);
    await ui.until(() => ui.$$(".score .n").map((n) => n.textContent).join(":") === "0:2", "счёт 0:2");

    // отмена последнего гола через ✕
    ui.click(ui.$$('.feed [data-a="cancel"]')[0]);
    await ui.until(() => ui.$$(".score .n").map((n) => n.textContent).join(":") === "0:1", "счёт после отмены 0:1");
    await ui.until(() => !ui.text().includes("Не отправлено"), "отмена отправлена");

    // второй телефон видит тот же счёт
    const phone2 = await openApp(5);
    await phone2.until(() => phone2.$$(".score .n").map((n) => n.textContent).join(":") === "0:1", "второй телефон видит 0:1");
    expect(phone2.$('[data-a="finish"]')).toBeNull(); // не админ
    expect(phone2.$('[data-tab="ratings"]')).toBeNull();

    ui.click(ui.$('[data-a="finish"]'));
    await ui.until(() => ui.text().includes("Матч завершён"), "матч завершён");

    // История: карточка матча и таблица статистики
    ui.click(ui.$('[data-tab="history"]'));
    await ui.until(() => ui.$$('[data-a="match"]').length === 1, "матч в истории");
    expect(ui.$('[data-a="match"]')!.textContent).toContain("0 : 1");
    ui.click(ui.$('[data-a="match"]'));
    await ui.until(() => ui.$(".sheet .score") && ui.$$(".sheet .feed li").length === 1, "карточка матча");
    expect(ui.$$(".sheet .chip small").length).toBe(10); // у всех изменение рейтинга
    ui.click(ui.$('.sheet [data-a="close"].btn'));
    ui.click(ui.$('[data-a="hist"][data-v="stats"]'));
    await ui.until(() => ui.$$('tr[data-a="player"]').length === 10, "таблица статистики");
    ui.click(ui.$$('tr[data-a="player"]')[0]);
    await ui.until(() => ui.$(".sheet") && ui.text().includes("1 игр"), "карточка игрока");
    ui.click(ui.$('.sheet [data-a="close"].btn'));

    ui.dom.window.close();
    phone2.dom.window.close();
  });

  it("рейтинги: админ меняет оценку кнопками", async () => {
    const ui = await openApp(1);
    await ui.until(() => ui.$('[data-tab="ratings"]'), "вкладка рейтингов");
    ui.click(ui.$('[data-tab="ratings"]'));
    await ui.until(() => ui.$$(".rate").length === 10, "список рейтингов");
    const start = Number(ui.$$(".rate .val")[0].textContent!.replace(",", "."));
    const target = Math.min(10, Math.round((start + 2) * 100) / 100);
    ui.click(ui.$$('.rate [data-d="1"]')[0]);
    ui.click(ui.$$('.rate [data-d="1"]')[0]);
    expect(ui.$$(".rate .val")[0].textContent).toBe(String(target).replace(".", ","));
    await new Promise((r) => setTimeout(r, 700)); // дебаунс сохранения
    const { results } = await env.DB.prepare(`SELECT skill FROM players WHERE skill = ?1`).bind(target).all();
    expect(results.length).toBeGreaterThanOrEqual(1);
    ui.dom.window.close();
  });

  it("игроки: переименование через шторку", async () => {
    const ui = await openApp(1);
    await ui.until(() => ui.$('[data-tab="ratings"]'), "вкладка игроков");
    expect(ui.$('[data-tab="ratings"]')!.textContent).toBe("Игроки");
    ui.click(ui.$('[data-tab="ratings"]'));
    await ui.until(() => ui.$$('[data-a="rename"]').length === 10, "список игроков");
    const target = ui.$$('[data-a="rename"]').find((b) => b.textContent!.includes("Игрок4"))!;
    ui.click(target);
    await ui.until(() => ui.$("#rename-input"), "поле имени");
    const input = ui.$("#rename-input") as HTMLInputElement;
    input.value = "Четвёртый";
    await new Promise((r) => setTimeout(r, 3300)); // поллинг не должен затереть ввод
    expect((ui.$("#rename-input") as HTMLInputElement).value).toBe("Четвёртый");
    ui.click(ui.$('[data-a="rename-save"]'));
    await ui.until(() => ui.$$('[data-a="rename"]').some((b) => b.textContent!.includes("Четвёртый")) && !ui.$(".sheet"), "новое имя в списке");
    expect(ui.$$(".rate .sub").some((d) => d.textContent!.includes("Игрок4"))).toBe(true); // видно, кто это в Telegram
    ui.dom.window.close();
  }, 15000);

  it("игроки: точная оценка через окно правки, в истории — отметка ✎", async () => {
    const ui = await openApp(1);
    await ui.until(() => ui.$('[data-tab="ratings"]'), "вкладка игроков");
    ui.click(ui.$('[data-tab="ratings"]'));
    await ui.until(() => ui.$$('[data-a="skilledit"]').length === 10, "список игроков");
    const row = ui.$$(".rate").find((r) => r.textContent!.includes("Игрок8"))!;
    ui.click(row.querySelector('[data-a="skilledit"]') as HTMLElement);
    await ui.until(() => ui.$("#skill-input") && ui.text().includes("матч"), "окно правки с историей");
    (ui.$("#skill-input") as HTMLInputElement).value = "6,3";
    ui.click(ui.$('[data-a="skillstep"][data-d="0.1"]'));
    expect((ui.$("#skill-input") as HTMLInputElement).value).toBe("6,4");
    ui.click(ui.$('[data-a="skill-save"]'));
    await ui.until(() => !ui.$(".sheet") && row.isConnected === false, "окно закрыто");
    await ui.until(() => ui.$$(".rate").some((r) => r.textContent!.includes("Игрок8") && r.textContent!.includes("6,4")), "новое значение");
    const { results } = await env.DB.prepare(`SELECT skill FROM players WHERE first_name = 'Игрок8'`).all<{ skill: number }>();
    expect(results[0].skill).toBe(6.4);

    // повторно открываем — в истории правка с автором
    const row2 = ui.$$(".rate").find((r) => r.textContent!.includes("Игрок8"))!;
    ui.click(row2.querySelector('[data-a="skilledit"]') as HTMLElement);
    await ui.until(() => ui.text().includes("✎ Игрок1:"), "правка в истории");
    ui.dom.window.close();
  }, 15000);
});
