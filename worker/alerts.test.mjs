// Рассылка «агент пропал»: отправка ровно один раз и никому лишнему.
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import * as bot from "./src/index.js";

const dir = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f.length > 30);
const sqlite = new DatabaseSync(`${dir}/${file}`);
sqlite.exec(`CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT, player_id TEXT, name TEXT, club TEXT, where_ru TEXT, old_status TEXT,
  new_status TEXT, mv TEXT, mv_eur INTEGER, url TEXT, sent_at TEXT)`);
sqlite.exec("CREATE TABLE IF NOT EXISTS access (user_id TEXT PRIMARY KEY, name TEXT, granted_at TEXT)");
sqlite.exec("DELETE FROM alerts"); sqlite.exec("DELETE FROM access");

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

let fails = 0, posted = [];
const check = (l, c, e = "") => { console.log(`${c ? "OK  " : "ПРОВАЛ"} ${l}${e ? " — " + e : ""}`); if (!c) fails++; };

// подменяем сеть: запоминаем, кому и что ушло бы
globalThis.fetch = async (u, init) => {
  posted.push(JSON.parse(init.body));
  return { json: async () => ({ ok: true }) };
};
const env = { DB, TM_BOT_TOKEN: "x", TM_BOT_ALLOW: "777" };

check("без событий никому не шлём", (await bot.notify(env)).sent === 0);

sqlite.prepare("INSERT INTO access VALUES (?,?,?)").run("111", "Агент", "now");
for (const [n, mv] of [["Игрок Дорогой", 170000000], ["Игрок Средний", 900000]])
  sqlite.prepare(
    "INSERT INTO alerts (ts,player_id,name,club,where_ru,old_status,new_status,mv,mv_eur,url,sent_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)"
  ).run("2026-09-19", String(mv), n, "ФК Тест", "🇩🇪 Германия", "AGENT", "NO_AGENT", "€1m", mv, "https://t/x");

posted = [];
const r1 = await bot.notify(env);
check("ушло обоим получателям", r1.users === 2, `получателей ${r1.users}`);
check("событий в рассылке два", r1.alerts === 2);
check("дорогой в тексте", posted.some((p) => p.text.includes("Игрок Дорогой")));
check("есть пояснение, почему это важно", posted.some((p) => p.text.includes("в поиске")));

posted = [];
const r2 = await bot.notify(env);
check("повторно то же не шлётся", r2.sent === 0, `ушло ${r2.sent}`);

// много событий - режется на части
sqlite.exec("DELETE FROM alerts");
for (let i = 0; i < 23; i++)
  sqlite.prepare(
    "INSERT INTO alerts (ts,player_id,name,club,where_ru,old_status,new_status,mv,mv_eur,url,sent_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)"
  ).run("2026-09-19", "p" + i, "Игрок " + i, "ФК", "🇩🇪", "AGENT", "UNKNOWN", "€1m", 1000000, "https://t/x");
posted = [];
await bot.notify(env);
check("длинный список разбит на части", posted.length / 2 === 3, `частей ${posted.length / 2}`);
check("каждая часть влезает в лимит", posted.every((p) => p.text.length < 4096));

sqlite.exec("DELETE FROM alerts"); sqlite.exec("DELETE FROM access");
console.log(fails ? `\nПРОВАЛОВ: ${fails}` : "\nвсе проверки рассылки прошли");
process.exit(fails ? 1 : 0);
