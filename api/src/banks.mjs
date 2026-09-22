// Подключения к банкам: хранение сессии, поддержание её живой и загрузка операций.
//
// Сессия интернет-банка — доступ к счетам, поэтому в базе она только зашифрованная:
// AES-256-GCM, ключ BANK_KEY лежит в api/.env. Утечка одной базы сессию не раскрывает.
//
// Пока банк один — Т-Банк (tbank.mjs). Сессия живёт, пока её пингуют; умерла —
// подключение помечается expired, а человеку уходит сообщение в Telegram: войти заново.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { loadEnv } from './llm.mjs';
import * as tbank from './tbank.mjs';

const FAILS_TO_EXPIRE = 3; // пинг может разово не пройти из-за сети — не спешим хоронить сессию
const FIRST_SYNC_DAYS = 90;
const OVERLAP_DAYS = 3; // операции «в обработке» меняют статус задним числом — перечитываем хвост

const now = () => new Date().toISOString();

function key() {
  loadEnv();
  const hex = process.env.BANK_KEY ?? '';
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('нет BANK_KEY (64 hex-символа) в api/.env');
  return Buffer.from(hex, 'hex');
}

export const banksReady = () => {
  try {
    key();
    return true;
  } catch {
    return false;
  }
};

export function encrypt(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(packed) {
  const [iv, tag, data] = String(packed).split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** После входа: сохранить сессию. Повторный вход обновляет то же подключение. */
export function saveSession(db, userId, bank, sessionId) {
  const at = now();
  db.prepare(
    `INSERT INTO bank_links (user_id, bank, session_enc, status, login_at, last_ok_at, fails)
     VALUES (?, ?, ?, 'active', ?, ?, 0)
     ON CONFLICT (user_id, bank) DO UPDATE SET
       session_enc = excluded.session_enc, status = 'active', login_at = excluded.login_at,
       last_ok_at = excluded.last_ok_at, fails = 0, expired_at = NULL, last_error = NULL`,
  ).run(userId, bank, encrypt(sessionId), at, at);
  return db.prepare('SELECT id FROM bank_links WHERE user_id = ? AND bank = ?').get(userId, bank).id;
}

/** Сообщение в Telegram: его заберёт и отправит бот на зарубежном сервере. */
export function notify(db, userId, text) {
  const chat = db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(userId)?.telegram_id;
  if (!chat) return false;
  db.prepare('INSERT INTO tg_outbox (chat_id, text, created_at) VALUES (?, ?, ?)').run(chat, text, now());
  return true;
}

/** Для бота: неотправленные сообщения. Отдаём один раз — повторить уведомление не страшно пропустить. */
export function takeOutbox(db) {
  const rows = db.prepare('SELECT id, chat_id, text FROM tg_outbox WHERE sent_at IS NULL ORDER BY id LIMIT 20').all();
  const mark = db.prepare('UPDATE tg_outbox SET sent_at = ? WHERE id = ?');
  for (const r of rows) mark.run(now(), r.id);
  return rows;
}

const lifetime = (from, to) => {
  const min = Math.round((Date.parse(to) - Date.parse(from)) / 60_000);
  return min < 120 ? `${min} мин` : min < 48 * 60 ? `${Math.round(min / 60)} ч` : `${Math.round(min / 1440)} дн`;
};

/** Пинг всех живых сессий. Раз в минуту из server.mjs. */
export async function keepAlive(db) {
  const links = db.prepare("SELECT * FROM bank_links WHERE status = 'active' AND session_enc IS NOT NULL").all();
  for (const link of links) {
    const alive = await tbank.ping(decrypt(link.session_enc));
    if (alive) {
      db.prepare('UPDATE bank_links SET last_ok_at = ?, fails = 0 WHERE id = ?').run(now(), link.id);
      continue;
    }
    const fails = link.fails + 1;
    if (fails < FAILS_TO_EXPIRE) {
      db.prepare('UPDATE bank_links SET fails = ? WHERE id = ?').run(fails, link.id);
      continue;
    }
    const at = now();
    db.prepare("UPDATE bank_links SET status = 'expired', fails = ?, expired_at = ?, session_enc = NULL WHERE id = ?")
      .run(fails, at, link.id);
    const lived = lifetime(link.login_at, link.last_ok_at ?? at);
    console.log(`банк: сессия подключения #${link.id} истекла, прожила ${lived}`);
    notify(db, link.user_id, `Т-Банк отключился: сессия прожила ${lived}. Чтобы операции снова загружались, войдите в Т-Банк заново.`);
  }
}

// Время банка — миллисекунды UTC; у чеков — московское время без зоны. Приводим к нему
const moscow = (ms) =>
  ms ? new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).replace(' ', 'T') : null;
const kopecks = (money) => (money?.value == null ? null : Math.round(Math.abs(money.value) * 100));

function opRow(link, budgetId, accountName, op) {
  return {
    link_id: link.id,
    budget_id: budgetId,
    ext_id: String(op.id),
    account: String(op.account),
    account_name: accountName ?? null,
    at: moscow(op.operationTime?.milliseconds),
    debited_at: moscow(op.debitingTime?.milliseconds),
    direction: op.type === 'Debit' ? 'debit' : 'credit',
    amount: kopecks(op.amount) ?? 0,
    currency: op.amount?.currency?.name ?? 'RUB',
    account_amount: kopecks(op.accountAmount),
    status: op.status ?? null,
    op_group: op.group ?? null,
    mcc: Number(op.mcc) || null,
    description: op.description ?? null,
    merchant: op.merchant?.name ?? op.brand?.name ?? null,
    bank_category: op.spendingCategory?.name ?? op.category?.name ?? null,
    card: op.cardNumber ? String(op.cardNumber).slice(-4) : null,
    has_receipt: op.hasShoppingReceipt ? 1 : 0,
    raw: JSON.stringify(op),
  };
}

/** Загрузка операций одного подключения. Повторы не плодят строк: ключ — id операции в банке. */
export async function syncLink(db, link) {
  const sessionId = decrypt(link.session_enc);
  const budgetId = db.prepare('SELECT budget_id FROM users WHERE id = ?').get(link.user_id)?.budget_id;
  if (!budgetId) return { accounts: 0, ops: 0 };

  const since = link.synced_at
    ? new Date(Date.parse(link.synced_at) - OVERLAP_DAYS * 86_400_000)
    : new Date(Date.now() - FIRST_SYNC_DAYS * 86_400_000);

  const upsert = db.prepare(
    `INSERT INTO bank_ops (link_id, budget_id, ext_id, account, account_name, at, debited_at, direction, amount,
       currency, account_amount, status, op_group, mcc, description, merchant, bank_category, card, has_receipt,
       raw, created_at, updated_at)
     VALUES (:link_id, :budget_id, :ext_id, :account, :account_name, :at, :debited_at, :direction, :amount,
       :currency, :account_amount, :status, :op_group, :mcc, :description, :merchant, :bank_category, :card,
       :has_receipt, :raw, :now, :now)
     ON CONFLICT (link_id, ext_id) DO UPDATE SET
       status = excluded.status, debited_at = excluded.debited_at, amount = excluded.amount,
       account_amount = excluded.account_amount, description = excluded.description, merchant = excluded.merchant,
       bank_category = excluded.bank_category, has_receipt = excluded.has_receipt, raw = excluded.raw,
       updated_at = excluded.updated_at`,
  );

  const accounts = await tbank.accounts(sessionId);
  let count = 0;
  for (const account of accounts) {
    const ops = await tbank.operations(sessionId, account.id, since);
    db.exec('BEGIN');
    try {
      for (const op of ops) {
        if (!op?.id || !op.operationTime) continue;
        upsert.run({ ...opRow(link, budgetId, account.name, op), now: now() });
        count += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  db.prepare('UPDATE bank_links SET synced_at = ?, last_error = NULL WHERE id = ?').run(now(), link.id);
  return { accounts: accounts.length, ops: count };
}

let syncing = false;

/** Загрузка по всем живым подключениям. Раз в 15 минут из server.mjs. */
export async function syncAll(db) {
  if (syncing) return;
  syncing = true;
  try {
    const links = db.prepare("SELECT * FROM bank_links WHERE status = 'active' AND session_enc IS NOT NULL").all();
    for (const link of links) {
      try {
        const res = await syncLink(db, link);
        console.log(`банк: подключение #${link.id} — счетов ${res.accounts}, операций ${res.ops}`);
      } catch (err) {
        db.prepare('UPDATE bank_links SET last_error = ? WHERE id = ?').run(String(err.message).slice(0, 300), link.id);
        console.error(`банк: подключение #${link.id}:`, err.message);
      }
    }
  } finally {
    syncing = false;
  }
}
