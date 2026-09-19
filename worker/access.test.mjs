// Проверка кода доступа: тот же шим D1, что и в основном тесте.
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import * as bot from "./src/index.js";

const dir = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f.length > 30);
const sqlite = new DatabaseSync(`${dir}/${file}`);
for (const q of [
  "CREATE TABLE IF NOT EXISTS access (user_id TEXT PRIMARY KEY, name TEXT, granted_at TEXT)",
  "CREATE TABLE IF NOT EXISTS attempts (user_id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, last_ts TEXT)",
  "DELETE FROM access", "DELETE FROM attempts",
]) sqlite.exec(q);

const DB = {
  prepare(sql) {
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      all() { return { results: sqlite.prepare(sql).all(...args) }; },
      first() { return sqlite.prepare(sql).get(...args) ?? null; },
      run() { return sqlite.prepare(sql).run(...args); },
    };
    return api;
  },
};

let fails = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "OK  " : "ПРОВАЛ"} ${label}${extra ? " — " + extra : ""}`);
  if (!cond) fails++;
};

// Выдуманный код: настоящий живёт только в секретах Worker и не должен
// попадать ни в репозиторий, ни в тесты.
const CODE = "SCOUT-TEST-0000";
const env = { DB, TM_ACCESS_CODE: CODE, TM_BOT_ALLOW: "999" };

check("чужой без кода не пущен", !(await bot.allowed(env, 111)));
check("владелец из настроек пущен всегда", await bot.allowed(env, 999));

sqlite.prepare("INSERT INTO access VALUES (?,?,?)").run("111", "Тест", "now");
check("после выдачи доступа пущен", await bot.allowed(env, 111));

check("без кода в настройках бот открыт",
      await bot.allowed({ DB, TM_ACCESS_CODE: "", TM_BOT_ALLOW: "" }, 222));

// счётчик попыток
check("свежему даётся 5 попыток", (await bot.checkAttempts(env, 333)) === 5);
for (let i = 0; i < 5; i++) await bot.noteAttempt(env, 333, false);
check("после 5 промахов заблокирован", (await bot.checkAttempts(env, 333)) === null);
await bot.noteAttempt(env, 333, true);
check("верный код снимает блокировку", (await bot.checkAttempts(env, 333)) === 5);

// срок блокировки истекает
sqlite.prepare("INSERT OR REPLACE INTO attempts VALUES (?,?,?)")
  .run("444", 9, new Date(Date.now() - 61 * 60000).toISOString());
check("через час блокировка спадает", (await bot.checkAttempts(env, 444)) === 5);

console.log(fails ? `\nПРОВАЛОВ: ${fails}` : "\nвсе проверки доступа прошли");
process.exit(fails ? 1 : 0);
