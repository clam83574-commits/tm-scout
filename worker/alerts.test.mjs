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

let fails = 0, posted = [], erased = [], calls = [], nextMid = 500, refuse = false;
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
  calls.push({ method, body });
  if (method === "answerCallbackQuery") return { json: async () => ({ ok: true, result: true }) };
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

// СВОДКА ПОСЛЕ ПРОГОНА. Уходит тем же людям и тем же каналом, поэтому
// обязана быть отзываемой так же, как уведомление: номера пишутся при
// отправке. Отдельная рассылка - самое вероятное место, где про это забудут.
sqlite.exec("DELETE FROM alerts"); sqlite.exec("DELETE FROM access"); sqlite.exec("DELETE FROM sent");
sqlite.prepare("INSERT INTO access VALUES (?,?,?)").run("111", "Агент", "now");
sqlite.prepare("INSERT INTO access VALUES (?,?,?)").run("222", "Клиент", "now");

posted = []; erased = [];
const d0 = await bot.digest(env, "   ");
check("пустая сводка никому не шлётся", d0.sent === 0 && posted.length === 0);

posted = [];
const d1 = await bot.digest(env, `📊 <b>База обновлена</b>
изменений нет`);
check("сводка ушла всем получателям", d1.users === 3 && d1.sent === 3, `получателей ${d1.users}, ушло ${d1.sent}`);
check("текст дошёл целиком", posted.every((p) => p.text.includes("База обновлена")));
check("разметка включена", posted.every((p) => p.parse_mode === "HTML"));
const dRows = sqlite.prepare("SELECT * FROM sent WHERE alert_batch=?").all(d1.batch);
check("номера сводки записаны", dRows.length === d1.sent, `записей ${dRows.length}`);

// длинную сводку режем по строкам, а не по символам - разорванный тег
// HTML Telegram не примет и вернёт ошибку на всю рассылку
posted = [];
const long = Array.from({ length: 400 }, (_, i) => `<b>строка ${i}</b> — текст подлиннее`).join(String.fromCharCode(10))
const d2 = await bot.digest(env, long);
const parts = posted.length / 3;
check("длинная сводка разбита на части", parts > 1, `частей ${parts}`);
check("каждая часть влезает в лимит", posted.every((p) => p.text.length < 4096));
check("теги не разорваны", posted.every((p) => (p.text.match(/<b>/g) || []).length === (p.text.match(/<\/b>/g) || []).length));

// Адресная отправка - механизм правила «проверяй на себе». Без теста он
// тихо сломается, и проверочная рассылка опять уйдёт живым получателям.
posted = [];
const d3 = await bot.digest(env, "проверка", "111");
check("only шлёт ровно одному", d3.sent === 1 && d3.users === 1, `ушло ${d3.sent} на ${d3.users}`);
check("ушло именно ему", posted.length === 1 && String(posted[0].chat_id) === "111");
check("остальные не получили", !posted.some((p) => String(p.chat_id) === "222"));

// Отказ базы при записи номера НЕ должен обрывать рассылку: отправка уже
// состоялась, и если бросить здесь, получатель увидит обрезанную сводку.
// Именно так 23.09 оборвалась сводка на дневном лимите записи D1.
const realPrepare = DB.prepare;
DB.prepare = (sql) => {
  if (sql.startsWith("INSERT INTO sent")) {
    return { bind: () => ({ run() { throw new Error("D1_ERROR: daily write limit"); } }) };
  }
  return realPrepare(sql);
};
posted = [];
const d4 = await bot.digest(env, Array.from({ length: 400 }, (_, i) => `строка ${i} подлиннее`).join(String.fromCharCode(10)), "111");
DB.prepare = realPrepare;
check("рассылка дошла целиком, несмотря на отказ базы", posted.length > 1, `частей ${posted.length}`);
check("неотозываемые номера возвращены наружу", (d4.unrecorded || []).length === posted.length, `сообщено ${(d4.unrecorded || []).length} из ${posted.length}`);

// и сводка отзывается ровно так же, как уведомление
erased = [];
const dr = await bot.recall(env, d1.batch);
check("сводка отзывается целиком", dr.deleted === d1.sent, `удалено ${dr.deleted} из ${d1.sent}`);

// УТРЕННЯЯ ДОСТАВКА. Обход кончается ночью; сводка обязана прийти в 08:30
// МСК, а не в три часа ночи - и ровно один раз.
sqlite.exec("DROP TABLE IF EXISTS digest_queue");
const night = new Date("2026-11-01T23:40:00Z");   // 02:40 МСК
const day = new Date("2026-11-02T07:10:00Z");     // 10:10 МСК
posted = [];
const q1 = await bot.deliverDigest(env, "📊 ночная сводка", null, night);
check("ночью сводка не шлётся, а ждёт утра", q1.queued === true && posted.length === 0, `ушло ${posted.length}`);
const q0 = await bot.deliverDigest(env, "   ", null, night);
check("пустая ночная сводка не встаёт в очередь", !q0.queued);
posted = [];
const q2 = await bot.deliverDigest(env, "проверка ночью", "111", night);
check("адресная проверка уходит сразу и ночью", q2.sent === 1 && posted.length === 1);
posted = [];
const q3 = await bot.deliverDigest(env, "дневная сводка", null, day);
check("днём сводка уходит сразу", q3.sent === 3 && !q3.queued, `ушло ${q3.sent}`);
posted = [];
const f1 = await bot.flushDigests(env);
check("утром придержанная сводка ушла всем", f1.length === 1 && f1[0].sent === 3, `ушло ${f1[0] && f1[0].sent}`);
check("ушла именно ночная", posted.every((p) => p.text.includes("ночная сводка")));
check("утренняя рассылка отзываема", sqlite.prepare("SELECT COUNT(*) n FROM sent WHERE alert_batch=?").get(f1[0].batch).n === 3);
posted = [];
const f2 = await bot.flushDigests(env);
check("второе утро не повторяет сводку", f2.length === 0 && posted.length === 0);
sqlite.exec("DROP TABLE IF EXISTS digest_queue");

