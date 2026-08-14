// Правка справочника категорий из кабинета: группы и категории.
//
// Источник правды — база (см. шапку categories.mjs). Всё, что здесь меняется,
// попадает в репозиторий командой `categories.mjs --export`.
//
// Главное ограничение: slug неизменен. На него ссылаются dictionary, item_labels,
// seller_rules и gtin_map, поэтому переименование — это правка name, а не slug'а.
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

/** Свободный slug: корень из названия, при совпадении — с номером. */
function freeSlug(db, table, base) {
  const taken = (slug) => db.prepare(`SELECT 1 FROM ${table} WHERE slug = ?`).get(slug);
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

/** Справочник целиком: группы, их категории и на что каждая категория завязана. */
export function getTaxonomy(db) {
  const groups = db.prepare('SELECT slug, name, icon, color, shade_from, shade_to, sort FROM groups ORDER BY sort, slug').all();
  const cats = db
    .prepare(
      `SELECT c.slug, c.group_slug, c.name, c.hint, c.sort,
              (SELECT COUNT(*) FROM item_labels l WHERE l.category_slug = c.slug)  AS items,
              (SELECT COUNT(*) FROM dictionary d  WHERE d.category_slug = c.slug)  AS dictionary,
              (SELECT COUNT(*) FROM seller_rules s WHERE s.category_slug = c.slug) AS sellers,
              (SELECT COUNT(*) FROM gtin_map m    WHERE m.category_slug = c.slug)  AS gtin
         FROM categories c ORDER BY c.sort, c.slug`,
    )
    .all();

  return {
    groups: groups.map((g) => ({
      ...g,
      categories: cats.filter((c) => c.group_slug === g.slug),
      items: cats.filter((c) => c.group_slug === g.slug).reduce((n, c) => n + c.items, 0),
    })),
  };
}

const nextSort = (db, table, where = '', args = []) =>
  (db.prepare(`SELECT COALESCE(MAX(sort), 0) + 10 AS s FROM ${table} ${where}`).get(...args).s);

// ── группы ───────────────────────────────────────────────

export function createGroup(db, body) {
  const name = trim(body.name);
  if (!name) return fail(400, 'нужно название группы');

  const slug = freeSlug(db, 'groups', translit(name) || 'group');
  db.prepare('INSERT INTO groups (slug, name, icon, color, sort) VALUES (?, ?, ?, ?, ?)').run(
    slug,
    name,
    trim(body.icon) || null,
    hexColor(body.color),
    nextSort(db, 'groups'),
  );
  return { group: db.prepare('SELECT slug, name, icon, color, shade_from, shade_to, sort FROM groups WHERE slug = ?').get(slug) };
}

export function updateGroup(db, slug, body) {
  const group = db.prepare('SELECT slug, name, icon, color, shade_from, shade_to, sort FROM groups WHERE slug = ?').get(slug);
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

  db.prepare('UPDATE groups SET name = ?, icon = ?, color = ?, shade_from = ?, shade_to = ?, sort = ? WHERE slug = ?').run(
    name,
    icon,
    color,
    from,
    to,
    sort,
    slug,
  );
  return { group: db.prepare('SELECT slug, name, icon, color, shade_from, shade_to, sort FROM groups WHERE slug = ?').get(slug) };
}

/** Группу удаляем только пустой: иначе её категории остались бы без родителя. */
export function deleteGroup(db, slug) {
  if (!db.prepare('SELECT 1 FROM groups WHERE slug = ?').get(slug)) return fail(404, 'группа не найдена');

  const inside = db.prepare('SELECT COUNT(*) c FROM categories WHERE group_slug = ?').get(slug).c;
  if (inside) return fail(409, `в группе ещё ${inside} ${inside === 1 ? 'категория' : 'категорий'} — перенесите или удалите их`);

  db.prepare('DELETE FROM groups WHERE slug = ?').run(slug);
  return { deleted: slug };
}

// ── категории ────────────────────────────────────────────

export function createCategory(db, body) {
  const name = trim(body.name);
  const groupSlug = trim(body.group_slug);
  if (!name) return fail(400, 'нужно название категории');
  if (!db.prepare('SELECT 1 FROM groups WHERE slug = ?').get(groupSlug)) return fail(400, 'нет такой группы');

  // slug рождается с префиксом группы — так он читаем; связь с группой держит колонка
  const slug = freeSlug(db, 'categories', `${groupSlug}.${translit(name) || 'category'}`);
  db.prepare('INSERT INTO categories (slug, group_slug, name, hint, sort) VALUES (?, ?, ?, ?, ?)').run(
    slug,
    groupSlug,
    name,
    trim(body.hint) || null,
    nextSort(db, 'categories', 'WHERE group_slug = ?', [groupSlug]),
  );
  return { category: db.prepare('SELECT * FROM categories WHERE slug = ?').get(slug) };
}

export function updateCategory(db, slug, body) {
  const category = db.prepare('SELECT * FROM categories WHERE slug = ?').get(slug);
  if (!category) return fail(404, 'категория не найдена');

  const name = body.name === undefined ? category.name : trim(body.name);
  if (!name) return fail(400, 'название не может быть пустым');

  const groupSlug = body.group_slug === undefined ? category.group_slug : trim(body.group_slug);
  if (!db.prepare('SELECT 1 FROM groups WHERE slug = ?').get(groupSlug)) return fail(400, 'нет такой группы');

  const hint = body.hint === undefined ? category.hint : trim(body.hint) || null;
  const sort = body.sort === undefined ? category.sort : Number(body.sort);

  db.prepare('UPDATE categories SET name = ?, group_slug = ?, hint = ?, sort = ? WHERE slug = ?').run(
    name,
    groupSlug,
    hint,
    sort,
    slug,
  );
  // Переразметка не нужна: метки ссылаются на slug, а он не менялся
  return { category: db.prepare('SELECT * FROM categories WHERE slug = ?').get(slug) };
}

/** На что завязана категория — этим же считается цена удаления. */
export function categoryUsage(db, slug) {
  const count = (sql) => db.prepare(sql).get(slug).c;
  return {
    items: count('SELECT COUNT(*) c FROM item_labels WHERE category_slug = ?'),
    dictionary: count('SELECT COUNT(*) c FROM dictionary WHERE category_slug = ?'),
    sellers: count('SELECT COUNT(*) c FROM seller_rules WHERE category_slug = ?'),
    gtin: count('SELECT COUNT(*) c FROM gtin_map WHERE category_slug = ?'),
  };
}

/**
 * Удаление. Если на категорию что-то ссылается, требуем, куда это перенести:
 * молча обнулить разметку значило бы потерять ручную работу.
 */
export function deleteCategory(db, slug, moveTo) {
  if (!db.prepare('SELECT 1 FROM categories WHERE slug = ?').get(slug)) return fail(404, 'категория не найдена');

  const usage = categoryUsage(db, slug);
  const total = usage.items + usage.dictionary + usage.sellers + usage.gtin;
  const target = trim(moveTo);

  if (total && !target) return { error: 'нужен перенос', status: 409, usage };
  if (target) {
    if (target === slug) return fail(400, 'переносить в саму себя нельзя');
    if (!db.prepare('SELECT 1 FROM categories WHERE slug = ?').get(target)) return fail(400, 'нет категории для переноса');
  }

  db.exec('BEGIN');
  try {
    if (target) {
      const now = new Date().toISOString();
      for (const table of ['item_labels', 'dictionary', 'seller_rules', 'gtin_map']) {
        db.prepare(`UPDATE ${table} SET category_slug = ?, updated_at = ? WHERE category_slug = ?`).run(target, now, slug);
      }
    }
    db.prepare('DELETE FROM categories WHERE slug = ?').run(slug);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { deleted: slug, moved_to: target || null, moved: total };
}
