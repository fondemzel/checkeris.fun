// Тарифы: Бесплатно, Плюс, Премиум. Тариф — у бюджета, а не у человека: платит один,
// пользуется вся семья. Срок — «до такого-то дня» (plan_until) или навсегда (пусто);
// пометка (plan_label) — откуда тариф: beta — подарок на время беты, founder — «Основатель»
// (Премиум навсегда), позже — оплата. Срок прошёл — бюджет на «Бесплатно», данные не трогаем.
//
// Оплаты пока нет: тариф меняет администратор (админка, страница бюджета). Пока идёт бета,
// новые бюджеты получают бета-Премиум; NEW_BUDGET_PLAN=free — новые на «Бесплатно».
//
// Ограничения — в сутки, кроме людей и подключений. «Без ограничений» у Плюса и Премиума —
// с предохранителем от злоупотреблений: общий лимит ФНС — 1000 обращений в сутки на всё
// приложение, разметка моделью стоит денег.
import { loadEnv } from './llm.mjs';

export const PLANS = {
  free: { id: 'free', title: 'Бесплатно', scans: 3, names: 30, members: 1, links: 1 },
  plus: { id: 'plus', title: 'Плюс', scans: 30, names: 1000, members: 5, links: Infinity },
  premium: { id: 'premium', title: 'Премиум', scans: 100, names: 1000, members: Infinity, links: Infinity },
};
export const LABELS = { beta: 'бета', founder: 'Основатель', paid: 'оплачен', gift: 'подарок' };

const today = () => new Date().toISOString().slice(0, 10);

/** Действующий тариф бюджета: срок вышел — «Бесплатно». */
export function planOf(db, budgetId) {
  const row = budgetId ? db.prepare('SELECT plan, plan_until, plan_label FROM budgets WHERE id = ?').get(budgetId) : null;
  const id = PLANS[row?.plan] ? row.plan : 'free';
  const sub = row?.plan_label === 'paid' ? db.prepare("SELECT plan,period_end FROM service_subscriptions WHERE budget_id=? AND mode='live'").get(budgetId) : null;
  const expired = id !== 'free' && (sub?.plan === id
    ? sub.period_end <= new Date().toISOString()
    : Boolean(row?.plan_until) && row.plan_until < today());
  return {
    ...PLANS[expired ? 'free' : id],
    until: row?.plan_until ?? null,
    label: row?.plan_label ?? null,
    expired, // был платный, срок вышел — показать «закончился такого-то»
    was: expired ? id : null,
  };
}

/** Тариф человека — тариф бюджета, в котором он сейчас. */
export function planOfUser(db, userId) {
  const budget = db.prepare('SELECT COALESCE(demo_return, budget_id) AS b FROM users WHERE id = ?').get(userId)?.b;
  return planOf(db, budget);
}

/** Сменить тариф (админка). until — 'YYYY-MM-DD' или пусто: навсегда. */
export function setPlan(db, budgetId, { plan, until = null, label = null }) {
  if (!PLANS[plan]) return { error: 'нет такого тарифа', status: 400 };
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) return { error: 'срок — дата ГГГГ-ММ-ДД', status: 400 };
  if (label && !LABELS[label]) return { error: 'нет такой пометки', status: 400 };
  const changed = db
    .prepare('UPDATE budgets SET plan = ?, plan_until = ?, plan_label = ? WHERE id = ? AND demo = 0')
    .run(plan, plan === 'free' ? null : until || null, plan === 'free' ? null : label || null, Number(budgetId)).changes;
  // Ручное назначение администратором не должно оставлять скрытое продление с баланса.
  if (changed) db.prepare("DELETE FROM service_subscriptions WHERE budget_id=? AND mode='live'").run(Number(budgetId));
  return changed ? { ok: true, plan: planOf(db, budgetId) } : { error: 'нет такого бюджета', status: 404 };
}

/** Тариф нового бюджета: в бету — Премиум с пометкой «бета», потом — «Бесплатно». */
export function newBudgetPlan() {
  loadEnv();
  return process.env.NEW_BUDGET_PLAN === 'free' ? { plan: 'free', label: null } : { plan: 'premium', label: 'beta' };
}

/** Сколько людей в бюджете сейчас (свой бюджет тех, кто в демо, — тоже их). */
export const budgetMembers = (db, budgetId) =>
  db.prepare('SELECT COUNT(*) AS n FROM users WHERE COALESCE(demo_return, budget_id) = ?').get(budgetId).n;

/**
 * Можно ли завести новое подключение (банк или магазин) этому человеку: считаем подключения
 * всех участников его бюджета. Уже заведённое — можно всегда: его просто обновляют.
 */
export function linkAllowed(db, userId, bank) {
  if (db.prepare('SELECT 1 FROM bank_links WHERE user_id = ? AND bank = ?').get(userId, bank)) return true;
  const budget = db.prepare('SELECT COALESCE(demo_return, budget_id) AS b FROM users WHERE id = ?').get(userId)?.b;
  const plan = planOf(db, budget);
  if (plan.links === Infinity) return true;
  const used = db.prepare(
    `SELECT COUNT(*) AS n FROM bank_links l JOIN users u ON u.id = l.user_id
      WHERE COALESCE(u.demo_return, u.budget_id) = ? AND l.status <> 'demo'`,
  ).get(budget).n;
  return used < plan.links;
}
