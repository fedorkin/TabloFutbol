import { readdirSync, readFileSync } from "node:fs";

/** Применяет все миграции из migrations/ по порядку. */
export async function applyMigrations(db: D1Database): Promise<void> {
  for (const file of readdirSync("migrations").filter((f: string) => f.endsWith(".sql")).sort()) {
    const sql: string = readFileSync(`migrations/${file}`, "utf8");
    const statements = sql.split(/;\s*\n/).map((s: string) => s.trim());
    for (const stmt of statements.filter((s: string) => s.replace(/--.*$/gm, "").trim())) {
      await db.prepare(stmt).run();
    }
  }
}
