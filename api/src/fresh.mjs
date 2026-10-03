// Что пришло с последним обновлением банка или магазина — чтобы человек сразу увидел новые
// операции и чеки и куда они разложены, и поправил категорию, пока помнит покупку.
//
// «Новое» — то, что легло в базу после момента since (время сервера): у операций банка это
// bank_ops.created_at, у магазинов — shop_cheques.created_at. Чеки, которые уже были (пришли
// из ФНС), не новые: они лишь отмечены как учтённые, их source_id не от магазина.
// Порядок — по времени поступления, свежие сверху: так их видно во время загрузки.

import { knownShop } from './shops.mjs';

const LIMIT = 2000; // больше за раз не показываем: это уже загрузка всей истории

/** Подключения этого банка у бюджета: данные банка видны всем участникам. */
function links(db, budgetId, bank) {
  return db
    .prepare('SELECT l.id FROM bank_links l JOIN users u ON u.id = l.user_id WHERE u.budget_id = ? AND l.bank = ?')
    .all(budgetId, bank)
    .map((r) => r.id);
}

export function freshItems(db, budgetId, bank, since) {
  const ids = links(db, budgetId, bank);
  if (!ids.length || !since) return { rows: [], total: 0 };
  const list = ids.join(',');

  if (knownShop(bank)) {
    const rows = db
      .prepare(
        `SELECT 'item' AS type, v.id, v.name, v.sum, v.purchased_at AS at, 'expense' AS kind,
                v.category_slug, v.category_source, v.receipt_id, c.created_at AS added
           FROM shop_cheques c
           JOIN receipts r ON r.id = c.receipt_id AND r.source_id LIKE ?
           JOIN v_items v ON v.receipt_id = r.id AND v.dup = 0
          WHERE c.link_id IN (${list}) AND c.created_at > ?
          ORDER BY c.created_at DESC, v.purchased_at DESC, v.pos
          LIMIT ${LIMIT + 1}`,
      )
      .all(`${bank}:%`, since);
    return { rows: rows.slice(0, LIMIT), total: rows.length, cut: rows.length > LIMIT };
  }

  const rows = db
    .prepare(
      `SELECT 'op' AS type, id, COALESCE(merchant, description) AS name, amount AS sum, at, direction, kind,
              category_slug, category_source, receipt_id, created_at AS added
         FROM bank_ops
        WHERE link_id IN (${list}) AND created_at > ? AND kind IN ('expense', 'income', 'covered')
        ORDER BY created_at DESC, at DESC
        LIMIT ${LIMIT + 1}`,
    )
    .all(since);
  return { rows: rows.slice(0, LIMIT), total: rows.length, cut: rows.length > LIMIT };
}
