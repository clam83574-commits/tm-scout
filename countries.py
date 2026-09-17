# -*- coding: utf-8 -*-
"""
Страны: русское название и флаг.

Раньше перевод был только у восьми лиг, вписанных вручную, — и когда приехал
мир, 126 стран показались в боте по-английски и без флагов. Эмодзи флага
собирается ИЗ КОДА страны, а не вписывается руками: так не бывает опечаток
и не путаются похожие флаги.

  RU["Germany"] -> ("Германия", "🇩🇪")
"""

# английское название на Transfermarkt -> (по-русски, код ISO 3166-1 alpha-2)
_MAP = {
    "Albania": ("Албания", "AL"), "Algeria": ("Алжир", "DZ"),
    "Andorra": ("Андорра", "AD"), "Argentina": ("Аргентина", "AR"),
    "Armenia": ("Армения", "AM"), "Australia": ("Австралия", "AU"),
    "Austria": ("Австрия", "AT"), "Azerbaijan": ("Азербайджан", "AZ"),
    "Bangladesh": ("Бангладеш", "BD"), "Belarus": ("Беларусь", "BY"),
    "Belgium": ("Бельгия", "BE"), "Belize": ("Белиз", "BZ"),
    "Bhutan": ("Бутан", "BT"), "Bolivia": ("Боливия", "BO"),
    "Bosnia-Herzegovina": ("Босния и Герцеговина", "BA"),
    "Brazil": ("Бразилия", "BR"), "Brunei Darussalam": ("Бруней", "BN"),
    "Bulgaria": ("Болгария", "BG"), "Cambodia": ("Камбоджа", "KH"),
    "Canada": ("Канада", "CA"), "Chile": ("Чили", "CL"),
    "China": ("Китай", "CN"), "Chinese Taipei": ("Тайвань", "TW"),
    "Colombia": ("Колумбия", "CO"), "Comoros": ("Коморы", "KM"),
    "Costa Rica": ("Коста-Рика", "CR"), "Croatia": ("Хорватия", "HR"),
    "Cyprus": ("Кипр", "CY"), "Czech Republic": ("Чехия", "CZ"),
    "Denmark": ("Дания", "DK"), "Dominican Republic": ("Доминикана", "DO"),
    "Ecuador": ("Эквадор", "EC"), "Egypt": ("Египет", "EG"),
    "El Salvador": ("Сальвадор", "SV"), "Estonia": ("Эстония", "EE"),
    "Ethiopia": ("Эфиопия", "ET"), "Faroe Islands": ("Фарерские острова", "FO"),
    "Fiji": ("Фиджи", "FJ"), "Finland": ("Финляндия", "FI"),
    "France": ("Франция", "FR"), "Georgia": ("Грузия", "GE"),
    "Germany": ("Германия", "DE"), "Ghana": ("Гана", "GH"),
    "Gibraltar": ("Гибралтар", "GI"), "Greece": ("Греция", "GR"),
    "Guatemala": ("Гватемала", "GT"), "Honduras": ("Гондурас", "HN"),
    "Hongkong": ("Гонконг", "HK"), "Hungary": ("Венгрия", "HU"),
    "Iceland": ("Исландия", "IS"), "India": ("Индия", "IN"),
    "Indonesia": ("Индонезия", "ID"), "Iran": ("Иран", "IR"),
    "Iraq": ("Ирак", "IQ"), "Ireland": ("Ирландия", "IE"),
    "Israel": ("Израиль", "IL"), "Italy": ("Италия", "IT"),
    "Jamaica": ("Ямайка", "JM"), "Japan": ("Япония", "JP"),
    "Jordan": ("Иордания", "JO"), "Kazakhstan": ("Казахстан", "KZ"),
    "Korea, South": ("Южная Корея", "KR"), "Kosovo": ("Косово", "XK"),
    "Kyrgyzstan": ("Киргизия", "KG"), "Laos": ("Лаос", "LA"),
    "Latvia": ("Латвия", "LV"), "Lebanon": ("Ливан", "LB"),
    "Libya": ("Ливия", "LY"), "Lithuania": ("Литва", "LT"),
    "Luxembourg": ("Люксембург", "LU"), "Malaysia": ("Малайзия", "MY"),
    "Maldives": ("Мальдивы", "MV"), "Malta": ("Мальта", "MT"),
    "Mexico": ("Мексика", "MX"), "Moldova": ("Молдова", "MD"),
    "Montenegro": ("Черногория", "ME"), "Morocco": ("Марокко", "MA"),
    "Myanmar": ("Мьянма", "MM"), "Netherlands": ("Нидерланды", "NL"),
    "New Zealand": ("Новая Зеландия", "NZ"), "Nicaragua": ("Никарагуа", "NI"),
    "Nigeria": ("Нигерия", "NG"), "North Macedonia": ("Северная Македония", "MK"),
    "Northern Ireland": ("Северная Ирландия", "GB"),
    "Norway": ("Норвегия", "NO"), "Oman": ("Оман", "OM"),
    "Panama": ("Панама", "PA"), "Paraguay": ("Парагвай", "PY"),
    "Peru": ("Перу", "PE"), "Philippines": ("Филиппины", "PH"),
    "Poland": ("Польша", "PL"), "Portugal": ("Португалия", "PT"),
    "Puerto Rico": ("Пуэрто-Рико", "PR"), "Qatar": ("Катар", "QA"),
    "Romania": ("Румыния", "RO"), "Russia": ("Россия", "RU"),
    "Rwanda": ("Руанда", "RW"), "San Marino": ("Сан-Марино", "SM"),
    "Saudi Arabia": ("Саудовская Аравия", "SA"), "Senegal": ("Сенегал", "SN"),
    "Serbia": ("Сербия", "RS"), "Singapore": ("Сингапур", "SG"),
    "Slovakia": ("Словакия", "SK"), "Slovenia": ("Словения", "SI"),
    "South Africa": ("ЮАР", "ZA"), "Spain": ("Испания", "ES"),
    "Sri Lanka": ("Шри-Ланка", "LK"), "Sweden": ("Швеция", "SE"),
    "Switzerland": ("Швейцария", "CH"), "Tajikistan": ("Таджикистан", "TJ"),
    "Thailand": ("Таиланд", "TH"), "Timor-Leste": ("Восточный Тимор", "TL"),
    "Tunisia": ("Тунис", "TN"), "Türkiye": ("Турция", "TR"),
    "Uganda": ("Уганда", "UG"), "Ukraine": ("Украина", "UA"),
    "United Arab Emirates": ("ОАЭ", "AE"), "United States": ("США", "US"),
    "Uruguay": ("Уругвай", "UY"), "Uzbekistan": ("Узбекистан", "UZ"),
    "Venezuela": ("Венесуэла", "VE"), "Vietnam": ("Вьетнам", "VN"),
}

