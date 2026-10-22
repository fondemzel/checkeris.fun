// Доход, вписанный вручную: зарплата наличными, возврат долга, подработка — то, чего банк не
// покажет или что пришло без подключённого банка.
//
// Лежит теми же строками, что доходы из банка (bank_ops: credit, kind = income), — тогда лента
// доходов, их категории, аналитика, экспорт и резервная копия видят его без отдельной ветки.
// Строке банка нужно подключение (link_id) — у ручных оно своё, служебное: bank = manual,
// status = manual. Его не пингуют и не показывают среди банков (listLinks). kind_source =
// manual: разметка, склейка переводов и правила вида такую строку не трогают.

import { randomBytes } from 'node:crypto';

export const MANUAL_BANK = 'manual';

const now = () => new Date().toISOString();
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/** Служебное подключение «вручную» человека: заводится с первым ручным доходом. */
function manualLink(db, userId) {
  db.prepare(
    `INSERT OR IGNORE INTO bank_links (user_id, bank, session_enc, status, login_at) VALUES (?, ?, NULL, 'manual', ?)`,
  ).run(userId, MANUAL_BANK, now());
  return db.prepare('SELECT id FROM bank_links WHERE user_id = ? AND bank = ?').get(userId, MANUAL_BANK).id;
}

/**
 * Записать доход: сумма в рублях («12 500,50»), дата, время (сегодня — текущее, прошлое —
 * полдень), категория дохода (in.*) и откуда он — «Зарплата», «Возврат долга»: это название
 * строки в ленте.
 */
export function addIncome(db, user, body) {
  const rubles = Number(String(body.sum ?? '').replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(rubles) || rubles <= 0 || rubles > 100_000_000) return { error: 'укажите сумму', status: 400 };
  const date = String(body.date ?? '');
  if (!isDay(date)) return { error: 'укажите дату', status: 400 };
  const time = /^\d{2}:\d{2}$/.test(body.time ?? '') ? body.time : '12:00';
  const category = db.prepare('SELECT slug, name FROM income_cats WHERE budget_id = ? AND slug = ?').get(user.budget_id, String(body.category ?? ''));
  if (!category) return { error: 'выберите категорию', status: 400 };
  const name = String(body.name ?? '').trim().slice(0, 200) || category.name;
  const note = String(body.note ?? '').trim().slice(0, 1000) || null;

  const at = `${date}T${time}:00`;
  const stamp = now();
  const id = db.prepare(
    `INSERT INTO bank_ops (link_id, budget_id, ext_id, account, at, direction, amount, currency, status, op_group,
                           description, kind, kind_source, category_slug, category_source, note, raw, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, 'credit', ?, 'RUB', 'OK', 'INCOME', ?, 'income', 'manual', ?, 'manual', ?, '{}', ?, ?)`,
  ).run(manualLink(db, user.id), user.budget_id, `manual:${randomBytes(8).toString('hex')}`, at, Math.round(rubles * 100),
    name, category.slug, note, stamp, stamp).lastInsertRowid;
  return { id: Number(id) };
}

/** Удалить ручной доход — только ручной: поступление из банка настоящее, его «не учитывают». */
export function deleteIncome(db, budgetId, id) {
  const op = db
    .prepare('SELECT l.bank FROM bank_ops o JOIN bank_links l ON l.id = o.link_id WHERE o.id = ? AND o.budget_id = ?')
    .get(id, budgetId);
  if (!op) return { error: 'запись не найдена', status: 404 };
  if (op.bank !== MANUAL_BANK) return { error: 'удалить можно только ручную запись', status: 409 };
  db.prepare('DELETE FROM bank_ops WHERE id = ?').run(id);
  return { ok: true };
}
