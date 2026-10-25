import { Hono } from "hono";
import { Api, Bot, webhookCallback } from "grammy";
import type { Env } from "./env";
import { BOT_COMMANDS, createBot } from "./bot";
import { runScheduled } from "./cron";
import { createApi } from "./api";

const app = new Hono<{ Bindings: Env }>();

// Бот создаётся один раз на изолят; getMe вызывается только при первом апдейте.
let bot: Bot | undefined;
const getBot = (env: Env) => (bot ??= createBot(env));

app.get("/", (c) => c.text("tablo-futbol ok"));

app.route("/api", createApi());

app.post("/webhook", (c) =>
  webhookCallback(getBot(c.env), "cloudflare-mod", { secretToken: c.env.WEBHOOK_SECRET })(c.req.raw),
);

/** Однократная настройка: GET /setup?secret=<WEBHOOK_SECRET> */
app.get("/setup", async (c) => {
  if (c.req.query("secret") !== c.env.WEBHOOK_SECRET) return c.text("forbidden", 403);
  const api = new Api(c.env.BOT_TOKEN);
  const url = new URL("/webhook", c.req.url).toString();
  await api.setWebhook(url, {
    secret_token: c.env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query", "chat_member"],
    drop_pending_updates: true,
  });
  await api.setMyCommands(BOT_COMMANDS, { scope: { type: "all_group_chats" } });
  // Кнопка «Табло» в личке с ботом
  await api.setChatMenuButton({
    menu_button: { type: "web_app", text: "Табло", web_app: { url: new URL("/app/", c.req.url).toString() } },
  });
  return c.json({ ok: true, webhook: url, info: await api.getWebhookInfo() });
});

/** Ручной запуск расписания для проверки: GET /cron?secret=<WEBHOOK_SECRET> */
app.get("/cron", async (c) => {
  if (c.req.query("secret") !== c.env.WEBHOOK_SECRET) return c.text("forbidden", 403);
  return c.text(await runScheduled(c.env));
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env).then((r) => console.log("cron:", r)));
  },
} satisfies ExportedHandler<Env>;