// ВЕСЬ СПИСОК ИЗ СВОДКИ. «Остальные в боте» раньше вели в никуда: под
// сводкой должны быть кнопки, и открывать они должны НОВОЕ сообщение -
// обычная кнопка заменила бы текст, и сводка исчезла бы у человека.
sqlite.exec(`CREATE TABLE IF NOT EXISTS players (player_id TEXT PRIMARY KEY, name TEXT,
  url TEXT, club TEXT, agent_status TEXT, market_value TEXT, contract_until TEXT,
  comp TEXT, comp_ru TEXT, comp_name TEXT, flag TEXT, country_ru TEXT)`);
sqlite.exec(`CREATE TABLE IF NOT EXISTS notes (player_id TEXT PRIMARY KEY, status TEXT,
  by_name TEXT, updated_at TEXT)`);
sqlite.exec("DELETE FROM players WHERE player_id LIKE 'tst%'");
sqlite.exec("DROP TABLE IF EXISTS digest_lists");
const tids = Array.from({ length: 25 }, (_, i) => "tst" + i);
for (const [i, id] of tids.entries())
  sqlite.prepare(`INSERT INTO players (player_id,name,url,club,agent_status,market_value,
    contract_until,comp,comp_ru,flag,country_ru) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, "Тестов " + i, "https://t/" + id, "ФК Тест", "NO_AGENT", "€1m", "30/06/2027",
         "MEX1", "Liga MX", "🇲🇽", "Мексика");
const list = { date: "2 ноября", hot_title: "🔥 Пропал агент — дороже 200 тыс. €",
  cheap_title: "Пропал агент — дешевле 200 тыс. €", hot: tids.slice(0, 23), cheap: tids.slice(23) };
const kbOf = (p) => (p.reply_markup && p.reply_markup.inline_keyboard) || null;

posted = [];
await bot.deliverDigest(env, Array.from({ length: 400 }, (_, i) => `строка ${i} подлиннее`).join(String.fromCharCode(10)), "111", day, list);
check("кнопки только под последней частью сводки", posted.length > 1 &&
  posted.slice(0, -1).every((p) => !kbOf(p)) && !!kbOf(posted.at(-1)), `частей ${posted.length}`);
const btns = kbOf(posted.at(-1)).flat();
check("две кнопки: весь список и дешевле порога",
  btns.length === 2 && btns[0].text.includes("23") && btns[1].text.includes("2"));
check("кнопки помещаются в лимит Telegram", btns.every((b) => Buffer.byteLength(b.callback_data) <= 64));

const lid = btns[0].callback_data.split("|")[1];
const [t0, k0] = await bot.screenLost(env, lid, "h", 0);
check("первая страница: десять игроков по порядку", t0.includes("Тестов 0") && t0.includes("Тестов 9") && !t0.includes("Тестов 10"));
check("видно, сколько всего и какая страница", t0.includes("23 игрока") && t0.includes("стр. 1 из 3"));
check("с первой страницы только вперёд", k0[0].length === 1 && k0[0][0].text === "▶️");
const [t2, k2] = await bot.screenLost(env, lid, "h", 2);
check("последняя страница - остаток", t2.includes("Тестов 22") && !t2.includes("Тестов 19"));
check("с последней только назад", k2[0].length === 1 && k2[0][0].text === "◀️");
check("в список дешевле - свои игроки", (await bot.screenLost(env, lid, "c", 0))[0].includes("Тестов 24"));
check("несуществующий список не роняет бота", (await bot.screenLost(env, "99999", "h", 0))[0].includes("не хранится"));

// нажатие под сводкой -> новое сообщение; стрелка внутри списка -> правка
const press = (data) => bot.default.fetch(new Request("https://x/tg", { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ callback_query: { id: "c1", data, from: { id: 111, first_name: "А" },
    message: { message_id: 42, chat: { id: 111 } } } }) }), env);
calls = [];
await press(btns[0].callback_data);
check("кнопка под сводкой открывает НОВОЕ сообщение", calls.some((c) => c.method === "sendMessage") &&
  !calls.some((c) => c.method === "editMessageText"));
calls = [];
await press(k0[0][0].callback_data);
check("стрелка листает список на месте", calls.some((c) => c.method === "editMessageText" && c.body.message_id === 42));

// ночью список ждёт вместе со сводкой и приходит утром с кнопками
posted = [];
await bot.deliverDigest(env, "ночная сводка со списком", null, night, list);
check("ночью ничего не ушло", posted.length === 0);
const fl = await bot.flushDigests(env);
check("утром сводка пришла с кнопками", fl.length === 1 && posted.length === 3 && posted.every((p) => !!kbOf(p)));

sqlite.exec("DELETE FROM players WHERE player_id LIKE 'tst%'");
sqlite.exec("DROP TABLE IF EXISTS digest_lists");
sqlite.exec("DROP TABLE IF EXISTS digest_queue");

sqlite.exec("DELETE FROM alerts"); sqlite.exec("DELETE FROM access"); sqlite.exec("DELETE FROM sent");
console.log(fails ? `\nПРОВАЛОВ: ${fails}` : "\nвсе проверки рассылки прошли");
process.exit(fails ? 1 : 0);
