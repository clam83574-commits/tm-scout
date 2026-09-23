# -*- coding: utf-8 -*-
"""
Краткая сводка после прогона - её бот рассылает получателям.

Зачем отдельно от diff.py: тот пишет ПОЛНЫЙ отчёт в markdown для чтения
глазами в репозитории, здесь же короткое сообщение в Telegram, где важны
первые три строки. Подробный список «агент пропал» уходит отдельным
уведомлением (alerts.py), поэтому тут только счётчики и тройка самых дорогих
- иначе получатель дважды за минуту прочитает одно и то же.

Сводка отправляется ДАЖЕ когда ничего не изменилось: молчание неотличимо от
сломавшегося прогона, а строка «база обновлена, изменений нет» отличима.

  python summary.py --since 15 --out out/summary.txt
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
MONTHS = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля",
          "августа", "сентября", "октября", "ноября", "декабря")


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


def build(since_days=15, alerts_min=200000):
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    cutoff = (datetime.now(timezone.utc) - timedelta(days=since_days)).isoformat()

    lost = c.execute(
        "SELECT ch.name, ch.club, p.mv_eur FROM changes ch "
        "LEFT JOIN players p ON p.player_id = ch.player_id "
        "WHERE ch.field='agent_status' AND ch.old='AGENT' "
        "  AND ch.new IN ('NO_AGENT','RELATIVES','UNKNOWN') AND ch.ts >= ? "
        "ORDER BY p.mv_eur DESC", (cutoff,)).fetchall()
    gained = c.execute(
        "SELECT COUNT(*) FROM changes WHERE field='agent_status' "
        "AND old IN ('NO_AGENT','RELATIVES','UNKNOWN') AND new='AGENT' "
        "AND ts >= ?", (cutoff,)).fetchone()[0]
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
    out = ["📊 <b>База обновлена</b> — %d %s" % (now.day, MONTHS[now.month - 1]), ""]

    if lost or gained or moved or contract:
        out.append("<b>Что изменилось за %d %s:</b>"
                   % (since_days, plural(since_days, "день", "дня", "дней")))
        if lost:
            out.append("🔥 пропал агент — <b>%s</b>" % num(len(lost)))
        if gained:
            out.append("✅ появился агент (убрать из работы) — %s" % num(gained))
        if moved:
            out.append("🔄 сменили клуб — %s" % num(moved))
        if contract:
            out.append("📅 изменился контракт — %s" % num(contract))
        # Тройка самых дорогих - чтобы сводку можно было оценить не открывая
        # бота. Полный список уходит отдельным уведомлением, поэтому здесь
        # именно тройка, а не «ещё 44 игрока» простынёй.
        top = [r for r in lost if r["mv_eur"]][:3]
        if top:
            out.append("")
            out.append("<i>самые дорогие из пропавших:</i>")
            for r in top:
                out.append("  • <b>%s</b> — %s · %s"
                           % (html.escape(r["name"] or "?"),
                              html.escape(r["club"] or "без клуба"),
                              money(r["mv_eur"])))
        # Отдельное уведомление шлёт не всех пропавших, а только дороже
        # порога. Без этой строки числа в двух сообщениях расходятся, и
        # читатель решает, что одно из них врёт.
        worth = len([r for r in lost if (r["mv_eur"] or 0) > alerts_min])
        if worth:
            out.append("")
            out.append("<i>следующим сообщением — список тех, кто дороже %s "
                       "(%s)</i>" % (money(alerts_min), num(worth)))
    else:
        out.append("Изменений с прошлого прогона нет.")

    out += ["",
            "<b>Сейчас в базе:</b> %s %s" % (num(total), plural(total, "кандидат", "кандидата", "кандидатов")),
            "🟢 нет агента %s · 🟡 семья %s · ⚪ пробел %s"
            % (num(by_status.get("NO_AGENT", 0)), num(by_status.get("RELATIVES", 0)),
               num(by_status.get("UNKNOWN", 0))),
            "%d %s · %d %s" % (countries, plural(countries, "страна", "страны", "стран"),
                               comps, plural(comps, "лига", "лиги", "лиг"))]
    return "\n".join(out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=15, help="за сколько дней")
    ap.add_argument("--alerts-min", type=int, default=200000,
                    help="порог отдельного уведомления - чтобы сослаться на него")
    ap.add_argument("--out", default="out/summary.txt")
    a = ap.parse_args()

    text = build(a.since, a.alerts_min)
    p = Path(a.out)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    print(text)
    print("\n-> %s (%d символов)" % (p, len(text)))
