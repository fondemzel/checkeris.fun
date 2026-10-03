// «Разметить автоматически»: товары без категории — модели, по кнопке человека и у него на
// глазах. Страница берёт список неразмеченного за период и отдаёт его сюда порциями: каждая
// порция — до MAX_NAMES разных названий, ответ — новые категории этих товаров.
//
// Модель платная, у каждого свой суточный лимит (quota.mjs): кончился — порция возвращается
// как есть, с пометкой, и страница останавливается до завтра.

import { classifyItems } from './classify.mjs';
import { askModel } from './scan.mjs';
import { modelQuotaLeft } from './quota.mjs';

const MAX_NAMES = 20; // как и за один вопрос модели (MAX_ASK в scan.mjs) — с запасом
const LIST_LIMIT = 1000;
const LIMIT_PLUS = LIST_LIMIT + 1; // на одну больше — узнать, что показали не всё

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');

/** Товары без категории за период: те, что считаются в расходах. */
export function unlabeled(db, budgetId, from, to) {
  const rows = db
    .prepare(
      `SELECT id, name, name_norm, sum, purchased_at AS at, seller, seller_inn, market
         FROM v_items
        WHERE budget_id = ? AND category_slug IS NULL AND counted = 1 AND dup = 0
          AND purchased_date >= ? AND purchased_date <= ?
        ORDER BY purchased_at DESC
        LIMIT ${LIMIT_PLUS}`,
    )
    .all(budgetId, isDate(from) ? from : '0000-00-00', isDate(to) ? to : '9999-12-31');
  return { rows: rows.slice(0, LIST_LIMIT), total: rows.length, cut: rows.length > LIST_LIMIT };
}
/**
 * Разметить порцию: сначала дешёвые ступени (словарь мог пополниться прошлой порцией), потом
 * модель — только то, чего не знает никто. Ответ — категории товаров порции.
 */
export async function labelBatch(db, user, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger).slice(0, 200);
  if (!list.length) return { rows: [], quota_left: modelQuotaLeft(db, user.id) };
  const marks = list.map(() => '?').join(',');
  const own = db.prepare(`SELECT id FROM v_items WHERE budget_id = ? AND id IN (${marks})`).all(user.budget_id, ...list).map((r) => r.id);

  classifyItems(db, own);
  const unknown = db
    .prepare(`SELECT COUNT(*) AS n FROM item_labels WHERE item_id IN (${marks}) AND source IN ('unknown', 'rule-fallback')`)
    .get(...list).n;
  const before = modelQuotaLeft(db, user.id);
  if (unknown && before > 0) await askModel(db, own, user.id);

  const rows = db
    .prepare(
      `SELECT id, category_slug, category_source FROM v_items WHERE id IN (${own.map(() => '?').join(',') || 'NULL'})`,
    )
    .all(...own);
  // Лимит кончился — только если было что спросить, а спросить уже нельзя
  return { rows, quota_left: modelQuotaLeft(db, user.id), quota_out: unknown > 0 && before <= 0 };
}

export { MAX_NAMES };
