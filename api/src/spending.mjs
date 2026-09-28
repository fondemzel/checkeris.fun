// Все траты одной лентой: позиции чеков и ручные записи — по названиям, траты из банка —
// по операциям. Это то, что телефон собирает у себя на экране «Расход», только на сервере:
// кабинет тянет таблицу порциями, а порцию из двух источников можно нарезать лишь после
// общей сортировки.
//
// Покупки, у которых нашёлся чек (kind = covered), приходят один раз — чеком. Переводы
// между своими счетами и отмеченное «не учитывать» — не траты, их здесь нет.
import { listItemGroups, parsePaging, NONE } from './queries.mjs';

const SOURCES = ['receipt', 'manual', 'bank'];

const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е');
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');

/** Траты из банка без чека с теми же фильтрами, что у позиций. */
function bankRows(db, budgetId, params) {
  const from = params.get('from');
  const to = params.get('to');
  const rows = db
    .prepare(
      `SELECT o.id, o.at, o.amount, o.merchant, o.description, o.bank_category, o.account_name,
              o.category_slug, o.category_source, o.note IS NOT NULL AS has_note,
              c.name AS category_name, c.group_slug, g.name AS group_name
         FROM bank_ops o
         LEFT JOIN categories c ON c.budget_id = o.budget_id AND c.slug = o.category_slug
         LEFT JOIN groups g ON g.budget_id = o.budget_id AND g.slug = c.group_slug
        WHERE o.budget_id = :budgetId AND o.direction = 'debit' AND o.kind = 'expense'
          AND o.at >= :from AND o.at <= :to`,
    )
    .all({
      budgetId,
      from: isDate(from) ? `${from}T00:00:00` : '0000',
      to: isDate(to) ? `${to}T23:59:59` : '9999',
    });

  // Фильтры — здесь, а не в SQL: lower() в SQLite не знает кириллицы
  const q = norm(params.get('q')).trim();
  const min = Number.parseFloat(params.get('min_sum') ?? '');
  const max = Number.parseFloat(params.get('max_sum') ?? '');
  const group = (params.get('group') ?? '').trim();
  const category = (params.get('category') ?? '').trim();
  const uncategorized = params.get('uncategorized') === '1';

  return rows
    .filter((o) => !q || norm(o.merchant).includes(q) || norm(o.description).includes(q))
    .filter((o) => !Number.isFinite(min) || o.amount >= Math.round(min * 100))
    .filter((o) => !Number.isFinite(max) || o.amount <= Math.round(max * 100))
    .filter((o) => (group === NONE ? !o.group_slug : !group || o.group_slug === group))
    .filter((o) => (category === NONE ? !o.category_slug : !category || o.category_slug === category))
    .filter((o) => !uncategorized || !o.category_slug)
    .map((o) => ({
      source: 'bank',
      op_id: o.id,
      name: o.merchant || o.description || 'Операция банка',
      purchased_at: o.at,
      sum: o.amount,
      positions: 1,
      quantity: 1,
      counted: 1,
      category_slug: o.category_slug,
      category_name: o.category_name,
      category_source: o.category_source,
      group_slug: o.group_slug,
      group_name: o.group_name,
      bank_category: o.bank_category,
      account_name: o.account_name,
      has_note: o.has_note,
    }));
}

const SORT_KEYS = {
  date: (r) => r.purchased_at ?? '',
  name: (r) => norm(r.name),
  sum: (r) => r.sum ?? 0,
  quantity: (r) => r.quantity ?? 0,
};

/**
 * Лента трат: src — источник (receipt | manual | bank, пусто — все), остальные фильтры
 * как у /api/items. Порция нарезается после общей сортировки.
 */
