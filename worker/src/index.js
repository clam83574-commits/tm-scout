/**
 * tm-scout bot на Cloudflare Workers.
 *
 * Порт bot.py: та же навигация и те же три независимых переключателя
 * категорий, но вместо long polling — вебхук, а вместо локального SQLite — D1.
 * Запросы остались на SQL, поэтому логика перенеслась почти дословно.
 *
 * Маршруты:
 *   POST /tg   — вебхук Telegram (подписан заголовком secret_token)
 *   GET  /     — проверка живости
 */

const PAGE = 8;

// Порядок = порядок бит в строке фильтра ("111").
// Все три показываются по умолчанию: агент сам решает, кого звать,
// наша работа — убрать из его поля зрения тех, у кого агент уже есть.
const CATS = [
  { status: "NO_AGENT", badge: "🟢", label: "агента нет" },
  { status: "RELATIVES", badge: "🟡", label: "семья" },
  { status: "UNKNOWN", badge: "⚪", label: "поле пустое" },
];
// Пометки общие на всех, кто пользуется ботом, а не личные: агенту и
// владельцу важно видеть, что этому игроку уже звонили — иначе двое будут
// набирать одного и того же.
const NOTES = [
  { key: "called", icon: "📞", label: "позвонил" },
  { key: "noreply", icon: "🔇", label: "не отвечает" },
  { key: "refused", icon: "❌", label: "отказ" },
];
const NOTE_ICON = Object.fromEntries(NOTES.map((n) => [n.key, n.icon]));
const NOTE_LABEL = Object.fromEntries(NOTES.map((n) => [n.key, n.label]));

// Строка фильтра: три разряда под категории + четвёртый «показывать
// отмеченных». Старые трёхсимвольные строки из ранее отправленных
// сообщений продолжают работать — недостающий разряд считается «1».
// Пятый разряд фильтра - положение с контрактом. «Свободный» для агента
// бывает двух видов, и оба важны: уже без клуба (брать хоть завтра, никому
// не платя) и контракт на исходе (за полгода до конца игрок вправе сам
// договариваться с кем угодно). Второй вид как раз и есть окно, в котором
// агента ищут.
const CONTRACT = {
  a: { label: "любой", sql: "" },
  x: {
    label: "кончается ≤6 мес",
    sql: " AND (comp='FREE' OR (contract_days IS NOT NULL AND contract_days BETWEEN 0 AND 183))",
  },
  f: { label: "уже без клуба", sql: " AND comp='FREE'" },
};
const CONTRACT_ORDER = ["a", "x", "f"];

const ALLON = "1".repeat(CATS.length) + "1" + "a";
const showMarked = (flt) => flt[CATS.length] !== "0";
const contractMode = (flt) => (CONTRACT[flt[CATS.length + 1]] ? flt[CATS.length + 1] : "a");
const contractSql = (flt) => CONTRACT[contractMode(flt)].sql;
const BADGE = Object.fromEntries(CATS.map((c) => [c.status, c.badge]));
// Кружок без подписи ничего не говорит тому, кто бота не настраивал,
// поэтому в списке статус дублируется словами.
const LABEL = Object.fromEntries(CATS.map((c) => [c.status, c.label]));

const ORDERS = {
  s: [
    "CASE agent_status WHEN 'NO_AGENT' THEN 0 WHEN 'RELATIVES' THEN 1 ELSE 2 END, club, name",
    "по точности",
  ],
  v: ["mv_eur DESC, name", "по цене"],
  a: ["age IS NULL, age ASC, name", "по возрасту"],
  c: ["contract_iso = '', contract_iso ASC, name", "по контракту"],
};

const statuses = (flt) => {
  const on = CATS.filter((_, i) => flt[i] === "1").map((c) => c.status);
  return on.length ? on : CATS.map((c) => c.status);
};

const fltLabel = (flt) => {
  const on = CATS.filter((_, i) => flt[i] === "1");
  const list = on.length ? on : CATS;
  const badges = list.map((c) => c.badge).join("");
  const cats =
    list.length === CATS.length
      ? `${badges} все категории`
      : `${badges} ${list.map((c) => c.label).join(" + ")}`;
  const cm = contractMode(flt);
  return cm === "a" ? cats : `${cats} · ⏳ ${CONTRACT[cm].label}`;
};

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const marks = (n) => new Array(n).fill("?").join(",");

/**
 * Приведение параметров из callback_data к безопасным значениям.
 *
 * Кнопки живут в истории переписки вечно, а данные под ними меняются каждую
 * неделю. Нажатие на «вперёд» в прошлогоднем сообщении приходит с номером
 * страницы, которой уже нет, и запрос возвращает пусто - а код брал
 * results[0]. Ошибку глотал общий try/catch, и кнопка просто переставала
 * работать без единого следа. То же с испорченным ключом сортировки.
 */
