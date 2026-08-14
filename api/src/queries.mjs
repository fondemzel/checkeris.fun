// Построение SQL для кабинета: фильтры, сортировка, пагинация.
// Все значения передаются параметрами — конкатенации пользовательского ввода нет,
// сортировка берётся только из белого списка колонок.

export const RECEIPT_SORTS = {
  date: 'r.purchased_at',
  sum: 'r.total_sum',
  seller: 'r.seller',
  place: 'r.retail_place',
  items: 'r.item_count',
};

export const ITEM_SORTS = {
  date: 'purchased_at',
  name: 'name_norm',
  sum: 'sum',
  price: 'price',
  quantity: 'quantity',
  seller: 'seller',
};

const MAX_PER_PAGE = 500;

export function parsePaging(params) {
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const perRaw = Number.parseInt(params.get('per') ?? '50', 10) || 50;
  const per = Math.min(MAX_PER_PAGE, Math.max(1, perRaw));
  return { page, per, offset: (page - 1) * per };
}

export function parseSort(params, allowed, fallback) {
  // hasOwn, а не allowed[key]: иначе `?sort=constructor` вытащит свойство прототипа
  const requested = params.get('sort');
  const sort = requested && Object.hasOwn(allowed, requested) ? requested : fallback;
  const dir = (params.get('dir') ?? '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return { sort, dir, column: allowed[sort] };
}

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');

/**
 * Общие фильтры для чеков и позиций.
 * @param prefix префикс колонок: 'r.' для таблицы receipts, '' для представления v_items
 */
export function buildFilters(params, { prefix = '', searchItems = false } = {}) {
  const where = [];
  const args = {};

  const from = params.get('from');
  const to = params.get('to');
  if (isDate(from)) {
    where.push(`${prefix}purchased_date >= :from`);
    args.from = from;
  }
  if (isDate(to)) {
    where.push(`${prefix}purchased_date <= :to`);
    args.to = to;
  }

  const inn = (params.get('seller_inn') ?? '').trim();
  if (inn) {
    where.push(`${prefix}seller_inn = :inn`);
    args.inn = inn;
  }

  const operation = Number.parseInt(params.get('operation') ?? '', 10);
  if (operation === 1 || operation === 2 || operation === 3 || operation === 4) {
    where.push(`${prefix}operation_type = :operation`);
    args.operation = operation;
  }

  const minSum = Number.parseFloat(params.get('min_sum') ?? '');
  if (Number.isFinite(minSum)) {
    where.push(`${prefix}${searchItems ? 'sum' : 'total_sum'} >= :min_sum`);
    args.min_sum = Math.round(minSum * 100);
  }
  const maxSum = Number.parseFloat(params.get('max_sum') ?? '');
  if (Number.isFinite(maxSum)) {
    where.push(`${prefix}${searchItems ? 'sum' : 'total_sum'} <= :max_sum`);
    args.max_sum = Math.round(maxSum * 100);
  }

  // Категории есть только у позиций: у чека их столько же, сколько строк.
  if (searchItems) {
    const group = (params.get('group') ?? '').trim();
    if (group) {
      where.push(`${prefix}group_slug = :group`);
      args.group = group;
    }
    const category = (params.get('category') ?? '').trim();
    if (category) {
      where.push(`${prefix}category_slug = :category`);
      args.category = category;
    }
    // Отдельный фильтр на неразмеченное: это рабочий режим, а не край выборки
    if (params.get('uncategorized') === '1') where.push(`${prefix}category_slug IS NULL`);
  }

  const q = (params.get('q') ?? '').trim().toLowerCase().replace(/ё/g, 'е');
  if (q) {
    args.q = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    if (searchItems) {
      // по названию позиции, продавцу и точке
      where.push(`(
        ${prefix}name_norm LIKE :q ESCAPE '\\'
        OR lower(${prefix}seller) LIKE :q ESCAPE '\\'
        OR lower(${prefix}retail_place) LIKE :q ESCAPE '\\'
      )`);
    } else {
      // по чеку: продавец, точка, адрес — и по названиям позиций внутри чека
      where.push(`(
        lower(${prefix}seller) LIKE :q ESCAPE '\\'
        OR lower(${prefix}retail_place) LIKE :q ESCAPE '\\'
        OR lower(${prefix}retail_address) LIKE :q ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM items i WHERE i.receipt_id = ${prefix}id AND i.name_norm LIKE :q ESCAPE '\\')
      )`);
    }
  }

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

export function listReceipts(db, params) {
  const { sql: whereSql, args } = buildFilters(params, { prefix: 'r.' });
  const { sort, dir, column } = parseSort(params, RECEIPT_SORTS, 'date');
  const { page, per, offset } = parsePaging(params);

  const rows = db
    .prepare(
      `SELECT r.id, r.purchased_at, r.purchased_date, r.seller, r.seller_inn, r.retail_place,
              r.retail_address, r.operation_type, r.total_sum, r.cash_sum, r.ecash_sum,
              r.item_count, r.items_sum, r.internet_sign
         FROM receipts r
         ${whereSql}
        ORDER BY ${column} ${dir}, r.id ${dir}
        LIMIT :limit OFFSET :offset`,
    )
    .all({ ...args, limit: per, offset });

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(r.total_sum), 0) AS sum,
              COALESCE(SUM(r.item_count), 0) AS items
         FROM receipts r
         ${whereSql}`,
    )
    .get(args);

  return { rows, totals, page, per, sort, dir: dir.toLowerCase() };
}

export function listItems(db, params) {
  const { sql: whereSql, args } = buildFilters(params, { searchItems: true });
  const { sort, dir, column } = parseSort(params, ITEM_SORTS, 'date');
  const { page, per, offset } = parsePaging(params);

  const rows = db
    .prepare(
      `SELECT id, receipt_id, pos, name, name_norm, quantity, unit, price, sum, nds, product_type, gtin,
              purchased_at, purchased_date, seller, seller_inn, retail_place, operation_type,
              category_slug, category_name, category_source, group_slug, group_name
         FROM v_items
         ${whereSql}
        ORDER BY ${column} ${dir}, id ${dir}
        LIMIT :limit OFFSET :offset`,
    )
    .all({ ...args, limit: per, offset });

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(sum), 0) AS sum,
              COUNT(DISTINCT receipt_id) AS receipts
         FROM v_items
         ${whereSql}`,
    )
    .get(args);

  return { rows, totals, page, per, sort, dir: dir.toLowerCase() };
}

