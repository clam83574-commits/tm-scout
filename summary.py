# -*- coding: utf-8 -*-
"""
Сводка после прогона - её бот рассылает получателям.

Это ОДНО сообщение после обхода, а не счётчики отдельно и список отдельно.
Смысл сводки не «сколько изменилось», а «кому звонить прямо сейчас»: поэтому
у каждого, кто потерял агента, есть имя, ССЫЛКА на Transfermarkt, клуб, цена
и страна с лигой - чтобы обработать вариант, не открывая бота и не разыскивая
человека руками.

Порог по стоимости обязателен для ПОДРОБНОГО списка. Поле про агента у
игроков низших лиг меняется чаще всего оттого, что его наконец кто-то
заполнил, а не оттого, что человек ищет агентство: без порога сообщение
утонет в шуме, и читать его перестанут. Остальные считаются числом и лежат
в боте, где их можно отфильтровать.

Сводка отправляется ДАЖЕ когда ничего не изменилось: молчание неотличимо от
сломавшегося прогона, а строка «изменений нет» отличима.

  python summary.py --since 15 --min-value 200000 --out out/summary.txt
"""
import argparse
import html
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent
DB = ROOT / "data" / "scout.sqlite"
CAND = ("NO_AGENT", "RELATIVES", "UNKNOWN")
BADGE = {"NO_AGENT": "🟢", "RELATIVES": "🟡", "UNKNOWN": "⚪"}
LABEL = {"NO_AGENT": "агента нет", "RELATIVES": "семья", "UNKNOWN": "поле пустое"}
MONTHS = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля",
          "августа", "сентября", "октября", "ноября", "декабря")
# Потолок подробного списка. Дальше сообщение перестаёт быть сводкой и
# становится выгрузкой, которую никто не дочитает; остаток лежит в боте,
# где его можно отсортировать и отфильтровать.
MAX_DETAIL = 40


def plural(n, one, few, many):
    """Русское склонение: 1 игрок, 2 игрока, 5 игроков."""
    n = abs(n) % 100
    if 11 <= n <= 14:
        return many
    n %= 10
    if n == 1:
        return one
    if 2 <= n <= 4:
        return few
    return many


def num(n):
    """134610 -> «134 610». Неразрывный пробел, чтобы число не рвалось."""
    return "{:,}".format(int(n)).replace(",", " ")


