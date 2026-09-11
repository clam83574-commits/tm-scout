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
const ALLON = "1".repeat(CATS.length);
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
  return list.length === CATS.length
    ? `${badges} все категории`
    : `${badges} ${list.map((c) => c.label).join(" + ")}`;
};

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const marks = (n) => new Array(n).fill("?").join(",");

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
async function screenLeagues(env, flt) {
  const st = statuses(flt);
  const { results } = await env.DB.prepare(
    `SELECT comp, comp_name, COUNT(*) n FROM players
     WHERE agent_status IN (${marks(st.length)}) GROUP BY comp ORDER BY tier`
  )
    .bind(...st)
    .all();
  if (!results.length) {
    return [
      "Под этот фильтр никто не подходит.",
      [[{ text: "⚙️ Фильтр", callback_data: `f|-|-|${flt}` }]],
    ];
  }
  const total = results.reduce((a, r) => a + r.n, 0);
  const txt = `<b>Игроки без агента</b>\n${fltLabel(flt)} — всего <b>${total}</b>\n\nВыбери лигу:`;
  const kb = rowsKb(
    results.map((r) => [`${r.comp_name} — ${r.n}`, `cl|${r.comp}|${flt}`]),
    1
  );
  kb.push([{ text: "⚙️ Фильтр: " + fltLabel(flt), callback_data: `f|-|-|${flt}` }]);
  return [txt, kb];
}

async function screenClubs(env, comp, flt) {
  const st = statuses(flt);
  const { results } = await env.DB.prepare(
    `SELECT club_id, club, COUNT(*) n FROM players
     WHERE comp=? AND agent_status IN (${marks(st.length)})
     GROUP BY club_id ORDER BY club`
  )
    .bind(comp, ...st)
    .all();
  const name = await env.DB.prepare("SELECT comp_name FROM players WHERE comp=? LIMIT 1")
    .bind(comp)
    .first();
  const total = results.reduce((a, r) => a + r.n, 0);
  const txt =
    `<b>${esc(name ? name.comp_name : comp)}</b>\n${fltLabel(flt)} — кандидатов ` +
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
    { text: "◀️ К лигам", callback_data: `lg|${flt}` },
  ]);
  return [txt, kb];
}

async function screenPlayers(env, comp, clubId, page, flt, srt = "s") {
  const st = statuses(flt);
  let where = `comp=? AND agent_status IN (${marks(st.length)})`;
  const args = [comp, ...st];
  if (clubId !== "ALL") {
    where += " AND club_id=?";
    args.push(clubId);
  }
  const cnt = await env.DB.prepare(`SELECT COUNT(*) n FROM players WHERE ${where}`)
    .bind(...args)
    .first();
  const total = cnt.n;
  if (!total) {
    return [
      "Под этот фильтр здесь никого нет.",
      [
        [
          { text: "⚙️ Фильтр", callback_data: `f|${comp}|${clubId}|${flt}` },
          { text: "◀️ К клубам", callback_data: `cl|${comp}|${flt}` },
        ],
      ],
    ];
  }
  const { results } = await env.DB.prepare(
    `SELECT * FROM players WHERE ${where} ORDER BY ${ORDERS[srt][0]} LIMIT ? OFFSET ?`
  )
    .bind(...args, PAGE, page * PAGE)
    .all();

  const head = clubId !== "ALL" ? results[0].club : results[0].comp_name;
  const lines = [
    `<b>${esc(head)}</b> — ${total} кандидатов\n${fltLabel(flt)} · ` +
      `${ORDERS[srt][1]} · стр. ${page + 1} из ${Math.ceil(total / PAGE)}\n`,
  ];
  for (const r of results) {
    const bits = [r.position, r.age ? `${r.age} г.` : "", r.market_value]
      .filter(Boolean)
      .join(" · ");
    lines.push(
      `${BADGE[r.agent_status] || "·"} <a href="${r.url}"><b>${esc(r.name)}</b></a>` +
        ` · ${LABEL[r.agent_status] || "?"}\n` +
        `    <i>${esc(r.club)}</i>\n    ${esc(bits)} · контракт до ${r.contract_until || "—"}`
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
    { text: "⚙️ Фильтр: " + fltLabel(flt), callback_data: `f|${comp}|${clubId}|${flt}` },
    { text: "◀️ К клубам", callback_data: `cl|${comp}|${flt}` },
  ]);
  return [lines.join("\n\n"), kb];
}