export function getReceipt(db, id) {
  const receipt = db
    .prepare(
      `SELECT id, purchased_at, purchased_date, seller, seller_inn, retail_place, retail_address,
              kkt_reg_id, fiscal_drive, fiscal_doc, fiscal_sign, operation_type, taxation_type,
              total_sum, cash_sum, ecash_sum, prepaid_sum, credit_sum, nds_18, nds_10, nds_0, nds_no,
              shift_number, operator, buyer, internet_sign, item_count, items_sum
         FROM receipts WHERE id = ?`,
    )
    .get(id);
  if (!receipt) return null;
  receipt.items = db
    .prepare(
      `SELECT id, pos, name, quantity, unit, price, sum, nds, nds_sum, product_type, gtin, provider_inn
         FROM items WHERE receipt_id = ? ORDER BY pos`,
    )
    .all(id);
  return receipt;
}

/** Позиция со всеми реквизитами — для карточки товара в правой панели. */
export function getItem(db, id) {
  return (
    db
      .prepare(
        `SELECT v.*, i.nds_sum, i.provider_inn,
                (SELECT COUNT(*) FROM items x WHERE x.name_norm = v.name_norm) AS same_name_count
           FROM v_items v
           JOIN items i ON i.id = v.id
          WHERE v.id = ?`,
      )
      .get(id) ?? null
  );
}

/**
 * Ручное назначение категории из карточки товара.
 *
 * Правка делается не по одной позиции, а по нормализованному названию: пользователь
 * решает, что значит «Сыр Российский 45%», а не что значит эта конкретная строка чека.
 * Поэтому запись идёт в общий словарь с source='manual' — это верхняя ступень лестницы
 * в classify.mjs, выше GTIN и правил продавца, и её не перетирает ни LLM (--fill
 * пропускает manual), ни пересчёт разметки (--apply берёт manual первым). Метки всех
 * позиций с этим названием обновляются здесь же, чтобы кабинет не ждал прогона скрипта.
 *
 * Пустой slug снимает ручное решение: словарная запись удаляется, метки очищаются,
 * и следующий `classify.mjs --apply` заново проводит название по лестнице.
 */
