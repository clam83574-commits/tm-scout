# -*- coding: utf-8 -*-
"""
tm-scout - выгрузка игроков БЕЗ агента с Transfermarkt.

Transfermarkt закрыт AWS WAF: обычный requests получает 202-заглушку.
Схема: Playwright один раз решает JS-челлендж -> кука aws-waf-token ->
дальше быстрый requests с этой кукой. Кука протухает -> перевыпуск.

Классификация поля "Player agent" на странице игрока:
  AGENT     - есть <a href=".../berater/ID">  (агент записан)
  NO_AGENT  - текст "no agent" без ссылки     (явно нет агента)
  RELATIVES - "Relatives"/"Family" без ссылки (ведёт родня / вписан текстом)
  UNKNOWN   - строки в таблице нет            (просто не заполнено)
"""
import argparse
import json
import random
import re
import sqlite3
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

# консоль Windows по умолчанию cp1252 - русские логи её роняют
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

BASE = "https://www.transfermarkt.com"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
ROOT = Path(__file__).resolve().parent
DB = ROOT / "data" / "scout.sqlite"

# Какие лиги обходим. Код = то, что стоит в адресе Transfermarkt после
# /wettbewerb/. Добавление страны = дописать сюда строки и прогнать сборщик:
# база дополняется, уже собранное не трогается.
COMPETITIONS = {
    "L1": ("Bundesliga", "Germany", 1),
    "L2": ("2. Bundesliga", "Germany", 2),
    "L3": ("3. Liga", "Germany", 3),
    "BE1": ("Jupiler Pro League", "Belgium", 1),
    "BE2": ("Challenger Pro League", "Belgium", 2),
    # третий уровень в Бельгии разделён по языковым сообществам
    "BE3A": ("1ste Nationale FFA", "Belgium", 3),
    "BE3V": ("1ste Nationale VV", "Belgium", 3),
}

# Как лига называется по-русски. «3. Liga» в списке ничего не говорит тому,
# кто не в теме немецкого футбола: не видно ни страны, ни уровня. Держим мапу
# ЗДЕСЬ и пишем результат в данные, чтобы у бота не заводилась своя копия,
# которая разойдётся при добавлении стран.
DISPLAY = {
    "L1": ("Бундеслига", "Германия", "🇩🇪"),
    "L2": ("2-я Бундеслига", "Германия", "🇩🇪"),
    "L3": ("3-я лига", "Германия", "🇩🇪"),
    "BE1": ("Жюпилер Про Лига", "Бельгия", "🇧🇪"),
    "BE2": ("Челленджер Про Лига", "Бельгия", "🇧🇪"),
    "BE3A": ("1-я Национальная, франкоф.", "Бельгия", "🇧🇪"),
    "BE3V": ("1-я Национальная, фламанд.", "Бельгия", "🇧🇪"),
    # "FREE" литералом, а не FREE_COMP: та константа объявлена ниже по файлу
    "FREE": ("Без клуба", "Без клуба", "🆓"),
}

DELAY = [1.0, 1.9]   # пауза между запросами, сек (меняется ключом --delay)
WORKERS = 1          # сколько страниц тянуть параллельно (--workers)


# ---------------------------------------------------------------- WAF / сессия
def harvest_token(headless=True):
    """Один прогон браузера: решить челлендж AWS WAF, забрать куки."""
    from playwright.sync_api import sync_playwright

    seed = BASE + "/bundesliga/startseite/wettbewerb/L1"
    with sync_playwright() as p:
        b = p.chromium.launch(headless=headless)
        ctx = b.new_context(user_agent=UA, locale="en-US",
                            viewport={"width": 1366, "height": 900})
        pg = ctx.new_page()
        pg.goto(seed, wait_until="domcontentloaded", timeout=60000)
        for _ in range(40):                       # ждём, пока челлендж отработает
            try:
                if "awsWafCookieDomainList" not in pg.content():
                    break
            except Exception:
                pass                              # страница перерисовывается
            time.sleep(1)
        pg.wait_for_timeout(1500)
        cookies = {c["name"]: c["value"] for c in ctx.cookies()}
        b.close()
    if "aws-waf-token" not in cookies:
        raise RuntimeError("не удалось получить aws-waf-token")
    return cookies


