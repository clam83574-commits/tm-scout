# -*- coding: utf-8 -*-
"""
Слияние баз параллельных частей обхода.

При последовательном обходе части передают базу друг другу, и сливать нечего.
Параллельный быстрее вчетверо, но каждая часть стартует от ОДНОЙ И ТОЙ ЖЕ
базы прошлого прогона и пишет только свой кусок — итог надо собрать.

  python merge.py out.sqlite shard1.sqlite shard2.sqlite ...

Правило слияния: побеждает СВЕЖАЯ запись (по checked_at). Части обходят
непересекающиеся лиги, поэтому спорных строк почти нет; правило нужно на
случай игрока, попавшего в две лиги (основа и дубль).
"""
import sqlite3
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def merge(out, parts):
    out = Path(out)
    parts = [Path(p) for p in parts]
    missing = [p for p in parts if not p.exists()]
    if missing:
        sys.exit("нет файлов: %s" % ", ".join(str(p) for p in missing))

    # первая часть становится основой, остальные вливаем в неё
    base = parts[0]
    if out.exists():
        out.unlink()
    out.write_bytes(base.read_bytes())
    c = sqlite3.connect(out)
    before = c.execute("SELECT COUNT(*) FROM players").fetchone()[0]
    print("основа (%s): %d игроков" % (base.name, before))

    cols = [r[1] for r in c.execute("PRAGMA table_info(players)")]
    collist = ",".join(cols)

    for p in parts[1:]:
        c.execute("ATTACH ? AS s", (str(p),))
        # только то, чего нет или что свежее: базовые строки у всех частей
        # одинаковые, перезаписывать их друг другом бессмысленно
        n = c.execute(
            "SELECT COUNT(*) FROM s.players s LEFT JOIN players t "
            "USING (player_id) WHERE t.player_id IS NULL "
            "OR s.checked_at > t.checked_at").fetchone()[0]
        c.execute(
            "INSERT OR REPLACE INTO players (%s) SELECT %s FROM s.players s "
            "LEFT JOIN players t USING (player_id) "
            "WHERE t.player_id IS NULL OR s.checked_at > t.checked_at"
            % (collist, ",".join("s." + x for x in cols)))
        # история изменений: у частей она общая по базовым строкам, поэтому
        # складываем с защитой от повторов
        c.execute("CREATE TEMP TABLE IF NOT EXISTS seen AS SELECT * FROM changes WHERE 0")
        ch = c.execute(
            "INSERT INTO changes SELECT * FROM s.changes s WHERE NOT EXISTS ("
            "SELECT 1 FROM changes t WHERE t.ts=s.ts AND t.player_id=s.player_id "
            "AND t.field=s.field)").rowcount
        c.commit()
        c.execute("DETACH s")
        print("  + %s: новых/обновлённых %d, изменений %d" % (p.name, n, ch))

    total = c.execute("SELECT COUNT(*) FROM players").fetchone()[0]
    comps = c.execute("SELECT COUNT(DISTINCT comp) FROM players").fetchone()[0]
    countries = c.execute("SELECT COUNT(DISTINCT country) FROM players").fetchone()[0]
    print("\nИТОГО: %d игроков, %d лиг, %d стран" % (total, comps, countries))
    for st, n in c.execute("SELECT agent_status, COUNT(*) FROM players "
                           "GROUP BY 1 ORDER BY 2 DESC"):
        print("  %-10s %6d" % (st, n))
    c.close()
    return total


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    merge(sys.argv[1], sys.argv[2:])