async function screenFilter(env, comp, clubId, flt) {
  const { results } = await env.DB.prepare(
    "SELECT agent_status, COUNT(*) n FROM players GROUP BY agent_status"
  ).all();
  const counts = Object.fromEntries(results.map((r) => [r.agent_status, r.n]));
  const txt =
    "<b>Кого показывать</b>\n\n" +
    "🟢 <b>агента нет</b> — на Transfermarkt прямо проставлено «no agent».\n" +
    "🟡 <b>семья</b> — ведёт родня либо агент вписан текстом без ссылки на агентство.\n" +
    "⚪ <b>поле пустое</b> — строки про агента на странице нет вовсе.\n\n" +
    "Включай любой комбинацией. По умолчанию все три — это ровно те страницы, " +
    "которые иначе пришлось бы открывать руками.";
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
  let back = comp !== "-" ? `cl|${comp}|${flt}` : `lg|${flt}`;
  if (comp !== "-" && clubId !== "-") back = `p|${comp}|${clubId}|0|${flt}|s`;
  kb.push([{ text: "✅ Применить", callback_data: back }]);
  return [txt, kb];
}

async function search(env, query) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM players WHERE name LIKE ? LIMIT 10"
  )
    .bind(`%${query}%`)
    .all();
  if (!results.length) {
    return (
      `По запросу «${esc(query)}» кандидатов не нашёл.\n` +
      "Значит, у него либо записан агент, либо его нет в собранных лигах."
    );
  }
  return [
    "<b>Найдено:</b>",
    ...results.map(
      (r) =>
        `${BADGE[r.agent_status] || "·"} <a href="${r.url}">${esc(r.name)}</a> · ` +
        `${LABEL[r.agent_status] || "?"}\n    ${esc(r.club)}, ${r.position || "—"}`
    ),
  ].join("\n");
}

// ------------------------------------------------------------- маршрутизация
const allowed = (env, uid) => {
  const list = (env.TM_BOT_ALLOW || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return !list.length || list.includes(String(uid));
};

async function handleCallback(env, cb) {
  if (!allowed(env, cb.from.id)) {
    return tg(env, "answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "Нет доступа",
      show_alert: true,
    });
  }
  const chat = cb.message.chat.id;
  const mid = cb.message.message_id;
  const p = cb.data.split("|");
  let screen;
  if (p[0] === "lg") screen = await screenLeagues(env, p[1]);
  else if (p[0] === "cl") screen = await screenClubs(env, p[1], p[2]);
  else if (p[0] === "f") screen = await screenFilter(env, p[1], p[2], p[3]);
  else if (p[0] === "p")
    screen = await screenPlayers(env, p[1], p[2], parseInt(p[3], 10), p[4], p[5] || "s");
  else return;
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
  await send(env, chat, screen[0], screen[1], mid);
}

async function handleMessage(env, msg) {
  const chat = msg.chat.id;
  const uid = msg.from.id;
  const text = (msg.text || "").trim();
  if (text.startsWith("/whoami")) {
    return send(
      env,
      chat,
      `Твой Telegram ID: <code>${uid}</code>\nЕго вписывают в TM_BOT_ALLOW, чтобы закрыть бота.`
    );
  }
  if (!allowed(env, uid)) {
    return send(
      env,
      chat,
      `Бот закрытый. Твой ID: <code>${uid}</code> — передай владельцу, чтобы выдал доступ.`
    );
  }
  if (text.startsWith("/start")) {
    const [t, kb] = await screenLeagues(env, ALLON);
    return send(env, chat, t, kb);
  }
  if (text.startsWith("/help")) {
    return send(
      env,
      chat,
      "/start — выбор лиги\n/whoami — узнать свой ID\n\n" +
        "Пришли фамилию текстом — найду игрока.\n\n" +
        "🟢 <b>агента нет</b> — так и записано на Transfermarkt\n" +
        "🟡 <b>семья</b> — ведёт родня или агент вписан без ссылки\n" +
        "⚪ <b>поле пустое</b> — строки про агента нет вовсе"
    );
  }
  if (text && !text.startsWith("/")) {
    return send(env, chat, await search(env, text));
  }
}

// Экраны экспортируются ради теста test.mjs — он гоняет их на настоящей базе.
export { screenLeagues, screenClubs, screenPlayers, screenFilter, search };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("tm-scout bot жив", { status: 200 });
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