class Session:
    """requests + автоперевыпуск WAF-куки, когда она протухла.

    Потокобезопасна: страницы тянутся из нескольких потоков, но браузер для
    перевыпуска куки запускается строго один за раз. Счётчик поколений нужен,
    чтобы десять потоков, одновременно поймавшие блокировку, не устроили
    десять перезапусков браузера подряд — перевыпускает первый, остальные
    видят, что поколение сменилось, и просто повторяют запрос.
    """

    def __init__(self, headless=True):
        self.headless = headless
        self.lock = threading.Lock()
        self.generation = 0
        self.blocked_hits = 0        # сколько раз нарывались на защиту
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        })
        # Пул должен быть не меньше числа потоков, иначе на высокой скорости
        # мы упрёмся в собственный пул и намеряем свой лимит, а не чужой.
        pool = max(16, WORKERS * 2)
        adapter = requests.adapters.HTTPAdapter(pool_connections=pool,
                                                pool_maxsize=pool)
        self.s.mount("https://", adapter)
        self.refresh(0)

    def refresh(self, seen_generation):
        with self.lock:
            if seen_generation != self.generation:
                return                       # кто-то уже обновил, повторяем
            print("  [waf] выпускаю новую куку через браузер...", flush=True)
            for k, v in harvest_token(self.headless).items():
                self.s.cookies.set(k, v, domain=".transfermarkt.com")
            self.generation += 1

    def get(self, url, tries=4):
        for i in range(tries):
            gen = self.generation
            try:
                r = self.s.get(url, timeout=30)
            except requests.RequestException:
                time.sleep(3 * (i + 1))
                continue
            if r.status_code == 404:
                return None
            blocked = (r.status_code in (202, 403, 429)
                       or "awsWafCookieDomainList" in r.text)
            if not blocked and r.status_code == 200:
                return BeautifulSoup(r.text, "lxml")
            with self.lock:
                self.blocked_hits += 1
            if i:
                self.refresh(gen)
            else:
                time.sleep(5)
        return None


def nap():
    time.sleep(random.uniform(*DELAY))


# ---------------------------------------------------------------- разбор страниц
def clubs_of(soup):
    """ID клубов со страницы лиги.

    Берём только турнирную таблицу (td.hauptlink внутри table.items), а не все
    ссылки страницы: на странице есть боковые виджеты со своими клубами.
    """
    ids = []
    sels = ('table.items td.hauptlink a[href*="/startseite/verein/"]',
            'a[href*="/startseite/verein/"]')      # запасной вариант
    for sel in sels:
        for a in soup.select(sel):
            m = re.search(r"/startseite/verein/(\d+)", a.get("href", ""))
            if m and m.group(1) not in ids:
                ids.append(m.group(1))
        if ids:
            break
    return ids


DOB = re.compile(r"(\d{2}/\d{2}/\d{4})\s*\((\d{1,2})\)")


def position_of(tr):
    """Амплуа игрока из строки таблицы.

    В составе клуба вложенный блок имеет класс posrela, в таблице игроков
    без клуба - нет. Раньше брали только первый вариант, и у всех свободных
    агентов позиция оставалась пустой, хотя на странице она есть.
    """
    for sel in ("td.posrela table tr:nth-of-type(2) td",
                "table.inline-table tr:nth-of-type(2) td",
                "table tr:nth-of-type(2) td"):
        node = tr.select_one(sel)
        if node:
            text = node.get_text(" ", strip=True)
            if text:
                return text
    return ""

# заголовок столбца -> наше поле; сверяемся с thead, а не с номерами ячеек,
# потому что состав столбцов у Transfermarkt меняется от вида к виду
COLMAP = {
    "date of birth/age": "birth",
    "contract": "contract_until",
    "market value": "market_value",
    "nat.": "nationality",
    "joined": "joined",
}


