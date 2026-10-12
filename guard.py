# -*- coding: utf-8 -*-
"""
Предохранитель перед полной заменой базы бота.

Заливка (d1sync.py) удаляет из бота всех, кого нет в локальной базе: она
верна ровно тогда, когда локальная база содержит ВСЁ. Если прогон стартовал с пустой базы, он соберёт
только свои лиги и сотрёт остальной мир.

Так и вышло 21.09.2026. Недельный прогон восстановил из кэша GitHub не
мировую базу, а пустышку в полтора килобайта, собрал Германию с Бельгией и
заменил ими 134 610 игроков в боте. Прогон при этом был зелёный: с его точки
зрения всё отработало штатно.

Вывод, который здесь зашит: кэш GitHub - хранилище «по возможности», а не
гарантия (вытеснение по объёму, срок 7 дней без обращения, промах по ключу).
Решение о полной замене не может опираться на веру в то, что кэш приехал.
Поэтому сравниваем то, что собрали, с тем, что уже живёт в боте, и при резкой
усушке отказываемся заливать. Пусть прогон падает красным - это чинится за
день, а потерянный мир стоит восьми часов обхода.

  python guard.py --remote-json out/remote.json

Код возврата 1 = заливать нельзя.
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent
DB = ROOT / "data" / "scout.sqlite"
STATUSES = ("NO_AGENT", "RELATIVES", "UNKNOWN")


def parse_wrangler(text):
    """Достаёт числа из вывода `wrangler d1 execute --json`.

    Вокруг JSON wrangler печатает баннер и предупреждения npm, поэтому берём
    подстроку от первой открывающей скобки, а не весь поток.
    """
    start = text.find("[")
    if start < 0:
        start = text.find("{")
    if start < 0:
        return None
    for end in range(len(text), start, -1):
        chunk = text[start:end]
        try:
            data = json.loads(chunk)
        except ValueError:
            continue
        if isinstance(data, dict):
            data = [data]
        for block in data:
            rows = (block or {}).get("results") or []
            if rows:
                return rows[0]
        return None
    return None


def local_counts(db=None):
    db = Path(db or DB)
    if not db.exists():
        return None
    c = sqlite3.connect(db)
    marks = ",".join("?" * len(STATUSES))
    row = c.execute(
        "SELECT COUNT(*), COUNT(DISTINCT country), COUNT(DISTINCT comp) "
        "FROM players WHERE agent_status IN (%s)" % marks, STATUSES).fetchone()
    c.close()
    return {"players": row[0], "countries": row[1], "comps": row[2]}


def check(remote, local, min_ratio=0.9):
    """Возвращает список причин отказа. Пустой список = заливать можно."""
    bad = []
    if not local:
        return ["локальной базы нет вообще"]
    if local["players"] == 0:
        return ["в локальной базе ноль кандидатов - заливать нечего"]
    # Первая заливка: в боте пусто или таблицы ещё нет. Сравнивать не с чем,
    # и запрещать нельзя - иначе продукт невозможно развернуть с нуля.
    if not remote or not remote.get("players"):
        print("в боте пока пусто - сравнивать не с чем, разрешаю")
        return []
    for field, title in (("players", "кандидатов"), ("countries", "стран"),
                         ("comps", "лиг")):
        was, now = remote.get(field) or 0, local[field]
        if was and now < was * min_ratio:
            bad.append("%s было %d, стало %d (%.0f%% от прежнего)"
                       % (title, was, now, 100.0 * now / was))
    return bad


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--remote-json", required=True,
                    help="файл с выводом wrangler d1 execute --json")
    ap.add_argument("--min-ratio", type=float, default=0.9,
                    help="допустимая доля от прежнего размера")
    ap.add_argument("--db", default=None,
                    help="база для проверки (по умолчанию data/scout.sqlite)")
    a = ap.parse_args()

    raw = Path(a.remote_json).read_text(encoding="utf-8", errors="replace")
    remote = parse_wrangler(raw)
    local = local_counts(a.db)

    print("в боте сейчас: %s" % (remote or "не прочитал"))
    print("собрано локально: %s" % (local or "базы нет"))

    reasons = check(remote, local, a.min_ratio)
    if reasons:
        for r in reasons:
            print("::error::заливка отменена - %s" % r)
        print("::error::Полная замена стёрла бы то, что уже собрано. Скорее "
              "всего прогон стартовал без базы прошлого раза. Проверь шаг "
              "восстановления кэша и артефакт world-sqlite.")
        sys.exit(1)
    print("проверка пройдена, заливаю")