export function listSpending(db, budgetId, params) {
  const src = SOURCES.includes(params.get('src')) ? params.get('src') : '';
  const { page, per, offset } = parsePaging(params);
  const sort = Object.hasOwn(SORT_KEYS, params.get('sort')) ? params.get('sort') : 'date';
  const asc = params.get('dir') === 'asc';

  let items = [];
  let excluded = { sum: 0, count: 0 };
  if (src !== 'bank') {
    const p = new URLSearchParams(params);
    for (const key of ['src', 'page', 'per', 'sort', 'dir']) p.delete(key);
    p.set('collapse', '1');
    p.set('per', '20000');
    const groups = listItemGroups(db, budgetId, p);
    items = groups.rows
      .map((r) => ({ ...r, source: r.manual ? 'manual' : 'receipt' }))
      .filter((r) => !src || r.source === src);
    if (!src) excluded = { sum: groups.totals.excluded_sum, count: groups.totals.excluded_count };
  }
  const ops = !src || src === 'bank' ? bankRows(db, budgetId, params) : [];

  const key = SORT_KEYS[sort];
  const all = [...items, ...ops].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const order = x < y ? -1 : x > y ? 1 : norm(a.name) < norm(b.name) ? -1 : 1;
    return asc ? order : -order;
  });

  const bySource = Object.fromEntries(SOURCES.map((s) => [s, { count: 0, sum: 0 }]));
  let positions = 0;
  let sum = 0;
  for (const r of all) {
    bySource[r.source].count += r.positions ?? 1;
    bySource[r.source].sum += r.sum ?? 0;
    positions += r.positions ?? 1;
    sum += r.sum ?? 0;
  }

  return {
    rows: all.slice(offset, offset + per),
    totals: {
      count: all.length,
      positions,
      sum,
      excluded_sum: excluded.sum,
      excluded_count: excluded.count,
      sources: bySource,
    },
    page,
    per,
    sort,
    dir: asc ? 'asc' : 'desc',
  };
}

/**
 * Для выгрузки: каждая покупка строкой, без схлопывания по названию. Позиции чеков и ручные
 * записи — из /api/items, траты банка — как в ленте. Порядок — по дате, новые сверху.
 */
export function spendingPurchases(db, budgetId, params, listItems) {
  const src = SOURCES.includes(params.get('src')) ? params.get('src') : '';
  const rows = [];
  if (src !== 'bank') {
    const p = new URLSearchParams(params);
    for (const key of ['src', 'collapse', 'sort', 'dir']) p.delete(key);
    p.set('per', '500');
    for (let page = 1; ; page += 1) {
      p.set('page', String(page));
      const chunk = listItems(db, budgetId, p).rows;
      for (const r of chunk) {
        const source = r.manual ? 'manual' : 'receipt';
        if (!src || source === src) rows.push({ ...r, source });
      }
      if (chunk.length < 500 || rows.length >= 50000) break;
    }
  }
  if (!src || src === 'bank') rows.push(...bankRows(db, budgetId, params));
  return rows.sort((a, b) => (a.purchased_at < b.purchased_at ? 1 : -1));
}

/**
 * Поступления: деньги пришли от других — зарплата, возвраты, переводы от людей. Переводы
 * между своими счетами сюда не входят, но их итог показываем рядом: иначе непонятно, куда
 * делась половина зачислений из выписки.
 */
export function listIncome(db, budgetId, params) {
  const from = params.get('from');
  const to = params.get('to');
  const span = {
    budgetId,
    from: isDate(from) ? `${from}T00:00:00` : '0000',
    to: isDate(to) ? `${to}T23:59:59` : '9999',
  };
  const all = db
    .prepare(
      `SELECT id, at, amount, merchant, description, account_name, card, bank_category, kind,
              note IS NOT NULL AS has_note,
              json_extract(raw, '$.senderDetails') AS sender
         FROM bank_ops
        WHERE budget_id = :budgetId AND direction = 'credit' AND kind = 'income'
          AND at >= :from AND at <= :to`,
    )
    .all(span);

  const q = norm(params.get('q')).trim();
  const min = Number.parseFloat(params.get('min_sum') ?? '');
  const max = Number.parseFloat(params.get('max_sum') ?? '');
  const rows = all
    .map((o) => ({
      source: 'bank',
      op_id: o.id,
      name: o.sender || o.merchant || o.description || 'Поступление',
      description: o.description,
      purchased_at: o.at,
      sum: o.amount,
      account_name: o.account_name,
      card: o.card,
      bank_category: o.bank_category,
      has_note: o.has_note,
    }))
    .filter((r) => !q || norm(r.name).includes(q) || norm(r.description).includes(q))
    .filter((r) => !Number.isFinite(min) || r.sum >= Math.round(min * 100))
    .filter((r) => !Number.isFinite(max) || r.sum <= Math.round(max * 100));

  const sort = Object.hasOwn(SORT_KEYS, params.get('sort')) ? params.get('sort') : 'date';
  const asc = params.get('dir') === 'asc';
  const key = SORT_KEYS[sort];
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const order = x < y ? -1 : x > y ? 1 : 0;
    return asc ? order : -order;
  });

  const transfers = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS sum FROM bank_ops
        WHERE budget_id = :budgetId AND direction = 'credit' AND kind = 'transfer'
          AND at >= :from AND at <= :to`,
    )
    .get(span);

  const { page, per, offset } = parsePaging(params);
  return {
    rows: rows.slice(offset, offset + per),
    totals: { count: rows.length, sum: rows.reduce((s, r) => s + r.sum, 0), transfers },
    page,
    per,
  };
}
