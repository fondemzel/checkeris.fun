// Вход в Т-Банк из консоли — пока в «Настройках» нет кнопки. Запускает человек в своём терминале:
//
//   node api/src/tbank_try.mjs                  — вход для первого пользователя (владельца)
//   node api/src/tbank_try.mjs --user <логин>   — для другого пользователя
//   node api/src/tbank_try.mjs --window         — с окном браузера: видно, что происходит
//
// Телефон, код и пароль вводятся здесь, в терминале, и никуда не пишутся. Сессия банка
// сохраняется в базу зашифрованной (banks.mjs); дальше её пингует и загружает операции
// сервер. Снимок экрана при ошибке — в api/data/tbank-login-error.png.
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { login } from './tbank.mjs';
import { openDb, migrate } from './db.mjs';
import { saveSession, syncLink } from './banks.mjs';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

function ask(question, { secret = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (secret) {
    // Пароль не показываем на экране
    rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? s : s.replace(/[^\r\n]/g, '*'));
  }
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      if (secret) process.stdout.write('\n');
      resolve(answer.trim());
    }),
  );
}

const db = openDb();
migrate(db);
const at = process.argv.indexOf('--user');
const user = at >= 0
  ? db.prepare('SELECT id, login, name FROM users WHERE login = ?').get(process.argv[at + 1])
  : db.prepare('SELECT id, login, name FROM users ORDER BY id LIMIT 1').get();
if (!user) {
  console.error('Нет такого пользователя');
  process.exit(1);
}

console.log(`Входим в Т-Банк для «${user.name ?? user.login}». Браузер откроется в фоне, данные спросим по ходу.\n`);
let sessionId;
try {
  sessionId = await login({
    headless: !process.argv.includes('--window'),
    log: (m) => console.log(`  · ${m}`),
    ask: (kind, hint) => ask(`${hint}: `, { secret: kind === 'password' }),
  });
} catch (err) {
  console.error(`\nНе вошли: ${err.message}`);
  if (err.state) console.error('Поля на странице:', JSON.stringify(err.state.ids));
  if (err.screenshot) {
    writeFileSync(join(DATA, 'tbank-login-error.png'), Buffer.from(err.screenshot, 'base64'));
    console.error('Снимок экрана: api/data/tbank-login-error.png');
  }
  process.exit(1);
}

const linkId = saveSession(db, user.id, 'tbank', sessionId);
console.log('\nСессия сохранена. Загружаем операции за 90 дней…');
const link = db.prepare('SELECT * FROM bank_links WHERE id = ?').get(linkId);
const res = await syncLink(db, link);
console.log(`Готово: счетов ${res.accounts}, операций ${res.ops}. Дальше сервер сам держит сессию и забирает новые операции.`);