def parse_squad(soup, club_id):
    """Состав клуба: одна страница = ~25 игроков со всеми базовыми полями."""
    out = []
    club = ""
    h = soup.select_one("h1, .data-header__headline-wrapper")
    if h:
        club = re.sub(r"\s+", " ", h.get_text(" ", strip=True))

    heads = [t.get_text(" ", strip=True).lower()
             for t in soup.select("table.items thead th")]
    idx = {COLMAP[h]: i for i, h in enumerate(heads) if h in COLMAP}

    for tr in soup.select("table.items > tbody > tr"):
        a = tr.select_one('a[href*="/profil/spieler/"]')
        if not a:
            continue
        m = re.search(r"/profil/spieler/(\d+)", a["href"])
        if not m:
            continue
        # recursive=False: столбец «Player» содержит вложенную таблицу
        tds = [td.get_text(" ", strip=True)
               for td in tr.find_all("td", recursive=False)]

        def cell(field):
            i = idx.get(field)
            return tds[i] if i is not None and i < len(tds) else ""

        pos = position_of(tr)
        dob = DOB.search(cell("birth"))
        nat = tr.select_one("td img.flaggenrahmen")

        out.append({
            "player_id": m.group(1),
            "name": re.sub(r"\s+", " ", a.get_text(" ", strip=True)),
            "url": BASE + a["href"].split("?")[0],
            "club_id": club_id,
            "club": club,
            "position": pos,
            "nationality": nat.get("title", "") if nat else "",
            "birth": dob.group(1) if dob else cell("birth"),
            "age": int(dob.group(2)) if dob else None,
            "contract_until": cell("contract_until"),
            "market_value": cell("market_value"),
        })
    return out


FREE_URL = BASE + "/statistik/vertragslosespieler"
FREE_COMP = "FREE"     # псевдо-лига для игроков без клуба


def parse_free_agents(soup):
    """Список игроков без клуба.

    Transfermarkt держит их отдельной таблицей: там есть дата, с которой
    игрок вне контракта. Без клуба и без агента - самое горячее сочетание,
    какое вообще бывает: ему не нужно ни отступных, ни согласия клуба.
    """
    out = []
    heads = [t.get_text(" ", strip=True).lower()
             for t in soup.select("table.items thead th")]
    idx = {h: i for i, h in enumerate(heads)}
    for tr in soup.select("table.items > tbody > tr"):
        a = tr.select_one('a[href*="/profil/spieler/"]')
        if not a:
            continue
        m = re.search(r"/profil/spieler/(\d+)", a["href"])
        if not m:
            continue
        tds = [td.get_text(" ", strip=True)
               for td in tr.find_all("td", recursive=False)]

        def cell(name):
            i = idx.get(name)
            return tds[i] if i is not None and i < len(tds) else ""

        pos = position_of(tr)
        nat = tr.select_one("td img.flaggenrahmen")
        age = cell("age")
        out.append({
            "player_id": m.group(1),
            "name": re.sub(r"\s+", " ", a.get_text(" ", strip=True)),
            "url": BASE + a["href"].split("?")[0],
            "club_id": "515",
            "club": "Без клуба",
            "position": pos,
            "nationality": nat.get("title", "") if nat else "",
            "birth": "",
            "age": int(age) if age.isdigit() else None,
            # для свободного агента «контракт до» - это дата, с которой он свободен
            "contract_until": cell("out-of-contract since"),
            "market_value": cell("market value"),
        })
    return out


AGENT_LABEL = re.compile(r"^(Player[- ]?agent|Spielerberater|Agent)\b", re.I)

# Что ещё забрать со страницы игрока. Мы её всё равно открываем ради агента,
# так что эти поля достаются бесплатно - ни одного лишнего запроса.
# Ключ - начало подписи в таблице, значение - имя нашего поля.
PROFILE_FIELDS = {
    "place of birth": "birth_place",
    "citizenship": "citizenship",
    "height": "height",
    "foot": "foot",
    "current club": "club_profile",
    "last contract extension": "contract_extended",
    "name in home country": "name_local",
}


def parse_profile(soup):
    """Всё полезное со страницы игрока за один разбор.

    Соцсети - самое ценное здесь: игроку без агента больше некуда написать,
    клубную почту он не читает. Второе гражданство важно для лимитов на
    легионеров, нога и рост - базовая селекция.
    """
    out = {}
    items = soup.select(".info-table__content")
    for i, node in enumerate(items):
        label = node.get_text(" ", strip=True).rstrip(":").strip().lower()
        cell = items[i + 1] if i + 1 < len(items) else None
        if cell is None:
            continue
        for prefix, field in PROFILE_FIELDS.items():
            if label.startswith(prefix) and field not in out:
                if field == "citizenship":
                    flags = [f.get("title", "") for f in cell.select("img.flaggenrahmen")]
                    out[field] = ", ".join(x for x in flags if x)
                else:
                    out[field] = re.sub(r"\s+", " ", cell.get_text(" ", strip=True))
                break
    socials = []
    for a in soup.select('.info-table__content a[href*="instagram"], '
                         '.info-table__content a[href*="twitter"], '
                         '.info-table__content a[href*="x.com"], '
                         '.info-table__content a[href*="facebook"], '
                         '.info-table__content a[href*="tiktok"]'):
        href = a.get("href", "")
        if href and href not in socials:
            socials.append(href)
    out["socials"] = " ".join(socials)
    return out


