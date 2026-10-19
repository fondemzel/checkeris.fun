// Лимиты трат по группам. Общие для всех участников бюджета; остаток на следующий период
// не переносится.
//
// Лимит задаётся на период бюджета (budgets.limit_period): месяц (по умолчанию), квартал,
// неделя или день. На экране выбирают любой отрезок — лимит на него считается по дням: у
// месячного лимита день стоит лимит ÷ число дней в этом месяце, у квартального — ÷ дней
// в квартале, у недельного — ÷ 7, у дневного — сам лимит. Лимиты можно выключить целиком
// (budgets.limits_on): заданные суммы сохраняются, но нигде не показываются.
// Так целый месяц — ровно месячный лимит, а «Две недели» или год — пропорциональная доля.
//
// Предложение лимита — обычная трата группы: среднее за три последних полных месяца,
// пересчитанное на период лимитов и округлённое вверх (1000 ₽ у квартала, 500 ₽ у месяца,
// 100 ₽ у недели, 10 ₽ у дня).
//
// Перераспределение: если у бюджета задана общая сумма лимитов (budgets.limit_total — её задаст
// мастер настройки лимитов), подъём лимита одной группы снимает разницу с остальных групп
// с лимитом пропорционально их лимитам, снижение — раздаёт её так же. Зафиксированные группы
// (budget_limits.fixed) перераспределение не трогает. Снимать не с чего — подъём запрещён.
// Общая сумма не задана — лимиты меняются по одному.
import { summary } from './queries.mjs';

const PERIODS = ['month', 'quarter', 'week', 'day'];
const STEP = { quarter: 100000, month: 50000, week: 10000, day: 1000 }; // шаг округления, копейки
const PER_MONTH = { quarter: 1 / 3, month: 1, week: 52 / 12, day: 365 / 12 }; // сколько таких периодов в среднем месяце
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const day = (s) => new Date(`${s}T00:00:00`);
const lastDay = (y, m) => new Date(y, m, 0).getDate(); // m — 1…12
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));
const fail = (status, error) => ({ status, error });

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

/** Период лимитов бюджета: month | week | day. */
export function limitPeriod(db, budgetId) {
  const p = db.prepare('SELECT limit_period FROM budgets WHERE id = ?').get(budgetId)?.limit_period;
  return PERIODS.includes(p) ? p : 'month';
}

/** Дней в квартале, куда попадает день d. */
const quarterDays = (d) => {
  const q = Math.floor(d.getMonth() / 3) * 3;
  return Math.round((new Date(d.getFullYear(), q + 3, 1) - new Date(d.getFullYear(), q, 1)) / 86400000);
};

/** Включены ли лимиты у бюджета. */
export function limitsOn(db, budgetId) {
  return (db.prepare('SELECT limits_on FROM budgets WHERE id = ?').get(budgetId)?.limits_on ?? 1) === 1;
}

/** Включить или выключить лимиты целиком: суммы остаются. */
export function setLimitsOn(db, budgetId, on) {
  db.prepare('UPDATE budgets SET limits_on = ? WHERE id = ?').run(on ? 1 : 0, budgetId);
  return getLimitsFull(db, budgetId);
}

/** Лимит периода amount → на отрезок from…to: по дням, у месячного — доля своего месяца. */
export function limitForRange(amount, period, from, to) {
  if (!amount || !isDay(from) || !isDay(to) || from > to) return 0;
  let sum = 0;
  for (let d = day(from), end = day(to); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    sum += period === 'day' ? amount
      : period === 'week' ? amount / 7
        : period === 'quarter' ? amount / quarterDays(d)
          : amount / lastDay(d.getFullYear(), d.getMonth() + 1);
  }
  return Math.round(sum);
}

/** Лимиты бюджета: { группа: копейки на период лимитов }. */
export function getLimits(db, budgetId) {
  const out = {};
  for (const r of db.prepare('SELECT group_slug, amount FROM budget_limits WHERE budget_id = ?').all(budgetId)) out[r.group_slug] = r.amount;
  return out;
}

const fixedOf = (db, budgetId) => {
  const out = {};
  for (const r of db.prepare('SELECT group_slug FROM budget_limits WHERE budget_id = ? AND fixed = 1').all(budgetId)) out[r.group_slug] = true;
  return out;
};

/**
 * Предложение лимитов по истории: среднее трёх полных месяцев перед month — на период
 * лимитов (period), вверх до шага периода. Без period — месячное, как раньше.
 */
