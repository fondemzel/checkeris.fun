// Сообщения в Telegram другим участникам общего бюджета: кто-то внёс трату или доход —
// остальные узнают. Каждый может выключить их у себя (users.notify_members, «Бюджет»).
//
// Сообщения коротко и по одному на событие: ручная запись, скан чека, загрузка из банка
// (одной сводкой на загрузку, а не по операции). Историю банка, которую грузят сотнями
// операций, не сообщаем. В тестовой базе (демо-режим) ничего не вносится — и не сообщается.
import { notify } from './banks.mjs';
import { isDemo } from './demo.mjs';

const BANKS = { tbank: 'Т-Банка', sber: 'Сбера' };
const rub = (kop) => `${new Intl.NumberFormat('ru-RU').format(Math.round(kop / 100))} ₽`;
const plural = (n, one, few, many) => {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
};

/** Разослать text остальным участникам бюджета от имени actorId. */
export function notifyMembers(db, budgetId, actorId, text) {
  if (!budgetId || !actorId || isDemo(db, budgetId)) return 0;
  const actor = db.prepare('SELECT COALESCE(name, login) AS name FROM users WHERE id = ?').get(actorId)?.name ?? 'Участник';
  const others = db
    .prepare('SELECT id FROM users WHERE budget_id = ? AND id <> ? AND telegram_id IS NOT NULL AND COALESCE(notify_members, 1) = 1')
    .all(budgetId, actorId);
  for (const u of others) notify(db, u.id, `${actor}: ${text}`);
  return others.length;
}

/** Ручная запись: «Кофе» — 350 ₽. */
export function notifyManual(db, budgetId, actorId, name, sum) {
  return notifyMembers(db, budgetId, actorId, `«${name}» — ${rub(sum)}`);
}

/** Скан чека: чек «Пятёрочка» на 1 234 ₽. */
export function notifyReceipt(db, receiptId, actorId) {
  const r = db.prepare('SELECT budget_id, COALESCE(retail_place, seller) AS place, total_sum FROM receipts WHERE id = ?').get(receiptId);
  if (!r) return 0;
  const place = String(r.place ?? '').replace(/\s+/g, ' ').trim(); // в чеках бывают двойные пробелы
  return notifyMembers(db, r.budget_id, actorId, `чек${place ? ` «${place}»` : ''} на ${rub(r.total_sum)}`);
}

/**
 * Загрузка из банка: новые операции одной сводкой. Переводы себе и исключённые не в счёт.
 * Одна — «трата 350 ₽ — Пятёрочка (Т-Банк)»; несколько — «из Т-Банка 3 траты на 2 400 ₽».
 */
export function notifyBankOps(db, linkId, extIds) {
  if (!extIds.length) return 0;
  const link = db.prepare('SELECT l.user_id, l.bank, u.budget_id FROM bank_links l JOIN users u ON u.id = l.user_id WHERE l.id = ?').get(linkId);
  if (!link) return 0;
  const marks = extIds.map(() => '?').join(', ');
  const ops = db
    .prepare(
      `SELECT direction, amount, COALESCE(merchant, description) AS who, kind FROM bank_ops
        WHERE link_id = ? AND ext_id IN (${marks}) AND COALESCE(kind, '') NOT IN ('transfer', 'excluded')`,
    )
    .all(linkId, ...extIds);
  const spent = ops.filter((o) => o.direction === 'debit');
  const got = ops.filter((o) => o.direction === 'credit');
  if (!spent.length && !got.length) return 0;
  const from = BANKS[link.bank] ?? 'банка';
  if (ops.length === 1) {
    const [o] = ops;
    const what = o.direction === 'debit' ? 'трата' : 'поступление';
    return notifyMembers(db, link.budget_id, link.user_id, `${what} ${rub(o.amount)}${o.who ? ` — ${o.who}` : ''} (из ${from})`);
  }
  const sum = (list) => list.reduce((n, o) => n + o.amount, 0);
  const parts = [];
  if (spent.length) parts.push(`${spent.length} ${plural(spent.length, 'трата', 'траты', 'трат')} на ${rub(sum(spent))}`);
  if (got.length) parts.push(`${got.length} ${plural(got.length, 'поступление', 'поступления', 'поступлений')} на ${rub(sum(got))}`);
  return notifyMembers(db, link.budget_id, link.user_id, `из ${from} ${parts.join(' и ')}`);
}