def parse_agent(soup):
    """(статус, текст) из блока 'Player agent' на странице игрока."""
    items = soup.select(".info-table__content")
    for i, node in enumerate(items):
        label = node.get_text(" ", strip=True)
        if not AGENT_LABEL.match(label):
            continue
        cell = items[i + 1] if i + 1 < len(items) else None
        if cell is None:
            break
        link = cell.select_one('a[href*="/berater/"]')
        txt = re.sub(r"\s+", " ", cell.get_text(" ", strip=True))
        if link:
            name = (link.get("title") or link.get_text(" ", strip=True)).strip()
            if name.endswith("..."):          # в таблице имя обрезано - берём из URL
                slug = link["href"].strip("/").split("/")[0]
                name = slug.replace("-", " ").title()
            return "AGENT", name or txt
        low = txt.lower()
        if "no agent" in low or "kein berater" in low:
            return "NO_AGENT", txt
        if "relative" in low or "verwandt" in low or "family" in low:
            return "RELATIVES", txt
        if txt in ("", "-", "—"):
            return "UNKNOWN", ""
        return "RELATIVES", txt          # агент вписан текстом без ссылки
    return "UNKNOWN", ""


# ---------------------------------------------------------------- база
# Столбцы, добавленные после первой версии схемы. Живут ОДНИМ списком и
# досоздаются в db_init, до любой записи: иначе прогон на старой базе падает
# с «no such column», причём не там, где столбец добавляли.
EXTRA_COLS = [
    ("mv_eur", "INTEGER"), ("contract_iso", "TEXT"),
    ("comp_ru", "TEXT"), ("country_ru", "TEXT"), ("flag", "TEXT"),
    ("name_local", "TEXT"), ("birth_place", "TEXT"), ("citizenship", "TEXT"),
    ("height", "TEXT"), ("foot", "TEXT"), ("contract_extended", "TEXT"),
    ("socials", "TEXT"), ("contract_days", "INTEGER"),
]


def db_init():
    DB.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB)
    c.executescript("""
    CREATE TABLE IF NOT EXISTS players (
      player_id TEXT PRIMARY KEY, name TEXT, url TEXT,
      club_id TEXT, club TEXT, country TEXT, comp TEXT, comp_name TEXT, tier INT,
      position TEXT, nationality TEXT, birth TEXT, age INT,
      contract_until TEXT, market_value TEXT,
      agent_status TEXT, agent_text TEXT, checked_at TEXT);
    CREATE TABLE IF NOT EXISTS changes (
      ts TEXT, player_id TEXT, name TEXT, club TEXT, comp TEXT,
      field TEXT, old TEXT, new TEXT);
    CREATE INDEX IF NOT EXISTS idx_comp ON players(comp);
    CREATE INDEX IF NOT EXISTS idx_status ON players(agent_status);
    """)
    have = {r[1] for r in c.execute("PRAGMA table_info(players)")}
    for col, typ in EXTRA_COLS:
        if col not in have:
            c.execute("ALTER TABLE players ADD COLUMN %s %s" % (col, typ))
    c.commit()
    return c


COLS = ("player_id name url club_id club country comp comp_name tier position "
        "nationality birth age contract_until market_value agent_status "
        "agent_text checked_at name_local birth_place citizenship height foot "
        "contract_extended socials").split()