const safePage = (p, pages) => {
  const n = parseInt(p, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (pages != null && n >= pages) return Math.max(0, pages - 1);
  return n;
};
const safeSort = (s) => (ORDERS[s] ? s : "s");

/** Русское склонение после числа: 1 стране, 2 странах, 5 странах. */
const plural = (n, one, few, many) => {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
};

/**
 * Есть ли в поле настоящее значение.
 *
 * Transfermarkt ставит прочерк там, где данных нет, и таких полей много:
 * стоимости нет у 79% игроков, даты контракта у 54% - в низших и молодёжных
 * лигах их просто не заполняют. Прочерк, вставленный в строку как значение,
 * давал «27 г. · - · контракт до -» и выглядел как сломанная вёрстка.
 */
const has = (v) => {
  const s = String(v ?? "").trim();
  return s !== "" && s !== "-" && s !== "—" && s !== "?";
};

/** У игрока без клуба дата в поле «контракт» - это день, С которого он свободен. */
const contractLine = (r) => {
  if (!has(r.contract_until)) return "";
  return r.comp === "FREE"
    ? `свободен с ${r.contract_until}`
    : `контракт до ${r.contract_until}`;
};

// ------------------------------------------------------------------ Telegram
async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.TM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

function send(env, chat, text, kb, edit) {
  const p = {
    chat_id: chat,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  if (kb) p.reply_markup = { inline_keyboard: kb };
  if (edit) {
    p.message_id = edit;
    return tg(env, "editMessageText", p);
  }
  return tg(env, "sendMessage", p);
}

/**
 * Кнопка «на главную» последней строкой.
 *
 * Возврат по одному уровню сохранён - он нужен, когда листаешь клубы внутри
 * лиги. Но из списка игроков до стран было три нажатия, и это раздражает
 * больше всего при обычной работе: посмотрел одну лигу, пошёл в другую.
 * Фильтр в ссылке сохраняется, иначе настройки сбрасывались бы каждый раз.
 */
const withHome = (kb, flt) => [
  ...kb,
  [{ text: "🏠 На главную", callback_data: `cs|0|${flt}` }],
];

function rowsKb(items, perRow = 2) {
  const kb = [];
  for (let i = 0; i < items.length; i += perRow) {
    kb.push(
      items.slice(i, i + perRow).map(([text, data]) => ({ text, callback_data: data }))
    );
  }
  return kb;
}

// -------------------------------------------------------------------- экраны
// Название лиги для показа: русское, если оно есть в данных, иначе исходное
// с Transfermarkt. Фолбэк нужен на случай новой лиги, которую ещё не внесли
// в DISPLAY в scout.py — лучше английское имя, чем пустая кнопка.
const compName = (r) => r.comp_ru || r.comp_name || r.comp;
const withFlag = (r) => (r.flag ? `${r.flag} ` : "") + compName(r);

const COUNTRIES_PAGE = 12;

/**
 * Первый экран: страны. Раньше здесь сразу вываливался плоский список всех
 * лиг - с одной страной это ещё читалось, а на мировых данных превращается
 * в ленту из сотен строк, по которой невозможно ничего найти.
 * Страны идут по убыванию числа кандидатов: нужные окажутся сверху.
 */
/**
 * Сколько ОТМЕЧЕННЫХ игроков в каждой стране (или лиге).
 *
 * Сводка считается при заливке данных и о пометках ничего не знает - их
 * ставят потом. Пометок мало, поэтому дешевле вычесть их из готовых чисел,
 * чем пересчитывать всё по большой таблице.
 */
async function markedCounts(env, field) {
  const { results } = await env.DB.prepare(
    `SELECT p.${field} k, COUNT(*) n FROM notes t
     JOIN players p ON p.player_id = t.player_id GROUP BY p.${field}`
  ).all();
  return Object.fromEntries(results.map((r) => [r.k, r.n]));
}

async function screenCountries(env, flt, page = 0) {
  page = safePage(page);
  const st = statuses(flt);
  // Считаем по сводной таблице, а не по 134 тысячам строк: раньше одно
  // нажатие вычитывало 269 тысяч строк, то есть меньше двадцати открытий
  // в сутки на бесплатном тарифе D1. Теперь около двух с половиной тысяч.
  const [countsRes, minus] = await Promise.all([
    env.DB.prepare(
      `SELECT country, MAX(country_ru) country_ru, MAX(flag) flag, SUM(n) n
       FROM stats WHERE bucket=? AND agent_status IN (${marks(st.length)})
       GROUP BY country`
    )
      .bind(contractMode(flt), ...st)
      .all(),
    showMarked(flt) ? Promise.resolve({}) : markedCounts(env, "country"),
  ]);
  const results = countsRes.results
    .map((r) => ({ ...r, n: r.n - (minus[r.country] || 0) }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n || String(a.country).localeCompare(b.country));
  if (!results.length) {
    return [
      "Под этот фильтр никто не подходит.",
      [[{ text: "⚙️ Фильтр", callback_data: `f|-|-|${flt}` }]],
    ];
  }
  const total = results.reduce((a, r) => a + r.n, 0);
  const pages = Math.ceil(results.length / COUNTRIES_PAGE);
  const slice = results.slice(page * COUNTRIES_PAGE, (page + 1) * COUNTRIES_PAGE);
  const txt =
    `<b>Игроки без агента</b>\n${fltLabel(flt)} — всего <b>${total}</b> ` +
    `в ${results.length} ${plural(results.length, "стране", "странах", "странах")}` +
    `\n\n<i>Или просто пришлите фамилию игрока либо название клуба.</i>` +
    `\n\nВыбери страну` +
    (pages > 1 ? ` (стр. ${page + 1} из ${pages})` : "") + ":";
  const kb = rowsKb(
    slice.map((r) => [
      `${r.flag ? r.flag + " " : ""}${r.country_ru || r.country} — ${r.n}`,
      `lg|${r.country}|${flt}`,
    ]),
    2
  );
  const nav = [];
  if (page) nav.push({ text: "◀️", callback_data: `cs|${page - 1}|${flt}` });
  if (page + 1 < pages) nav.push({ text: "▶️", callback_data: `cs|${page + 1}|${flt}` });
  if (nav.length) kb.push(nav);
  kb.push([{ text: "⚙️ Фильтр: " + fltLabel(flt), callback_data: `f|-|-|${flt}` }]);
  return [txt, kb];
}

/**
 * Лиги одной страны, постранично.
 *
 * Постраничность здесь не про красоту: в Германии 74 лиги вместе со всеми
 * региональными - без неё экран превращается в ленту кнопок, по которой
 * ничего не найти. Порядок - по дивизиону, поэтому первый экран это всегда
 * профессиональные лиги, а не какая-нибудь Landesliga Hammonia.
 */
async function screenLeagues(env, country, flt, page = 0) {
  page = safePage(page);
  const st = statuses(flt);
  // По сводке, как и экран стран: у Германии 23 тысячи кандидатов, считать
  // их заново на каждое открытие списка лиг незачем.
  const [compsRes, minus] = await Promise.all([
    env.DB.prepare(
      `SELECT comp, MAX(comp_name) comp_name, MAX(comp_ru) comp_ru, MAX(flag) flag,
              MAX(country_ru) country_ru, MIN(tier) tier, SUM(n) n
       FROM stats WHERE country=? AND bucket=? AND agent_status IN (${marks(st.length)})
       GROUP BY comp`
    )
      .bind(country, contractMode(flt), ...st)
      .all(),
    showMarked(flt) ? Promise.resolve({}) : markedCounts(env, "comp"),
  ]);
  const results = compsRes.results
    .map((r) => ({ ...r, n: r.n - (minus[r.comp] || 0) }))
    .filter((r) => r.n > 0)
    .sort((a, b) => (a.tier || 99) - (b.tier || 99) || b.n - a.n);
  if (!results.length) {
    return ["В этой стране под фильтр никто не подходит.", withHome([], flt)];
  }
  const total = results.reduce((a, r) => a + r.n, 0);
  const pages = Math.ceil(results.length / COUNTRIES_PAGE);
  page = safePage(page, pages);
  const slice = results.slice(page * COUNTRIES_PAGE, (page + 1) * COUNTRIES_PAGE);
  const head = `${results[0].flag ? results[0].flag + " " : ""}${results[0].country_ru || country}`;
  const txt =
    `<b>${esc(head)}</b>\n${fltLabel(flt)} — кандидатов <b>${total}</b> ` +
    `в ${results.length} ${plural(results.length, "лиге", "лигах", "лигах")}` +
    (pages > 1 ? `\nстр. ${page + 1} из ${pages}` : "") +
    `\n\nВыбери лигу:`;
  const kb = rowsKb(
    slice.map((r) => [
      // номер дивизиона в подписи: когда лиг под сотню, «Оберлига» без
      // указания уровня не говорит ничего
      `${compName(r)}${r.tier && r.tier <= 7 ? ` · ${r.tier}` : r.tier === 90 ? " · мол." : ""} — ${r.n}`,
      `cl|${r.comp}|${flt}`,
    ]),
    1
  );
  const nav = [];
  if (page) nav.push({ text: "◀️", callback_data: `lg|${country}|${flt}|${page - 1}` });
  if (page + 1 < pages)
    nav.push({ text: "▶️", callback_data: `lg|${country}|${flt}|${page + 1}` });
  if (nav.length) kb.push(nav);
  return [txt, withHome(kb, flt)];
}

async function screenClubs(env, comp, flt) {
  const st = statuses(flt);
  const { results } = await env.DB.prepare(
    `SELECT club_id, club, COUNT(*) n FROM players
     WHERE comp=? AND agent_status IN (${marks(st.length)})${contractSql(flt)}
     GROUP BY club_id ORDER BY club`
  )
    .bind(comp, ...st)
    .all();
  const name = await env.DB.prepare(
    "SELECT comp_name, comp_ru, country, country_ru, flag FROM players WHERE comp=? LIMIT 1"
  )
    .bind(comp)
    .first();
  const total = results.reduce((a, r) => a + r.n, 0);
  const head = name ? withFlag(name) : comp;
  const country = name && name.country_ru ? `${name.country_ru} · ` : "";
  const txt =
    `<b>${esc(head)}</b>\n${country}${fltLabel(flt)} — кандидатов ` +
    `<b>${total}</b>\n\nВыбери клуб или смотри всю лигу:`;
  const kb = [
    [{ text: `📋 Вся лига (${total})`, callback_data: `p|${comp}|ALL|0|${flt}|s` }],
  ];
  kb.push(
    ...rowsKb(
      results.map((r) => [
        `${r.club.slice(0, 22)} (${r.n})`,
        `p|${comp}|${r.club_id}|0|${flt}|s`,
      ])
    )
  );
  kb.push([
    { text: "⚙️ Фильтр: " + fltLabel(flt), callback_data: `f|${comp}|-|${flt}` },
    {
      text: "◀️ К лигам",
      callback_data: name && name.country ? `lg|${name.country}|${flt}` : `cs|0|${flt}`,
    },
  ]);
  return [txt, withHome(kb, flt)];
}

async function screenPlayers(env, comp, clubId, page, flt, srt = "s") {
  srt = safeSort(srt);
  const st = statuses(flt);
  let where = `comp=? AND agent_status IN (${marks(st.length)})`;
  const args = [comp, ...st];
  if (clubId !== "ALL") {
    where += " AND club_id=?";
    args.push(clubId);
  }
  // Скрыть уже отработанных: агент не хочет каждую неделю смотреть на тех,
  // кому уже звонил. Подзапрос, а не JOIN, чтобы не задваивать строки.
  if (!showMarked(flt)) {
    where += " AND player_id NOT IN (SELECT player_id FROM notes)";
  }
  where += contractSql(flt);
  const cnt = await env.DB.prepare(`SELECT COUNT(*) n FROM players WHERE ${where}`)
    .bind(...args)
    .first();
  const total = cnt.n;   // нужен до выборки: от него зависит номер страницы
  if (!total) {
    return [
      "Под этот фильтр здесь никого нет.",
      withHome(
        [
          [
            { text: "⚙️ Фильтр", callback_data: `f|${comp}|${clubId}|${flt}` },
            { text: "◀️ К клубам", callback_data: `cl|${comp}|${flt}` },
          ],
        ],
        flt
      ),
    ];
  }
  const pages = Math.ceil(total / PAGE);
  page = safePage(page, pages);
  const { results } = await env.DB.prepare(
    `SELECT * FROM players WHERE ${where} ORDER BY ${ORDERS[srt][0]} LIMIT ? OFFSET ?`
  )
    .bind(...args, PAGE, page * PAGE)
    .all();
  if (!results.length) {
    return [
      "Список изменился, эта страница опустела.",
      withHome([[{ text: "◀️ К клубам", callback_data: `cl|${comp}|${flt}` }]], flt),
    ];
  }

  // Пометки только для показанных восьми - одним запросом, а не восемью
  const ids = results.map((r) => r.player_id);
  const noted = {};
  if (ids.length) {
    const { results: ns } = await env.DB.prepare(
      `SELECT player_id, status, by_name FROM notes WHERE player_id IN (${marks(ids.length)})`
    )
      .bind(...ids)
      .all();
    for (const n of ns) noted[n.player_id] = n;
  }

  const head = clubId !== "ALL" ? results[0].club : withFlag(results[0]);
  const lines = [
    `<b>${esc(head)}</b> — ${total} кандидатов\n${fltLabel(flt)} · ` +
      `${ORDERS[srt][1]} · стр. ${page + 1} из ${Math.ceil(total / PAGE)}\n`,
  ];
  for (const r of results) {
    // всё, чего нет, просто не показываем: пустое место честнее прочерка
    const bits = [
      has(r.position) ? r.position : "",
      r.age ? `${r.age} г.` : "",
      has(r.market_value) ? r.market_value : "",
      contractLine(r),
    ]
      .filter(Boolean)
      .join(" · ");
    const n = noted[r.player_id];
    const mark = n ? `${NOTE_ICON[n.status] || "•"} <b>${NOTE_LABEL[n.status] || n.status}</b>` +
      (n.by_name ? ` · ${esc(n.by_name)}` : "") + "\n    " : "";
    lines.push(
      `${BADGE[r.agent_status] || "·"} <a href="${r.url}"><b>${esc(r.name)}</b></a>` +
        ` · ${LABEL[r.agent_status] || "?"}\n    ${mark}` +
        `<i>${esc(r.club)}</i>\n    ${esc(bits)}`
    );
  }

  const step = (p) => `p|${comp}|${clubId}|${p}|${flt}|${srt}`;
  const nav = [];
  if (page) nav.push({ text: "◀️", callback_data: step(page - 1) });
  if ((page + 1) * PAGE < total) nav.push({ text: "▶️", callback_data: step(page + 1) });
  const kb = nav.length ? [nav] : [];
  kb.push(
    Object.entries(ORDERS).map(([k, v]) => ({
      text: (k === srt ? "● " : "") + v[1],
      callback_data: `p|${comp}|${clubId}|0|${flt}|${k}`,
    }))
  );
  kb.push([
    { text: "📝 Отметить", callback_data: `m|${comp}|${clubId}|${page}|${flt}|${srt}` },
    { text: "⚙️ Фильтр", callback_data: `f|${comp}|${clubId}|${flt}` },
    { text: "◀️ К клубам", callback_data: `cl|${comp}|${flt}` },
  ]);
  return [lines.join("\n\n"), withHome(kb, flt)];
}

/** Выбор игрока со страницы, чтобы поставить ему пометку. */
async function screenMark(env, comp, clubId, page, flt, srt) {
  const st = statuses(flt);
  let where = `comp=? AND agent_status IN (${marks(st.length)})`;
  const args = [comp, ...st];
  if (clubId !== "ALL") {
    where += " AND club_id=?";
    args.push(clubId);
  }
  if (!showMarked(flt)) {
    where += " AND player_id NOT IN (SELECT player_id FROM notes)";
  }
  where += contractSql(flt);
  const { results } = await env.DB.prepare(
    `SELECT player_id, name, club FROM players WHERE ${where} ORDER BY ${ORDERS[srt][0]} LIMIT ? OFFSET ?`
  )
    .bind(...args, PAGE, page * PAGE)
    .all();
  const back = `p|${comp}|${clubId}|${page}|${flt}|${srt}`;
  if (!results.length) {
    return ["Некого отмечать.",
            withHome([[{ text: "◀️ Назад", callback_data: back }]], flt)];
  }
  let kb = results.map((r) => [
    {
      text: `${r.name.slice(0, 28)} — ${r.club.slice(0, 16)}`,
      callback_data: `nt|${r.player_id}|${comp}|${clubId}|${page}|${flt}|${srt}`,
    },
  ]);
  kb.push([{ text: "◀️ Назад", callback_data: back }]);
  kb = withHome(kb, flt);
  return ["<b>Кого отметить?</b>\nВыбери игрока с этой страницы:", kb];
}

/** Карточка одного игрока и кнопки пометок. */
async function screenNote(env, pid, comp, clubId, page, flt, srt) {
  const p = await env.DB.prepare("SELECT * FROM players WHERE player_id=?")
    .bind(pid)
    .first();
  const n = await env.DB.prepare("SELECT * FROM notes WHERE player_id=?")
    .bind(pid)
    .first();
  const back = `p|${comp}|${clubId}|${page}|${flt}|${srt}`;
  if (!p) return ["Игрок не найден.",
                  withHome([[{ text: "◀️ Назад", callback_data: back }]], flt)];

  const bits = [
    has(p.position) ? p.position : "",
    p.age ? `${p.age} г.` : "",
    has(p.market_value) ? p.market_value : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // В карточке, в отличие от списка, отсутствие срока стоит назвать словами:
  // «не указан» и «нет контракта» — разные вещи, и агенту важно не спутать.
  const contract = contractLine(p)
    ? contractLine(p) +
      (p.contract_days != null && p.contract_days > 0 ? ` (${p.contract_days} дн.)` : "")
    : "срок контракта не указан";
  let txt =
    `${BADGE[p.agent_status] || "·"} <a href="${p.url}"><b>${esc(p.name)}</b></a> · ` +
    `${LABEL[p.agent_status] || "?"}\n<i>${esc(p.club)}</i>\n` +
    (bits ? `${esc(bits)}\n` : "") +
    contract;
  if (has(p.citizenship)) txt += `\nгражданство: ${esc(p.citizenship)}`;
  const body = [p.height, p.foot].filter(has).join(" · ");
  if (body) txt += `\n${esc(body)}`;
  if (p.socials) {
    const links = p.socials
      .split(" ")
      .filter(Boolean)
      .map((u) => {
        const host = (u.match(/https?:\/\/(?:www\.)?([^./]+)/) || [])[1] || "ссылка";
        return `<a href="${u}">${host}</a>`;
      });
    txt += `\nсвязь: ${links.join(" · ")}`;
  }
  txt += n
    ? `\n\nСейчас: ${NOTE_ICON[n.status] || "•"} <b>${NOTE_LABEL[n.status] || n.status}</b>` +
      (n.by_name ? ` (${esc(n.by_name)})` : "")
    : "\n\nПометки нет.";

  const tail = `${pid}|${comp}|${clubId}|${page}|${flt}|${srt}`;
  const kb = [
    NOTES.map((x) => ({ text: `${x.icon} ${x.label}`, callback_data: `ns|${x.key}|${tail}` })),
  ];
  if (n) kb.push([{ text: "🧹 Снять пометку", callback_data: `ns|clear|${tail}` }]);
  kb.push([{ text: "◀️ К списку", callback_data: back }]);
  return [txt, withHome(kb, flt)];
}

async function screenFilter(env, comp, clubId, flt) {
  // тоже по сводке: счётчики у галочек не стоят полного прохода по базе
  const { results } = await env.DB.prepare(
    "SELECT agent_status, SUM(n) n FROM stats WHERE bucket=? GROUP BY agent_status"
  )
    .bind(contractMode(flt))
    .all();
  const counts = Object.fromEntries(results.map((r) => [r.agent_status, r.n]));
  const txt =
    "<b>Кого показывать</b>\n\n" +
    "🟢 <b>агента нет</b> — на Transfermarkt прямо проставлено «no agent».\n" +
    "🟡 <b>семья</b> — ведёт родня либо агент вписан текстом без ссылки на агентство.\n" +
    "⚪ <b>поле пустое</b> — строки про агента на странице нет вовсе.\n\n" +
    "Включай любой комбинацией. По умолчанию все три — это ровно те страницы, " +
    "которые иначе пришлось бы открывать руками.\n\n" +
    "<b>Контракт</b> — отдельный срез:\n" +
    "• <b>кончается ≤6 мес</b> — игрок уже вправе сам договариваться о новом " +
    "клубе, это и есть окно, когда ищут агента;\n" +
    "• <b>уже без клуба</b> — контракт закончился, брать можно хоть завтра и " +
    "никому не платя.";
  const kb = CATS.map((c, i) => {
    const on = flt[i] === "1";
    const next = flt.slice(0, i) + (on ? "0" : "1") + flt.slice(i + 1);
    return [
      {
        text: `${on ? "☑️" : "⬜"} ${c.badge} ${c.label} — ${counts[c.status] || 0}`,
        callback_data: `f|${comp}|${clubId}|${next}`,
      },
    ];
  });
  // Четвёртый разряд фильтра - показывать ли уже отмеченных
  const marked = showMarked(flt);
  const flipped = flt.slice(0, CATS.length) + (marked ? "0" : "1") + contractMode(flt);
  kb.push([
    {
      text: `${marked ? "☑️" : "⬜"} показывать отмеченных`,
      callback_data: `f|${comp}|${clubId}|${flipped}`,
    },
  ]);
  // Пятый разряд - положение с контрактом, кнопка перебирает значения
  const cm = contractMode(flt);
  const next = CONTRACT_ORDER[(CONTRACT_ORDER.indexOf(cm) + 1) % CONTRACT_ORDER.length];
  kb.push([
    {
      text: `⏳ Контракт: ${CONTRACT[cm].label}`,
      callback_data: `f|${comp}|${clubId}|${flt.slice(0, CATS.length + 1)}${next}`,
    },
  ]);
  let back = comp !== "-" ? `cl|${comp}|${flt}` : `cs|0|${flt}`;
  if (comp !== "-" && clubId !== "-") back = `p|${comp}|${clubId}|0|${flt}|s`;
  kb.push([{ text: "✅ Применить", callback_data: back }]);
  return [txt, withHome(kb, flt)];
}

const SEARCH_CLUBS = 6;
const SEARCH_PLAYERS = 8;

/**
 * Поиск одной строкой: и по игроку, и по клубу.
 *
 * Спрашивать «кого ищем, игрока или клуб?» - лишний шаг: человек и так знает,
 * что набрал. Ищем в обоих справочниках и показываем что нашлось; клубы
 * кнопками (нажал - открыл состав), игроки списком со ссылками.
 *
 * Игроки ищутся ПО НАЧАЛУ фамилии или имени сравнением диапазона: LIKE с
 * ведущим процентом индекс использовать не умеет и читал бы все 134 тысячи
 * строк - это 37 поисков в сутки на бесплатном лимите. Клубы ищутся
 * подстрокой, но по отдельной таблице в 7 тысяч строк: там нужное слово
 * редко стоит первым («1.FC Köln», «SV Werder Bremen»).
 */
async function search(env, query, flt = ALLON) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) {
    return ["Слишком короткий запрос — нужно хотя бы две буквы.", withHome([], flt)];
  }
  const hi = q + "￿";

  const [clubsRes, playersRes] = await Promise.all([
    env.DB.prepare(
      "SELECT club_id, club, comp, comp_ru, comp_name, flag, country_ru, n " +
        "FROM clubs WHERE club_key LIKE ? ORDER BY n DESC LIMIT ?"
    )
      .bind(`%${q}%`, SEARCH_CLUBS)
      .all(),
    env.DB.prepare(
      "SELECT * FROM players WHERE (last_key >= ?1 AND last_key < ?2) " +
        "OR (name_key >= ?1 AND name_key < ?2) " +
        "ORDER BY mv_eur DESC, name LIMIT ?3"
    )
      .bind(q, hi, SEARCH_PLAYERS)
      .all(),
  ]);

  const clubs = clubsRes.results;
  const players = playersRes.results;
  if (!clubs.length && !players.length) {
    return [
      `По запросу «${esc(query)}» ничего не нашлось.\n\n` +
        "Игроков ищу по началу фамилии или имени, клубы — по любой части " +
        "названия. Если игрок не найден, значит у него записан агент " +
        "или его лига пока не собрана.",
      withHome([], flt),
    ];
  }

  const out = [];
  const kb = [];
  if (clubs.length) {
    out.push(`<b>Клубы</b> — нажмите, чтобы открыть состав:`);
    for (const c of clubs) {
      const where = [c.flag, c.comp_ru || c.comp_name].filter(Boolean).join(" ");
      kb.push([
        {
          text: `${c.club} (${c.n}) · ${c.comp_ru || c.comp_name || c.comp}`.slice(0, 60),
          callback_data: `p|${c.comp}|${c.club_id}|0|${flt}|s`,
        },
      ]);
      out.push(`  ${esc(c.club)} — ${c.n} · ${esc(where)}`);
    }
    out.push("");
  }
  if (players.length) {
    out.push("<b>Игроки</b>");
    for (const r of players) {
      const bits = [
        has(r.position) ? r.position : "",
        r.age ? `${r.age} г.` : "",
        has(r.market_value) ? r.market_value : "",
      ]
        .filter(Boolean)
        .join(" · ");
      out.push(
        `${BADGE[r.agent_status] || "·"} <a href="${r.url}">${esc(r.name)}</a> · ` +
          `${LABEL[r.agent_status] || "?"}\n    <i>${esc(r.club)}</i>` +
          (bits ? `\n    ${esc(bits)}` : "")
      );
    }
    if (players.length === SEARCH_PLAYERS) {
      out.push("<i>Показаны первые " + SEARCH_PLAYERS + ". Уточните запрос.</i>");
    }
  }
  return [out.join("\n"), withHome(kb, flt)];
}

// ------------------------------------------------------------- маршрутизация
const MAX_TRIES = 5;          // попыток подряд
const LOCK_MINUTES = 60;      // и на сколько блокируем после них

/** Хозяева, вписанные в настройки: их доступ не зависит от базы и кода. */
const isOwner = (env, uid) =>
  (env.TM_BOT_ALLOW || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(uid));

/**
 * Пускать ли пользователя.
 *
 * Доступ по коду, а не по списку id: список требует, чтобы каждый новый
 * человек сначала прислал свой номер, а владелец его вписал и переопубликовал
 * бота. Код выдаётся словами и работает сразу.
 *
 * Введённый код запоминается: заставлять набирать его каждый раз — верный
 * способ, чтобы код записали в заметки и он утёк.
 */
async function allowed(env, uid) {
  if (isOwner(env, uid)) return true;
  if (!env.TM_ACCESS_CODE) return true;   // код не задан - бот открыт
  const row = await env.DB.prepare("SELECT 1 FROM access WHERE user_id=?")
    .bind(String(uid))
    .first();
  return !!row;
}

/** Сколько осталось попыток; null - заблокирован до истечения срока. */
async function checkAttempts(env, uid) {
  const r = await env.DB.prepare("SELECT n, last_ts FROM attempts WHERE user_id=?")
    .bind(String(uid))
    .first();
  if (!r) return MAX_TRIES;
  const age = (Date.now() - Date.parse(r.last_ts || 0)) / 60000;
  if (age > LOCK_MINUTES) return MAX_TRIES;      // срок истёк, счётчик не в счёт
  return r.n >= MAX_TRIES ? null : MAX_TRIES - r.n;
}

async function noteAttempt(env, uid, ok) {
  if (ok) {
    await env.DB.prepare("DELETE FROM attempts WHERE user_id=?").bind(String(uid)).run();
    return;
  }
  await env.DB.prepare(
    "INSERT INTO attempts (user_id, n, last_ts) VALUES (?,1,?) " +
      "ON CONFLICT(user_id) DO UPDATE SET n = n + 1, last_ts = excluded.last_ts"
  )
    .bind(String(uid), new Date().toISOString())
    .run();
}

const ASK_CODE =
  "🔒 <b>Бот закрытый</b>\n\n" +
  "Доступ выдают разработчики. Пришлите код доступа одним сообщением — " +
  "он выглядит так: <code>SCOUT-XXXX-XXXX</code>.\n\n" +
  "Если кода нет, запросите его у того, кто дал вам ссылку на бота.";

async function handleCallback(env, cb) {
  if (!(await allowed(env, cb.from.id))) {
    // Кнопки из чужой пересланной переписки тоже должны отбиваться,
    // иначе доступ обходится простой пересылкой сообщения с клавиатурой.
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Нужен код доступа",
      show_alert: true,
    });
    return send(env, cb.message.chat.id, ASK_CODE);
  }
  const chat = cb.message.chat.id;
  const mid = cb.message.message_id;
  // Гасим «часики» на кнопке СРАЗУ, не дожидаясь базы. Раньше это стояло
  // после всех запросов, и кнопка полторы секунды выглядела зависшей, хотя
  // работа шла. Промис не ждём здесь - дождёмся вместе с отправкой ответа.
  const ack = tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
  const p = cb.data.split("|");
  let screen;
  if (p[0] === "cs") screen = await screenCountries(env, p[2], parseInt(p[1], 10));
  else if (p[0] === "lg") screen = await screenLeagues(env, p[1], p[2], p[3] || 0);
  else if (p[0] === "cl") screen = await screenClubs(env, p[1], p[2]);
  else if (p[0] === "f") screen = await screenFilter(env, p[1], p[2], p[3]);
  else if (p[0] === "p")
    screen = await screenPlayers(env, p[1], p[2], parseInt(p[3], 10), p[4], p[5] || "s");
  else if (p[0] === "m")
    screen = await screenMark(env, p[1], p[2], parseInt(p[3], 10), p[4], p[5] || "s");
  else if (p[0] === "nt")
    screen = await screenNote(env, p[1], p[2], p[3], parseInt(p[4], 10), p[5], p[6] || "s");
  else if (p[0] === "ns") {
    // ns|<статус или clear>|<pid>|<comp>|<club>|<page>|<flt>|<srt>
    const [, status, pid, comp, clubId, page, flt, srt] = p;
    const who = [cb.from.first_name, cb.from.last_name].filter(Boolean).join(" ") ||
      cb.from.username || String(cb.from.id);
    if (status === "clear") {
      await env.DB.prepare("DELETE FROM notes WHERE player_id=?").bind(pid).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO notes (player_id, status, by_name, updated_at) VALUES (?,?,?,?) " +
          "ON CONFLICT(player_id) DO UPDATE SET status=excluded.status, " +
          "by_name=excluded.by_name, updated_at=excluded.updated_at"
      )
        .bind(pid, status, who, new Date().toISOString())
        .run();
    }
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: status === "clear" ? "Пометка снята" : `Отмечено: ${NOTE_LABEL[status] || status}`,
    }).catch(() => {});   // ack уже ушёл выше, этот — только ради всплывашки
    const [t, kb] = await screenNote(env, pid, comp, clubId, parseInt(page, 10), flt, srt);
    return send(env, cb.message.chat.id, t, kb, cb.message.message_id);
  } else return;
  await Promise.all([ack, send(env, chat, screen[0], screen[1], mid)]);
}

