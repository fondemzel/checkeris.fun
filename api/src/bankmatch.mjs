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

// Время у операций и чеков — московское без зоны; для разницы в минутах зона не важна
const minutes = (at) => Date.parse(`${String(at).slice(0, 19)}Z`) / 60_000;

/** Переводы между своими счетами: банк помечает их сам, плюс пары «списание — зачисление». */
function markTransfers(db, budgetId) {
  // Банк знает про свои внутренние переводы
  db.prepare(
    `UPDATE bank_ops SET kind = 'transfer'
      WHERE budget_id = ? AND json_extract(raw, '$.isInner') = 1`,
  ).run(budgetId);

  // Пара: то же число копеек ушло и пришло почти в ту же секунду — это перекладывание
  // из кармана в карман, например «Перевод округлений» в копилку.
  // Ищем группировкой по сумме, а не сравнением «каждая с каждой»: история банка — это
  // десятки тысяч операций, и попарное сравнение занимало минуты, пока сервер стоял
  const unpaired = db
    .prepare('SELECT id, at, amount, direction FROM bank_ops WHERE budget_id = ? AND pair_id IS NULL ORDER BY at, id')
    .all(budgetId);
  const credits = new Map(); // сумма → зачисления
  for (const op of unpaired) {
    if (op.direction !== 'credit') continue;
    if (!credits.has(op.amount)) credits.set(op.amount, []);
    credits.get(op.amount).push({ id: op.id, t: minutes(op.at) });
  }

  const link = db.prepare("UPDATE bank_ops SET pair_id = ?, kind = 'transfer' WHERE id = ? AND pair_id IS NULL");
  const taken = new Set();
  for (const op of unpaired) {
    if (op.direction !== 'debit') continue;
    const t = minutes(op.at);
    const match = (credits.get(op.amount) ?? []).find((c) => !taken.has(c.id) && Math.abs(c.t - t) <= 5);
    if (!match) continue;
    taken.add(op.id);
    taken.add(match.id);
    link.run(match.id, op.id);
    link.run(op.id, match.id);
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
  if (!ops.length) return 0;

  // Чеки, ещё не отданные другой операции, — сразу все, сгруппированные по сумме: запрос
  // на каждую операцию при десятках тысяч операций держал сервер минутами
  const receipts = new Map();
  const free = db.prepare(
    `SELECT r.id, r.purchased_at, r.total_sum FROM receipts r
      WHERE r.budget_id = ? AND r.fiscal_drive <> 'manual'
        AND NOT EXISTS (SELECT 1 FROM bank_ops o WHERE o.budget_id = r.budget_id AND o.receipt_id = r.id)`,
  );
  for (const r of free.all(budgetId)) {
    if (!receipts.has(r.total_sum)) receipts.set(r.total_sum, []);
    receipts.get(r.total_sum).push({ id: r.id, t: minutes(r.purchased_at) });
  }

  const save = db.prepare("UPDATE bank_ops SET receipt_id = ?, kind = 'covered' WHERE id = ?");
  const taken = new Set();
  let matched = 0;
  for (const op of ops) {
    const t = minutes(op.at);
    let best = null;
    for (const r of receipts.get(op.amount) ?? []) {
      const gap = Math.abs(r.t - t);
      if (gap > MINUTES || taken.has(r.id)) continue;
      if (!best || gap < best.gap) best = { id: r.id, gap };
    }
    if (!best) continue;
    taken.add(best.id);
    save.run(best.id, op.id);
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
    const categorized = applyRules(db, budgetId);
    db.exec('COMMIT');
    return { transfers, receipts, categorized };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Ключ правила: продавец, а если его нет — описание операции. Приводим к общему виду,
 * чтобы «МОСЭНЕРГОСБЫТ» и «Мосэнергосбыт » были одним и тем же.
 */
export function ruleKey(op) {
  const raw = String(op.merchant || op.description || '').toLowerCase().replace(/ё/g, 'е');
  const key = raw.replace(/[^a-zа-я0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return key.length >= 2 ? key : null;
}

/** Разложить траты без чека по категориям, которые человек уже выбирал для этих продавцов. */
export function applyRules(db, budgetId) {
  const ops = db
    .prepare(
      `SELECT id, merchant, description FROM bank_ops
        WHERE budget_id = ? AND kind = 'expense' AND category_slug IS NULL`,
    )
    .all(budgetId);
  const rule = db.prepare('SELECT category_slug FROM bank_rules WHERE budget_id = ? AND key = ?');
  const save = db.prepare("UPDATE bank_ops SET category_slug = ?, category_source = 'rule' WHERE id = ?");
  let done = 0;
  for (const op of ops) {
    const key = ruleKey(op);
    const found = key && rule.get(budgetId, key);
    if (!found) continue;
    save.run(found.category_slug, op.id);
    done += 1;
  }
  return done;
}

/**
 * Категория траты без чека: человек выбрал её сам. Запоминаем для этого продавца и сразу
 * размечаем все его операции — и прошлые, и те, что придут позже (applyRules).
 */
export function setOpCategory(db, budgetId, id, slug) {
  const op = db.prepare('SELECT * FROM bank_ops WHERE id = ? AND budget_id = ?').get(id, budgetId);
  if (!op) return { error: 'operation not found', status: 404 };

  const category = slug
    ? db
        .prepare(
          `SELECT c.slug, c.name, c.group_slug, g.name AS group_name
             FROM categories c JOIN groups g ON g.budget_id = c.budget_id AND g.slug = c.group_slug
            WHERE c.budget_id = ? AND c.slug = ?`,
        )
        .get(budgetId, slug)
    : null;
  if (slug && !category) return { error: 'unknown category', status: 400 };

  const key = ruleKey(op);
  const at = new Date().toISOString();
  db.exec('BEGIN');
  try {
    if (!slug) {
      // Сняли категорию: забываем и правило, иначе оно вернёт её обратно
      if (key) db.prepare('DELETE FROM bank_rules WHERE budget_id = ? AND key = ?').run(budgetId, key);
      db.prepare('UPDATE bank_ops SET category_slug = NULL, category_source = NULL WHERE id = ?').run(id);
      db.exec('COMMIT');
      return { category: null, affected: 1 };
    }

    if (key) {
      db.prepare(
        `INSERT INTO bank_rules (budget_id, key, category_slug, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (budget_id, key) DO UPDATE SET category_slug = excluded.category_slug,
           updated_at = excluded.updated_at`,
      ).run(budgetId, key, slug, at);
    }
    db.prepare("UPDATE bank_ops SET category_slug = ?, category_source = 'manual' WHERE id = ?").run(slug, id);
    const affected = key ? 1 + applyRules(db, budgetId) : 1;
    db.exec('COMMIT');
    return { category, affected };
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
