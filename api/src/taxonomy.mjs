// Справочник категорий бюджета: группы и категории, общие для всех его участников.
//
// Каждый бюджет получает копию системного справочника (provisionTaxonomy) и дальше
// правит её как хочет. Общее знание о товарах — словарь, штрихкоды, правила продавцов —
// пишется в системных кодах, а в категории бюджета попадает через category_links.
//
// Главное ограничение: slug неизменен. На него ссылаются разметка позиций, ручные
// правки и связи, поэтому переименование — это правка name, а не slug'а.
// Группа категории тоже не зашита в slug: её задаёт колонка group_slug.

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

/** Название → латинский корень slug'а. Пустой результат допустим: вызывающий подставит запасной. */
function translit(name) {
  return [...String(name ?? '').toLowerCase()]
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
}

/** Свободный slug в справочнике этого бюджета: корень из названия, при совпадении — с номером. */
function freeSlug(db, table, budgetId, base) {
  const taken = (slug) => db.prepare(`SELECT 1 FROM ${table} WHERE budget_id = ? AND slug = ?`).get(budgetId, slug);
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}_${i}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error('не удалось подобрать свободный slug');
}

const fail = (status, error) => ({ error, status });

const trim = (v) => String(v ?? '').trim();

const clamp = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

/** Цвет принимаем только как #rrggbb: он уходит прямо в стиль чипса. */
function hexColor(value) {
  const hex = trim(value).toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
}

const GROUP_COLUMNS = 'slug, name, icon, color, shade_from, shade_to, sort';

const findGroup = (db, budgetId, slug) =>
  db.prepare(`SELECT ${GROUP_COLUMNS} FROM groups WHERE budget_id = ? AND slug = ?`).get(budgetId, slug);

const findCategory = (db, budgetId, slug) =>
  db.prepare('SELECT slug, group_slug, name, hint, sort FROM categories WHERE budget_id = ? AND slug = ?').get(budgetId, slug);

/**
 * Справочник новому бюджету — копия системного, и каждая системная категория
 * ведёт в свою копию. Своей транзакции не открывает: её держит вызывающий.
 * Возвращает false, если справочник у бюджета уже есть.
 */
export function provisionTaxonomy(db, budgetId) {
  if (db.prepare('SELECT 1 FROM groups WHERE budget_id = ? LIMIT 1').get(budgetId)) return false;

  db.prepare(
    `INSERT INTO groups (budget_id, ${GROUP_COLUMNS})
     SELECT ?, ${GROUP_COLUMNS} FROM sys_groups`,
  ).run(budgetId);
  db.prepare(
    `INSERT INTO categories (budget_id, slug, group_slug, name, hint, sort)
     SELECT ?, slug, group_slug, name, hint, sort FROM sys_categories`,
  ).run(budgetId);
  db.prepare(
    `INSERT INTO category_links (budget_id, sys_slug, slug)
     SELECT ?, slug, slug FROM sys_categories`,
  ).run(budgetId);
  return true;
}

/** Справочник целиком: группы, их категории и на что каждая категория завязана. */
export function getTaxonomy(db, budgetId) {
  const groups = db
    .prepare(`SELECT ${GROUP_COLUMNS} FROM groups WHERE budget_id = ? ORDER BY sort, slug`)
    .all(budgetId);
  const cats = db
    .prepare(
      `SELECT c.slug, c.group_slug, c.name, c.hint, c.sort,
              (SELECT COUNT(*) FROM item_labels l
                WHERE l.budget_id = c.budget_id AND l.category_slug = c.slug) AS items,
              (SELECT COUNT(*) FROM budget_dictionary d
                WHERE d.budget_id = c.budget_id AND d.category_slug = c.slug) AS dictionary,
              (SELECT COUNT(*) FROM category_links k
                WHERE k.budget_id = c.budget_id AND k.slug = c.slug) AS links
         FROM categories c WHERE c.budget_id = ? ORDER BY c.sort, c.slug`,
    )
    .all(budgetId);

  return {
    groups: groups.map((g) => ({
      ...g,
      categories: cats.filter((c) => c.group_slug === g.slug),
      items: cats.filter((c) => c.group_slug === g.slug).reduce((n, c) => n + c.items, 0),
    })),
  };
}

const nextSort = (db, table, budgetId, where = '', args = []) =>
  db.prepare(`SELECT COALESCE(MAX(sort), 0) + 10 AS s FROM ${table} WHERE budget_id = ? ${where}`).get(budgetId, ...args).s;

