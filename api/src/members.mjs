// Сообщения в Telegram другим участникам общего бюджета: кто-то внёс трату или доход —
// остальные узнают. Каждый может выключить их у себя (users.notify_members, «Бюджет»).
//
// По одному сообщению на событие: ручная запись, скан чека, загрузка из банка (одной сводкой
// на загрузку, а не по операции). Историю банка, которую грузят сотнями операций, не сообщаем.
// В тестовой базе (демо-режим) ничего не вносится — и не сообщается.
//
// Вид сообщения: значок и «Имя · что случилось» в первой строке, ниже — суть (где, сколько,
// категория) и ссылка, которая открывает это в приложении. Имя — в начале, а не при глаголе:
// по имени нельзя надёжно понять, «добавил» или «добавила».
import { notify } from './banks.mjs';
import { isDemo } from './demo.mjs';
import { opWho } from './bankmatch.mjs';

const SITE = (process.env.SITE_ORIGIN || 'https://checkeris.fun').replace(/\/$/, '');
const BANK_FROM = { tbank: 'из Т-Банка', sber: 'из Сбера' };
const BANK_TO = { tbank: 'в Т-Банк', sber: 'в Сбер' };
const rub = (kop) => `${new Intl.NumberFormat('ru-RU').format(Math.round(kop / 100))} ₽`;
// Текст из данных — в разметку HTML только экранированным: «<» в названии сломал бы сообщение
const html = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clean = (s) => html(String(s ?? '').replace(/\s+/g, ' ').trim()); // в чеках бывают двойные пробелы
// Ссылка под словом — последней строкой сообщения
const look = (url, word = 'Посмотреть') => `<a href="${html(url)}">${word}</a>`;
const plural = (n, one, few, many) => {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
};
// Название товара — первые два-три слова: «Молоко Простоквашино 3,2% 930 мл» → «Молоко Простоквашино»
// и обычным регистром: в чеках названия бывают ЗАГЛАВНЫМИ («ЖИГУЛЕВСКОЕ Пиво» → «Жигулевское пиво»)
const shortName = (name) => {
  const words = clean(name).split(' ');
  const two = words.slice(0, 2).join(' ');
  const short = (two.length < 12 && words[2] && !/\d/.test(words[2]) ? words.slice(0, 3).join(' ') : two).toLowerCase();
  return short.charAt(0).toUpperCase() + short.slice(1);
};

/** Разослать участникам бюджета, кроме actorId: «значок Имя · заголовок», ниже — строки. */
export function notifyMembers(db, budgetId, actorId, icon, title, lines = []) {
  if (!budgetId || !actorId || isDemo(db, budgetId)) return 0;
  const actor = html(db.prepare('SELECT COALESCE(name, login) AS name FROM users WHERE id = ?').get(actorId)?.name ?? 'Участник');
  const others = db
    .prepare('SELECT id FROM users WHERE budget_id = ? AND id <> ? AND telegram_id IS NOT NULL AND COALESCE(notify_members, 1) = 1')
    .all(budgetId, actorId);
  const text = [`${icon} ${actor} · ${title}`, ...lines.filter(Boolean)].join('\n');
  for (const u of others) notify(db, u.id, text, { html: true });
  return others.length;
}

const categoryName = (db, budgetId, slug) =>
  slug
    ? db.prepare('SELECT name FROM categories WHERE budget_id = ? AND slug = ?').get(budgetId, slug)?.name
      ?? db.prepare('SELECT name FROM income_cats WHERE budget_id = ? AND slug = ?').get(budgetId, slug)?.name
    : null;

/** Ручная запись: «✍️ Ольга · запись вручную / Кофе — 350 ₽ · Рестораны и кафе / ссылка». */
export function notifyManual(db, budgetId, actorId, itemId) {
  const it = db
    .prepare('SELECT i.name, i.sum, l.category_slug FROM items i LEFT JOIN item_labels l ON l.item_id = i.id WHERE i.id = ?')
    .get(itemId);
  if (!it) return 0;
  const cat = categoryName(db, budgetId, it.category_slug);
  return notifyMembers(db, budgetId, actorId, '✍️', 'запись вручную', [
    `${clean(it.name)} — ${rub(it.sum)}${cat ? ` · ${html(cat)}` : ''}`,
    look(`${SITE}/m/?screen=item&item=${itemId}`),
  ]);
}

