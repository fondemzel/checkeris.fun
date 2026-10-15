// Лимиты трат по группам — основа «Аналитики». Лимит задаётся на календарный месяц, общий
// для всех участников бюджета; остаток на следующий месяц не переносится.
//
// Предложение лимита — обычная трата группы: среднее за три последних полных месяца,
// округлённое вверх до 500 ₽. Человек принимает его одной кнопкой и правит точечно.
import { summary } from './queries.mjs';

const ROUND = 50000; // 500 ₽ в копейках
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(y, m, 0).getDate(); // m — 1…12

/** Месяц «ГГГГ-ММ» → его первый и последний день. Неверный — текущий месяц. */
function monthRange(month) {
  const now = new Date();
  const ok = /^(\d{4})-(\d{2})$/.exec(String(month ?? ''));
  const y = ok ? Number(ok[1]) : now.getFullYear();
  const m = ok ? Number(ok[2]) : now.getMonth() + 1;
  return { month: `${y}-${pad(m)}`, y, m, from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` };
}

/** Траты по группам за период: и позиции чеков, и траты из банка без чека. Без категории — «-». */
function spentByGroup(db, budgetId, from, to) {
  const rows = summary(db, budgetId, new URLSearchParams({ by: 'group', from, to })).rows;
  const out = {};
  for (const r of rows) out[r.key ?? '-'] = (out[r.key ?? '-'] ?? 0) + r.sum;
  return out;
}

/** Лимиты бюджета: { группа: копейки в месяц }. */
export function getLimits(db, budgetId) {
  const out = {};
  for (const r of db.prepare('SELECT group_slug, amount FROM budget_limits WHERE budget_id = ?').all(budgetId)) out[r.group_slug] = r.amount;
  return out;
}

/** Предложение лимитов по истории: среднее трёх полных месяцев перед month, вверх до 500 ₽. */
export function suggestLimits(db, budgetId, month) {
  const { y, m } = monthRange(month);
  const start = new Date(y, m - 4, 1);
  const end = new Date(y, m - 1, 0);
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const spent = spentByGroup(db, budgetId, iso(start), iso(end));
  const out = {};
  for (const [group, sum] of Object.entries(spent)) {
    if (group === '-' || sum <= 0) continue;
    out[group] = Math.ceil(sum / 3 / ROUND) * ROUND;
  }
  return out;
}

/**
 * Сколько обычно тратится в группе после такого-то числа месяца: среднее за три прошлых
 * месяца по дням day+1…конец. Прогноз к концу месяца = потрачено + это. Так разовые
 * платежи (аренда в начале месяца) не «умножаются» на остаток месяца, как при продлении темпа,
 * а ежедневные траты (еда) растут как обычно.
 */
function usualRest(db, budgetId, y, m, day) {
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const out = {};
  for (let k = 1; k <= 3; k += 1) {
    const first = new Date(y, m - 1 - k, 1);
    const last = new Date(y, m - k, 0);
    if (day >= last.getDate()) continue; // месяц короче — после этого числа ничего
    const spent = spentByGroup(db, budgetId, iso(new Date(first.getFullYear(), first.getMonth(), day + 1)), iso(last));
    for (const [g, sum] of Object.entries(spent)) out[g] = (out[g] ?? 0) + sum / 3;
  }
  for (const g of Object.keys(out)) out[g] = Math.round(out[g]);
  return out;
}

/** Всё для экрана «Аналитика» за месяц: траты по группам, лимиты, предложения; для текущего — прогноз. */
export function getAnalytics(db, budgetId, month) {
  const range = monthRange(month);
  const now = new Date();
  const current = range.y === now.getFullYear() && range.m === now.getMonth() + 1;
  return {
    month: range.month,
    from: range.from,
    to: range.to,
    spent: spentByGroup(db, budgetId, range.from, range.to),
    limits: getLimits(db, budgetId),
    suggest: suggestLimits(db, budgetId, range.month),
    rest: current ? usualRest(db, budgetId, range.y, range.m, now.getDate()) : {}, // обычно ещё до конца месяца
  };
}

/** Задать лимиты: { группа: копейки }; 0 или пусто — лимит снят. Группы только этого бюджета. */
export function setLimits(db, budgetId, limits) {
  const known = new Set(db.prepare('SELECT slug FROM groups WHERE budget_id = ?').all(budgetId).map((g) => g.slug));
  const put = db.prepare(
    `INSERT INTO budget_limits (budget_id, group_slug, amount, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (budget_id, group_slug) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`,
  );
  const drop = db.prepare('DELETE FROM budget_limits WHERE budget_id = ? AND group_slug = ?');
  const now = new Date().toISOString();
  for (const [group, value] of Object.entries(limits ?? {})) {
    if (!known.has(group)) continue;
    const amount = Math.round(Number(value) || 0);
    if (amount > 0) put.run(budgetId, group, amount, now);
    else drop.run(budgetId, group);
  }
  return { limits: getLimits(db, budgetId) };
}
