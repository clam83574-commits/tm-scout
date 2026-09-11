# -*- coding: utf-8 -*-
"""
Что изменилось с прошлого прогона.

Главное здесь - строка «агент пропал»: у игрока закончился контракт с
агентством, и это самый горячий повод позвонить. Вручную такое не ловится
вообще, потому что требует помнить прошлое состояние всей базы.

  python diff.py --since 8 --out out/weekly-diff.md
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
CAND = ("NO_AGENT", "RELATIVES", "UNKNOWN")
RU = {"NO_AGENT": "нет агента", "RELATIVES": "семья", "UNKNOWN": "пробел",
      "AGENT": "агент записан"}


def report(since_days=8):
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    cutoff = (datetime.now(timezone.utc) - timedelta(days=since_days)).isoformat()
    rows = c.execute("SELECT * FROM changes WHERE ts >= ? ORDER BY ts", (cutoff,)).fetchall()

    lost, gained, moved, contract = [], [], [], []
    for r in rows:
        if r["field"] == "agent_status":
            if r["old"] == "AGENT" and r["new"] in CAND:
                lost.append(r)
            elif r["old"] in CAND and r["new"] == "AGENT":
                gained.append(r)
        elif r["field"] == "club":
            moved.append(r)
        elif r["field"] == "contract_until":
            contract.append(r)

    out = ["# Изменения за %d дней" % since_days,
           "",
           "_собрано %s UTC_" % datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
           ""]

    if not rows:
        out.append("С прошлого прогона ничего не поменялось.")
        return "\n".join(out)

    def block(title, items, fmt):
        if not items:
            return
        out.append("## %s — %d" % (title, len(items)))
        out.append("")
        for r in items:
            out.append("- " + fmt(r))
        out.append("")

    block("🔥 Агент пропал", lost,
          lambda r: "**%s** — %s (%s) · было «%s», стало «%s»"
                    % (r["name"], r["club"], r["comp"],
                       RU.get(r["old"], r["old"]), RU.get(r["new"], r["new"])))
    block("Появился агент — убрать из работы", gained,
          lambda r: "%s — %s · теперь %s" % (r["name"], r["club"], RU.get(r["new"], r["new"])))
    block("Сменил клуб", moved,
          lambda r: "%s: %s → %s" % (r["name"], r["old"] or "—", r["new"]))
    block("Изменился контракт", contract,
          lambda r: "%s (%s): %s → %s" % (r["name"], r["club"], r["old"] or "—", r["new"]))

    now = dict(c.execute("SELECT agent_status, COUNT(*) FROM players "
                         "GROUP BY agent_status").fetchall())
    total = sum(now.get(s, 0) for s in CAND)
    out += ["## Сейчас в базе", "",
            "Кандидатов всего: **%d** (нет агента %d · семья %d · пробел %d)"
            % (total, now.get("NO_AGENT", 0), now.get("RELATIVES", 0),
               now.get("UNKNOWN", 0)),
            "", "Игроков с записанным агентом: %d" % now.get("AGENT", 0)]
    c.close()
    return "\n".join(out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=8, help="за сколько дней")
    ap.add_argument("--out", default=None, help="куда записать markdown")
    a = ap.parse_args()
    text = report(a.since)
    if a.out:
        p = Path(a.out)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        print("записано -> %s" % p)
    else:
        print(text)
