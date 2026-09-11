/**
 * Разворачивает бота в Cloudflare одной командой:  node setup.mjs
 *
 * Делает всё: создаёт базу D1, подставляет её id в wrangler.toml, заливает
 * данные, кладёт секреты, публикует Worker и вешает вебхук Telegram.
 *
 * ЕДИНСТВЕННОЕ, что нужно сделать до него — один раз войти в аккаунт:
 *     npx wrangler login
 * Это подтверждение личности, за владельца его сделать нельзя.
 *
 * Скрипт идемпотентный: если база или секрет уже есть, шаг пропускается.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";

const TOML = "wrangler.toml";
const ENV = "../.env";
const SECRET_FILE = ".webhook-secret";   // под .gitignore

/**
 * Запросы к Telegram идут через curl, а не через встроенный fetch.
 * На машине владельца задан HTTP(S)_PROXY; curl его уважает, fetch в Node —
 * нет, и падает по таймауту подключения к api.telegram.org.
 * curl.exe — настоящий исполняемый файл, поэтому shell не нужен и кавычки
 * не ломаются.
 */
function tgApi(token, method, payload) {
  const tmp = ".tg-payload.json";
  writeFileSync(tmp, JSON.stringify(payload), "utf8");
  try {
    const out = execFileSync(
      "curl",
      ["-s", "-m", "30", "-X", "POST",
       `https://api.telegram.org/bot${token}/${method}`,
       "-H", "content-type: application/json",
       "--data-binary", `@${tmp}`],
      { encoding: "utf8" }
    );
    return JSON.parse(out);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

// На Windows execFileSync запускается через shell, а тот заново делит строку
// по пробелам: --command=SELECT COUNT(*) ... распадётся на четыре аргумента.
// Поэтому всё, что содержит пробелы, заворачиваем в кавычки сами.
const win = process.platform === "win32";
const quote = (a) => (win && /[\s()]/.test(a) && !/^".*"$/.test(a) ? `"${a}"` : a);

const run = (args, opts = {}) =>
  execFileSync("npx", ["wrangler", ...args].map(quote), {
    encoding: "utf8",
    stdio: opts.input !== undefined ? ["pipe", "pipe", "pipe"] : ["inherit", "pipe", "pipe"],
    input: opts.input,
    shell: win,
  });

const say = (s) => console.log(s);
const die = (s) => {
  console.error("\n✗ " + s);
  process.exit(1);
};

// ---------------------------------------------------------------- 0. проверки
if (!existsSync(ENV)) die(`нет ${ENV} с токеном бота`);
const token = (readFileSync(ENV, "utf8").match(/^TM_BOT_TOKEN=(.+)$/m) || [])[1]?.trim();
if (!token) die("в .env нет строки TM_BOT_TOKEN=...");

try {
  const who = run(["whoami"]);
  say("✓ вход в Cloudflare: " + (who.match(/[\w.+-]+@[\w.-]+/) || ["аккаунт найден"])[0]);
} catch {
  die("не выполнен вход в Cloudflare.\n  Запусти в обычном терминале:  npx wrangler login\n  затем снова:  node setup.mjs");
}

// ------------------------------------------------------------- 1. база данных
let toml = readFileSync(TOML, "utf8");
const known = (toml.match(/database_id\s*=\s*"([0-9a-f-]{36})"/) || [])[1];
let dbId = known && known !== "00000000-0000-0000-0000-000000000000" ? known : null;

if (!dbId) {
  say("… создаю базу D1 «tm-scout»");
  let out = "";
  try {
    out = run(["d1", "create", "tm-scout"]);
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
    if (!/already exists/i.test(out)) die("не удалось создать базу:\n" + out);
    say("  база уже была — беру её id из списка");
    out = run(["d1", "list", "--json"]);
    const found = JSON.parse(out).find((d) => d.name === "tm-scout");
    if (!found) die("база tm-scout не найдена в списке");
    dbId = found.uuid;
  }
  dbId = dbId || (out.match(/([0-9a-f]{8}-[0-9a-f-]{27})/) || [])[1];
  if (!dbId) die("не смог вычитать database_id из ответа wrangler:\n" + out);
  toml = toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${dbId}"`);
  writeFileSync(TOML, toml, "utf8");
  say("✓ база создана, id вписан в wrangler.toml");
} else {
  say("✓ база уже настроена: " + dbId);
}

// ------------------------------------------------------------------ 2. данные
say("… заливаю кандидатов в D1");
run(["d1", "execute", "tm-scout", "--remote", "--file=../out/d1-import.sql", "-y"]);
const cnt = run(["d1", "execute", "tm-scout", "--remote", "--json",
                 "--command=SELECT COUNT(*) n FROM players"]);
say("✓ в базе строк: " + (JSON.parse(cnt)[0]?.results?.[0]?.n ?? "?"));

// ----------------------------------------------------------------- 3. секреты
// Секрет вебхука переживает перезапуск: иначе каждый прогон ставил бы в
// Worker новое значение, а при обрыве до setWebhook бот остался бы с
// секретом, которого никто не знает.
const hookSecret = existsSync(SECRET_FILE)
  ? readFileSync(SECRET_FILE, "utf8").trim()
  : randomBytes(24).toString("hex");
writeFileSync(SECRET_FILE, hookSecret, "utf8");

say("… кладу секреты");
run(["secret", "put", "TM_BOT_TOKEN"], { input: token + "\n" });
run(["secret", "put", "TM_WEBHOOK_SECRET"], { input: hookSecret + "\n" });
say("✓ секреты на месте (в репозиторий они не попадают)");

// ---------------------------------------------------------------- 4. публикация
say("… публикую Worker");
const dep = run(["deploy"]);
const urlMatch = dep.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
if (!urlMatch) die("Worker опубликован, но не нашёл его адрес в выводе:\n" + dep);
const workerUrl = urlMatch[0];
say("✓ Worker: " + workerUrl);

// ------------------------------------------------------------------ 5. вебхук
say("… вешаю вебхук Telegram");
const res = tgApi(token, "setWebhook", {
  url: `${workerUrl}/tg`,
  secret_token: hookSecret,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
});
if (!res.ok) die("Telegram отказал: " + JSON.stringify(res));
say("✓ вебхук установлен");

const info = tgApi(token, "getWebhookInfo", {});
say("\nГотово. Проверка от Telegram:");
say("  адрес:              " + info.result.url);
say("  ожидает доставки:   " + info.result.pending_update_count);
if (info.result.last_error_message) {
  say("  ПОСЛЕДНЯЯ ОШИБКА:  " + info.result.last_error_message);
}
say("\nБот живёт в Cloudflare. Локальный python bot.py больше не нужен —");
say("останови его, иначе два процесса будут драться за одни апдейты.");
say("\nЗакрыть бота от посторонних: впиши Telegram id в TM_BOT_ALLOW");
say("в wrangler.toml и выполни  npx wrangler deploy");