// ── группы ───────────────────────────────────────────────

export function createGroup(db, budgetId, body) {
  const name = trim(body.name);
  if (!name) return fail(400, 'нужно название группы');

  const slug = freeSlug(db, 'groups', budgetId, translit(name) || 'group');
  db.prepare('INSERT INTO groups (budget_id, slug, name, icon, color, sort) VALUES (?, ?, ?, ?, ?, ?)').run(
    budgetId,
    slug,
    name,
    trim(body.icon) || null,
    hexColor(body.color),
    nextSort(db, 'groups', budgetId),
  );
  return { group: findGroup(db, budgetId, slug) };
}

export function updateGroup(db, budgetId, slug, body) {
  const group = findGroup(db, budgetId, slug);
  if (!group) return fail(404, 'группа не найдена');

  const name = body.name === undefined ? group.name : trim(body.name);
  if (!name) return fail(400, 'название не может быть пустым');
  const icon = body.icon === undefined ? group.icon : trim(body.icon) || null;
  const sort = body.sort === undefined ? group.sort : Number(body.sort);
  const color = body.color === undefined ? group.color : hexColor(body.color);

  // Диапазон оттенков: между ними раскладываются категории группы. Держим from < to
  // и не даём подойти вплотную к белому — иначе первая категория станет неразличимой.
  let from = body.shade_from === undefined ? group.shade_from : clamp(body.shade_from, 5, 100);
  let to = body.shade_to === undefined ? group.shade_to : clamp(body.shade_to, 5, 100);
  if (from > to) [from, to] = [to, from];

  db.prepare(
    `UPDATE groups SET name = ?, icon = ?, color = ?, shade_from = ?, shade_to = ?, sort = ?
      WHERE budget_id = ? AND slug = ?`,
  ).run(name, icon, color, from, to, sort, budgetId, slug);
  return { group: findGroup(db, budgetId, slug) };
}

/** Группу удаляем только пустой: иначе её категории остались бы без родителя. */
export function deleteGroup(db, budgetId, slug) {
  if (!findGroup(db, budgetId, slug)) return fail(404, 'группа не найдена');

  const inside = db.prepare('SELECT COUNT(*) c FROM categories WHERE budget_id = ? AND group_slug = ?').get(budgetId, slug).c;
  if (inside) return fail(409, `в группе ещё ${inside} ${inside === 1 ? 'категория' : 'категорий'} — перенесите или удалите их`);

  db.prepare('DELETE FROM groups WHERE budget_id = ? AND slug = ?').run(budgetId, slug);
  return { deleted: slug };
}

// ── категории ────────────────────────────────────────────

export function createCategory(db, budgetId, body) {
  const name = trim(body.name);
  const groupSlug = trim(body.group_slug);
  if (!name) return fail(400, 'нужно название категории');
  if (!findGroup(db, budgetId, groupSlug)) return fail(400, 'нет такой группы');

  // slug рождается с префиксом группы — так он читаем; связь с группой держит колонка
  const slug = freeSlug(db, 'categories', budgetId, `${groupSlug}.${translit(name) || 'category'}`);
  db.prepare('INSERT INTO categories (budget_id, slug, group_slug, name, hint, sort) VALUES (?, ?, ?, ?, ?, ?)').run(
    budgetId,
    slug,
    groupSlug,
    name,
    trim(body.hint) || null,
    nextSort(db, 'categories', budgetId, 'AND group_slug = ?', [groupSlug]),
  );
  return { category: findCategory(db, budgetId, slug) };
}

export function updateCategory(db, budgetId, slug, body) {
  const category = findCategory(db, budgetId, slug);
  if (!category) return fail(404, 'категория не найдена');

  const name = body.name === undefined ? category.name : trim(body.name);
  if (!name) return fail(400, 'название не может быть пустым');

  const groupSlug = body.group_slug === undefined ? category.group_slug : trim(body.group_slug);
  if (!findGroup(db, budgetId, groupSlug)) return fail(400, 'нет такой группы');

  const hint = body.hint === undefined ? category.hint : trim(body.hint) || null;
  const sort = body.sort === undefined ? category.sort : Number(body.sort);

  db.prepare('UPDATE categories SET name = ?, group_slug = ?, hint = ?, sort = ? WHERE budget_id = ? AND slug = ?').run(
    name,
    groupSlug,
    hint,
    sort,
    budgetId,
    slug,
  );
  // Переразметка не нужна: метки ссылаются на slug, а он не менялся
  return { category: findCategory(db, budgetId, slug) };
}

