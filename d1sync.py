# -*- coding: utf-8 -*-
"""
Заливка в D1 только РАЗНИЦЫ между собранной базой и тем, что уже в боте.

Полная заливка (d1-import.sql: DROP TABLE + 136 тысяч INSERT + 8 индексов)
стоит 1,36 млн записанных строк. Бесплатный D1 даёт 100 тысяч в сутки на ВЕСЬ
аккаунт Cloudflare, а на том же аккаунте живут и другие боты (launch-scout,
pilgrim). 28.09 и 12.10.2026 мировой обход выжигал этот лимит за десять
секунд, и до полуночи UTC соседние боты не могли записать ни строки: ни
пользователя, ни платежа, ни свежего среза.

Здесь иначе. Берём выгрузку таблицы из D1 (wrangler d1 export - это чтения,
их 5 млн в сутки), сравниваем построчно с локальной базой и пишем только:
  DELETE  - игрок пропал из выборки (появился агент, ушёл из лиги);
  INSERT  - новый игрок;
  UPDATE  - только изменившиеся столбцы, а не строка целиком: правка цены
            трогает один индекс, а не все восемь.
contract_days в сравнении не участвует: это «дней до конца контракта» на
сегодня, он меняется у всех каждый день, и сравнение по нему превращало бы
любую заливку в полную. Бот считает дни сам из contract_iso.

Если правок больше бюджета (--max-writes), льём сначала важное (пропавшие,
новые, смена статуса агента), остальное - следующим прогоном: разница
считается от того, что реально лежит в D1, поэтому недолитое не теряется.

  npx wrangler@4 d1 export tm-scout --remote --table players --output out/remote-players.sql
  python d1sync.py --remote-dump out/remote-players.sql --out out/d1-sync.sql

Код возврата 0 - файл готов (возможно, пустой: менять нечего);
1 - выгрузка D1 пуста или не скачалась, заливать нельзя.
"""
import argparse
import sqlite3
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from scout import D1_INDEXES, JSON_COLS  # noqa: E402

ROOT = Path(__file__).resolve().parent
DB = ROOT / "data" / "scout.sqlite"
STATUSES = ("NO_AGENT", "RELATIVES", "UNKNOWN")
IGNORE = {"contract_days"}
# Сколько записанных строк D1 считает за операцию: сама строка таблицы плюс
# по строке в каждом затронутом индексе (UPDATE индекса = удалить + вставить).
ROW_COST = 1 + len(D1_INDEXES)


def lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def load_remote(dump):
    """Выгрузку wrangler d1 export - во временную базу в памяти.

    None, если таблицы players в выгрузке нет (бот развёртывается с нуля).
    """
    mem = sqlite3.connect(":memory:")
    text = Path(dump).read_text(encoding="utf-8") if Path(dump).exists() else ""
    if text.strip():
        mem.executescript(text)
    has = mem.execute("SELECT 1 FROM sqlite_master WHERE type='table' "
                      "AND name='players'").fetchone()
    return mem if has else None


def update_cost(cols):
    touched = sum(1 for _, idx in D1_INDEXES if set(idx) & set(cols))
    return 1 + 2 * touched


