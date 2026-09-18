// Личные суточные квоты.
//
// Лимит ФНС (1000 обращений в сутки) и платная модель — общие на всё приложение.
// Регистрация открытая, поэтому одному активному пользователю нельзя дать выбрать
// их за всех. Администратор квот не имеет: это владелец проекта, и его расход
// ограничен общими лимитами.
//
//   USER_DAILY_SCANS        — сканов в сутки на пользователя (по умолчанию 30)
//   USER_DAILY_MODEL_NAMES  — незнакомых названий на разметку моделью (по умолчанию 100)
import { loadEnv } from './llm.mjs';

const today = () => new Date().toISOString().slice(0, 10);

function limitOf(name, fallback) {
  loadEnv();
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Сколько сканов осталось на сегодня. Считаются задания, созданные за сутки по UTC. */
export function scanQuota(db, user) {
  if (user.role === 'admin') return { limit: Infinity, used: 0, left: Infinity };
  const limit = limitOf('USER_DAILY_SCANS', 30);
  const used = db
    .prepare('SELECT COUNT(*) c FROM scan_jobs WHERE user_id = ? AND created_at >= ?')
    .get(user.id, today()).c;
  return { limit, used, left: limit - used };
}

/**
 * Сколько названий можно отдать модели из запрошенных — и сразу записать расход.
 * Не хватило квоты — позиции останутся без категории, человек выберет её сам.
 */
export function takeModelQuota(db, userId, wanted) {
  const user = userId ? db.prepare('SELECT role FROM users WHERE id = ?').get(userId) : null;
  if (!user) return 0; // сканировавший удалил аккаунт — платить за него некому
  if (user.role === 'admin') return wanted;

  const limit = limitOf('USER_DAILY_MODEL_NAMES', 100);
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
