// Тариф и кошелёк принадлежат бюджету. Только подписанная нотификация/проверка банка
// зачисляет деньги. Все денежные изменения атомарны и имеют уникальный ключ операции.
import { randomUUID } from 'node:crypto';
import { PLANS, planOf, budgetMembers } from './plans.mjs';
import { modelQuotaLeft, scanQuota } from './quota.mjs';
import { acquiringConfig, acquiringReady, acquiringCall, billingMode } from './tbankpay.mjs';

export const SERVICE_PRICES = { free: 0, plus: 14900, premium: 29900 };
const PERIOD = 30 * 86_400_000;
const fail = (status, error) => ({ status, error });
const currentBudget = (db, user) => db.prepare('SELECT * FROM budgets WHERE id = ?').get(user.budget_id);
export const serviceBalance = (db, id, mode = billingMode()) => db.prepare('SELECT COALESCE(SUM(amount),0) n FROM service_ledger WHERE budget_id = ? AND mode=?').get(id,mode).n;
const finite = (n) => Number.isFinite(n) ? n : null;

function atomic(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function charge(db, budget, plan, at, operation, mode = billingMode()) {
  const cost = SERVICE_PRICES[plan];
  if (!cost || serviceBalance(db, budget, mode) < cost) return false;
  db.prepare("INSERT INTO service_ledger(budget_id,amount,operation,kind,created_at,mode) VALUES (?,?,?,'subscription',?,?)")
    .run(budget, -cost, `${mode}:${operation}`, at.toISOString(),mode);
  const end = new Date(at.getTime() + PERIOD).toISOString();
  db.prepare(`INSERT INTO service_subscriptions(budget_id,plan,period_end,renew,mode) VALUES (?,?,?,1,?)
    ON CONFLICT(budget_id,mode) DO UPDATE SET plan=excluded.plan,period_end=excluded.period_end,next_plan=NULL,renew=1`).run(budget, plan, end,mode);
  if (mode === 'live') db.prepare("UPDATE budgets SET plan=?,plan_until=?,plan_label='paid' WHERE id=?").run(plan, end.slice(0,10), budget);
  return true;
}

/** Не берём плату за пропущенные периоды. Нехватка денег оставляет бюджет на Free. */
export function renewService(db, at = new Date()) {
  if (!acquiringReady()) return 0;
  const mode = billingMode();
  let count = 0;
  atomic(db, () => {
    for (const sub of db.prepare(`SELECT s.* FROM service_subscriptions s JOIN budgets b ON b.id=s.budget_id
      WHERE s.renew=1 AND s.period_end<=? AND b.demo=0 AND s.mode=?
      AND (s.mode='test' OR (b.plan_label='paid' AND b.plan=s.plan))`).all(at.toISOString(),mode)) {
      const next = sub.next_plan ?? sub.plan;
      if (next === 'free') {
        db.prepare('UPDATE service_subscriptions SET renew=0,next_plan=NULL WHERE budget_id=? AND mode=?').run(sub.budget_id,mode);
        continue;
      }
      if (charge(db, sub.budget_id, next, at, `renew:${sub.budget_id}:${sub.period_end}`,mode)) count++;
    }
  });
  return count;
}

export function serviceInfo(db, user, paymentId = null) {
  const budget = currentBudget(db, user);
  if (!budget) return fail(404, 'Бюджет не найден');
  const demo = Boolean(budget.demo);
  const mode = billingMode();
  let plan = planOf(db, budget.id);
  const subscription = db.prepare('SELECT plan,next_plan,period_end,renew FROM service_subscriptions WHERE budget_id=? AND mode=?').get(budget.id,mode);
  const scans = scanQuota(db, user);
  const day = new Date().toISOString().slice(0,10);
  const calls = db.prepare('SELECT calls FROM fns_budget_usage WHERE budget_id=? AND day=?').get(budget.id, day)?.calls ?? 0;
  const links = db.prepare(`SELECT COUNT(*) n FROM bank_links l JOIN users u ON u.id=l.user_id
    WHERE COALESCE(u.demo_return,u.budget_id)=? AND l.status<>'demo'`).get(budget.id).n;
  const owner = db.prepare('SELECT name,login FROM users WHERE id=?').get(budget.owner_id);
  if (mode === 'test' && subscription) {
    const expired = subscription.period_end <= new Date().toISOString();
    plan = { ...plan, id: expired ? 'free' : subscription.plan, label: 'paid', until: subscription.period_end.slice(0,10), expired };
  }
  return {
    budget: { id: budget.id, name: budget.name, owner: owner?.name ?? owner?.login ?? '', is_owner: budget.owner_id === user.id },
    demo, test_mode: mode === 'test', balance: demo ? 0 : serviceBalance(db, budget.id), currency: 'RUB', period_days: 30,
    payment_ready: !demo && acquiringReady(),
    payment: paymentId ? db.prepare('SELECT id,status FROM service_payments WHERE id=? AND budget_id=? AND mode=?').get(String(paymentId),budget.id,mode) ?? null : null,
    plan: { id: plan.id, label: plan.label, until: plan.until, expired: plan.expired },
    subscription: subscription ? { ...subscription, renew: Boolean(subscription.renew) } : null,
    catalog: Object.values(PLANS).map((p) => ({ id: p.id, price: SERVICE_PRICES[p.id], scans: p.scans,
      names: p.names, members: finite(p.members), links: finite(p.links) })),
    usage: {
      day, fns_calls: calls, fns_tracking_from: db.prepare("SELECT value FROM service_meta WHERE key='started_at'").get()?.value,
      scans: { used: scans.used, limit: finite(scans.limit), left: finite(Math.max(0, scans.left)) },
      names: { left: finite(modelQuotaLeft(db, user.id)), limit: user.role === 'admin' ? null : plan.names },
      members: { used: budgetMembers(db, budget.id), limit: finite(plan.members) },
      links: { used: links, limit: finite(plan.links) },
    },
  };
}

export function chooseServicePlan(db, user, id, at = new Date()) {
  const budget = currentBudget(db, user);
  if (!budget || budget.demo) return fail(409, 'В демо нельзя менять тариф');
  if (budget.owner_id !== user.id) return fail(403, 'Тариф меняет только владелец бюджета');
  if (!Object.hasOwn(SERVICE_PRICES, id)) return fail(400, 'Нет такого тарифа');
  if (!acquiringReady()) return fail(503, 'Оплата тарифов пока не открыта');
  const mode = billingMode();
  return atomic(db, () => {
    const plan = planOf(db, budget.id);
    const sub = db.prepare('SELECT * FROM service_subscriptions WHERE budget_id=? AND mode=?').get(budget.id,mode);
    // Смену действующего платного тарифа применяем при следующем списании, без двойной оплаты.
    if (sub && (mode === 'test' || budget.plan_label === 'paid') && sub.period_end > at.toISOString()) {
      db.prepare('UPDATE service_subscriptions SET next_plan=?,renew=? WHERE budget_id=? AND mode=?')
        .run(id === sub.plan ? null : id, id === 'free' ? 0 : 1, budget.id,mode);
      return { ok: true, scheduled: true, effective_at: sub.period_end };
    }
    if (mode === 'live' && plan.id === id && !plan.expired) return { ok: true };
    if (id === 'free') {
      if (mode === 'live') db.prepare("UPDATE budgets SET plan='free',plan_until=NULL,plan_label=NULL WHERE id=?").run(budget.id);
      db.prepare('DELETE FROM service_subscriptions WHERE budget_id=? AND mode=?').run(budget.id,mode);
      return { ok: true };
    }
    if (!charge(db, budget.id, id, at, `start:${randomUUID()}`)) return fail(402, 'Недостаточно средств. Пополните баланс бюджета');
    return { ok: true };
  });
}

/** Храним заказ ДО сети: потерянный ответ банка не может создать незаписанное зачисление. */
export async function startServiceTopup(db, user, amount) {
  if (!acquiringReady()) return fail(503, 'Пополнение пока недоступно');
  const budget = currentBudget(db, user);
  if (!budget || budget.demo) return fail(409, 'В демо нельзя пополнять баланс');
  if (!Number.isSafeInteger(amount) || amount < 10000 || amount > 1000000) return fail(400, 'Сумма пополнения — от 100 до 10 000 ₽');
  // Повторный щелчок не создаёт сразу несколько заказов; старый заказ остаётся проверяемым.
  const mode = billingMode();
  const recent = db.prepare(`SELECT payment_url FROM service_payments WHERE budget_id=? AND user_id=? AND amount=? AND mode=?
    AND status IN ('NEW','FORM_SHOWED') AND created_at>? ORDER BY created_at DESC LIMIT 1`)
    .get(budget.id, user.id, amount, mode, new Date(Date.now()-60_000).toISOString());
  if (recent?.payment_url) return { payment_url: recent.payment_url };
  const id = randomUUID();
  db.prepare('INSERT INTO service_payments(id,budget_id,user_id,amount,created_at,mode) VALUES (?,?,?,?,?,?)')
    .run(id, budget.id, user.id, amount, new Date().toISOString(),mode);
  const c = acquiringConfig();
  try {
    const result = await acquiringCall('Init', {
      OrderId: id, Amount: amount, PayType: 'O', Description: 'Пополнение баланса Чекера',
      NotificationURL: `${c.origin}/api/service/tbank/notify`,
      SuccessURL: `${c.origin}/m/?screen=set_balance&service_payment=${id}`,
      FailURL: `${c.origin}/m/?screen=set_balance&service_payment=${id}`,
    });
    const url = new URL(result.PaymentURL);
    if (url.protocol !== 'https:' || !result.PaymentId || !Number.isSafeInteger(Number(result.Amount)) || Number(result.Amount) !== amount) throw new Error('Некорректный ответ платёжного сервиса');
    // Уведомление может прийти раньше ответа Init; не перезаписываем подтверждённый статус.
    db.prepare('UPDATE service_payments SET provider_id=?,payment_url=? WHERE id=?')
      .run(String(result.PaymentId), url.href, id);
    return { payment_url: url.href };
  } catch {
    return fail(502, 'Не удалось открыть оплату. Попробуйте позже');
  }
}

/** Вызывать только после проверки подписи либо серверного GetState. */
export function applyServicePayment(db, data) {
  return atomic(db, () => {
    const order = db.prepare('SELECT * FROM service_payments WHERE id=?').get(String(data.OrderId));
    if (!order || order.mode !== billingMode() || !order.budget_id || !data.PaymentId || !Number.isSafeInteger(Number(data.Amount))
      || Number(data.Amount) !== order.amount || (order.provider_id && order.provider_id !== String(data.PaymentId))) return false;
    const at = new Date().toISOString();
    const refunds = ['REFUNDED','REVERSED','PARTIAL_REFUNDED'];
    if (refunds.includes(order.status) && !refunds.includes(data.Status)) return true;
    if (data.Status === 'CONFIRMED' && data.Success === true) {
      // Позднее CONFIRMED после возврата не восстанавливает уже возвращённые средства.
      if (!['REFUNDED','REVERSED','PARTIAL_REFUNDED'].includes(order.status)
          && !db.prepare('SELECT 1 FROM service_ledger WHERE operation=?').get(`refund:${order.id}`)) {
        db.prepare("INSERT OR IGNORE INTO service_ledger(budget_id,amount,operation,kind,created_at,mode) VALUES (?,?,?,'topup',?,?)")
          .run(order.budget_id, order.amount, `topup:${order.id}`, at,order.mode);
      }
    } else if (['REFUNDED','REVERSED'].includes(data.Status) && data.Success === true) {
      if (db.prepare('SELECT 1 FROM service_ledger WHERE operation=?').get(`topup:${order.id}`)) {
        db.prepare("INSERT OR IGNORE INTO service_ledger(budget_id,amount,operation,kind,created_at,mode) VALUES (?,?,?,'refund',?,?)")
          .run(order.budget_id, -order.amount, `refund:${order.id}`, at,order.mode);
      }
    }
    // Запоздавший AUTHORIZED/NEW не понижает статус уже обработанного зачисления.
    if (!db.prepare('SELECT 1 FROM service_ledger WHERE operation IN (?,?)').get(`topup:${order.id}`, `refund:${order.id}`)
        || ['CONFIRMED','REFUNDED','REVERSED','PARTIAL_REFUNDED'].includes(data.Status)) {
      db.prepare('UPDATE service_payments SET provider_id=?,status=?,checked_at=? WHERE id=?')
        .run(String(data.PaymentId), String(data.Status), at, order.id);
    }
    return true;
  });
}

export async function reconcileServicePayments(db) {
  const c = acquiringConfig();
  if (!c.terminal || !c.password) return;
  const rows = db.prepare(`SELECT * FROM service_payments WHERE status NOT IN ('CONFIRMED','REFUNDED','REVERSED','CANCELED','REJECTED','DEADLINE_EXPIRED')
    AND mode=? AND created_at>? AND (checked_at IS NULL OR checked_at<?) ORDER BY COALESCE(checked_at,created_at) LIMIT 10`)
    .all(billingMode(),new Date(Date.now()-7*86_400_000).toISOString(),new Date(Date.now()-60_000).toISOString());
  for (const row of rows) {
    db.prepare('UPDATE service_payments SET checked_at=? WHERE id=?').run(new Date().toISOString(),row.id);
    try {
      if (row.provider_id) applyServicePayment(db, await acquiringCall('GetState', { PaymentId: row.provider_id }));
      else {
        const order = await acquiringCall('CheckOrder', { OrderId: row.id });
        for (const payment of order.Payments ?? []) applyServicePayment(db, { ...payment, OrderId: row.id });
      }
    }
    catch { /* Следующий опрос повторит проверку; деньги по сетевой ошибке не зачисляем. */ }
  }
}
