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
sqlite.exec(`CREATE TABLE IF NOT EXISTS sent (id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_batch TEXT, user_id TEXT, message_id INTEGER, sent_at TEXT, deleted_at TEXT)`);
sqlite.exec("DELETE FROM alerts"); sqlite.exec("DELETE FROM access"); sqlite.exec("DELETE FROM sent");

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

let fails = 0, posted = [], erased = [], nextMid = 500, refuse = false;
const check = (l, c, e = "") => { console.log(`${c ? "OK  " : "ПРОВАЛ"} ${l}${e ? " — " + e : ""}`); if (!c) fails++; };

// Подменяем сеть. Telegram отвечает на sendMessage номером сообщения - без
// него отозвать рассылку нечем, поэтому подмена обязана его возвращать,
// иначе тест «номера записаны» прошёл бы на пустом месте.
globalThis.fetch = async (u, init) => {
  const method = String(u).split("/").pop();
  const body = JSON.parse(init.body);
  if (method === "deleteMessage") {
    erased.push(body);
    if (refuse)
      return { json: async () => ({ ok: false, description: "message can't be deleted" }) };
    return { json: async () => ({ ok: true, result: true }) };
  }
  posted.push(body);
  return { json: async () => ({ ok: true, result: { message_id: nextMid++ } }) };
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

// ОТЗЫВ РАССЫЛКИ. Уведомление уходит живым людям, в том числе клиенту;
// ошибиться в нём - значит послать чужому человеку то, что он не должен был
// видеть. Отозвать сообщение Telegram даёт только по его номеру и списка
// отправленного не отдаёт: номер, не записанный в момент отправки, потерян
// навсегда. Поэтому проверяем не «рассылка ушла», а «её можно вернуть».
sqlite.exec("DELETE FROM alerts"); sqlite.exec("DELETE FROM access"); sqlite.exec("DELETE FROM sent");
sqlite.prepare("INSERT INTO access VALUES (?,?,?)").run("111", "Агент", "now");
const addAlert = (id) => sqlite.prepare(
  "INSERT INTO alerts (ts,player_id,name,club,where_ru,old_status,new_status,mv,mv_eur,url,sent_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)"
).run("2026-09-19", id, "Игрок " + id, "ФК", "🇩🇪", "AGENT", "NO_AGENT", "€1m", 1000000, "https://t/x");

addAlert("a1");
posted = []; erased = [];
const n1 = await bot.notify(env);
const rows = sqlite.prepare("SELECT * FROM sent").all();
check("номер каждого сообщения записан сразу", rows.length === n1.sent, `записей ${rows.length}, отправлено ${n1.sent}`);
check("номера настоящие, а не нули", rows.every((r) => r.message_id >= 500));
check("рассылка получила метку", typeof n1.batch === "string" && n1.batch.length > 0);

addAlert("b1");
const n2 = await bot.notify(env);
check("у второй рассылки своя метка", n2.batch !== n1.batch);

// отзываем только первую - вторая обязана уцелеть
const midsOf = (b) => new Set(sqlite.prepare("SELECT message_id FROM sent WHERE alert_batch=?").all(b).map((r) => r.message_id));
const mine = midsOf(n1.batch), theirs = midsOf(n2.batch);
erased = [];
const rc1 = await bot.recall(env, n1.batch);
check("отозвана только своя рассылка", rc1.deleted === n1.sent, `удалено ${rc1.deleted} из ${n1.sent}`);
check("удалены ровно её номера", erased.length === mine.size && erased.every((e) => mine.has(e.message_id)));
check("чужие сообщения не тронуты", erased.every((e) => !theirs.has(e.message_id)));
const left = sqlite.prepare("SELECT COUNT(*) n FROM sent WHERE deleted_at IS NULL").get();
check("вторая рассылка осталась отзываемой", left.n === n2.sent, `осталось ${left.n}`);

// повтор не должен дёргать Telegram по уже удалённым
erased = [];
const rc2 = await bot.recall(env, n1.batch);
check("повторный отзыв ничего не делает", rc2.deleted === 0 && erased.length === 0);

// Telegram отказал (прошло больше 48 часов): метку НЕ ставим, иначе
// сообщение считалось бы удалённым, а оно висит у получателя
refuse = true;
const rc3 = await bot.recall(env, n2.batch);
refuse = false;
check("отказ Telegram попадает в ответ", rc3.failed.length === n2.sent && rc3.deleted === 0);
const stuck = sqlite.prepare("SELECT COUNT(*) n FROM sent WHERE deleted_at IS NULL").get();
check("неудалённое не помечено удалённым", stuck.n === n2.sent, `не помечено ${stuck.n}`);

// отзыв без метки забирает всё, что ещё висит
const rc4 = await bot.recall(env, null);
check("отзыв всего разом добивает остаток", rc4.deleted === n2.sent, `удалено ${rc4.deleted}`);

sqlite.exec("DELETE FROM alerts"); sqlite.exec("DELETE FROM access"); sqlite.exec("DELETE FROM sent");
console.log(fails ? `\nПРОВАЛОВ: ${fails}` : "\nвсе проверки рассылки прошли");
process.exit(fails ? 1 : 0);