def upsert(c, row):
    """Пишем игрока и логируем изменения - дифф и есть главный продукт."""
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    old = c.execute("SELECT agent_status, club, contract_until FROM players "
                    "WHERE player_id=?", (row["player_id"],)).fetchone()
    if old:
        pairs = (("agent_status", old[0], row["agent_status"]),
                 ("club", old[1], row["club"]),
                 ("contract_until", old[2], row["contract_until"]))
        for field, prev, new in pairs:
            if prev != new and new:
                c.execute("INSERT INTO changes VALUES (?,?,?,?,?,?,?,?)",
                          (ts, row["player_id"], row["name"], row["club"],
                           row["comp"], field, prev, new))
    row["checked_at"] = ts
    # Столбцы перечисляем ПОИМЕНОВАННО, а не через VALUES(...) по позиции:
    # normalize() дописывает в таблицу служебные поля (mv_eur, comp_ru и др.),
    # и позиционная вставка ломается, как только их станет больше.
    # Дописанные поля обнулятся, но normalize() идёт сразу после прогона.
    marks = ",".join("?" * len(COLS))
    c.execute("INSERT OR REPLACE INTO players (%s) VALUES (%s)"
              % (",".join(COLS), marks), [row.get(k) for k in COLS])


# ---------------------------------------------------------------- прогон
def crawl(comps, limit_clubs=None, limit_players=None, headless=True):
    ses = Session(headless)
    c = db_init()
    stats = {}
    # Один игрок может стоять и в основе, и в дубле (Stuttgart / Stuttgart II),
    # а дубли играют в низшем дивизионе. Без этого набора поздний проход
    # перезаписывал бы ранний и каждую неделю рождал ложное «сменил клуб»
    # в недельной сводке. Побеждает первое вхождение: лиги идём по возрастанию
    # дивизиона, значит остаётся основная команда.
    seen = set()
    for item in comps:
        # Лига приходит либо кодом (тогда берём её из COMPETITIONS), либо
        # готовой записью из переписи competitions.json — там их 431.
        if isinstance(item, dict):
            code, name = item["code"], item["name"]
            country, tier = item.get("country", ""), item.get("tier", 0)
        else:
            code = item
            name, country, tier = COMPETITIONS[code]
        print("\n=== %s (%s) ===" % (name, code), flush=True)
        soup = ses.get(BASE + "/x/startseite/wettbewerb/" + code)
        if not soup:
            print("  !! лига не открылась")
            continue
        clubs = clubs_of(soup)
        if limit_clubs:
            clubs = clubs[:limit_clubs]
        print("  клубов: %d" % len(clubs), flush=True)
        squad = []
        for i, cid in enumerate(clubs, 1):
            nap()
            s = ses.get(BASE + "/x/kader/verein/%s/plus/1" % cid)
            if not s:
                print("  [%d/%d] клуб %s: не открылся" % (i, len(clubs), cid))
                continue
            rows = parse_squad(s, cid)
            label = rows[0]["club"] if rows else cid
            fresh = [r for r in rows if r["player_id"] not in seen]
            seen.update(r["player_id"] for r in fresh)
            squad += fresh
            dup = len(rows) - len(fresh)
            print("  [%d/%d] %s: %d игроков%s"
                  % (i, len(clubs), label, len(fresh),
                     " (+%d уже учтены выше)" % dup if dup else ""), flush=True)
        if limit_players:
            squad = squad[:limit_players]
        print("  всего игроков: %d - проверяю агентов" % len(squad), flush=True)
        tally = {}

        def check(row):
            """Тянем страницу игрока. Пишем в базу НЕ здесь: sqlite и потоки
            не дружат, поэтому запись остаётся на главном потоке."""
            nap()
            s = ses.get(row["url"])
            if s is None:
                row["agent_status"], row["agent_text"] = "ERROR", ""
                return row
            row["agent_status"], row["agent_text"] = parse_agent(s)
            row.update(parse_profile(s))
            return row

        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for i, row in enumerate(pool.map(check, squad), 1):
                row.update(country=country, comp=code, comp_name=name, tier=tier)
                tally[row["agent_status"]] = tally.get(row["agent_status"], 0) + 1
                upsert(c, row)
                if i % 25 == 0:
                    c.commit()
                    print("    %d/%d %s" % (i, len(squad), tally), flush=True)
        c.commit()
        stats[code] = tally
        print("  ИТОГ %s: %s" % (name, tally), flush=True)
    c.close()
    return stats


MV_NUM = re.compile(r"€\s*([\d.,]+)\s*(bn|m|k)?", re.I)
MULT = {"bn": 1_000_000_000, "m": 1_000_000, "k": 1_000, None: 1}


