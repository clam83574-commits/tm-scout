// Тест экранов Worker на настоящей локальной базе D1.
// Шим повторяет API D1 (prepare/bind/all/first) поверх node:sqlite.
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import * as bot from "./src/index.js";

const dir = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f.length > 30);
// не readOnly: тест пометок пишет в notes
const sqlite = new DatabaseSync(`${dir}/${file}`);
sqlite.exec("CREATE TABLE IF NOT EXISTS notes (player_id TEXT PRIMARY KEY, status TEXT NOT NULL, by_name TEXT, updated_at TEXT)");

const DB = {
  prepare(sql) {
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      all() { return { results: sqlite.prepare(sql).all(...args) }; },
      first() { return sqlite.prepare(sql).get(...args) ?? null; },
    };
    return api;
  },
};
const env = { DB, TM_BOT_ALLOW: "" };

let fails = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "OK  " : "ПРОВАЛ"} ${label}${extra ? " — " + extra : ""}`);
  if (!cond) fails++;
};

const [coTxt, coKb] = await bot.screenCountries(env, "1111", 0);
check("первый экран - страны", coTxt.includes("Выбери страну"));
check("стран немного, а не сотни лиг", coKb.length <= 8, `рядов ${coKb.length}`);
check("свободные агенты отдельной строкой", JSON.stringify(coKb).includes("Без клуба"));

const [lgTxt, lgKb] = await bot.screenLeagues(env, "Germany", "1111");
check("лиги одной страны", lgKb.length === 4, `рядов ${lgKb.length}`);
check("заголовок - страна", lgTxt.includes("Германия"));
check("в лигах Германии 102 кандидата", lgTxt.includes("<b>102</b>"));


const [lg2] = await bot.screenCountries(env, "1101", 0);
check("фильтр 🟢🟡 сужает выборку", lg2.includes("<b>") && !lg2.includes("Под этот фильтр"));

check("лиги по-русски", JSON.stringify(lgKb).includes("3-я лига"));

const [clTxt, clKb] = await bot.screenClubs(env, "L3", "1111");
check("экран клубов L3: 48 кандидатов", clTxt.includes("<b>48</b>"));
check("экран клубов: есть «Вся лига»", JSON.stringify(clKb).includes("Вся лига"));

const [plTxt, plKb] = await bot.screenPlayers(env, "L1", "ALL", 0, "1111", "v");
check("сортировка по цене: сверху Olise", plTxt.includes("Michael Olise"));
check("страниц 1 из 4", plTxt.includes("стр. 1 из 4"));
check("ссылка на Transfermarkt", plTxt.includes('href="https://www.transfermarkt.com/'));
check("кнопки сортировки отмечают текущую", JSON.stringify(plKb).includes("● по цене"));

const [p2] = await bot.screenPlayers(env, "L1", "ALL", 1, "1111", "v");
check("вторая страница отличается", !p2.includes("Michael Olise"));

const [emptyTxt] = await bot.screenPlayers(env, "L2", "ALL", 0, "1001", "s");
check("пустая выборка не падает", emptyTxt.includes("никого нет"));

const [fTxt, fKb] = await bot.screenFilter(env, "L1", "ALL", "1101");
// считаем галочки только среди трёх категорий: ниже есть ещё
// переключатель «показывать отмеченных», он тоже с галочкой
const catRows = JSON.stringify(fKb.slice(0, 3));
check("фильтр: две галочки из трёх", (catRows.match(/☑️/g) || []).length === 2);
check("фильтр: есть переключатель отмеченных",
      JSON.stringify(fKb).includes("показывать отмеченных"));
check("фильтр: третья снята", JSON.stringify(fKb).includes("⬜"));
check("фильтр: счётчики на месте", fTxt.length > 100 &&
      /— \d+/.test(JSON.stringify(fKb.slice(0, 3))));

check("статус подписан словами", plTxt.includes("поле пустое") || plTxt.includes("семья"));
check("заголовок: все три = «все категории»", plTxt.includes("все категории"));
const [subTxt] = await bot.screenPlayers(env, "L1", "ALL", 0, "0101", "s");
check("заголовок при подвыборке перечисляет словами", subTxt.includes("семья"));

console.log("\n--- как выглядит карточка ---");
console.log(plTxt.split("\n\n")[1].replace(/<[^>]+>/g, ""));
console.log("---\n");

// --- пометки ---
const pid = (await bot.screenPlayers(env, "L1", "ALL", 0, "1111", "s"))[0]
  .match(/spieler\/(\d+)/)[1];
sqlite.exec("DELETE FROM notes");
const [markTxt, markKb] = await bot.screenMark(env, "L1", "ALL", 0, "1111", "s");
check("экран «кого отметить» показывает 8", markKb.length === 10, `рядов ${markKb.length}`);
const [noteTxt, noteKb] = await bot.screenNote(env, pid, "L1", "ALL", 0, "1111", "s");
check("карточка игрока: пометки нет", noteTxt.includes("Пометки нет"));
check("карточка: три кнопки пометок", noteKb[0].length === 3);
sqlite.exec(`INSERT INTO notes VALUES ('${pid}','called','Тест','2026-09-11')`);
const [noteTxt2, noteKb2] = await bot.screenNote(env, pid, "L1", "ALL", 0, "1111", "s");
check("карточка показывает пометку", noteTxt2.includes("позвонил") && noteTxt2.includes("Тест"));
check("появилась кнопка снятия", JSON.stringify(noteKb2).includes("Снять"));
const [listTxt] = await bot.screenPlayers(env, "L1", "ALL", 0, "1111", "s");
check("пометка видна в списке", listTxt.includes("📞"));
const before = (await bot.screenPlayers(env, "L1", "ALL", 0, "1111", "s"))[0].match(/— (\d+) кандидат/)[1];
const after = (await bot.screenPlayers(env, "L1", "ALL", 0, "1110", "s"))[0].match(/— (\d+) кандидат/)[1];
check("скрытие отмеченных уменьшает выборку", Number(after) === Number(before) - 1, `${before} -> ${after}`);
sqlite.exec("DELETE FROM notes");

// --- краевые случаи: кнопки в старых сообщениях живут вечно, а данные
// под ними меняются каждую неделю. Раньше это роняло экран молча. ---
const survives = async (label, fn) => {
  try { const r = await fn(); check(label, Array.isArray(r) && typeof r[0] === "string"); }
  catch (e) { check(label, false, e.message.slice(0, 50)); }
};
await survives("страница за пределами выборки", () => bot.screenPlayers(env, "L1", "ALL", 99, "1111", "s"));
await survives("испорченный ключ сортировки", () => bot.screenPlayers(env, "L1", "ALL", 0, "1111", "ZZ"));
await survives("номер страницы не число", () => bot.screenPlayers(env, "L1", "ALL", NaN, "1111", "s"));
await survives("отрицательная страница", () => bot.screenPlayers(env, "L1", "ALL", -5, "1111", "s"));
await survives("страны: страница за пределами", () => bot.screenCountries(env, "1111a", 99));
await survives("лиги: страница за пределами", () => bot.screenLeagues(env, "Belgium", "1111a", 99));
await survives("несуществующая страна", () => bot.screenLeagues(env, "Narnia", "1111a", 0));
await survives("пометки за пределами", () => bot.screenMark(env, "L1", "ALL", 99, "1111", "s"));

const [lgPg, lgPgKb] = await bot.screenLeagues(env, "Belgium", "1111a", 0);
check("в подписи кнопки есть дивизион", /· [1-7] —/.test(JSON.stringify(lgPgKb)),
      lgPgKb[0][0].text);
check("лиги считаются со склонением", lgPg.includes("в 4 лигах"));

// --- прочерки вместо данных ---
// У 79% игроков нет стоимости, у 54% нет даты контракта: Transfermarkt
// ставит там прочерк. Показанный как значение, он ломал вид строки.
sqlite.exec("UPDATE players SET market_value='-', contract_until='-' WHERE player_id=(SELECT player_id FROM players LIMIT 1)");
const [dashTxt] = await bot.screenPlayers(env, "L1", "ALL", 0, "1111a", "s");
check("прочерк не попадает в строку", !/· *- *·/.test(dashTxt) && !/до -/.test(dashTxt));
check("нет висящего разделителя в конце", !/· *$/m.test(dashTxt));
const pidDash = sqlite.prepare("SELECT player_id FROM players WHERE market_value='-' AND contract_until='-' LIMIT 1").get().player_id;
const [cardTxt] = await bot.screenNote(env, pidDash, "L1", "ALL", 0, "1111a", "s");
check("в карточке сказано словами", cardTxt.includes("срок контракта не указан"));
check("в карточке нет голого прочерка", !/· *- *·/.test(cardTxt));

// --- «на главную» на каждом экране ---
// Из списка игроков до стран было три нажатия; кнопка должна быть в одном
// и том же месте, последней строкой, и сохранять выбранный фильтр.
const pidHome = sqlite.prepare("SELECT player_id FROM players LIMIT 1").get().player_id;
const homeScreens = {
  "лиги": await bot.screenLeagues(env, "Germany", "1101x", 0),
  "клубы": await bot.screenClubs(env, "L1", "1101x"),
  "игроки": await bot.screenPlayers(env, "L1", "ALL", 0, "1101x", "s"),
  "фильтр": await bot.screenFilter(env, "L1", "ALL", "1101x"),
  "кого отметить": await bot.screenMark(env, "L1", "ALL", 0, "1101x", "s"),
  "карточка": await bot.screenNote(env, pidHome, "L1", "ALL", 0, "1101x", "s"),
  "пусто": await bot.screenPlayers(env, "L2", "ALL", 0, "1001a", "s"),
  "нет страны": await bot.screenLeagues(env, "Narnia", "1111a", 0),
};
for (const [name, [, kb]] of Object.entries(homeScreens)) {
  const last = kb[kb.length - 1] || [];
  check(`«на главную» последней строкой: ${name}`,
        last.length === 1 && last[0].text.includes("На главную"));
}
check("«на главную» сохраняет фильтр",
      homeScreens["игроки"][1].at(-1)[0].callback_data === "cs|0|1101x");

const s1 = await bot.search(env, "Bellingham");
check("поиск находит Беллингема", s1.includes("Jobe Bellingham"));
const s2 = await bot.search(env, "цйукенг");
check("поиск без результата не падает", s2.includes("не нашёл"));

const esc = await bot.search(env, "'");
check("кавычка в запросе не ломает SQL", typeof esc === "string");

console.log(fails ? `\nПРОВАЛОВ: ${fails}` : "\nвсе проверки прошли");
process.exit(fails ? 1 : 0);