def money(eur):
    """12 500 000 -> «12,5 млн €». Запятая как разделитель и без хвоста ,0."""
    if not eur:
        return ""
    if eur >= 1000000:
        v = "%.1f" % (eur / 1000000.0)
        return (v[:-2] if v.endswith(".0") else v.replace(".", ",")) + " млн €"
    return "%d тыс. €" % (eur // 1000)


def esc(v):
    return html.escape(str(v)) if v else ""


def build(since_days=15, min_value=200000):
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    cutoff = (datetime.now(timezone.utc) - timedelta(days=since_days)).isoformat()

    # Джойн к players обязателен: в changes лежит только факт смены статуса,
    # а звонить по нему нельзя - там нет ни ссылки, ни цены, ни лиги.
    lost = c.execute(
        "SELECT ch.name, ch.new, p.url, p.club, p.mv_eur, p.market_value, "
        "       p.flag, p.country_ru, p.comp_ru, p.comp_name, p.contract_until "
        "  FROM changes ch JOIN players p ON p.player_id = ch.player_id "
        " WHERE ch.field='agent_status' AND ch.old='AGENT' "
        "   AND ch.new IN ('NO_AGENT','RELATIVES','UNKNOWN') AND ch.ts >= ? "
        " ORDER BY p.mv_eur DESC", (cutoff,)).fetchall()
    gained = c.execute(
        "SELECT ch.name FROM changes ch "
        "  JOIN players p ON p.player_id = ch.player_id "
        " WHERE ch.field='agent_status' AND ch.old IN ('NO_AGENT','RELATIVES','UNKNOWN') "
        "   AND ch.new='AGENT' AND ch.ts >= ? ORDER BY p.mv_eur DESC",
        (cutoff,)).fetchall()
    moved = c.execute("SELECT COUNT(*) FROM changes WHERE field='club' "
                      "AND ts >= ?", (cutoff,)).fetchone()[0]
    contract = c.execute("SELECT COUNT(*) FROM changes WHERE field='contract_until' "
                         "AND ts >= ?", (cutoff,)).fetchone()[0]

    by_status = dict(c.execute("SELECT agent_status, COUNT(*) FROM players "
                               "GROUP BY agent_status").fetchall())
    total = sum(by_status.get(s, 0) for s in CAND)
    countries = c.execute("SELECT COUNT(DISTINCT country) FROM players").fetchone()[0]
    comps = c.execute("SELECT COUNT(DISTINCT comp) FROM players").fetchone()[0]
    c.close()

    now = datetime.now(timezone.utc)
    out = ["📊 <b>База обновлена</b> — %d %s" % (now.day, MONTHS[now.month - 1])]

    hot = [r for r in lost if (r["mv_eur"] or 0) > min_value]

    if hot:
        out += ["",
                "🔥 <b>Пропал агент</b> — %s %s дороже %s"
                % (num(len(hot)), plural(len(hot), "игрок", "игрока", "игроков"),
                   money(min_value)),
                "<i>агент у них был, теперь нет: контракт с агентством "
                "закончился, человек в поиске</i>",
                ""]
        for r in hot[:MAX_DETAIL]:
            # Флаг приклеен к стране, а не отбит точкой: «🇪🇸 · Испания»
            # читается как два разных поля.
            country = " ".join(x for x in (r["flag"], r["country_ru"]) if x)
            where = " · ".join(x for x in (country,
                                           r["comp_ru"] or r["comp_name"]) if x)
            out.append('%s <a href="%s"><b>%s</b></a> · %s'
                       % (BADGE.get(r["new"], "·"), esc(r["url"]), esc(r["name"]),
                          LABEL.get(r["new"], r["new"])))
            second = "    <i>%s</i>" % esc(r["club"] or "без клуба")
            # Цену берём посчитанную, а не строку Transfermarkt («€220.00m»):
            # в одном сообщении должен быть один формат денег.
            if r["mv_eur"]:
                second += " · %s" % money(r["mv_eur"])
            if r["contract_until"]:
                second += " · контракт до %s" % esc(r["contract_until"])
            out.append(second)
            if where:
                out.append("    %s" % where)
            out.append("")
        if len(hot) > MAX_DETAIL:
            out.append("<i>…и ещё %s — весь список в боте</i>"
                       % num(len(hot) - MAX_DETAIL))
            out.append("")
        cheap = len(lost) - len(hot)
        if cheap:
            out.append("<i>ещё у %s дешевле порога тоже пропал агент — они в боте</i>"
                       % num(cheap))
            out.append("")
    elif lost:
        out += ["",
                "🔥 Пропал агент — %s, все дешевле %s. Смотрите в боте."
                % (num(len(lost)), money(min_value))]

    tail = []
    if gained:
        names = ", ".join(esc(r["name"]) for r in gained[:10])
        more = " и ещё %s" % num(len(gained) - 10) if len(gained) > 10 else ""
        tail.append("✅ <b>Появился агент</b> — %s, убрать из работы: %s%s"
                    % (num(len(gained)), names, more))
    if moved:
        tail.append("🔄 Сменили клуб — %s" % num(moved))
    if contract:
        tail.append("📅 Изменился контракт — %s" % num(contract))
    if tail:
        out += [""] + tail

    if not lost and not gained and not moved and not contract:
        out += ["", "Изменений с прошлого прогона нет."]

    out += ["",
            "<b>Сейчас в базе:</b> %s %s"
            % (num(total), plural(total, "кандидат", "кандидата", "кандидатов")),
            "🟢 нет агента %s · 🟡 семья %s · ⚪ пробел %s"
            % (num(by_status.get("NO_AGENT", 0)), num(by_status.get("RELATIVES", 0)),
               num(by_status.get("UNKNOWN", 0))),
            "%s %s · %s %s"
            % (num(countries), plural(countries, "страна", "страны", "стран"),
               num(comps), plural(comps, "лига", "лиги", "лиг"))]
    return "\n".join(out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=15, help="за сколько дней")
    ap.add_argument("--min-value", type=int, default=200000,
                    help="порог стоимости для подробного списка")
    ap.add_argument("--out", default="out/summary.txt")
    a = ap.parse_args()

    text = build(a.since, a.min_value)
    p = Path(a.out)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    print(text)
    print("\n-> %s (%d символов)" % (p, len(text)))