def mv_to_eur(text):
    """'€18.00m' -> 18000000, '€500k' -> 500000, '-' -> 0."""
    m = MV_NUM.search(text or "")
    if not m:
        return 0
    try:
        num = float(m.group(1).replace(",", "."))
    except ValueError:
        return 0
    return int(num * MULT[(m.group(2) or "").lower() or None])


def date_to_iso(text):
    """'30/06/2029' -> '2029-06-30' (чтобы сортировалось как строка)."""
    m = re.search(r"(\d{2})/(\d{2})/(\d{4})", text or "")
    return "%s-%s-%s" % (m.group(3), m.group(2), m.group(1)) if m else ""


def normalize(c=None):
    """Досчитывает поля для сортировки. Идемпотентно, гоняется по готовой базе."""
    own = c is None
    c = c or db_init()
    n = 0
    today = datetime.now(timezone.utc).date()
    rows = c.execute("SELECT player_id, market_value, contract_until, comp, "
                     "comp_name, country FROM players").fetchall()
    for pid, mv, ct, comp, comp_name, country in rows:
        # Для лиг, названных по-русски вручную, берём перевод; для остальных
        # 400+ лиг мира - оригинальное название. Названия лиг это имена
        # собственные («LaLiga», «Serie A»), так что читаемость не страдает,
        # а перевод можно досыпать в DISPLAY когда угодно: он применяется
        # одним прогоном normalize, без пересбора данных.
        ru, country_ru, flag = DISPLAY.get(comp, (comp_name, country, ""))
        iso = date_to_iso(ct)
        # Дней до конца контракта: игрок без агента, у которого контракт
        # заканчивается, - самый горячий повод для звонка. За полгода до
        # конца он вправе подписать предварительный договор с кем угодно.
        days = None
        if iso:
            try:
                days = (datetime.strptime(iso, "%Y-%m-%d").date() - today).days
            except ValueError:
                days = None
        c.execute("UPDATE players SET mv_eur=?, contract_iso=?, comp_ru=?, "
                  "country_ru=?, flag=?, contract_days=? WHERE player_id=?",
                  (mv_to_eur(mv), iso, ru, country_ru, flag, days, pid))
        n += 1
    c.commit()
    missing = [r[0] for r in c.execute(
        "SELECT DISTINCT comp FROM players WHERE comp_ru IS NULL")]
    if missing:
        print("ВНИМАНИЕ: нет русского названия для лиг: %s — добавь в DISPLAY"
              % ", ".join(missing))
    print("нормализовано строк: %d" % n)
    if own:
        c.close()


def crawl_free_agents(headless=True, max_pages=12):
    """Игроки без клуба - отдельным проходом, ~250 человек и 5 страниц."""
    ses = Session(headless)
    c = db_init()
    # Признак конца - страница без НОВЫХ игроков, а не пустая: после
    # последней Transfermarkt отдаёт ту же выдачу снова, и цикл по
    # «пока не пусто» молотил бы вхолостую до упора в max_pages.
    uniq, seen, page = [], set(), 1
    while page <= max_pages:
        nap()
        soup = ses.get("%s?page=%d" % (FREE_URL, page))
        if not soup:
            break
        fresh = [r for r in parse_free_agents(soup) if r["player_id"] not in seen]
        if not fresh:
            break
        seen.update(r["player_id"] for r in fresh)
        uniq += fresh
        print("  страница %d: +%d игроков" % (page, len(fresh)), flush=True)
        page += 1
    print("  всего без клуба: %d - проверяю агентов" % len(uniq), flush=True)

    def check(row):
        nap()
        s = ses.get(row["url"])
        if s is None:
            row["agent_status"], row["agent_text"] = "ERROR", ""
            return row
        row["agent_status"], row["agent_text"] = parse_agent(s)
        row.update(parse_profile(s))
        return row

    tally = {}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for i, row in enumerate(pool.map(check, uniq), 1):
            # Страна = «без клуба», а НЕ гражданство: иначе 250 свободных
            # агентов размазываются по 74 странам и засоряют выбор страны,
            # хотя это одна понятная группа. Гражданство остаётся в своём поле.
            row.update(country="Free agents", comp=FREE_COMP,
                       comp_name="Free agents", tier=0)
            tally[row["agent_status"]] = tally.get(row["agent_status"], 0) + 1
            upsert(c, row)
            if i % 50 == 0:
                c.commit()
    c.commit()
    c.close()
    print("  ИТОГ без клуба: %s" % tally, flush=True)
    return {FREE_COMP: tally}


