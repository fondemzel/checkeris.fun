// Справочник доходов бюджета: группы и категории в них — устроен как справочник расходов
// (taxonomy.mjs), но живёт в своих таблицах, чтобы категории доходов не попадали ни в выбор
// категории товара, ни в разметку чеков.
//
// Доходы — это поступления из банка (bank_ops, kind = income). Категория лежит там же, где
// у трат без чека, — в bank_ops.category_slug; коды начинаются с «in.», поэтому с категориями
// расходов не пересекаются. Выбор человека запоминается по описанию поступления (bank_rules,
// ключ с приставкой «in:») и применяется к таким же прошлым и будущим поступлениям.

const now = () => new Date().toISOString();
const fail = (status, error) => ({ error, status });
const trim = (v) => String(v ?? '').trim();
const hex = (v) => (/^#[0-9a-f]{6}$/i.test(trim(v)) ? trim(v).toLowerCase() : null);
const clamp = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));
const stamp = () => Date.now().toString(36) + Math.floor(Math.random() * 36).toString(36);

// Стартовый набор — общий для всех; дальше каждый бюджет правит его как хочет:
// заводит «Проекты» с категорией на проект или «Аренду» с категорией на квартиру
const DEFAULTS = [
  ['work', 'Работа', 'briefcase', '#46a758', [['in.salary', 'Зарплата'], ['in.bonus', 'Премии']]],
  ['invest', 'Инвестиции', 'trending', '#3b7bce', [['in.dividends', 'Дивиденды'], ['in.interest', 'Проценты по вкладам']]],
  ['other', 'Прочее', 'dots', '#7c8894', [['in.cashback', 'Кэшбэк'], ['in.gifts', 'Подарки'], ['in.other', 'Другое']]],
];

/** Стартовый справочник новому бюджету. Своей транзакции не открывает. */
export function provisionIncome(db, budgetId) {
  if (db.prepare('SELECT 1 FROM income_groups WHERE budget_id = ? LIMIT 1').get(budgetId)) return;
  const group = db.prepare('INSERT INTO income_groups (budget_id, slug, name, icon, color, sort) VALUES (?, ?, ?, ?, ?, ?)');
  const cat = db.prepare('INSERT INTO income_cats (budget_id, slug, group_slug, name, sort) VALUES (?, ?, ?, ?, ?)');
  DEFAULTS.forEach(([slug, name, icon, color, cats], i) => {
    group.run(budgetId, slug, name, icon, color, i * 10);
    cats.forEach(([cslug, cname], j) => cat.run(budgetId, cslug, slug, cname, j * 10));
  });
}

const GROUP_COLUMNS = 'slug, name, icon, color, shade_from, shade_to, sort';
const findGroup = (db, budgetId, slug) =>
  db.prepare(`SELECT ${GROUP_COLUMNS} FROM income_groups WHERE budget_id = ? AND slug = ?`).get(budgetId, slug);
const findCat = (db, budgetId, slug) =>
  db.prepare('SELECT slug, group_slug, name, sort FROM income_cats WHERE budget_id = ? AND slug = ?').get(budgetId, slug);
const nextSort = (db, table, budgetId, where = '', args = []) =>
  db.prepare(`SELECT COALESCE(MAX(sort), 0) + 10 AS s FROM ${table} WHERE budget_id = ? ${where}`).get(budgetId, ...args).s;

/** Справочник для экрана настройки — в том же виде, что справочник расходов. */
export function getIncomeTaxonomy(db, budgetId) {
  const groups = db.prepare(`SELECT ${GROUP_COLUMNS} FROM income_groups WHERE budget_id = ? ORDER BY sort, slug`).all(budgetId);
  const cats = db
    .prepare(
      `SELECT c.slug, c.group_slug, c.name, c.sort,
              (SELECT COUNT(*) FROM bank_ops o WHERE o.budget_id = c.budget_id AND o.category_slug = c.slug) AS ops
         FROM income_cats c WHERE c.budget_id = ? ORDER BY c.sort, c.slug`,
    )
    .all(budgetId)
    // items, dictionary, links — поля справочника расходов: у доходов их нет, экран общий
    .map((c) => ({ ...c, hint: null, items: 0, dictionary: 0, links: 0 }));
  return { groups: groups.map((g) => ({ ...g, categories: cats.filter((c) => c.group_slug === g.slug) })) };
}

/** Для meta: группы с категориями — как categories у расходов, чтобы выбор категории был общим. */
export function incomeMeta(db, budgetId) {
  return getIncomeTaxonomy(db, budgetId).groups.map(({ categories, ...g }) => ({
    ...g,
    subcategories: categories.map((c) => ({ slug: c.slug, name: c.name })),
  }));
}

// ── группы ───────────────────────────────────────────────

export function createIncomeGroup(db, budgetId, body) {
  const name = trim(body.name);
  if (!name) return fail(400, 'нужно название группы');
  const slug = `g${stamp()}`;
  db.prepare('INSERT INTO income_groups (budget_id, slug, name, icon, color, sort) VALUES (?, ?, ?, ?, ?, ?)')
    .run(budgetId, slug, name, trim(body.icon) || null, hex(body.color), nextSort(db, 'income_groups', budgetId));
  return { group: findGroup(db, budgetId, slug) };
}