def plan(local, remote):
    """Список (приоритет, стоимость, sql). Меньший приоритет льётся раньше."""
    remote_cols = [r[1] for r in remote.execute("PRAGMA table_info(players)")]
    added = [c for c in JSON_COLS if c not in remote_cols]
    ops = []
    for c in added:
        # Новый столбец в выгрузке: добавить в D1, а не пересоздавать таблицу.
        # Значения дольются обычными UPDATE ниже (в remote столбца нет = NULL).
        typ = "INTEGER" if c in ("tier", "age", "mv_eur") else "TEXT"
        ops.append((0, 1, "ALTER TABLE players ADD COLUMN %s %s;" % (c, typ)))

    marks = ",".join("?" * len(STATUSES))
    loc = {r[0]: r for r in local.execute(
        "SELECT %s FROM players WHERE agent_status IN (%s)"
        % (",".join(JSON_COLS), marks), STATUSES)}
    have = [c for c in JSON_COLS if c in remote_cols]
    rem = {}
    for r in remote.execute("SELECT %s FROM players" % ",".join(have)):
        d = dict(zip(have, r))
        rem[d["player_id"]] = tuple(d.get(c) for c in JSON_COLS)

    gone = sorted(set(rem) - set(loc))
    for i in range(0, len(gone), 200):
        part = gone[i:i + 200]
        ops.append((1, ROW_COST * len(part),
                    "DELETE FROM players WHERE player_id IN (%s);"
                    % ",".join(lit(p) for p in part)))

    cols_sql = ",".join(JSON_COLS)
    for pid in sorted(set(loc) - set(rem)):
        ops.append((2, ROW_COST, "INSERT OR REPLACE INTO players (%s) VALUES (%s);"
                    % (cols_sql, ", ".join(lit(v) for v in loc[pid]))))

    status_i = JSON_COLS.index("agent_status")
    for pid in sorted(set(loc) & set(rem)):
        new, old = loc[pid], rem[pid]
        diff = [i for i, c in enumerate(JSON_COLS)
                if c not in IGNORE and new[i] != old[i]]
        if not diff:
            continue
        cols = [JSON_COLS[i] for i in diff]
        # contract_days едет попутно, раз строку всё равно трогаем
        di = JSON_COLS.index("contract_days")
        if new[di] != old[di]:
            diff.append(di)
            cols.append("contract_days")
        prio = 3 if status_i in diff else 4
        ops.append((prio, update_cost(cols),
                    "UPDATE players SET %s WHERE player_id = %s;"
                    % (", ".join("%s = %s" % (JSON_COLS[i], lit(new[i])) for i in diff),
                       lit(pid))))
    return ops, {"gone": len(gone), "new": len(set(loc) - set(rem)),
                 "added_cols": added, "local": len(loc), "remote": len(rem)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--remote-dump", required=True,
                    help="вывод wrangler d1 export --table players")
    ap.add_argument("--out", default=str(ROOT / "out" / "d1-sync.sql"))
    ap.add_argument("--db", default=None, help="локальная база (data/scout.sqlite)")
    ap.add_argument("--full", default=str(ROOT / "out" / "d1-import.sql"),
                    help="полная заливка - только когда в D1 таблицы ещё нет")
    ap.add_argument("--allow-full", action="store_true",
                    help="разрешить полную заливку, если выгрузка D1 пуста")
    ap.add_argument("--max-writes", type=int, default=50000,
                    help="бюджет записанных строк D1 на прогон")
    a = ap.parse_args()

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    local = sqlite3.connect(a.db or DB)
    remote = load_remote(a.remote_dump)
    if remote is None:
        # Пустая выгрузка - это и «бот с нуля», и «export не скачался». Во
        # втором случае полная заливка снова выжгла бы лимит всего аккаунта,
        # поэтому сами не решаем: с нуля разворачивают руками, --allow-full.
        if not a.allow_full:
            print("::error::в выгрузке D1 нет таблицы players (%s). Если бот "
                  "разворачивается с нуля - запусти с --allow-full; иначе "
                  "проверь шаг wrangler d1 export." % a.remote_dump)
            return 1
        print("::warning::в D1 нет таблицы players - заливаю целиком (%s). "
              "Это больше суточного лимита бесплатного D1." % a.full)
        out.write_text(Path(a.full).read_text(encoding="utf-8"), encoding="utf-8")
        return 0

    ops, st = plan(local, remote)
    ops.sort(key=lambda o: o[0])
    upd = sum(1 for o in ops if o[0] in (3, 4))
    print("в D1: %d, собрано: %d -> удалить %d, добавить %d, обновить %d%s"
          % (st["remote"], st["local"], st["gone"], st["new"], upd,
             (", новые столбцы: %s" % ", ".join(st["added_cols"])) if st["added_cols"] else ""))

    take, spent = [], 0
    for prio, cost, sql in ops:
        if spent + cost > a.max_writes and take:
            break
        take.append(sql)
        spent += cost
    left = len(ops) - len(take)
    # Индексы - на случай, если таблицу когда-то залили без них. Если они
    # есть, IF NOT EXISTS ничего не пишет.
    take += ["CREATE INDEX IF NOT EXISTS %s ON players(%s);" % (n, ", ".join(c))
             for n, c in D1_INDEXES]
    out.write_text("\n".join(take) + "\n", encoding="utf-8")
    print("к заливке %d операций, ~%d записанных строк (бюджет %d) -> %s"
          % (len(take) - len(D1_INDEXES), spent, a.max_writes, out))
    if left:
        print("::warning::не влезло в бюджет %d операций - дольются следующим "
              "прогоном (разница считается от того, что уже в D1)" % left)
    return 0


if __name__ == "__main__":
    sys.exit(main())
