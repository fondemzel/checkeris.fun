// Суточные квоты — по тарифу бюджета (plans.mjs).
//
// Лимит ФНС (1000 обращений в сутки) и платная модель — общие на всё приложение, поэтому
// и у «без ограничений» есть предохранитель. Сканы считаются на бюджет (тариф — у бюджета:
// семья делит их), названия для модели — на человека. Администратор квот не имеет: это
// владелец проекта, и его расход ограничен общими лимитами.
import { planOf, planOfUser } from './plans.mjs';

const today = () => new Date().toISOString().slice(0, 10);

/** Сколько сканов осталось бюджету на сегодня. Считаются задания, созданные за сутки по UTC. */
export function scanQuota(db, user) {
  if (user.role === 'admin') return { limit: Infinity, used: 0, left: Infinity };
  const plan = planOf(db, user.budget_id);
  const used = db
    .prepare('SELECT COUNT(*) c FROM scan_jobs WHERE budget_id = ? AND created_at >= ?')
    .get(user.budget_id, today()).c;
  return { limit: plan.scans, used, left: plan.scans - used, plan: plan.id };
}

/**
 * Сколько названий можно отдать модели из запрошенных — и сразу записать расход.
 * Не хватило квоты — позиции останутся без категории, человек выберет её сам.
 */
/** Сколько названий модель ещё разметит сегодня за этого человека (у владельца — без счёта). */
export function modelQuotaLeft(db, userId) {
  const user = userId ? db.prepare('SELECT role FROM users WHERE id = ?').get(userId) : null;
  if (!user) return 0;
  if (user.role === 'admin') return Infinity;
  const used = db.prepare("SELECT n FROM usage_daily WHERE user_id = ? AND day = ? AND kind = 'llm_names'").get(userId, today())?.n ?? 0;
  return Math.max(0, planOfUser(db, userId).names - used);
}

export function takeModelQuota(db, userId, wanted) {
  const user = userId ? db.prepare('SELECT role FROM users WHERE id = ?').get(userId) : null;
  if (!user) return 0; // сканировавший удалил аккаунт — платить за него некому
  if (user.role === 'admin') return wanted;

  const limit = planOfUser(db, userId).names;
  const day = today();
  const used = db.prepare("SELECT n FROM usage_daily WHERE user_id = ? AND day = ? AND kind = 'llm_names'").get(userId, day)?.n ?? 0;
  const allowed = Math.max(0, Math.min(wanted, limit - used));
  if (allowed) {
    db.prepare(
      `INSERT INTO usage_daily (user_id, day, kind, n) VALUES (?, ?, 'llm_names', ?)
       ON CONFLICT (user_id, day, kind) DO UPDATE SET n = n + excluded.n`,
    ).run(userId, day, allowed);
  }
  return allowed;
}
