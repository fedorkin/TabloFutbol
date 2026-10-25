import type { TgUser } from "./db";

const enc = new TextEncoder();
// копия в свежий ArrayBuffer — чтобы типы WebCrypto сходились и в Workers, и в Node
const utf8 = (s: string) => new Uint8Array(enc.encode(s));

async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, utf8(data));
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Проверка initData из Telegram Mini App:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export async function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSec = 7 * 86400,
  now = Date.now(),
): Promise<TgUser | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = await hmac(utf8("WebAppData"), botToken);
  if (!safeEqual(hex(await hmac(secret, dataCheck)), hash)) return null;

  const authDate = Number(params.get("auth_date"));
  if (!authDate || now / 1000 - authDate > maxAgeSec) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "null");
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

/** Для тестов: подписать initData так же, как это делает Telegram. */
export async function signInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  const dataCheck = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = await hmac(utf8("WebAppData"), botToken);
  const params = new URLSearchParams(fields);
  params.set("hash", hex(await hmac(secret, dataCheck)));
  return params.toString();
}
