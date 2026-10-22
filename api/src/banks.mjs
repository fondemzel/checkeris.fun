// Подключения к банкам: хранение сессии, поддержание её живой и загрузка операций.
//
// Сессия интернет-банка — доступ к счетам, поэтому в базе она только зашифрованная:
// AES-256-GCM, ключ BANK_KEY лежит в api/.env. Утечка одной базы сессию не раскрывает.
//
// Пока банк один — Т-Банк (tbank.mjs). Сессия живёт, пока её пингуют; умерла —
// подключение помечается expired, а человеку уходит сообщение в Telegram: войти заново.
import { notifyBankOps } from './members.mjs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { loadEnv } from './llm.mjs';
import { matchBank, opWhoSql } from './bankmatch.mjs';
import { convertForeign } from './fx.mjs';
import { parseOp, trimOp, validOp } from './bankformat.mjs';
import { disabledAccounts } from './bankaccounts.mjs';
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

/**
 * Сообщение в Telegram: его заберёт и отправит бот на зарубежном сервере. html — текст
 * с разметкой Telegram (ссылка под словом); всё, что пришло из данных, должно быть экранировано.
 */
export function notify(db, userId, text, { html = false } = {}) {
  const chat = db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(userId)?.telegram_id;
  if (!chat) return false;
  db.prepare('INSERT INTO tg_outbox (chat_id, text, html, created_at) VALUES (?, ?, ?, ?)').run(chat, text, html ? 1 : 0, now());
  return true;
}