# У этих флага по коду страны не собрать: части Великобритании имеют
# собственные эмодзи-последовательности, а «без клуба» вообще не страна.
_SPECIAL = {
    "England": ("Англия", "\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F"),
    "Scotland": ("Шотландия", "\U0001F3F4\U000E0067\U000E0062\U000E0073\U000E0063\U000E0074\U000E007F"),
    "Wales": ("Уэльс", "\U0001F3F4\U000E0067\U000E0062\U000E0077\U000E006C\U000E0073\U000E007F"),
    "Free agents": ("Без клуба", "🆓"),
}


def _flag(iso):
    """AL -> 🇦🇱. Региональные индикаторы идут подряд от 🇦, как буквы от A."""
    return "".join(chr(0x1F1E6 + ord(ch) - ord("A")) for ch in iso.upper())


RU = dict(_SPECIAL)
for _name, (_ru, _iso) in _MAP.items():
    RU[_name] = (_ru, _flag(_iso))


def lookup(country):
    """(по-русски, флаг). Для неизвестной страны — её же имя и пустой флаг."""
    return RU.get(country, (country, ""))


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print("стран в таблице:", len(RU))
    for name in ("Germany", "England", "Korea, South", "Türkiye", "Free agents",
                 "United States", "Narnia"):
        ru, fl = lookup(name)
        print("  %-22s %s %s" % (name, fl or "··", ru))
