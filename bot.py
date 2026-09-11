# -*- coding: utf-8 -*-
"""
tm-scout bot - Telegram-оболочка над базой, которую собрал scout.py.

Работает на голом Bot API (long polling), без сторонних библиотек:
одна зависимость requests, которая и так нужна сборщику.

Навигация: лига -> клуб (или вся лига) -> список кандидатов.
Три категории кандидатов включаются независимо, любой комбинацией:
показываем всё, решение принимает агент.

Запуск: python bot.py  (токен и список допуска берутся из .env рядом)
"""
import html
import os
import sqlite3
import sys
import time
from pathlib import Path

import requests

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent
DB = ROOT / "data" / "scout.sqlite"
PAGE = 8            # игроков в одном сообщении


def load_env(path=ROOT / ".env"):
    """Мини-.env: токен не должен лежать в коде."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


load_env()
TOKEN = os.environ.get("TM_BOT_TOKEN", "").strip()
API = "https://api.telegram.org/bot%s/" % TOKEN
ALLOW = {x.strip() for x in os.environ.get("TM_BOT_ALLOW", "").split(",") if x.strip()}

# Три категории кандидатов. Порядок = порядок бит в строке фильтра ("111").
# Агент просил показывать все три - он сам решает, кого звать.
CATS = [
    ("NO_AGENT", "🟢", "агента нет"),
    ("RELATIVES", "🟡", "семья"),
    ("UNKNOWN", "⚪", "поле пустое"),
]
BADGE = {c[0]: c[1] for c in CATS}
# Кружок без подписи ничего не говорит тому, кто бота не настраивал,
# поэтому в списке статус дублируется словами.
LABEL = {c[0]: c[2] for c in CATS}
ALLON = "1" * len(CATS)

# ключ -> (ORDER BY, подпись кнопки)
ORDERS = {
    "s": ("CASE agent_status WHEN 'NO_AGENT' THEN 0 WHEN 'RELATIVES' THEN 1 "
          "ELSE 2 END, club, name", "по точности"),
    "v": ("mv_eur DESC, name", "по цене"),
    "a": ("age IS NULL, age ASC, name", "по возрасту"),
    "c": ("contract_iso = '', contract_iso ASC, name", "по контракту"),
}


def statuses(flt):
    """'101' -> ('NO_AGENT', 'UNKNOWN'). Пустой набор бессмыслен - включаем всё."""
    picked = tuple(c[0] for c, bit in zip(CATS, flt) if bit == "1")
    return picked or tuple(c[0] for c in CATS)


def flt_label(flt):
    picked = [c for c, bit in zip(CATS, flt) if bit == "1"] or CATS
    badges = "".join(c[1] for c in picked)
    if len(picked) == len(CATS):
        return badges + " все категории"
    return badges + " " + " + ".join(c[2] for c in picked)


def db():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c


# ---------------------------------------------------------------- Telegram API
def call(method, **payload):
    try:
        return requests.post(API + method, json=payload, timeout=60).json()
    except requests.RequestException as e:
        print("api error:", e, flush=True)
        return {}


def send(chat, text, kb=None, edit=None):
    p = {"chat_id": chat, "text": text, "parse_mode": "HTML",
         "disable_web_page_preview": True}
    if kb:
        p["reply_markup"] = {"inline_keyboard": kb}
    if edit:
        p["message_id"] = edit
        return call("editMessageText", **p)
    return call("sendMessage", **p)


def rows_kb(items, per_row=2):
    kb, row = [], []
    for label, data in items:
        row.append({"text": label, "callback_data": data})
        if len(row) == per_row:
            kb.append(row)
            row = []
    if row:
        kb.append(row)
    return kb


# ---------------------------------------------------------------- экраны
def screen_leagues(flt):
    c = db()
    st = statuses(flt)
    q = ("SELECT comp, comp_name, COUNT(*) n FROM players "
         "WHERE agent_status IN (%s) GROUP BY comp "
         "ORDER BY tier" % ",".join("?" * len(st)))
    rows = c.execute(q, st).fetchall()
    if not rows:
        return "Под этот фильтр никто не подходит.", [
            [{"text": "⚙️ Фильтр", "callback_data": "f|-|-|%s" % flt}]]
    total = sum(r["n"] for r in rows)
    txt = ("<b>Игроки без агента</b>\n%s — всего <b>%d</b>\n\nВыбери лигу:"
           % (flt_label(flt), total))
    kb = rows_kb([("%s — %d" % (r["comp_name"], r["n"]), "cl|%s|%s" % (r["comp"], flt))
                  for r in rows], per_row=1)
    kb.append([{"text": "⚙️ Фильтр: " + flt_label(flt),
                "callback_data": "f|-|-|%s" % flt}])
    return txt, kb


def screen_clubs(comp, flt):
    c = db()
    st = statuses(flt)
    q = ("SELECT club_id, club, COUNT(*) n FROM players "
         "WHERE comp=? AND agent_status IN (%s) "
         "GROUP BY club_id ORDER BY club" % ",".join("?" * len(st)))
    rows = c.execute(q, (comp,) + st).fetchall()
    name = c.execute("SELECT comp_name FROM players WHERE comp=?", (comp,)).fetchone()
    total = sum(r["n"] for r in rows)
    txt = ("<b>%s</b>\n%s — кандидатов <b>%d</b>\n\nВыбери клуб или смотри всю лигу:"
           % (name["comp_name"] if name else comp, flt_label(flt), total))
    kb = [[{"text": "📋 Вся лига (%d)" % total,
            "callback_data": "p|%s|ALL|0|%s|s" % (comp, flt)}]]
    kb += rows_kb([("%s (%d)" % (r["club"][:22], r["n"]),
                    "p|%s|%s|0|%s|s" % (comp, r["club_id"], flt)) for r in rows])
    kb.append([{"text": "⚙️ Фильтр: " + flt_label(flt),
                "callback_data": "f|%s|-|%s" % (comp, flt)},
               {"text": "◀️ К лигам", "callback_data": "lg|%s" % flt}])
    return txt, kb


def screen_players(comp, club_id, page, flt, srt="s"):
    c = db()
    st = statuses(flt)
    where = "comp=? AND agent_status IN (%s)" % ",".join("?" * len(st))
    args = [comp] + list(st)
    if club_id != "ALL":
        where += " AND club_id=?"
        args.append(club_id)
    total = c.execute("SELECT COUNT(*) FROM players WHERE " + where, args).fetchone()[0]
    if not total:
        return "Под этот фильтр здесь никого нет.", [
            [{"text": "⚙️ Фильтр", "callback_data": "f|%s|%s|%s" % (comp, club_id, flt)},
             {"text": "◀️ К клубам", "callback_data": "cl|%s|%s" % (comp, flt)}]]
    rows = c.execute("SELECT * FROM players WHERE %s ORDER BY %s LIMIT ? OFFSET ?"
                     % (where, ORDERS[srt][0]),
                     args + [PAGE, page * PAGE]).fetchall()
    head = rows[0]["club"] if club_id != "ALL" else rows[0]["comp_name"]
    lines = ["<b>%s</b> — %d кандидатов\n%s · %s · стр. %d из %d\n"
             % (html.escape(head), total, flt_label(flt), ORDERS[srt][1],
                page + 1, (total - 1) // PAGE + 1)]
    for r in rows:
        bits = [b for b in (r["position"], "%s г." % r["age"] if r["age"] else "",
                            r["market_value"]) if b]
        lines.append(
            '%s <a href="%s"><b>%s</b></a> · %s\n    <i>%s</i>\n    %s · контракт до %s'
            % (BADGE.get(r["agent_status"], "·"), r["url"],
               html.escape(r["name"]), LABEL.get(r["agent_status"], "?"),
               html.escape(r["club"]),
               html.escape(" · ".join(bits)), r["contract_until"] or "—"))
    nav = []
    if page:
        nav.append({"text": "◀️", "callback_data":
                    "p|%s|%s|%d|%s|%s" % (comp, club_id, page - 1, flt, srt)})
    if (page + 1) * PAGE < total:
        nav.append({"text": "▶️", "callback_data":
                    "p|%s|%s|%d|%s|%s" % (comp, club_id, page + 1, flt, srt)})
    kb = [nav] if nav else []
    kb.append([{"text": ("● " if k == srt else "") + v[1],
                "callback_data": "p|%s|%s|0|%s|%s" % (comp, club_id, flt, k)}
               for k, v in ORDERS.items()])
    kb.append([{"text": "⚙️ Фильтр: " + flt_label(flt),
                "callback_data": "f|%s|%s|%s" % (comp, club_id, flt)},
               {"text": "◀️ К клубам", "callback_data": "cl|%s|%s" % (comp, flt)}])
    return "\n\n".join(lines), kb


def screen_filter(comp, club_id, flt):
    """Независимые переключатели категорий - любая комбинация."""
    c = db()
    counts = dict(c.execute("SELECT agent_status, COUNT(*) FROM players "
                            "GROUP BY agent_status").fetchall())
    txt = ("<b>Кого показывать</b>\n\n"
           "🟢 <b>агента нет</b> — на Transfermarkt прямо проставлено «no agent».\n"
           "🟡 <b>семья</b> — ведёт родня либо агент вписан текстом без ссылки "
           "на агентство.\n"
           "⚪ <b>поле пустое</b> — строки про агента на странице нет вовсе.\n\n"
           "Включай любой комбинацией. По умолчанию все три — это ровно те "
           "страницы, которые иначе пришлось бы открывать руками.")
    kb = []
    for i, (status, badge, label) in enumerate(CATS):
        on = flt[i] == "1"
        new = flt[:i] + ("0" if on else "1") + flt[i + 1:]
        kb.append([{"text": "%s %s %s — %d" % ("☑️" if on else "⬜", badge, label,
                                               counts.get(status, 0)),
                    "callback_data": "f|%s|%s|%s" % (comp, club_id, new)}])
    back = ("cl|%s|%s" % (comp, flt)) if comp != "-" else ("lg|%s" % flt)
    if comp != "-" and club_id != "-":
        back = "p|%s|%s|0|%s|s" % (comp, club_id, flt)
    kb.append([{"text": "✅ Применить", "callback_data": back}])
    return txt, kb


def search(query):
    c = db()
    rows = c.execute("SELECT * FROM players WHERE name LIKE ? AND agent_status!='AGENT' "
                     "LIMIT 10", ["%" + query + "%"]).fetchall()
    if not rows:
        return ("По запросу «%s» кандидатов не нашёл.\nЗначит, у него либо записан "
                "агент, либо его нет в собранных лигах." % html.escape(query))
    out = ["<b>Найдено:</b>"]
    for r in rows:
        out.append('%s <a href="%s">%s</a> · %s\n    %s, %s'
                   % (BADGE.get(r["agent_status"], "·"), r["url"],
                      html.escape(r["name"]), LABEL.get(r["agent_status"], "?"),
                      html.escape(r["club"]), r["position"] or "—"))
    return "\n".join(out)


# ---------------------------------------------------------------- маршрутизация
def allowed(uid):
    return not ALLOW or str(uid) in ALLOW


def handle_callback(cb):
    if not allowed(cb["from"]["id"]):
        return call("answerCallbackQuery", callback_query_id=cb["id"],
                    text="Нет доступа", show_alert=True)
    chat = cb["message"]["chat"]["id"]
    mid = cb["message"]["message_id"]
    parts = cb["data"].split("|")
    kind = parts[0]
    if kind == "lg":
        txt, kb = screen_leagues(parts[1])
    elif kind == "cl":
        txt, kb = screen_clubs(parts[1], parts[2])
    elif kind == "f":
        txt, kb = screen_filter(parts[1], parts[2], parts[3])
    elif kind == "p":
        txt, kb = screen_players(parts[1], parts[2], int(parts[3]), parts[4],
                                 parts[5] if len(parts) > 5 else "s")
    else:
        return
    call("answerCallbackQuery", callback_query_id=cb["id"])
    send(chat, txt, kb, edit=mid)


def handle_message(msg):
    chat = msg["chat"]["id"]
    uid = msg["from"]["id"]
    text = (msg.get("text") or "").strip()
    if text.startswith("/whoami"):
        return send(chat, "Твой Telegram ID: <code>%s</code>\n"
                          "Его вписывают в TM_BOT_ALLOW, чтобы закрыть бота." % uid)
    if not allowed(uid):
        return send(chat, "Бот закрытый. Твой ID: <code>%s</code> — "
                          "передай владельцу, чтобы выдал доступ." % uid)
    if text.startswith("/start"):
        send(chat, *screen_leagues(ALLON))
    elif text.startswith("/help"):
        send(chat, "/start — выбор лиги\n/whoami — узнать свой ID\n\n"
                   "Пришли фамилию текстом — найду игрока.\n\n"
                   "🟢 <b>агента нет</b> — так и записано на Transfermarkt\n"
                   "🟡 <b>семья</b> — ведёт родня или агент вписан без ссылки\n"
                   "⚪ <b>поле пустое</b> — строки про агента нет вовсе")
    elif text and not text.startswith("/"):
        send(chat, search(text))


def main():
    if not TOKEN:
        sys.exit("нет TM_BOT_TOKEN (положи его в .env рядом с bot.py)")
    if not DB.exists():
        sys.exit("нет базы %s — сначала запусти scout.py" % DB)
    me = call("getMe").get("result", {})
    print("бот запущен: @%s" % me.get("username"), flush=True)
    if not ALLOW:
        print("ВНИМАНИЕ: TM_BOT_ALLOW пуст — бот отвечает кому угодно. "
              "Перед тем как давать ссылку, впиши id в .env", flush=True)
    call("setMyCommands", commands=[
        {"command": "start", "description": "Выбрать лигу"},
        {"command": "help", "description": "Как пользоваться"},
        {"command": "whoami", "description": "Узнать свой Telegram ID"},
    ])
    offset = None
    while True:
        r = call("getUpdates", offset=offset, timeout=50)
        for u in r.get("result", []):
            offset = u["update_id"] + 1
            try:
                if "callback_query" in u:
                    handle_callback(u["callback_query"])
                elif "message" in u:
                    handle_message(u["message"])
            except Exception as e:
                print("ошибка обработки:", type(e).__name__, e, flush=True)
        if not r.get("ok"):
            time.sleep(3)


if __name__ == "__main__":
    main()