/** Скан чека: «🧾 Ольга · новый чек / Пятёрочка — 1 234 ₽ / Молоко, хлеб и ещё 9 позиций / ссылка». */
export function notifyReceipt(db, receiptId, actorId) {
  const r = db.prepare('SELECT budget_id, COALESCE(retail_place, seller) AS place, total_sum FROM receipts WHERE id = ?').get(receiptId);
  if (!r) return 0;
  const items = db.prepare('SELECT name FROM items WHERE receipt_id = ? ORDER BY pos').all(receiptId);
  // Разные товары — повторы одного (два пива) не тратят место в строке
  const names = [...new Set(items.map((i) => shortName(i.name)))];
  const first = names.slice(0, 3);
  const more = names.length - first.length;
  const goods = first.length
    ? `${first.join(', ')}${more > 0 ? ` и ещё ${more} ${plural(more, 'позиция', 'позиции', 'позиций')}` : ''}`
    : '';
  const place = clean(r.place);
  return notifyMembers(db, r.budget_id, actorId, '🧾', 'новый чек', [
    `${place || 'Чек'} — ${rub(r.total_sum)}`,
    goods,
    look(`${SITE}/m/?receipt=${receiptId}`, 'Посмотреть чек'),
  ]);
}

/**
 * Загрузка из банка: новые операции одной сводкой. Переводы себе и исключённые не в счёт.
 * Одна — «💳 Дима · трата из Т-Банка / Пятёрочка — 500 ₽ · Еда / ссылка на неё»;
 * несколько — «💳 Дима · новые операции из Т-Банка / 3 траты на 1 100 ₽: Пятёрочка, …».
 */
export function notifyBankOps(db, linkId, extIds) {
  if (!extIds.length) return 0;
  const link = db.prepare('SELECT l.user_id, l.bank, u.budget_id FROM bank_links l JOIN users u ON u.id = l.user_id WHERE l.id = ?').get(linkId);
  if (!link) return 0;
  const marks = extIds.map(() => '?').join(', ');
  const ops = db
    .prepare(
      `SELECT id, at, direction, amount, merchant, description, op_group, category_slug, kind FROM bank_ops
        WHERE link_id = ? AND ext_id IN (${marks}) AND COALESCE(kind, '') NOT IN ('transfer', 'excluded')
        ORDER BY at`,
    )
    .all(linkId, ...extIds);
  const spent = ops.filter((o) => o.direction === 'debit');
  const got = ops.filter((o) => o.direction === 'credit');
  if (!ops.length) return 0;
  const from = BANK_FROM[link.bank] ?? 'из банка';
  const who = (o) => clean(opWho(o)) || 'Операция';

  if (ops.length === 1) {
    const [o] = ops;
    const income = o.direction === 'credit';
    const cat = categoryName(db, link.budget_id, o.category_slug);
    return notifyMembers(db, link.budget_id, link.user_id, income ? '💰' : '💳',
      income ? `поступление ${BANK_TO[link.bank] ?? 'в банк'}` : `трата ${from}`, [
        `${who(o)} — ${rub(o.amount)}${cat ? ` · ${html(cat)}` : ''}`,
        look(`${SITE}/m/?screen=op&op=${o.id}`),
      ]);
  }

  const sum = (list) => list.reduce((n, o) => n + o.amount, 0);
  const names = (list) => [...new Set(list.map(who))].slice(0, 3).join(', ');
  const first = ops[0].at.slice(0, 10);
  const last = ops[ops.length - 1].at.slice(0, 10);
  return notifyMembers(db, link.budget_id, link.user_id, '💳', `новые операции ${from}`, [
    spent.length ? `${spent.length} ${plural(spent.length, 'трата', 'траты', 'трат')} на ${rub(sum(spent))}: ${names(spent)}` : '',
    got.length ? `${got.length} ${plural(got.length, 'поступление', 'поступления', 'поступлений')} на ${rub(sum(got))}` : '',
    look(`${SITE}/m/?screen=summary&from=${first}&to=${last}`),
  ]);
}