/** Для бота: неотправленные сообщения. Отдаём один раз — повторить уведомление не страшно пропустить. */
export function takeOutbox(db) {
  const rows = db
    .prepare('SELECT id, chat_id, text, delete_msg, html FROM tg_outbox WHERE sent_at IS NULL ORDER BY id LIMIT 20')
    .all();
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

/** Строка bank_ops из операции банка: храним сокращённый ответ, поля — по разбору его банка. */
function opRow(link, budgetId, bank, accountName, op) {
  const trimmed = trimOp(bank, accountName ? { ...op, accountName } : op);
  return {
    link_id: link.id,
    budget_id: budgetId,
    account_name: trimmed.accountName ?? null,
    ...parseOp(bank, trimmed),
    raw: JSON.stringify(trimmed),
  };
}

function opUpsert(db) {
  return db.prepare(
    `INSERT INTO bank_ops (link_id, budget_id, ext_id, account, account_name, at, debited_at, direction, amount,
       currency, account_amount, status, op_group, mcc, description, merchant, bank_category, card, has_receipt,
       raw, created_at, updated_at)
     VALUES (:link_id, :budget_id, :ext_id, :account, :account_name, :at, :debited_at, :direction, :amount,
       :currency, :account_amount, :status, :op_group, :mcc, :description, :merchant, :bank_category, :card,
       :has_receipt, :raw, :now, :now)
     ON CONFLICT (link_id, ext_id) DO UPDATE SET
       status = excluded.status, debited_at = excluded.debited_at, amount = excluded.amount, currency = excluded.currency,
       account_amount = excluded.account_amount, description = excluded.description, merchant = excluded.merchant,
       bank_category = excluded.bank_category, has_receipt = excluded.has_receipt, raw = excluded.raw,
       updated_at = excluded.updated_at`,
  );
}

/**
 * Операции, присланные приложением с телефона. Вход в банк и сама выгрузка происходят
 * на устройстве человека — сюда приезжают уже готовые операции в том виде, в каком их
 * отдал банк. Подключение для такого источника помечается status = 'device':
 * сессии банка на сервере нет и пинговать нечего.
 */
export function importOps(db, userId, bank, ops, { defer = false } = {}) {
  const budgetId = db.prepare('SELECT budget_id FROM users WHERE id = ?').get(userId)?.budget_id;
  if (!budgetId) return { ops: 0 };
  const at = now();
  db.prepare(
    `INSERT INTO bank_links (user_id, bank, session_enc, status, login_at, last_ok_at, synced_at)
     VALUES (?, ?, NULL, 'device', ?, ?, ?)
     ON CONFLICT (user_id, bank) DO UPDATE SET status = 'device', session_enc = NULL,
       last_ok_at = excluded.last_ok_at, synced_at = excluded.synced_at, fails = 0, expired_at = NULL`,
  ).run(userId, bank, at, at, at);
  const link = db.prepare('SELECT id FROM bank_links WHERE user_id = ? AND bank = ?').get(userId, bank);

  const upsert = opUpsert(db);
  const known = db.prepare('SELECT 1 FROM bank_ops WHERE link_id = ? AND ext_id = ?');
  // Счета, которые человек выключил, не принимаем — даже если старое приложение их прислало.
  // Незнакомый счёт запоминаем включённым: новая карта не должна выпасть из учёта молча
  const disabled = disabledAccounts(db, link.id);
  const remember = db.prepare(
    `INSERT OR IGNORE INTO bank_accounts (link_id, account, name, enabled, updated_at) VALUES (?, ?, ?, 1, ?)`,
  );
  // Т-Банк меняет номер операции, когда проводит её: у покупки «в обработке» один id, у
  // списанной — другой. По номеру она выглядит новой и ложится второй строкой. Узнаём её по
  // двойнику: тот же счёт, та же секунда, сумма и направление, а двойник ещё не списан.
  // Двойнику отдаём новый номер — строка обновляется на месте, с чеком, категорией и
  // комментарием. У Сбера времени списания нет вовсе, и его это не касается
  // Сумма — в валюте банка: валютная операция у нас уже в рублях, её исходная — в orig_amount
  const same = `link_id = :link AND account = :account AND at = :at AND COALESCE(orig_amount, amount) = :amount
    AND direction = :direction AND ext_id <> :ext`;
  const pendingTwin = db.prepare(`SELECT id FROM bank_ops WHERE ${same} AND debited_at IS NULL ORDER BY id LIMIT 1`);
  const settledTwin = db.prepare(`SELECT 1 FROM bank_ops WHERE ${same} AND debited_at IS NOT NULL LIMIT 1`);
  const adopt = db.prepare('UPDATE bank_ops SET ext_id = ? WHERE id = ?');
  let count = 0;
  let added = 0; // сколько операций человек видит впервые: остальные приехали на повторную проверку
  const fresh = []; // их номера — для сообщения другим участникам бюджета (members.mjs)
  let skipped = 0;
  db.exec('BEGIN');
  try {
    for (const op of ops ?? []) {
      if (!validOp(bank, op)) continue;
      const row = opRow(link, budgetId, bank, null, op);
      if (disabled.has(row.account)) {
        skipped += 1;
        continue;
      }
      remember.run(link.id, row.account, row.account_name, at);
      if (!known.get(link.id, row.ext_id)) {
        const key = { link: link.id, account: row.account, at: row.at, amount: row.amount, direction: row.direction, ext: row.ext_id };
        if (row.debited_at) {
          // Списанная, а у нас она ещё «в обработке» под старым номером — это она же
          const pending = pendingTwin.get(key);
          if (pending) adopt.run(row.ext_id, pending.id);
          else {
            added += 1;
            fresh.push(row.ext_id);
          }
        } else if (settledTwin.get(key)) {
          // Банк снова прислал вариант «в обработке», а проведённая уже есть — не плодим
          count += 1;
          continue;
        } else {
          added += 1;
          fresh.push(row.ext_id);
        }
      }
      upsert.run({ ...row, now: at });
      count += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const total = db.prepare('SELECT COUNT(*) c FROM bank_ops WHERE link_id = ?').get(link.id).c;
  // Загрузка истории идёт сотнями пачек: разбирать всё после каждой незачем — один раз в конце
  if (defer) return { ops: count, added, total, skipped };
  // Сразу разбираем: что покрыто чеком, что перевод между своими, что доход
  const marks = matchBank(db, budgetId);
  convertForeign(db).catch((err) => console.error('валюта:', err.message)); // траты в валюте — в рубли
  // Другим участникам бюджета — что пришло (вид операций уже разобран: переводы себе не в счёт)
  try {
    notifyBankOps(db, link.id, fresh);
  } catch (err) {
    console.error('сообщение участникам:', err.message);
  }
  return { ops: count, added, total, skipped, ...marks };
}

/**
 * Пары, которые легли двумя строками до того, как приём научился узнавать проведённую
 * операцию (см. importOps): одна «в обработке», другая списанная, под разными номерами.
 * Оставляем строку «в обработке» — к ней уже привязаны чек, категория, комментарий, — а
 * номер, время списания и ответ банка берём у проведённой. Проведённую убираем.
 * Идемпотентно: когда пар нет, ничего не делает.
 */
export function mergeSettledTwins(db) {
  const pairs = db
    .prepare(
      `SELECT a.id AS keepId, b.id AS dropId FROM bank_ops a
         JOIN bank_ops b ON b.link_id = a.link_id AND b.account = a.account AND b.at = a.at
          AND COALESCE(b.orig_amount, b.amount) = COALESCE(a.orig_amount, a.amount)
          AND b.direction = a.direction AND b.id <> a.id
        WHERE a.debited_at IS NULL AND b.debited_at IS NOT NULL`,
    )
    .all();
  if (!pairs.length) return 0;
  const read = db.prepare('SELECT ext_id, debited_at, status, raw, receipt_id, note FROM bank_ops WHERE id = ?');
  const drop = db.prepare('DELETE FROM bank_ops WHERE id = ?');
  const take = db.prepare(
    `UPDATE bank_ops SET ext_id = :ext_id, debited_at = :debited_at, status = :status, raw = :raw,
       -- Что человек или разметка успели сделать с проведённой — не теряем
       receipt_id = COALESCE(receipt_id, :receipt_id), note = COALESCE(note, :note), updated_at = :now
     WHERE id = :keepId`,
  );
  const repoint = db.prepare('UPDATE bank_ops SET pair_id = :keepId WHERE pair_id = :dropId');
  const at = now();
  const done = new Set();
  db.exec('BEGIN');
  try {
    for (const { keepId, dropId } of pairs) {
      if (done.has(keepId) || done.has(dropId)) continue; // строка уже склеена с другой
      done.add(keepId).add(dropId);
      // Номер у операции уникален: проведённую сначала убираем, потом отдаём её номер
      const settled = read.get(dropId);
      drop.run(dropId);
      take.run({ ...settled, keepId, now: at });
      repoint.run({ keepId, dropId });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return done.size / 2;
}

/** Загрузка операций одного подключения. Повторы не плодят строк: ключ — id операции в банке. */
export async function syncLink(db, link) {
  const sessionId = decrypt(link.session_enc);
  const budgetId = db.prepare('SELECT budget_id FROM users WHERE id = ?').get(link.user_id)?.budget_id;
  if (!budgetId) return { accounts: 0, ops: 0 };

  const since = link.synced_at
    ? new Date(Date.parse(link.synced_at) - OVERLAP_DAYS * 86_400_000)
    : new Date(Date.now() - FIRST_SYNC_DAYS * 86_400_000);

  const upsert = opUpsert(db);

  const accounts = await tbank.accounts(sessionId);
  let count = 0;
  for (const account of accounts) {
    const ops = await tbank.operations(sessionId, account.id, since);
    db.exec('BEGIN');
    try {
      for (const op of ops) {
        if (!op?.id || !op.operationTime) continue;
        upsert.run({ ...opRow(link, budgetId, 'tbank', account.name, op), now: now() });
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

/** Что показать в настройках: подключения человека, без самих сессий. */
export function listLinks(db, userId) {
  // Сегодня — по Москве: время операций хранится московским, без зоны
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  return db
    .prepare(
      `SELECT l.bank, l.status, l.login_at, l.last_ok_at, l.expired_at, l.synced_at, l.last_error,
              l.dev_state, l.dev_detail, l.dev_at, l.bg_at, l.session_at,
              (SELECT COUNT(*) FROM bank_ops o WHERE o.link_id = l.id)
                + (SELECT COUNT(*) FROM shop_cheques c WHERE c.link_id = l.id) AS ops,
              -- За сегодня: столько новых операций видно в строке банка. Выключенные счета не в счёт.
              -- У Озона вместо операций — его чеки
              (SELECT COUNT(*) FROM bank_ops o
                WHERE o.link_id = l.id AND o.at >= :today AND COALESCE(o.kind, '') <> 'excluded')
                + (SELECT COUNT(*) FROM shop_cheques c WHERE c.link_id = l.id AND c.purchased_at >= :today) AS today,
              (SELECT MAX(at) FROM bank_ops o WHERE o.link_id = l.id) AS last_op_at
         FROM bank_links l WHERE l.user_id = :user AND l.bank <> 'manual'`, -- ручные доходы — не банк (manualincome.mjs)
    )
    .all({ today, user: userId });
}

const REPORT_STATES = new Set(['ok', 'expired', 'offline', 'error', 'off']);

/**
 * Итог обращения телефона к банку или магазину (LinkReport в приложении): ok — загрузили,
 * expired — просит войти заново, offline — не отвечает, error — другое, off — вышли на
 * телефоне. Без этого сервер считал подключение живым, пока телефон молча не мог войти.
 *
 * bg_at — когда фоновое задание телефона приходило в последний раз: по нему видно, будит ли
 * система приложение. session_at — с какого момента жива нынешняя сессия (первый успех после
 * «войти заново»): вместе с expired_at даёт, сколько сессия банка живёт на деле.
 */
export function reportLink(db, userId, { bank, state, detail = null, background = false, perms = null } = {}) {
  if (!/^[a-z]{2,10}$/.test(String(bank ?? '')) || !REPORT_STATES.has(state)) return { error: 'неверный отчёт', status: 400 };
  const at = now();
  const link = db.prepare('SELECT id, dev_state, status FROM bank_links WHERE user_id = ? AND bank = ?').get(userId, bank);
  if (!link) {
    if (state === 'off') return { ok: true };
    db.prepare(`INSERT INTO bank_links (user_id, bank, session_enc, status, login_at) VALUES (?, ?, NULL, 'device', ?)`).run(userId, bank, at);
  }
  const was = link?.dev_state ?? null;
  db.prepare(
    `UPDATE bank_links SET
       dev_state = :state, dev_detail = :detail, dev_at = :at,
       bg_at = CASE WHEN :bg THEN :at ELSE bg_at END,
       dev_perms = COALESCE(:perms, dev_perms),
       last_ok_at = CASE WHEN :state = 'ok' THEN :at ELSE last_ok_at END,
       -- новая сессия: первый успех после «войти заново», выхода или впервые
       session_at = CASE WHEN :state = 'ok' AND (:was IS NULL OR :was IN ('expired', 'off')) THEN :at ELSE session_at END,
       expired_at = CASE WHEN :state = 'expired' AND COALESCE(:was, '') <> 'expired' THEN :at
                         WHEN :state = 'ok' THEN NULL ELSE expired_at END,
       status = CASE WHEN :state = 'off' THEN 'off' WHEN status = 'off' AND :state = 'ok' THEN 'device' ELSE status END
     WHERE user_id = :user AND bank = :bank`,
  ).run({ state, detail: detail == null ? null : String(detail).slice(0, 300), at, bg: background ? 1 : 0, perms: perms == null ? null : String(perms).slice(0, 80), was, user: userId, bank });
  if (perms != null) warnPerms(db, userId, String(perms));
  return { ok: true };
}

/**
 * Телефон сообщил, что Чекеру не хватает разрешений (Perms.summary: «фон да, автозапуск нет»):
 * без них система будит фоновое обновление редко, и банки молча отстают. Бот пишет один раз,
 * как только разрешение пропало; снова — только если его выдали и опять отозвали.
 */
function warnPerms(db, userId, perms) {
  const missing = [];
  if (/фон нет/.test(perms)) missing.push('работа в фоне без ограничений');
  if (/автозапуск нет/.test(perms)) missing.push('автозапуск');
  const warned = db.prepare('SELECT perm_warned FROM users WHERE id = ?').get(userId)?.perm_warned ?? null;
  if (!missing.length) {
    if (warned) db.prepare('UPDATE users SET perm_warned = NULL WHERE id = ?').run(userId);
    return;
  }
  const key = missing.join(', ');
  if (warned === key) return;
  const what = missing.length > 1 ? `выключены ${key}` : `выключен${missing[0] === 'автозапуск' ? '' : 'а'} ${key}`;
  const text = `На телефоне у Чекера ${what}, поэтому банки и магазины обновляются в фоне редко или не обновляются совсем.`
    + `
Включите в <a href="${SITE}/m/?screen=set_banks">Настройки → Банки → Разрешения</a>`;
  if (notify(db, userId, text, { html: true })) db.prepare('UPDATE users SET perm_warned = ? WHERE id = ?').run(key, userId);
}

const SITE = (process.env.SITE_ORIGIN || 'https://checkeris.fun').replace(/\/$/, '');
const LINK_NAMES = { tbank: 'Т-Банк', sber: 'Сбербанк', ozon: 'Озон', wb: 'Wildberries' };
const REMIND_HOUR = 20; // вечером по Москве
const mskDay = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

/**
 * Напоминание в Telegram: банк или магазин просит войти заново (по отчёту телефона, reportLink).
 * Раз в сутки, вечером, одним сообщением на человека — со ссылкой на экран каждого в Чекере.
 * Сбер, например, держит сессию только час: без входа его операции не обновляются.
 * Выключается у себя: users.remind_login («Настройки → Банки → Синхронизация»).
 */
export function remindLogins(db, at = new Date()) {
  const hour = Number(at.toLocaleString('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hour12: false }));
  if (hour !== REMIND_HOUR) return 0;
  const today = mskDay(at.toISOString());
  const links = db.prepare(
    `SELECT l.id, l.user_id, l.bank, l.remind_at FROM bank_links l JOIN users u ON u.id = l.user_id
      WHERE l.dev_state = 'expired' AND l.status <> 'off' AND u.telegram_id IS NOT NULL AND COALESCE(u.remind_login, 1) = 1`,
  ).all().filter((l) => !l.remind_at || mskDay(l.remind_at) !== today);
  const byUser = new Map();
  for (const l of links) byUser.set(l.user_id, [...(byUser.get(l.user_id) ?? []), l]);
  const mark = db.prepare('UPDATE bank_links SET remind_at = ? WHERE id = ?');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let sent = 0;
  for (const [userId, list] of byUser) {
    const lines = list.map((l) => {
      const name = LINK_NAMES[l.bank] ?? l.bank;
      return `• ${esc(name)} — <a href="${SITE}/m/?screen=bank_card&amp;bank=${encodeURIComponent(l.bank)}">войти</a>`;
    });
    const text = `Просят войти заново — без этого их операции не обновляются:\n${lines.join('\n')}`;
    if (notify(db, userId, text, { html: true })) {
      for (const l of list) mark.run(at.toISOString(), l.id);
      sent += 1;
    }
  }
  return sent;
}

/** Отключить банк: операции остаются, связь с источником обрывается. */
export function unlink(db, userId, bank) {
  db.prepare("UPDATE bank_links SET session_enc = NULL, status = 'off' WHERE user_id = ? AND bank = ?")
    .run(userId, bank);
  return { ok: true };
}

/**
 * Операции банка за период. Пока это отдельный список: в суммы расходов они не входят,
 * иначе покупка картой считалась бы дважды — чеком и операцией. Сопоставление впереди.
 */
const BANK_SORTS = { date: 'at', name: 'COALESCE(merchant, description)', sum: 'amount' };

export function listBankOps(db, budgetId, {
  from, to, direction = 'debit', kind = null, group = null, category = null, per = 200, page = 1,
  sort = 'date', dir = 'desc',
}) {
  const column = BANK_SORTS[sort] ?? BANK_SORTS.date;
  const order = dir === 'asc' ? 'ASC' : 'DESC';
  const args = { budgetId, from: `${from}T00:00:00`, to: `${to}T23:59:59` };
  const kinds = kind ? String(kind).split(',').filter((k) => /^[a-z]+$/.test(k)) : [];
  // «-» — траты без категории: их тоже нужно уметь открыть списком
  const byCategory = category === '-' ? 'AND category_slug IS NULL' : category ? 'AND category_slug = :category' : '';
  const byGroup = group === '-'
    ? 'AND category_slug IS NULL'
    : group
      ? `AND category_slug IN (SELECT c.slug FROM categories c
           WHERE c.budget_id = :budgetId AND c.group_slug = :group)`
      : '';
  const where = `WHERE budget_id = :budgetId AND at BETWEEN :from AND :to
                 ${direction === 'all' ? '' : 'AND direction = :direction'}
                 ${kinds.length ? `AND kind IN (${kinds.map((k) => `'${k}'`).join(', ')})` : ''}
                 ${byCategory} ${byGroup}`;
  if (direction !== 'all') args.direction = direction;
  if (category && category !== '-') args.category = category;
  if (group && group !== '-') args.group = group;

  const rows = db
    .prepare(
      `SELECT id, ext_id, at, direction, amount, currency, account_name, status, op_group, mcc,
              description, merchant, bank_category, card, has_receipt, kind, receipt_id,
              category_slug, category_source, note IS NOT NULL AS has_note, orig_amount, orig_currency,
              (SELECT l.bank FROM bank_links l WHERE l.id = bank_ops.link_id) AS bank
         FROM bank_ops ${where}
        ORDER BY ${column} ${order} LIMIT :limit OFFSET :offset`,
    )
    .all({ ...args, limit: per, offset: (page - 1) * per });

  const totals = db
    .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS sum FROM bank_ops ${where}`)
    .get(args);

  return { rows, totals, page, per };
}

/** Забыть банк совсем: операции и само подключение. Чеки и ручные траты не трогаем. */
export function forgetBank(db, userId, bank) {
  const link = db.prepare('SELECT id FROM bank_links WHERE user_id = ? AND bank = ?').get(userId, bank);
  if (!link) return { ops: 0 };
  const ops = db.prepare('SELECT COUNT(*) c FROM bank_ops WHERE link_id = ?').get(link.id).c;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM bank_ops WHERE link_id = ?').run(link.id);
    db.prepare('DELETE FROM bank_accounts WHERE link_id = ?').run(link.id);
    db.prepare('DELETE FROM bank_links WHERE id = ?').run(link.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { ops };
}

/** Одна операция для её карточки: с категорией и сколько ещё операций у этого продавца. */
export function getBankOp(db, budgetId, id) {
  const op = db
    .prepare(
      `SELECT o.id, o.at, o.debited_at, o.direction, o.amount, o.currency, o.account, o.account_name, o.status,
              o.op_group, o.mcc, o.description, o.merchant, o.bank_category, o.card, o.kind,
              o.receipt_id, o.category_slug, o.category_source, o.note, o.orig_amount, o.orig_currency,
              json_extract(o.raw, '$.senderDetails') AS sender,
              l.bank, -- какой именно банк: в карточке это видно в строке «Источник»
              c.name AS category_name, c.group_slug, g.name AS group_name,
              -- Сколько операций затронет выбор категории: у траты — того же продавца,
              -- у поступления — с тем же описанием
              (SELECT COUNT(*) FROM bank_ops x
                WHERE x.budget_id = o.budget_id
                  AND x.kind = CASE WHEN o.direction = 'credit' THEN 'income' ELSE 'expense' END
                  AND CASE WHEN o.direction = 'credit'
                        THEN COALESCE(x.description, json_extract(x.raw, '$.senderDetails'), x.merchant)
                        ELSE ${opWhoSql('x')} END
                    = CASE WHEN o.direction = 'credit'
                        THEN COALESCE(o.description, json_extract(o.raw, '$.senderDetails'), o.merchant)
                        ELSE ${opWhoSql('o')} END
              ) AS same_count
         FROM bank_ops o
         JOIN bank_links l ON l.id = o.link_id
         LEFT JOIN categories c ON c.budget_id = o.budget_id AND c.slug = o.category_slug
         LEFT JOIN groups g ON g.budget_id = o.budget_id AND g.slug = c.group_slug
        WHERE o.id = ? AND o.budget_id = ?`,
    )
    .get(id, budgetId);
  return op ?? null;
}

/** Комментарий к трате из банка. Пустой — удалить. */
export function setBankOpNote(db, budgetId, id, note) {
  const text = String(note ?? '').trim().slice(0, 1000) || null;
  const res = db.prepare('UPDATE bank_ops SET note = ? WHERE id = ? AND budget_id = ?').run(text, id, budgetId);
  return res.changes ? { note: text } : { error: 'operation not found', status: 404 };
}