export function suggestLimits(db, budgetId, month, period = 'month') {
  const { y, m } = monthRange(month);
  const spent = spentByGroup(db, budgetId, iso(new Date(y, m - 4, 1)), iso(new Date(y, m - 1, 0)));
  const step = STEP[period] ?? STEP.month;
  const out = {};
  for (const [group, sum] of Object.entries(spent)) {
    if (group === '-' || sum <= 0) continue;
    out[group] = Math.ceil(sum / 3 / (PER_MONTH[period] ?? 1) / step) * step;
  }
  return out;
}

/** Всё для правки лимитов: период, лимиты, зафиксированные, общая сумма, предложения на период. */
export function getLimitsFull(db, budgetId) {
  const period = limitPeriod(db, budgetId);
  return {
    on: limitsOn(db, budgetId),
    period,
    limits: getLimits(db, budgetId),
    fixed: fixedOf(db, budgetId),
    total: db.prepare('SELECT limit_total FROM budgets WHERE id = ?').get(budgetId)?.limit_total ?? null,
    suggest: suggestLimits(db, budgetId, '', period),
  };
}

/**
 * Три прошлых «таких же» отрезка: целые месяцы — те же месяцы раньше, иначе — сдвиг на длину
 * отрезка. По ним считается «обычно» и сколько обычно уходит до конца отрезка (прогноз).
 */
function previousRanges(from, to) {
  const a = day(from);
  const b = day(to);
  const next = new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1);
  const months = a.getDate() === 1 && next.getDate() === 1
    ? (next.getFullYear() - a.getFullYear()) * 12 + next.getMonth() - a.getMonth()
    : 0;
  const days = Math.round((b - a) / 86400000) + 1;
  return [1, 2, 3].map((k) => (months
    ? { from: new Date(a.getFullYear(), a.getMonth() - k * months, 1), to: new Date(a.getFullYear(), a.getMonth() - (k - 1) * months, 0) }
    : { from: new Date(a.getFullYear(), a.getMonth(), a.getDate() - k * days), to: new Date(b.getFullYear(), b.getMonth(), b.getDate() - k * days) }));
}

/**
 * Состояние лимитов на отрезок — для карточки лимита под кольцом: лимит на отрезок, потрачено,
 * обычно (среднее трёх прошлых таких же отрезков) и сколько обычно уходит после сегодняшнего
 * дня до конца отрезка (прогноз = потрачено + это). Разовые платежи вроде аренды так не
 * «умножаются» на остаток, как при продлении темпа.
 */
export function getLimitState(db, budgetId, from, to) {
  if (!isDay(from) || !isDay(to) || from > to) return fail(400, 'нужен период');
  const period = limitPeriod(db, budgetId);
  const limits = getLimits(db, budgetId);
  const range = {};
  for (const [g, amount] of Object.entries(limits)) range[g] = limitForRange(amount, period, from, to);
  const today = iso(new Date());
  const prev = previousRanges(from, to);
  const usual = {};
  const rest = {};
  const add = (map, spent) => {
    for (const [g, sum] of Object.entries(spent)) map[g] = (map[g] ?? 0) + sum / 3;
  };
  for (const r of prev) add(usual, spentByGroup(db, budgetId, iso(r.from), iso(r.to)));
  // Отрезок идёт сейчас: сколько в прошлые разы уходило после того же по счёту дня
  const current = today >= from && today <= to;
  if (current) {
    const done = Math.round((day(today) - day(from)) / 86400000) + 1; // дней прошло, считая сегодня
    for (const r of prev) {
      const after = new Date(r.from.getFullYear(), r.from.getMonth(), r.from.getDate() + done);
      if (after <= r.to) add(rest, spentByGroup(db, budgetId, iso(after), iso(r.to)));
    }
  }
  const round = (map) => Object.fromEntries(Object.entries(map).map(([g, v]) => [g, Math.round(v)]));
  return {
    on: limitsOn(db, budgetId), period, from, to, today, current,
    limits, range,
    fixed: fixedOf(db, budgetId),
    spent: spentByGroup(db, budgetId, from, to),
    usual: round(usual),
    rest: round(rest),
    suggest: suggestLimits(db, budgetId, '', period),
  };
}