export function setItemCategory(db, id, slug) {
  const item = db.prepare('SELECT id, name, name_norm FROM items WHERE id = ?').get(id);
  if (!item) return { error: 'item not found', status: 404 };

  const category = slug
    ? db.prepare('SELECT slug, name, group_slug, group_name FROM categories WHERE slug = ?').get(slug)
    : null;
  if (slug && !category) return { error: 'unknown category', status: 400 };

  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    if (category) {
      db.prepare(
        `INSERT INTO dictionary (name_norm, category_slug, source, confidence, votes, updated_at)
         VALUES (:name_norm, :slug, 'manual', 1, 1, :now)
         ON CONFLICT (name_norm) DO UPDATE SET
           category_slug = :slug, source = 'manual', confidence = 1,
           votes = dictionary.votes + 1, updated_at = :now`,
      ).run({ name_norm: item.name_norm, slug: category.slug, now });

      db.prepare(
        `INSERT INTO item_labels (item_id, category_slug, source, confidence, updated_at)
         SELECT id, :slug, 'manual', 1, :now FROM items WHERE name_norm = :name_norm
         ON CONFLICT (item_id) DO UPDATE SET
           category_slug = :slug, source = 'manual', confidence = 1, updated_at = :now`,
      ).run({ name_norm: item.name_norm, slug: category.slug, now });
    } else {
      db.prepare('DELETE FROM dictionary WHERE name_norm = ?').run(item.name_norm);
      db.prepare(
        `DELETE FROM item_labels WHERE item_id IN (SELECT id FROM items WHERE name_norm = ?)`,
      ).run(item.name_norm);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const affected = db.prepare('SELECT COUNT(*) c FROM items WHERE name_norm = ?').get(item.name_norm).c;
  return { item_id: item.id, name: item.name, name_norm: item.name_norm, category, affected };
}

/** Справочные данные для фильтров и шапки кабинета. */
export function getMeta(db) {
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS receipts,
              COALESCE(SUM(total_sum), 0) AS sum,
              COALESCE(SUM(item_count), 0) AS items,
              MIN(purchased_date) AS date_from,
              MAX(purchased_date) AS date_to
         FROM receipts`,
    )
    .get();

  const sellers = db
    .prepare(
      `SELECT seller_inn, MIN(seller) AS seller, COUNT(*) AS receipts, SUM(total_sum) AS sum
         FROM receipts
        WHERE seller_inn IS NOT NULL AND seller_inn <> ''
        GROUP BY seller_inn
        ORDER BY sum DESC`,
    )
    .all();

  const months = db
    .prepare(
      `SELECT substr(purchased_date, 1, 7) AS month, COUNT(*) AS receipts, SUM(total_sum) AS sum
         FROM receipts
        GROUP BY month
        ORDER BY month`,
    )
    .all();

  const lastImport = db.prepare('SELECT file, imported_at FROM imports ORDER BY id DESC LIMIT 1').get() ?? null;

  // Справочник для чипсов: группы и вложенные подкатегории, с числом размеченных позиций
  const rows = db
    .prepare(
      `SELECT c.slug, c.name, c.group_slug, c.group_name, c.icon, c.sort,
              (SELECT COUNT(*) FROM item_labels l WHERE l.category_slug = c.slug) AS items
         FROM categories c ORDER BY c.sort`,
    )
    .all();

  const groups = [];
  for (const row of rows) {
    let group = groups.find((g) => g.slug === row.group_slug);
    if (!group) {
      groups.push((group = { slug: row.group_slug, name: row.group_name, icon: row.icon, items: 0, subcategories: [] }));
    }
    group.subcategories.push({ slug: row.slug, name: row.name, items: row.items });
    group.items += row.items;
  }

  const uncategorized = db.prepare(`SELECT COUNT(*) c FROM v_items WHERE category_slug IS NULL`).get().c;

  return { stats, sellers, months, lastImport, categories: groups, uncategorized };
}