export function updateIncomeGroup(db, budgetId, slug, body) {
  const group = findGroup(db, budgetId, slug);
  if (!group) return fail(404, 'группа не найдена');
  const name = body.name === undefined ? group.name : trim(body.name);
  if (!name) return fail(400, 'название не может быть пустым');
  const icon = body.icon === undefined ? group.icon : trim(body.icon) || null;
  const color = body.color === undefined ? group.color : hex(body.color);
  let from = body.shade_from === undefined ? group.shade_from : clamp(body.shade_from, 5, 100);
  let to = body.shade_to === undefined ? group.shade_to : clamp(body.shade_to, 5, 100);
  if (from > to) [from, to] = [to, from];
  db.prepare('UPDATE income_groups SET name = ?, icon = ?, color = ?, shade_from = ?, shade_to = ? WHERE budget_id = ? AND slug = ?')
    .run(name, icon, color, from, to, budgetId, slug);
  return { group: findGroup(db, budgetId, slug) };
}

/** Группу удаляем только пустой: иначе её категории остались бы без родителя. */
export function deleteIncomeGroup(db, budgetId, slug) {
  if (!findGroup(db, budgetId, slug)) return fail(404, 'группа не найдена');
  const inside = db.prepare('SELECT COUNT(*) c FROM income_cats WHERE budget_id = ? AND group_slug = ?').get(budgetId, slug).c;
  if (inside) return fail(409, 'в группе ещё есть категории — перенесите или удалите их');
  db.prepare('DELETE FROM income_groups WHERE budget_id = ? AND slug = ?').run(budgetId, slug);
  return { deleted: slug };
}

// ── категории ────────────────────────────────────────────

export function createIncomeCat(db, budgetId, body) {
  const name = trim(body.name);
  const groupSlug = trim(body.group_slug);
  if (!name) return fail(400, 'нужно название категории');
  if (!findGroup(db, budgetId, groupSlug)) return fail(400, 'нет такой группы');
  const slug = `in.c${stamp()}`;
  db.prepare('INSERT INTO income_cats (budget_id, slug, group_slug, name, sort) VALUES (?, ?, ?, ?, ?)')
    .run(budgetId, slug, groupSlug, name, nextSort(db, 'income_cats', budgetId, 'AND group_slug = ?', [groupSlug]));
  return { category: findCat(db, budgetId, slug) };
}

export function updateIncomeCat(db, budgetId, slug, body) {
  const cat = findCat(db, budgetId, slug);
  if (!cat) return fail(404, 'категория не найдена');
  const name = body.name === undefined ? cat.name : trim(body.name);
  if (!name) return fail(400, 'название не может быть пустым');
  const groupSlug = body.group_slug === undefined ? cat.group_slug : trim(body.group_slug);
  if (!findGroup(db, budgetId, groupSlug)) return fail(400, 'нет такой группы');
  db.prepare('UPDATE income_cats SET name = ?, group_slug = ? WHERE budget_id = ? AND slug = ?').run(name, groupSlug, budgetId, slug);
  return { category: findCat(db, budgetId, slug) };
}

/**
 * Удаление. Если в категории есть поступления, нужно сказать, куда их перенести: молча
 * снять разметку значило бы потерять ручную работу. Правила по описаниям едут туда же.
 */
export function deleteIncomeCat(db, budgetId, slug, moveTo) {
  if (!findCat(db, budgetId, slug)) return fail(404, 'категория не найдена');
  const used =
    db.prepare('SELECT COUNT(*) c FROM bank_ops WHERE budget_id = ? AND category_slug = ?').get(budgetId, slug).c +
    db.prepare('SELECT COUNT(*) c FROM bank_rules WHERE budget_id = ? AND category_slug = ?').get(budgetId, slug).c;
  const target = trim(moveTo);
  if (used && !target) return { error: 'нужен перенос', status: 409, used };
  if (target && (target === slug || !findCat(db, budgetId, target))) return fail(400, 'нет категории для переноса');

  db.exec('BEGIN');
  try {
    if (target) {
      db.prepare('UPDATE bank_ops SET category_slug = ? WHERE budget_id = ? AND category_slug = ?').run(target, budgetId, slug);
      db.prepare('UPDATE bank_rules SET category_slug = ?, updated_at = ? WHERE budget_id = ? AND category_slug = ?')
        .run(target, now(), budgetId, slug);
    }
    db.prepare('DELETE FROM income_cats WHERE budget_id = ? AND slug = ?').run(budgetId, slug);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { deleted: slug, moved_to: target || null, moved: used };
}

// ── разметка поступлений ─────────────────────────────────

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
export function setIncomeCategory(db, budgetId, op, slug, only = false) {
  const category = slug ? findCat(db, budgetId, slug) : null;
  if (slug && !category) return fail(400, 'unknown category');
  const sender = db.prepare("SELECT json_extract(raw, '$.senderDetails') AS s FROM bank_ops WHERE id = ?").get(op.id).s;
  // Только этот доход: правило по описанию не трогаем, ручная метка его перекрывает
  const key = only ? null : incomeKey({ ...op, sender });
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