def export(path=None, statuses=("NO_AGENT", "RELATIVES", "UNKNOWN")):
    import csv
    c = db_init()
    # normalize() ВНУТРИ export, а не на стороне вызывающего: выгрузка читает
    # досчитанные столбцы (contract_iso, mv_eur, comp_ru), и стоит забыть
    # вызов в одной из веток main — на свежей базе всё падает с
    # «no such column». Пусть функция сама обеспечивает то, что ей нужно.
    normalize(c)
    marks = ",".join("?" * len(statuses))
    q = ("SELECT comp_name, club, name, position, age, contract_until, "
         "market_value, agent_status, agent_text, url FROM players "
         "WHERE agent_status IN (" + marks + ") "
         "ORDER BY tier, CASE agent_status WHEN 'NO_AGENT' THEN 0 "
         "WHEN 'RELATIVES' THEN 1 ELSE 2 END, club, name")
    rows = c.execute(q, statuses).fetchall()
    path = Path(path or ROOT / "out" / "candidates.csv")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["Лига", "Клуб", "Игрок", "Позиция", "Возраст", "Контракт до",
                    "Стоимость", "Статус", "Поле agent", "Ссылка"])
        w.writerows(rows)
    print("выгружено %d строк -> %s" % (len(rows), path))
    export_json(c, statuses, path.parent / "candidates.json")
    export_d1(c, statuses, path.parent / "d1-import.sql")
    c.close()
    return path


JSON_COLS = ("player_id name url club_id club country comp comp_name tier position "
             "nationality age contract_until contract_iso contract_days "
             "market_value mv_eur agent_status agent_text comp_ru country_ru flag "
             "citizenship height foot socials birth_place").split()


def export_json(c, statuses, path):
    """Плоский JSON - им кормится бот, если он живёт без SQL-базы."""
    marks = ",".join("?" * len(statuses))
    rows = c.execute("SELECT %s FROM players WHERE agent_status IN (%s)"
                     % (",".join(JSON_COLS), marks), statuses).fetchall()
    data = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "count": len(rows),
            "players": [dict(zip(JSON_COLS, r)) for r in rows]}
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print("JSON -> %s" % path)


def export_d1(c, statuses, path):
    """SQL для заливки в Cloudflare D1: wrangler d1 execute --file=..."""
    marks = ",".join("?" * len(statuses))
    rows = c.execute("SELECT %s FROM players WHERE agent_status IN (%s)"
                     % (",".join(JSON_COLS), marks), statuses).fetchall()
    decl = ", ".join("%s %s" % (k, "INTEGER" if k in ("tier", "age", "mv_eur")
                                else "TEXT") for k in JSON_COLS)
    # DROP, а не CREATE IF NOT EXISTS: при добавлении столбца (например
    # comp_ru) старая таблица в D1 осталась бы со старой схемой, и вставка
    # упала бы на несовпадении числа колонок. Таблица и так переписывается
    # целиком каждый прогон, терять нечего.
    out = ["DROP TABLE IF EXISTS players;",
           "CREATE TABLE players (%s, PRIMARY KEY (player_id));" % decl]
    def lit(v):
        if v is None:
            return "NULL"
        if isinstance(v, int):
            return str(v)
        return "'" + str(v).replace("'", "''") + "'"
    for r in rows:
        out.append("INSERT INTO players VALUES (%s);" % ", ".join(lit(v) for v in r))
    path.write_text("\n".join(out), encoding="utf-8")
    print("D1 SQL -> %s (%d строк)" % (path, len(rows)))


