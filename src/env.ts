export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  GROUP_CHAT_ID: string;
  TIMEZONE: string;
  PLAYER_LIMIT: string;
  GAME_WEEKDAY: string;
  GAME_TIME: string;
  GAME_PLACE: string;
}

export interface Config {
  groupChatId: number;
  timezone: string;
  playerLimit: number;
  gameWeekday: number; // 1 = пн … 7 = вс
  gameTime: string;
  gamePlace: string;
}

export function readConfig(env: Env): Config {
  return {
    groupChatId: Number(env.GROUP_CHAT_ID || 0),
    timezone: env.TIMEZONE || "Asia/Nicosia",
    playerLimit: Number(env.PLAYER_LIMIT || 10),
    gameWeekday: Number(env.GAME_WEEKDAY || 4),
    gameTime: env.GAME_TIME || "",
    gamePlace: env.GAME_PLACE || "",
  };
}