/** Всё для экрана «Аналитика» за месяц: траты, лимиты на этот месяц, предложения; для текущего — прогноз. */
export function getAnalytics(db, budgetId, month) {
  const range = monthRange(month);
  const now = new Date();
  const current = range.y === now.getFullYear() && range.m === now.getMonth() + 1;
  const state = getLimitState(db, budgetId, range.from, range.to);
  return {
    month: range.month,
    off: !limitsOn(db, budgetId),
    from: range.from,
    to: range.to,
    spent: state.spent,
    limits: state.range, // на этот месяц — из лимитов любого периода
    suggest: suggestLimits(db, budgetId, range.month),
    rest: current ? state.rest : {},
  };
}

/** Округлить лимиты до шага, остаток — самой крупной группе (чтобы сумма сошлась). */
function roundShares(shares, step, total) {
  const out = {};
  let sum = 0;
  for (const [g, v] of Object.entries(shares)) {
    out[g] = Math.max(0, Math.round(v / step) * step);
    sum += out[g];
  }
  const biggest = Object.keys(out).sort((a, b) => out[b] - out[a])[0];
  if (biggest) out[biggest] = Math.max(0, out[biggest] + (total - sum));
  return out;
}

/**
 * Задать лимиты: { группа: копейки на период лимитов } (0 — снять) и фиксацию { группа: bool }.
 * С общей суммой — перераспределение (см. начало файла). Группы — только этого бюджета.
 */
export function setLimits(db, budgetId, limits = {}, fixed = {}) {
  const known = new Set(db.prepare('SELECT slug FROM groups WHERE budget_id = ?').all(budgetId).map((g) => g.slug));
  const period = limitPeriod(db, budgetId);
  const total = db.prepare('SELECT limit_total FROM budgets WHERE id = ?').get(budgetId)?.limit_total ?? null;
  const current = getLimits(db, budgetId);
  const fix = { ...fixedOf(db, budgetId) };
  for (const [g, v] of Object.entries(fixed ?? {})) if (known.has(g)) fix[g] = Boolean(v);

  const next = { ...current };
  for (const [g, value] of Object.entries(limits ?? {})) {
    if (!known.has(g)) continue;
    const amount = Math.max(0, Math.round(Number(value) || 0));
    // Перераспределение: только с общей суммой, только при правке одной группы с лимитом
    if (total != null && Object.keys(limits).length === 1 && current[g] && amount) {
      const delta = amount - current[g];
      const others = Object.keys(current).filter((o) => o !== g && !fix[o] && current[o] > 0);
      const pool = others.reduce((n, o) => n + current[o], 0);
      if (delta > 0 && pool < delta) {
        return fail(409, 'Поднять лимит не за счёт чего: остальные лимиты зафиксированы или уже на нуле');
      }
      if (delta && pool > 0) {
        const shares = Object.fromEntries(others.map((o) => [o, current[o] - (delta * current[o]) / pool]));
        Object.assign(next, roundShares(shares, STEP[period], pool - delta));
      }
    }
    next[g] = amount;
  }

  const put = db.prepare(
    `INSERT INTO budget_limits (budget_id, group_slug, amount, fixed, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (budget_id, group_slug) DO UPDATE SET amount = excluded.amount, fixed = excluded.fixed, updated_at = excluded.updated_at`,
  );
  const drop = db.prepare('DELETE FROM budget_limits WHERE budget_id = ? AND group_slug = ?');
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const [g, amount] of Object.entries(next)) {
      if (amount > 0) put.run(budgetId, g, amount, fix[g] ? 1 : 0, now);
      else drop.run(budgetId, g);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getLimitsFull(db, budgetId);
}

/** Сменить период лимитов: заданные лимиты (и общая сумма) пересчитываются пропорционально. */
export function setLimitPeriod(db, budgetId, period) {
  if (!PERIODS.includes(period)) return fail(400, 'неизвестный период');
  const old = limitPeriod(db, budgetId);
  if (old === period) return getLimitsFull(db, budgetId);
  const ratio = PER_MONTH[old] / PER_MONTH[period];
  const step = STEP[period];
  const scale = (v) => Math.max(step, Math.round((v * ratio) / step) * step);
  db.exec('BEGIN');
  try {
    const put = db.prepare('UPDATE budget_limits SET amount = ? WHERE budget_id = ? AND group_slug = ?');
    for (const [g, amount] of Object.entries(getLimits(db, budgetId))) put.run(scale(amount), budgetId, g);
    db.prepare('UPDATE budgets SET limit_period = ?, limit_total = CASE WHEN limit_total IS NULL THEN NULL ELSE ? END WHERE id = ?')
      .run(period, scale(db.prepare('SELECT limit_total FROM budgets WHERE id = ?').get(budgetId)?.limit_total ?? 0), budgetId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getLimitsFull(db, budgetId);
}
