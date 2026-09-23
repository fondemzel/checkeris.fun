// Загрузка всей истории банка: мастер на телефоне ведёт человека по шагам, а сервер
// хранит, на каком шаге он остановился, делает копию базы перед загрузкой и подводит итог.
//
// Сами операции приходят обычным путём (importOps) с defer: разметка — один раз в конце,
// а не после каждой из сотен пачек.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DB_PATH } from './db.mjs';
import { matchBank } from './bankmatch.mjs';
import { knownBank, trimOp } from './bankformat.mjs';

const now = () => new Date().toISOString();

/** Шаг мастера и всё, что странице нужно помнить между запусками: хранится как есть. */
export function getHistory(db, userId, bank) {
  const row = db.prepare('SELECT * FROM bank_history WHERE user_id = ? AND bank = ?').get(userId, bank);
  if (!row) return { state: null };
  return {
    state: JSON.parse(row.state),
    started_at: row.started_at,
    finished_at: row.finished_at,
    updated_at: row.updated_at,
  };
}

export function saveHistory(db, userId, bank, state) {
  db.prepare(
    `INSERT INTO bank_history (user_id, bank, state, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, bank) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
  ).run(userId, bank, JSON.stringify(state ?? {}), now());
  return { ok: true };
}

/**
 * Перед загрузкой — копия базы: история приносит десятки тысяч строк, и если что-то
 * пойдёт не так, вернуться должно быть к чему. Одна копия в день, повторный старт её не плодит.
 */
export function startHistory(db, userId, bank) {
  const day = now().slice(0, 10);
  const dir = join(dirname(DB_PATH), 'backups');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `before-history-${day}.db`);
  if (!existsSync(file)) db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const at = now();
  db.prepare(
    `INSERT INTO bank_history (user_id, bank, state, started_at, updated_at) VALUES (?, ?, '{}', ?, ?)
     ON CONFLICT (user_id, bank) DO UPDATE SET started_at = excluded.started_at, finished_at = NULL,
       updated_at = excluded.updated_at`,
  ).run(userId, bank, at, at);
  return { ok: true, backup: file.split(/[\\/]/).pop() };
}

/** Конец загрузки: разметить всё разом и рассказать, что получилось. */
export function finishHistory(db, userId, bank) {
  const budgetId = db.prepare('SELECT budget_id FROM users WHERE id = ?').get(userId)?.budget_id;
  const link = db.prepare('SELECT id FROM bank_links WHERE user_id = ? AND bank = ?').get(userId, bank);
  if (!budgetId || !link) return { error: 'bank not connected', status: 404 };
  const marks = matchBank(db, budgetId);
  db.prepare('UPDATE bank_history SET finished_at = ?, updated_at = ? WHERE user_id = ? AND bank = ?')
    .run(now(), now(), userId, bank);
  return { ...marks, ...historyStats(db, link.id) };
}

/** Что лежит в базе по подключению: для итоговых экранов мастера. */
export function historyStats(db, linkId) {
  const total = db
    .prepare('SELECT COUNT(*) AS count, MIN(at) AS first, MAX(at) AS last FROM bank_ops WHERE link_id = ?')
    .get(linkId);
  const kinds = db
    .prepare(
      `SELECT kind, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS sum,
              SUM(category_slug IS NOT NULL) AS categorized
         FROM bank_ops WHERE link_id = ? GROUP BY kind`,
    )
    .all(linkId);
  const accounts = db
    .prepare(
      `SELECT account, account_name AS name, COUNT(*) AS count, MIN(at) AS first, MAX(at) AS last
         FROM bank_ops WHERE link_id = ? GROUP BY account ORDER BY count DESC`,
    )
    .all(linkId);
  const years = db
    .prepare('SELECT substr(at, 1, 4) AS year, COUNT(*) AS count FROM bank_ops WHERE link_id = ? GROUP BY year')
    .all(linkId);
  return { total, kinds, accounts, years };
}

/**
 * Операции, загруженные до сокращения, хранят ответ банка целиком (килобайты служебного).
 * Сокращаем по тому же списку полей; сокращённые не трогаем. Вызывается при запуске.
 */
export function trimStoredOps(db) {
  const rows = db
    .prepare(
      `SELECT o.id, o.raw, l.bank FROM bank_ops o JOIN bank_links l ON l.id = o.link_id
        WHERE json_extract(o.raw, '$.analytics') IS NOT NULL OR json_extract(o.raw, '$.brand.logo') IS NOT NULL`,
    )
    .all();
  if (!rows.length) return 0;
  const save = db.prepare('UPDATE bank_ops SET raw = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (!knownBank(r.bank)) continue;
      save.run(JSON.stringify(trimOp(r.bank, JSON.parse(r.raw))), r.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}
