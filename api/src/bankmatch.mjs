// Разбор операций банка: что из них трата, что доход, а что вообще не движение денег.
//
// Одна покупка картой существует дважды: чеком из ФНС (с товарами) и операцией банка.
// Считать её нужно один раз, поэтому операция, у которой нашёлся чек, помечается covered —
// в суммах расходов её представляет чек, а сама операция остаётся для истории.
//
// Виды (bank_ops.kind):
//   covered  — есть чек: сумма уже посчитана по чеку
//   expense  — трата без чека: переводы людям, ЖКХ, подписки, покупки за границей
//   income   — поступление
//   transfer — перевод между своими счетами: ни доход, ни расход
//
// Разметка идемпотентна: её можно гонять сколько угодно, результат тот же.

// Чек пробивают в момент оплаты, но время в кассе и в банке расходится: часы кассы,
// задержка авторизации. Полчаса — с запасом, а совпадение суммы до копейки делает
// ошибку маловероятной
const MINUTES = 30;

/** Переводы между своими счетами: банк помечает их сам, плюс пары «списание — зачисление». */
function markTransfers(db, budgetId) {
  // Банк знает про свои внутренние переводы
  db.prepare(
    `UPDATE bank_ops SET kind = 'transfer'
      WHERE budget_id = ? AND json_extract(raw, '$.isInner') = 1`,
  ).run(budgetId);

  // Пара: то же число копеек ушло и пришло почти в ту же секунду — это перекладывание
  // из кармана в карман, например «Перевод округлений» в копилку
  const pairs = db
    .prepare(
      `SELECT a.id AS debit_id, b.id AS credit_id
         FROM bank_ops a
         JOIN bank_ops b ON b.budget_id = a.budget_id AND b.direction = 'credit'
          AND b.amount = a.amount AND b.id <> a.id
          AND abs(julianday(b.at) - julianday(a.at)) * 1440 <= 5
        WHERE a.budget_id = ? AND a.direction = 'debit'
          AND (a.pair_id IS NULL AND b.pair_id IS NULL)`,
    )
    .all(budgetId);

  const link = db.prepare("UPDATE bank_ops SET pair_id = ?, kind = 'transfer' WHERE id = ? AND pair_id IS NULL");
  const taken = new Set();
  for (const p of pairs) {
    if (taken.has(p.debit_id) || taken.has(p.credit_id)) continue;
    taken.add(p.debit_id);
    taken.add(p.credit_id);
    link.run(p.credit_id, p.debit_id);
    link.run(p.debit_id, p.credit_id);
  }
  return taken.size / 2;
}

/**
 * Операция ↔ чек: та же сумма до копейки и близкое время. Из нескольких кандидатов берём
 * ближайший по времени, и каждый чек достаётся только одной операции.
 */
function matchReceipts(db, budgetId) {
  const ops = db
    .prepare(
      `SELECT id, at, amount FROM bank_ops
        WHERE budget_id = ? AND direction = 'debit' AND receipt_id IS NULL
          AND (kind IS NULL OR kind <> 'transfer')
        ORDER BY at`,
    )
    .all(budgetId);

  const candidates = db.prepare(
    `SELECT r.id, r.purchased_at FROM receipts r
      WHERE r.budget_id = :budgetId AND r.total_sum = :amount AND r.fiscal_drive <> 'manual'
        AND abs(julianday(r.purchased_at) - julianday(:at)) * 1440 <= :minutes
        AND NOT EXISTS (SELECT 1 FROM bank_ops o WHERE o.receipt_id = r.id)
      ORDER BY abs(julianday(r.purchased_at) - julianday(:at))
      LIMIT 1`,
  );
  const save = db.prepare("UPDATE bank_ops SET receipt_id = ?, kind = 'covered' WHERE id = ?");

  let matched = 0;
  for (const op of ops) {
    const receipt = candidates.get({ budgetId, amount: op.amount, at: op.at, minutes: MINUTES });
    if (!receipt) continue;
    save.run(receipt.id, op.id);
    matched += 1;
  }
  return matched;
}

/** Остальное: приход — доход, расход без чека — трата. */
function classifyRest(db, budgetId) {
  db.prepare(
    `UPDATE bank_ops
        SET kind = CASE WHEN direction = 'credit' THEN 'income' ELSE 'expense' END
      WHERE budget_id = ? AND kind IS NULL`,
  ).run(budgetId);
}

/** Полный проход по бюджету. Вызывается после загрузки операций из приложения. */
export function matchBank(db, budgetId) {
  db.exec('BEGIN');
  try {
    const transfers = markTransfers(db, budgetId);
    const receipts = matchReceipts(db, budgetId);
    classifyRest(db, budgetId);
    db.exec('COMMIT');
    return { transfers, receipts };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Сводка по видам за период: сколько потрачено, получено и переложено между счетами. */
export function bankTotals(db, budgetId, from, to) {
  return db
    .prepare(
      `SELECT kind, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS sum
         FROM bank_ops
        WHERE budget_id = ? AND at BETWEEN ? AND ?
        GROUP BY kind`,
    )
    .all(budgetId, `${from}T00:00:00`, `${to}T23:59:59`);
}
