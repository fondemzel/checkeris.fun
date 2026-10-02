// Категории доходов бюджета: плоский список без групп — «Зарплата», «Дивиденды»…
//
// Доходы — это поступления из банка (bank_ops, kind = income). Категория лежит там же, где
// у трат без чека, — в bank_ops.category_slug; коды начинаются с «in.», поэтому с категориями
// расходов не пересекаются. Выбор человека запоминается по отправителю (bank_rules, ключ
// с приставкой «in:») и применяется к его прошлым и будущим поступлениям.

const now = () => new Date().toISOString();
const fail = (status, error) => ({ error, status });
const trim = (v) => String(v ?? '').trim();
const hex = (v) => (/^#[0-9a-f]{6}$/i.test(trim(v)) ? trim(v).toLowerCase() : null);

// Стартовый набор — общий для всех; дальше каждый бюджет правит его как хочет
const DEFAULTS = [
  ['in.salary', 'Зарплата', 'briefcase', '#46a758'],
  ['in.dividends', 'Дивиденды', 'trending', '#3b7bce'],
  ['in.interest', 'Проценты по вкладам', 'percent', '#12a594'],
  ['in.cashback', 'Кэшбэк', 'coins', '#f5a524'],
  ['in.other', 'Прочее', 'dots', '#7c8894'],
];

/** Стартовые категории новому бюджету. Своей транзакции не открывает. */
export function provisionIncome(db, budgetId) {
  const add = db.prepare(
    'INSERT OR IGNORE INTO income_categories (budget_id, slug, name, icon, color, sort) VALUES (?, ?, ?, ?, ?, ?)',
  );
  DEFAULTS.forEach(([slug, name, icon, color], i) => add.run(budgetId, slug, name, icon, color, i * 10));
}

const find = (db, budgetId, slug) =>
  db.prepare('SELECT slug, name, icon, color, sort FROM income_categories WHERE budget_id = ? AND slug = ?').get(budgetId, slug);

/** Список с числом поступлений в каждой категории. */
export function listIncomeCats(db, budgetId) {
  return db
    .prepare(
      `SELECT c.slug, c.name, c.icon, c.color, c.sort,
              (SELECT COUNT(*) FROM bank_ops o WHERE o.budget_id = c.budget_id AND o.category_slug = c.slug) AS ops
         FROM income_categories c WHERE c.budget_id = ? ORDER BY c.sort, c.slug`,
    )
    .all(budgetId);
}

export function createIncomeCat(db, budgetId, body) {
  const name = trim(body.name);
  if (!name) return fail(400, 'нужно название категории');
  const slug = `in.c${Date.now().toString(36)}`;
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 10 AS s FROM income_categories WHERE budget_id = ?').get(budgetId).s;
  db.prepare('INSERT INTO income_categories (budget_id, slug, name, icon, color, sort) VALUES (?, ?, ?, ?, ?, ?)')
    .run(budgetId, slug, name, trim(body.icon) || 'dots', hex(body.color), sort);
  return { category: find(db, budgetId, slug) };
}

export function updateIncomeCat(db, budgetId, slug, body) {
  const cat = find(db, budgetId, slug);
  if (!cat) return fail(404, 'категория не найдена');
  const name = body.name === undefined ? cat.name : trim(body.name);
  if (!name) return fail(400, 'название не может быть пустым');
  const icon = body.icon === undefined ? cat.icon : trim(body.icon) || null;
  const color = body.color === undefined ? cat.color : hex(body.color);
  db.prepare('UPDATE income_categories SET name = ?, icon = ?, color = ? WHERE budget_id = ? AND slug = ?')
    .run(name, icon, color, budgetId, slug);
  return { category: find(db, budgetId, slug) };
}

/**
 * Удаление. Если в категории есть поступления, нужно сказать, куда их перенести: молча
 * снять разметку значило бы потерять ручную работу. Правила по отправителям едут туда же.
 */
export function deleteIncomeCat(db, budgetId, slug, moveTo) {
  if (!find(db, budgetId, slug)) return fail(404, 'категория не найдена');
  const used =
    db.prepare('SELECT COUNT(*) c FROM bank_ops WHERE budget_id = ? AND category_slug = ?').get(budgetId, slug).c +
    db.prepare('SELECT COUNT(*) c FROM bank_rules WHERE budget_id = ? AND category_slug = ?').get(budgetId, slug).c;
  const target = trim(moveTo);
  if (used && !target) return { error: 'нужен перенос', status: 409, used };
  if (target && (target === slug || !find(db, budgetId, target))) return fail(400, 'нет категории для переноса');

  db.exec('BEGIN');
  try {
    if (target) {
      db.prepare('UPDATE bank_ops SET category_slug = ? WHERE budget_id = ? AND category_slug = ?').run(target, budgetId, slug);
      db.prepare('UPDATE bank_rules SET category_slug = ?, updated_at = ? WHERE budget_id = ? AND category_slug = ?')
        .run(target, now(), budgetId, slug);
    }
    db.prepare('DELETE FROM income_categories WHERE budget_id = ? AND slug = ?').run(budgetId, slug);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { deleted: slug, moved_to: target || null, moved: used };
}

/**
 * Ключ правила для поступления — его описание: «Проценты на остаток», «Кэшбэк за обычные
 * покупки», имя отправителя перевода. Поле «продавец» у поступлений не годится: это общий
 * канал («Бонусы», «Входящий перевод», «Сбербанк»), под которым лежит совсем разное.
 * Приставка отделяет ключ от правил расходов.
 */
export function incomeKey(op) {
  const raw = String(op.description || op.sender || op.merchant || '').toLowerCase().replace(/ё/g, 'е');
  const key = raw.replace(/[^a-zа-я0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return key.length >= 2 ? `in:${key}` : null;
}

/** Разложить поступления по категориям, которые человек уже выбирал для таких же поступлений. */
export function applyIncomeRules(db, budgetId) {
  const ops = db
    .prepare(
      `SELECT id, merchant, description, json_extract(raw, '$.senderDetails') AS sender FROM bank_ops
        WHERE budget_id = ? AND kind = 'income' AND (category_slug IS NULL OR category_source = 'rule')`,
    )
    .all(budgetId);
  const rule = db.prepare('SELECT category_slug FROM bank_rules WHERE budget_id = ? AND key = ?');
  const save = db.prepare("UPDATE bank_ops SET category_slug = ?, category_source = 'rule' WHERE id = ? AND category_slug IS NOT ?");
  let done = 0;
  for (const op of ops) {
    const key = incomeKey(op);
    const found = key && rule.get(budgetId, key);
    if (found) done += save.run(found.category_slug, op.id, found.category_slug).changes;
  }
  return done;
}

/** Категория поступления: человек выбрал её сам. Запоминаем для поступлений с тем же описанием. */
export function setIncomeCategory(db, budgetId, op, slug) {
  const category = slug ? find(db, budgetId, slug) : null;
  if (slug && !category) return fail(400, 'unknown category');
  const sender = db.prepare("SELECT json_extract(raw, '$.senderDetails') AS s FROM bank_ops WHERE id = ?").get(op.id).s;
  const key = incomeKey({ ...op, sender });
  db.exec('BEGIN');
  try {
    if (!slug) {
      // Сняли категорию: забываем и правило, иначе оно вернёт её обратно
      if (key) db.prepare('DELETE FROM bank_rules WHERE budget_id = ? AND key = ?').run(budgetId, key);
      db.prepare('UPDATE bank_ops SET category_slug = NULL, category_source = NULL WHERE id = ?').run(op.id);
      db.exec('COMMIT');
      return { category: null, affected: 1 };
    }
    if (key) {
      db.prepare(
        `INSERT INTO bank_rules (budget_id, key, category_slug, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (budget_id, key) DO UPDATE SET category_slug = excluded.category_slug, updated_at = excluded.updated_at`,
      ).run(budgetId, key, slug, now());
    }
    db.prepare("UPDATE bank_ops SET category_slug = ?, category_source = 'manual' WHERE id = ?").run(slug, op.id);
    const affected = key ? 1 + applyIncomeRules(db, budgetId) : 1;
    db.exec('COMMIT');
    return { category, affected };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