/**
 * Перестановка после перетаскивания. Клиент присылает весь новый порядок, а не «поставь
 * между этими двумя»: целочисленный sort при вставке серединой исчерпывается за десяток
 * перетаскиваний. Здесь же меняется группа — перенос и перестановка это одно движение.
 */
export function reorder(db, budgetId, body) {
  const order = Array.isArray(body.order) ? body.order.map(trim) : [];
  if (!order.length) return fail(400, 'пустой порядок');
  if (new Set(order).size !== order.length) return fail(400, 'в порядке есть повторы');

  const groups = body.kind === 'groups';
  const table = groups ? 'groups' : 'categories';
  const known = new Set(db.prepare(`SELECT slug FROM ${table} WHERE budget_id = ?`).all(budgetId).map((r) => r.slug));
  const missing = order.filter((slug) => !known.has(slug));
  if (missing.length) return fail(400, `неизвестные записи: ${missing.join(', ')}`);

  const groupSlug = trim(body.group_slug);
  if (!groups && !findGroup(db, budgetId, groupSlug)) return fail(400, 'нет такой группы');

  const setSort = db.prepare(`UPDATE ${table} SET sort = ? WHERE budget_id = ? AND slug = ?`);
  const setGroup = db.prepare('UPDATE categories SET group_slug = ? WHERE budget_id = ? AND slug = ?');

  db.exec('BEGIN');
  try {
    order.forEach((slug, i) => {
      setSort.run(i * 10, budgetId, slug);
      if (!groups) setGroup.run(groupSlug, budgetId, slug);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Переразметка не нужна: метки ссылаются на slug, а он не менялся
  return { reordered: order.length, group_slug: groups ? null : groupSlug };
}

/**
 * На что завязана категория — этим же считается цена удаления: размеченные позиции,
 * ручные правки и системные категории, которые ведут сюда (через них общее знание
 * раскладывает новые покупки).
 */
export function categoryUsage(db, budgetId, slug) {
  const count = (sql) => db.prepare(sql).get(budgetId, slug).c;
  return {
    items: count('SELECT COUNT(*) c FROM item_labels WHERE budget_id = ? AND category_slug = ?'),
    dictionary: count('SELECT COUNT(*) c FROM budget_dictionary WHERE budget_id = ? AND category_slug = ?'),
    links: count('SELECT COUNT(*) c FROM category_links WHERE budget_id = ? AND slug = ?'),
  };
}

/**
 * Удаление. Если на категорию что-то ссылается, требуем, куда это перенести:
 * молча обнулить разметку значило бы потерять ручную работу. Вместе с разметкой
 * переезжают и связи — поэтому удалённая «Доставка еды» продолжает приходить туда,
 * куда её перенесли, а не пропадает из разбора новых чеков.
 */
export function deleteCategory(db, budgetId, slug, moveTo) {
  if (!findCategory(db, budgetId, slug)) return fail(404, 'категория не найдена');

  const usage = categoryUsage(db, budgetId, slug);
  const total = usage.items + usage.dictionary + usage.links;
  const target = trim(moveTo);

  if (total && !target) return { error: 'нужен перенос', status: 409, usage };
  if (target) {
    if (target === slug) return fail(400, 'переносить в саму себя нельзя');
    if (!findCategory(db, budgetId, target)) return fail(400, 'нет категории для переноса');
  }

  db.exec('BEGIN');
  try {
    if (target) {
      const now = new Date().toISOString();
      db.prepare('UPDATE item_labels SET category_slug = ?, updated_at = ? WHERE budget_id = ? AND category_slug = ?')
        .run(target, now, budgetId, slug);
      db.prepare('UPDATE budget_dictionary SET category_slug = ?, updated_at = ? WHERE budget_id = ? AND category_slug = ?')
        .run(target, now, budgetId, slug);
      db.prepare('UPDATE category_links SET slug = ? WHERE budget_id = ? AND slug = ?').run(target, budgetId, slug);
    }
    db.prepare('DELETE FROM categories WHERE budget_id = ? AND slug = ?').run(budgetId, slug);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { deleted: slug, moved_to: target || null, moved: total };
}
