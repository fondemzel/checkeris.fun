// «Разметить автоматически»: всё без категории — товары из чеков и траты банка без чека —
// модели, по кнопке человека и у него на глазах. Страница берёт список неразмеченного за
// период и отдаёт его сюда порциями: до 20 разных названий за раз.
//
// Товар узнаём по названию (общий словарь товаров), трату банка — по продавцу (общий
// справочник продавцов, merchant_dictionary). Чего не знает справочник — спрашиваем модель.
// Модель платная, у каждого свой суточный лимит (quota.mjs): кончился — порция возвращается
// как есть, с пометкой, и страница останавливается до завтра.

import { classifyItems, guessMerchants, budgetCategoryOf } from './classify.mjs';
import { askModel } from './scan.mjs';
import { modelQuotaLeft, takeModelQuota } from './quota.mjs';
import { ruleKey } from './bankmatch.mjs';

const LIST_LIMIT = 1000;

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');

/** Без категории за период: товары, что считаются в расходах, и траты банка без чека. */
export function unlabeled(db, budgetId, from, to) {
  const since = isDate(from) ? from : '0000-00-00';
  const until = isDate(to) ? to : '9999-12-31';
  const items = db
    .prepare(
      `SELECT 'item' AS type, id, name, name_norm AS key, sum, purchased_at AS at, seller, seller_inn, market
         FROM v_items
        WHERE budget_id = ? AND category_slug IS NULL AND counted = 1 AND dup = 0
          AND purchased_date >= ? AND purchased_date <= ?`,
    )
    .all(budgetId, since, until);
  const ops = db
    .prepare(
      `SELECT 'op' AS type, id, COALESCE(merchant, description) AS name, amount AS sum, at, merchant, description
         FROM bank_ops
        WHERE budget_id = ? AND kind = 'expense' AND category_slug IS NULL
          AND at >= ? AND at <= ?`,
    )
    .all(budgetId, `${since}T00:00:00`, `${until}T23:59:59`)
    .map((op) => ({ ...op, key: `op:${ruleKey(op) ?? op.id}` }));
  const rows = [...items, ...ops].sort((a, b) => (a.at < b.at ? 1 : -1));
  return { rows: rows.slice(0, LIST_LIMIT), total: rows.length, cut: rows.length > LIST_LIMIT };
}

const marksOf = (list) => list.map(() => '?').join(',');

/**
 * Разметить порцию. Товары: сначала дешёвые ступени (словарь мог пополниться прошлой
 * порцией), потом модель. Траты банка: справочник продавцов, незнакомых — модели.
 * Ответ — категории записей порции.
 */
export async function labelBatch(db, user, ids, opIds) {
  const itemIds = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger).slice(0, 200);
  const opList = (Array.isArray(opIds) ? opIds : []).map(Number).filter(Number.isInteger).slice(0, 200);
  const before = modelQuotaLeft(db, user.id);
  let unknown = 0;
  const rows = [];

  if (itemIds.length) {
    const own = db
      .prepare(`SELECT id FROM v_items WHERE budget_id = ? AND id IN (${marksOf(itemIds)})`)
      .all(user.budget_id, ...itemIds)
      .map((r) => r.id);
    if (own.length) {
      classifyItems(db, own);
      const left = db
        .prepare(`SELECT COUNT(*) AS n FROM item_labels WHERE item_id IN (${marksOf(own)}) AND source IN ('unknown', 'rule-fallback')`)
        .get(...own).n;
      unknown += left;
      if (left && modelQuotaLeft(db, user.id) > 0) await askModel(db, own, user.id);
      rows.push(...db
        .prepare(`SELECT 'item' AS type, id, category_slug, category_source FROM v_items WHERE id IN (${marksOf(own)})`)
        .all(...own));
    }
  }

  if (opList.length) {
    const ops = db
      .prepare(`SELECT id, merchant, description, bank_category FROM bank_ops WHERE budget_id = ? AND id IN (${marksOf(opList)})`)
      .all(user.budget_id, ...opList);
    const byKey = new Map();
    for (const op of ops) {
      const key = ruleKey(op);
      if (key && !byKey.has(key)) byKey.set(key, { key, name: op.merchant || op.description || '', hint: op.bank_category });
    }
    const known = db.prepare('SELECT category_slug FROM merchant_dictionary WHERE key = ?');
    const ask = [...byKey.values()].filter((m) => !known.get(m.key));
    unknown += ask.length;
    const allowed = ask.length ? takeModelQuota(db, user.id, ask.length) : 0;
    if (allowed) {
      try {
        await guessMerchants(db, ask.slice(0, allowed));
      } catch (err) {
        console.error('модель не разметила продавцов:', err.message);
      }
    }
    // Догадка — не выбор человека: category_source = 'model'. Правило продавца она не создаёт
    // и уступит ему, как только человек выберет сам
    const save = db.prepare(
      "UPDATE bank_ops SET category_slug = ?, category_source = 'model' WHERE id = ? AND category_slug IS NULL AND kind = 'expense'",
    );
    for (const op of ops) {
      const sys = known.get(ruleKey(op) ?? '')?.category_slug;
      // «Прочее» — значит, модель не узнала продавца (часто это перевод человеку): пусть
      // остаётся без категории — так видно, что её стоит выбрать самому
      if (!sys || sys.startsWith('other.')) continue;
      const slug = budgetCategoryOf(db, user.budget_id, sys);
      if (slug) save.run(slug, op.id);
    }
    rows.push(...db
      .prepare(`SELECT 'op' AS type, id, category_slug, category_source FROM bank_ops WHERE id IN (${marksOf(opList)})`)
      .all(...opList));
  }

  // Лимит кончился — только если было что спросить, а спросить уже нельзя
  return { rows, quota_left: modelQuotaLeft(db, user.id), quota_out: unknown > 0 && before <= 0 };
}