async function handleMessage(env, msg) {
  const chat = msg.chat.id;
  const uid = msg.from.id;
  const text = (msg.text || "").trim();
  if (text.startsWith("/whoami")) {
    return send(env, chat, `Ваш Telegram ID: <code>${uid}</code>`);
  }

  if (!(await allowed(env, uid))) {
    const left = await checkAttempts(env, uid);
    if (left === null) {
      return send(
        env,
        chat,
        `⛔ Слишком много неверных попыток. Попробуйте через ${LOCK_MINUTES} минут.`
      );
    }
    // Сверяем без учёта регистра и лишних пробелов: код диктуют голосом
    // и пересылают в мессенджерах, где он легко приезжает с пробелом.
    const given = text.replace(/\s+/g, "").toUpperCase();
    const real = env.TM_ACCESS_CODE.replace(/\s+/g, "").toUpperCase();
    if (given && given === real) {
      await noteAttempt(env, uid, true);
      await env.DB.prepare(
        "INSERT OR REPLACE INTO access (user_id, name, granted_at) VALUES (?,?,?)"
      )
        .bind(
          String(uid),
          [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") ||
            msg.from.username ||
            String(uid),
          new Date().toISOString()
        )
        .run();
      const [t, kb] = await screenCountries(env, ALLON, 0);
      await send(env, chat, "✅ Код принят. Доступ открыт — больше вводить не нужно.");
      return send(env, chat, t, kb);
    }
    if (text && !text.startsWith("/")) {
      await noteAttempt(env, uid, false);
      const rest = left - 1;
      return send(
        env,
        chat,
        rest > 0
          ? `❌ Код неверный. Осталось попыток: ${rest}.`
          : `⛔ Попытки исчерпаны. Следующая через ${LOCK_MINUTES} минут.`
      );
    }
    return send(env, chat, ASK_CODE);
  }

  if (text.startsWith("/start")) {
    const [t, kb] = await screenCountries(env, ALLON, 0);
    return send(env, chat, t, kb);
  }
  if (text.startsWith("/help")) {
    return send(
      env,
      chat,
      "/start — страна → лига → клуб → игроки\n/whoami — узнать свой ID\n\n" +
        "Пришли фамилию текстом — найду игрока.\n\n" +
        "🟢 <b>агента нет</b> — так и записано на Transfermarkt\n" +
        "🟡 <b>семья</b> — ведёт родня или агент вписан без ссылки\n" +
        "⚪ <b>поле пустое</b> — строки про агента нет вовсе"
    );
  }
  if (text && !text.startsWith("/")) {
    const [t, kb] = await search(env, text);
    return send(env, chat, t, kb);
  }
}

// Экраны экспортируются ради теста test.mjs — он гоняет их на настоящей базе.
export { allowed, checkAttempts, noteAttempt, notify, recall, digest };
export { screenCountries, screenLeagues, screenClubs, screenPlayers, screenFilter,
         search, screenMark, screenNote };

/**
 * Рассылка накопившихся уведомлений «агент пропал».
 *
 * Шлёт Worker, а не сборщик на GitHub: тогда токен бота остаётся только
 * в секретах Cloudflare и не расползается по секретам репозитория. Сборщик
 * лишь складывает события в очередь и дёргает этот адрес.
 *
 * Получатели - все, кто уже прошёл по коду. Отдельный список подписчиков
 * заводить незачем: доступ к боту и есть подписка.
 */
/** Кому шлём: все, кто прошёл по коду. Доступ к боту и есть подписка. */
async function recipients(env) {
  const { results: users } = await env.DB.prepare(
    "SELECT user_id FROM access"
  ).all();
  const ids = new Set(users.map((u) => String(u.user_id)));
  for (const o of (env.TM_BOT_ALLOW || "").split(",").map((x) => x.trim())) {
    if (o) ids.add(o);
  }
  return ids;
}

/**
 * Отправить и СРАЗУ записать номер сообщения.
 *
 * Отправка и запись номера живут в одной функции намеренно. Telegram даёт
 * удалить сообщение только по номеру и не умеет перечислять отправленное:
 * рассылка, забывшая записать номер, неотзываема навсегда. Так уже вышло с
 * проверочным уведомлением, ушедшим клиенту. Пока это одна функция, новая
 * рассылка не может завести себе отзыв «потом».
 */
async function sendTracked(env, uid, text, batch) {
  const r = await send(env, uid, text);
  if (!r || !r.ok) return false;
  const mid = r.result && r.result.message_id;
  if (mid) {
    await env.DB.prepare(
      "INSERT INTO sent (alert_batch, user_id, message_id, sent_at) VALUES (?,?,?,?)"
    )
      .bind(batch, String(uid), mid, batch)
      .run();
  }
  return true;
}

/** Telegram режет сообщение на 4096 символах. */
const NL = String.fromCharCode(10);
function splitLong(text, limit = 3800) {
  if (text.length <= limit) return [text];
  const parts = [];
  let buf = "";
  for (const line of text.split(NL)) {
    if ((buf + NL + line).length > limit && buf) {
      parts.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + NL + line : line;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

/**
 * Краткая сводка после прогона: текст собирает сборщик (summary.py), здесь
 * только доставка. Разделение намеренное - считать по базе удобнее там, где
 * она лежит целиком, а токен бота остаётся в секретах Cloudflare.
 */
async function digest(env, text, only) {
  if (!text || !text.trim()) return { sent: 0, users: 0, note: "пустая сводка" };
  // only=<id> - отправить ОДНОМУ. Нужен, чтобы проверочную рассылку можно
  // было погонять на себе: правило «не проверяй на живом списке» держится
  // только тогда, когда есть чем его выполнить. Проверочное уведомление
  // однажды ушло клиенту именно потому, что такого способа не было.
  const ids = only ? new Set([String(only)]) : await recipients(env);
  if (!ids.size) return { sent: 0, users: 0, note: "некому слать" };
  const batch = "digest-" + new Date().toISOString();
  const chunks = splitLong(text.trim());
  let sent = 0;
  for (const uid of ids) {
    for (const chunk of chunks) {
      if (await sendTracked(env, uid, chunk, batch)) sent++;
    }
  }
  return { sent, users: ids.size, batch };
}

async function notify(env) {
  const { results: alerts } = await env.DB.prepare(
    "SELECT * FROM alerts WHERE sent_at IS NULL ORDER BY mv_eur DESC"
  ).all();
  if (!alerts.length) return { sent: 0, users: 0 };

  const ids = await recipients(env);
  if (!ids.size) return { sent: 0, users: 0, note: "некому слать" };

  const head =
    `🔥 <b>Пропал агент</b> — ${alerts.length} ` +
    `${plural(alerts.length, "игрок", "игрока", "игроков")}\n` +
    `<i>у них был агент, теперь нет — значит, контракт с агентством ` +
    `закончился и человек в поиске</i>\n`;

  const blocks = alerts.map(
    (a) =>
      `${BADGE[a.new_status] || "·"} <a href="${a.url}"><b>${esc(a.name)}</b></a> · ` +
      `${LABEL[a.new_status] || a.new_status}\n` +
      `    <i>${esc(a.club)}</i>${has(a.mv) ? ` · ${esc(a.mv)}` : ""}` +
      (a.where_ru ? `\n    ${esc(a.where_ru)}` : "")
  );

  // Telegram режет сообщение на 4096 символах - бьём на части по десять
  const chunks = [];
  for (let i = 0; i < blocks.length; i += 10) {
    chunks.push((i === 0 ? head : "") + "\n" + blocks.slice(i, i + 10).join("\n\n"));
  }

  const batch = new Date().toISOString();
  let sent = 0;
  for (const uid of ids) {
    for (const text of chunks) {
      if (await sendTracked(env, uid, text, batch)) sent++;
    }
  }
  await env.DB.prepare("UPDATE alerts SET sent_at=? WHERE sent_at IS NULL")
    .bind(batch)
    .run();
  return { sent, users: ids.size, alerts: alerts.length, batch };
}

/** Отозвать рассылку целиком: удалить у всех получателей. */
async function recall(env, batch) {
  const { results } = await env.DB.prepare(
    "SELECT id, user_id, message_id FROM sent WHERE deleted_at IS NULL" +
      (batch ? " AND alert_batch=?" : "")
  )
    .bind(...(batch ? [batch] : []))
    .all();
  let gone = 0;
  const failed = [];
  for (const m of results) {
    const r = await tg(env, "deleteMessage", {
      chat_id: m.user_id,
      message_id: m.message_id,
    });
    if (r && r.ok) {
      gone++;
      await env.DB.prepare("UPDATE sent SET deleted_at=? WHERE id=?")
        .bind(new Date().toISOString(), m.id)
        .run();
    } else {
      failed.push({ user: m.user_id, why: (r && r.description) || "?" });
    }
  }
  return { deleted: gone, failed };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("tm-scout bot жив", { status: 200 });
    }
    // Рассылка уведомлений: дёргается сборщиком после заливки данных.
    // Защищён тем же секретом, что и вебхук.
    if (request.method === "POST" && url.pathname === "/notify") {
      if (
        env.TM_WEBHOOK_SECRET &&
        request.headers.get("x-telegram-bot-api-secret-token") !== env.TM_WEBHOOK_SECRET
      ) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        // ?recall=<метка> или ?recall=all - отозвать уже отправленное
        const rc = url.searchParams.get("recall");
        const r = rc ? await recall(env, rc === "all" ? null : rc) : await notify(env);
        return new Response(JSON.stringify(r), {
          headers: { "content-type": "application/json" },
        });
      } catch (e) {
        console.error("рассылка:", e && e.stack ? e.stack : e);
        return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
      }
    }
    // Сводка после прогона: текст приходит телом запроса, отправляет бот.
    // Тот же секрет, что и у вебхука.
    if (request.method === "POST" && url.pathname === "/digest") {
      if (
        env.TM_WEBHOOK_SECRET &&
        request.headers.get("x-telegram-bot-api-secret-token") !== env.TM_WEBHOOK_SECRET
      ) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const r = await digest(env, await request.text(),
                               url.searchParams.get("only"));
        return new Response(JSON.stringify(r), {
          headers: { "content-type": "application/json" },
        });
      } catch (e) {
        console.error("сводка:", e && e.stack ? e.stack : e);
        return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
      }
    }
    if (request.method !== "POST" || url.pathname !== "/tg") {
      return new Response("not found", { status: 404 });
    }
    // Без этой проверки в Worker может постучаться кто угодно и выдать себя
    // за Telegram. Секрет задаётся при установке вебхука.
    if (
      env.TM_WEBHOOK_SECRET &&
      request.headers.get("x-telegram-bot-api-secret-token") !== env.TM_WEBHOOK_SECRET
    ) {
      return new Response("forbidden", { status: 403 });
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    try {
      if (update.callback_query) await handleCallback(env, update.callback_query);
      else if (update.message) await handleMessage(env, update.message);
    } catch (e) {
      // Telegram повторяет доставку на не-200; ошибку логируем, но отвечаем 200,
      // иначе один битый апдейт зациклит доставку.
      console.error("ошибка обработки:", e && e.stack ? e.stack : e);
    }
    return new Response("ok");
  },
};
