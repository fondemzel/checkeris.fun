// Проба входа в Т-Банк и загрузки операций — запускается человеком в своём терминале:
//
//   node api/src/tbank_try.mjs            — вход (телефон, код из СМС, пароль) и операции за 30 дней
//   node api/src/tbank_try.mjs --window   — то же, но с окном браузера: видно, что происходит
//
// Телефон, код и пароль вводятся здесь, в терминале, и никуда не пишутся. Сохраняется только
// сессия банка — в api/data/tbank-session.json (каталог данных в git не попадает).
// Снимок экрана при ошибке — в api/data/tbank-login-error.png.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { login, ping, accounts, operations } from './tbank.mjs';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const SESSION_FILE = join(DATA, 'tbank-session.json');

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

let sessionId = existsSync(SESSION_FILE) ? JSON.parse(readFileSync(SESSION_FILE, 'utf8')).sessionId : null;

if (sessionId && (await ping(sessionId))) {
  console.log('Сохранённая сессия жива — вход не нужен.');
} else {
  console.log('Входим в Т-Банк. Браузер откроется в фоне, данные спросим по ходу.\n');
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
  writeFileSync(SESSION_FILE, JSON.stringify({ sessionId, at: new Date().toISOString() }));
}

const list = await accounts(sessionId);
console.log(`\nСчета (${list.length}):`);
for (const a of list) {
  console.log(`  ${a.id}  ${a.accountType ?? ''}  ${a.name ?? ''}  ${a.moneyAmount?.value ?? ''} ${a.moneyAmount?.currency?.name ?? ''}`);
}

const from = new Date(Date.now() - 30 * 86_400_000);
let total = 0;
for (const a of list.filter((x) => ['Current', 'Credit', 'Saving'].includes(x.accountType))) {
  const ops = await operations(sessionId, a.id, from);
  total += ops.length;
  console.log(`\n${a.name}: операций за 30 дней — ${ops.length}`);
  for (const op of ops.slice(0, 5)) {
    const when = new Date(op.operationTime?.milliseconds ?? op.operationTime).toLocaleString('ru-RU');
    console.log(`  ${when}  ${op.type === 'Debit' ? '−' : '+'}${op.amount?.value}  ${op.description}  [${op.category?.name ?? ''}, MCC ${op.mcc}]${op.hasShoppingReceipt ? '  🧾 есть чек' : ''}`);
  }
}
console.log(`\nВсего операций за 30 дней: ${total}. Сессия сохранена в api/data/tbank-session.json`);