def bench(n, headless=True):
    """Замер: сколько страниц в минуту и какой процент отказов на текущих
    настройках скорости. Берём реальные адреса игроков из собранной базы,
    чтобы мерить ровно то, что делает прогон."""
    c = db_init()
    urls = [r[0] for r in c.execute(
        "SELECT url FROM players ORDER BY RANDOM() LIMIT ?", (n,)).fetchall()]
    c.close()
    if len(urls) < n:
        print("в базе только %d адресов — меряю на них" % len(urls))
    ses = Session(headless)
    ok = fail = 0
    t0 = time.time()

    def one(u):
        nap()
        return ses.get(u) is not None

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for good in pool.map(one, urls):
            if good:
                ok += 1
            else:
                fail += 1
    el = time.time() - t0
    rate = len(urls) / el if el else 0
    print("\n--- ЗАМЕР ---")
    print("потоков: %d, пауза: %.1f-%.1f с" % (WORKERS, DELAY[0], DELAY[1]))
    print("страниц: %d, успешно: %d, не отдалось: %d" % (len(urls), ok, fail))
    print("нарывались на защиту: %d раз" % ses.blocked_hits)
    print("время: %.1f с -> %.2f стр/с (%.0f стр/час)" % (el, rate, rate * 3600))
    if rate:
        print("весь мир (281 000 страниц) в таком темпе: %.1f ч" % (281000 / rate / 3600))
    return {"ok": ok, "fail": fail, "blocked": ses.blocked_hits, "rate": rate}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--comps", default="L1", help="через запятую: L1,L2,L3")
    ap.add_argument("--clubs", type=int, default=None, help="лимит клубов (проба)")
    ap.add_argument("--players", type=int, default=None, help="лимит игроков (проба)")
    ap.add_argument("--headed", action="store_true", help="браузер с окном")
    ap.add_argument("--workers", type=int, default=1,
                    help="сколько страниц тянуть параллельно (по умолчанию 1)")
    ap.add_argument("--delay", default="1.0,1.9",
                    help="пауза между запросами: мин,макс в секундах")
    ap.add_argument("--bench", type=int, default=0, metavar="N",
                    help="замер: прогнать N страниц и показать скорость и отказы")
    ap.add_argument("--world", action="store_true",
                    help="все лиги из переписи competitions.json (кубки пропускаются)")
    ap.add_argument("--shard", default="", metavar="I/N",
                    help="взять только часть I из N (части равны по трудоёмкости)")
    ap.add_argument("--max-tier", type=int, default=7,
                    help="глубже какого дивизиона не спускаться")
    ap.add_argument("--youth", action="store_true",
                    help="добавить молодёжные лиги (80 лиг, ~28 000 игроков)")
    ap.add_argument("--free-agents", action="store_true",
                    help="собрать игроков без клуба (~250 человек)")
    ap.add_argument("--export", action="store_true", help="только выгрузить CSV")
    ap.add_argument("--normalize", action="store_true",
                    help="только досчитать поля сортировки")
    a = ap.parse_args()
    WORKERS = max(1, a.workers)
    DELAY[:] = [float(x) for x in a.delay.split(",")]
    if a.bench:
        bench(a.bench, headless=not a.headed)
        sys.exit(0)
    if a.normalize:
        normalize()
        sys.exit(0)
    if a.export:
        export()          # export сам нормализует
        sys.exit(0)
    if a.free_agents:
        t0 = time.time()
        st = crawl_free_agents(headless=not a.headed)
        print("\nготово за %d сек: %s" % (int(time.time() - t0),
                                          json.dumps(st, ensure_ascii=False)))
        export()
        sys.exit(0)
    if a.world:
        import discover
        rows = discover.load()
        if not rows:
            sys.exit("нет переписи лиг - сначала: python discover.py")
        # молодёжные лиги помечены уровнем 90: там агента нет по-настоящему,
        # а не из-за пробела в базе, поэтому сегмент ценный - но объёмный
        levels = set(range(1, a.max_tier + 1)) | ({90} if a.youth else set())
        leagues = [r for r in rows
                   if r.get("is_league") and r.get("tier", 0) in levels]
        if a.shard:
            i, total = (int(x) for x in a.shard.split("/"))
            leagues = discover.shard(leagues, i - 1, total)
            print("часть %d из %d: лиг %d, игроков ~%d"
                  % (i, total, len(leagues), sum(r["players"] for r in leagues)))
        comps = leagues
    else:
        comps = a.comps.split(",")
    t0 = time.time()
    st = crawl(comps, a.clubs, a.players, headless=not a.headed)
    print("\nготово за %d сек: %s" % (int(time.time() - t0),
                                      json.dumps(st, ensure_ascii=False)))
    export()
