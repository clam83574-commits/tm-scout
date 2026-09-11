// Тест экранов Worker на настоящей локальной базе D1.
// Шим повторяет API D1 (prepare/bind/all/first) поверх node:sqlite.
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import * as bot from "./src/index.js";

const dir = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f.length > 30);
const sqlite = new DatabaseSync(`${dir}/${file}`, { readOnly: true });

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

const [lgTxt, lgKb] = await bot.screenLeagues(env, "111");
check("экран лиг: всего 102", lgTxt.includes("<b>102</b>"));
check("экран лиг: три лиги + фильтр", lgKb.length === 4, `кнопок ${lgKb.length}`);

const [lg2] = await bot.screenLeagues(env, "110");
check("фильтр 🟢🟡 сужает до 41", lg2.includes("<b>41</b>"));

check("лиги по-русски с флагом", lgTxt.includes("Германия") && JSON.stringify(lgKb).includes("3-я лига"), lgKb[2][0].text);

const [clTxt, clKb] = await bot.screenClubs(env, "L3", "111");
check("экран клубов L3: 48 кандидатов", clTxt.includes("<b>48</b>"));
check("экран клубов: есть «Вся лига»", JSON.stringify(clKb).includes("Вся лига"));

const [plTxt, plKb] = await bot.screenPlayers(env, "L1", "ALL", 0, "111", "v");
check("сортировка по цене: сверху Olise", plTxt.includes("Michael Olise"));
check("страниц 1 из 4", plTxt.includes("стр. 1 из 4"));
check("ссылка на Transfermarkt", plTxt.includes('href="https://www.transfermarkt.com/'));
check("кнопки сортировки отмечают текущую", JSON.stringify(plKb).includes("● по цене"));

const [p2] = await bot.screenPlayers(env, "L1", "ALL", 1, "111", "v");
check("вторая страница отличается", !p2.includes("Michael Olise"));

const [emptyTxt] = await bot.screenPlayers(env, "L2", "ALL", 0, "100", "s");
check("пустая выборка не падает", emptyTxt.includes("никого нет"));

const [fTxt, fKb] = await bot.screenFilter(env, "L1", "ALL", "110");
check("фильтр: две галочки из трёх", JSON.stringify(fKb).match(/☑️/g).length === 2);
check("фильтр: третья снята", JSON.stringify(fKb).includes("⬜"));
check("фильтр: счётчики на месте", fTxt.length > 100 && JSON.stringify(fKb).includes("— 61"));

check("статус подписан словами", plTxt.includes("поле пустое") || plTxt.includes("семья"));
check("заголовок: все три = «все категории»", plTxt.includes("все категории"));
const [subTxt] = await bot.screenPlayers(env, "L1", "ALL", 0, "010", "s");
check("заголовок при подвыборке перечисляет словами", subTxt.includes("семья"));

console.log("\n--- как выглядит карточка ---");
console.log(plTxt.split("\n\n")[1].replace(/<[^>]+>/g, ""));
console.log("---\n");

const s1 = await bot.search(env, "Bellingham");
check("поиск находит Беллингема", s1.includes("Jobe Bellingham"));
const s2 = await bot.search(env, "цйукенг");
check("поиск без результата не падает", s2.includes("не нашёл"));

const esc = await bot.search(env, "'");
check("кавычка в запросе не ломает SQL", typeof esc === "string");

console.log(fails ? `\nПРОВАЛОВ: ${fails}` : "\nвсе проверки прошли");
process.exit(fails ? 1 : 0);
