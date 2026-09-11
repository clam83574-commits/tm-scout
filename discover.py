# -*- coding: utf-8 -*-
"""
Перепись всех национальных лиг Transfermarkt -> competitions.json

Руками такой список не ведут: лиг под восемьсот, коды меняются, сезоны
переименовываются. Сборщик берёт лиги отсюда, а не из захардкоженного словаря.

  python discover.py                 # обойти все континенты
  python discover.py --continents europa

Результат: competitions.json со строками
  {"code": "L1", "name": "Bundesliga", "country": "Germany",
   "clubs": 18, "players": 508, "continent": "europa"}
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

from bs4 import BeautifulSoup

import scout

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "competitions.json"
CONTINENTS = ["europa", "amerika", "asien", "afrika"]


def last_page(soup):
    nums = []
    for a in soup.select(".tm-pagination a"):
        m = re.search(r"page=(\d+)", a.get("href", ""))
        if m:
            nums.append(int(m.group(1)))
    return max(nums) if nums else 1


def parse_page(soup, continent):
    out = []
    for tr in soup.select("table.items > tbody > tr"):
        a = tr.select_one('a[href*="/startseite/wettbewerb/"]')
        if not a:
            continue
        m = re.search(r"/startseite/wettbewerb/([A-Z0-9]+)", a.get("href", ""))
        if not m:
            continue
        tds = [t.get_text(" ", strip=True) for t in tr.find_all("td")]
        tds = [t for t in tds if t]
        # колонки: лига | страна | клубов | игроков | ср.возраст | ...
        nums = [t for t in tds if t.isdigit()]
        flag = tr.select_one("img.flaggenrahmen")
        out.append({
            "code": m.group(1),
            "name": a.get_text(" ", strip=True) or (tds[0] if tds else ""),
            "country": flag.get("title", "") if flag else "",
            "clubs": int(nums[0]) if len(nums) > 0 else 0,
            "players": int(nums[1]) if len(nums) > 1 else 0,
            "continent": continent,
        })
    return out


LEVEL_RE = re.compile(r"League level:\s*(.+)", re.I)
TIERS = {"first tier": 1, "second tier": 2, "third tier": 3, "fourth tier": 4,
         "fifth tier": 5, "sixth tier": 6, "seventh tier": 7}


def classify(ses, rows):
    """Лига или кубок, и какой дивизион.

    Отличить по названию нельзя: «Cup» пишут на десятке языков, а «Torneo
    Apertura» — это лига. Надёжный признак на самой странице турнира:
    у лиги есть строка «League level: ...» и таблица клубов, у кубка нет
    ни того, ни другого. Без этой проверки кубки попадают в обход, а игрок
    получает ярлык «Кубок Молдовы» вместо своего чемпионата.
    """
    from concurrent.futures import ThreadPoolExecutor

    def one(r):
        scout.nap()
        soup = ses.get("%s/x/startseite/wettbewerb/%s" % (scout.BASE, r["code"]))
        level, tier = "", 0
        if soup:
            for li in soup.select(".data-header__items li, .data-header__label"):
                m = LEVEL_RE.search(li.get_text(" ", strip=True))
                if m:
                    level = re.sub(r"\s+", " ", m.group(1)).strip()
                    tier = TIERS.get(level.lower(), 90 if "youth" in level.lower() else 0)
                    break
        r["level"] = level
        r["tier"] = tier
        r["is_league"] = bool(level)
        return r

    with ThreadPoolExecutor(max_workers=scout.WORKERS) as pool:
        done = 0
        for _ in pool.map(one, rows):
            done += 1
            if done % 100 == 0:
                print("  классифицировано %d/%d" % (done, len(rows)), flush=True)
    return rows


def discover(continents, headless=True):
    ses = scout.Session(headless)
    seen, rows = set(), []
    for cont in continents:
        soup = ses.get("%s/wettbewerbe/%s" % (scout.BASE, cont))
        if not soup:
            print("!! не открылся континент %s" % cont)
            continue
        pages = last_page(soup)
        print("%s: страниц %d" % (cont, pages), flush=True)
        for page in range(1, pages + 1):
            if page > 1:
                scout.nap()
                soup = ses.get("%s/wettbewerbe/%s?page=%d" % (scout.BASE, cont, page))
                if not soup:
                    print("  !! страница %d не открылась" % page)
                    continue
            for row in parse_page(soup, cont):
                if row["code"] in seen:
                    continue
                seen.add(row["code"])
                rows.append(row)
        done = [r for r in rows if r["continent"] == cont]
        print("  лиг: %d, игроков: %d"
              % (len(done), sum(r["players"] for r in done)), flush=True)

    print("\nклассифицирую %d турниров (лига или кубок)..." % len(rows), flush=True)
    classify(ses, rows)

    rows.sort(key=lambda r: (-r["players"], r["code"]))
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")

    leagues = [r for r in rows if r["is_league"]]
    cups = [r for r in rows if not r["is_league"]]
    youth = [r for r in leagues if r["tier"] == 90]
    real = [r for r in leagues if 1 <= r["tier"] <= 7]

    def line(label, rs):
        pl = sum(r["players"] for r in rs)
        cl = sum(r["clubs"] for r in rs)
        print("  %-22s турниров %4d, клубов %6d, игроков %7d, запросов %7d"
              % (label, len(rs), cl, pl, pl + cl))

    print("\nПЕРЕПИСЬ")
    line("всего найдено", rows)
    line("кубки (пропускаем)", cups)
    line("молодёжные лиги", youth)
    line("ЛИГИ 1-7 дивизион", real)
    print("-> %s" % OUT)
    return rows


def load():
    """Список лиг для сборщика. Пусто, если перепись ещё не делали."""
    if not OUT.exists():
        return []
    return json.loads(OUT.read_text(encoding="utf-8"))


def shard(rows, index, total):
    """Режем список на равные по ТРУДОЁМКОСТИ части, а не по числу лиг.

    Лиги очень разные: в одной 600 игроков, в другой 200. Деление поровну
    по количеству дало бы части, различающиеся в разы, и одна задача
    упиралась бы в шестичасовой лимит, пока другие простаивают.
    Раскладываем по самой лёгкой части — жадно, от крупных к мелким.
    """
    parts = [[] for _ in range(total)]
    load_ = [0] * total
    for r in sorted(rows, key=lambda x: -x["players"]):
        i = load_.index(min(load_))
        parts[i].append(r)
        load_[i] += r["players"] + r["clubs"]
    return parts[index]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--continents", default=",".join(CONTINENTS))
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--delay", default="0.5,1.0")
    ap.add_argument("--shards", type=int, default=0,
                    help="показать разбиение на N частей")
    a = ap.parse_args()
    scout.WORKERS = max(1, a.workers)
    scout.DELAY[:] = [float(x) for x in a.delay.split(",")]
    if a.shards:
        rows = load()
        if not rows:
            sys.exit("сначала выполни перепись: python discover.py")
        for i in range(a.shards):
            part = shard(rows, i, a.shards)
            print("часть %d/%d: лиг %d, игроков %d, клубов %d"
                  % (i + 1, a.shards, len(part),
                     sum(r["players"] for r in part),
                     sum(r["clubs"] for r in part)))
        sys.exit(0)
    t0 = time.time()
    discover(a.continents.split(","), headless=not a.headed)
    print("перепись заняла %d с" % int(time.time() - t0))
