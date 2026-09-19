# -*- coding: utf-8 -*-
"""
Отбор событий «агент пропал» для уведомления.

Главный сигнал продукта: у игрока БЫЛ агент, а теперь нет. Значит, контракт
с агентством закончился, и игрок в поиске — звонить надо сейчас, а не через
месяц. Вручную такое не ловится вообще: нужно помнить прошлое состояние
всей базы.

Порог по стоимости обязателен. Без него уведомление утонет в игроках
низших лиг, у которых поле про агента меняется от того, что его наконец
кто-то заполнил, а не от событий на рынке.

  python alerts.py --since 8 --min-value 200000 --out out/d1-alerts.sql
"""
import argparse
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
LOST = ("NO_AGENT", "RELATIVES", "UNKNOWN")
RU = {"NO_AGENT": "агента нет", "RELATIVES": "семья", "UNKNOWN": "поле пустое",
      "AGENT": "агент был"}


def collect(since_days=8, min_value=200000):
    """События «был агент -> не стало» дороже порога, за последние N дней."""
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    cutoff = (datetime.now(timezone.utc) - timedelta(days=since_days)).isoformat()
    marks = ",".join("?" * len(LOST))
    rows = c.execute(
        "SELECT ch.ts, ch.player_id, ch.name, ch.club, ch.old, ch.new, "
        "       p.mv_eur, p.market_value, p.url, p.flag, p.country_ru, "
        "       p.comp_ru, p.comp_name "
        "  FROM changes ch JOIN players p ON p.player_id = ch.player_id "
        " WHERE ch.field = 'agent_status' AND ch.old = 'AGENT' "
        "   AND ch.new IN (%s) AND ch.ts >= ? AND p.mv_eur > ? "
        " ORDER BY p.mv_eur DESC" % marks,
        (*LOST, cutoff, min_value)).fetchall()
    c.close()
    return rows


def to_sql(rows, path):
    """SQL для дозаливки в очередь бота. Повторы отсекаются по игроку и метке."""
    def lit(v):
        if v is None:
            return "NULL"
        if isinstance(v, int):
            return str(v)
        return "'" + str(v).replace("'", "''") + "'"

    out = []
    for r in rows:
        where = " · ".join(x for x in (r["flag"], r["country_ru"],
                                       r["comp_ru"] or r["comp_name"]) if x)
        # NOT EXISTS: прогон может зацепить то же событие повторно, если
        # запускали вручную поверх планового - слать дважды нельзя
        out.append(
            "INSERT INTO alerts (ts, player_id, name, club, where_ru, "
            "old_status, new_status, mv, mv_eur, url, sent_at) "
            "SELECT %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NULL WHERE NOT EXISTS ("
            "SELECT 1 FROM alerts WHERE player_id=%s AND ts=%s);"
            % (lit(r["ts"]), lit(r["player_id"]), lit(r["name"]), lit(r["club"]),
               lit(where), lit(r["old"]), lit(r["new"]), lit(r["market_value"]),
               lit(r["mv_eur"]), lit(r["url"]),
               lit(r["player_id"]), lit(r["ts"])))
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Пустой файл тоже пишем: шаг заливки не должен падать из-за его отсутствия
    path.write_text("\n".join(out) if out else "SELECT 1;", encoding="utf-8")
    return path


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=8, help="за сколько дней")
    ap.add_argument("--min-value", type=int, default=200000,
                    help="порог рыночной стоимости в евро")
    ap.add_argument("--out", default="out/d1-alerts.sql")
    a = ap.parse_args()

    rows = collect(a.since, a.min_value)
    print("событий «агент пропал» дороже %d евро за %d дней: %d"
          % (a.min_value, a.since, len(rows)))
    for r in rows[:20]:
        print("  %-26s %-24s %10s  %s -> %s"
              % (r["name"][:26], (r["club"] or "")[:24], r["market_value"],
                 RU.get(r["old"], r["old"]), RU.get(r["new"], r["new"])))
    if len(rows) > 20:
        print("  ... и ещё %d" % (len(rows) - 20))
    print("-> %s" % to_sql(rows, a.out))
