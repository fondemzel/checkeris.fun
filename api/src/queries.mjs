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
      `SELECT id, receipt_id, pos, name, quantity, unit, price, sum, nds, product_type, gtin,
              purchased_at, purchased_date, seller, seller_inn, retail_place, operation_type
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
        `SELECT v.*, i.nds_sum, i.provider_inn, r.retail_address, r.total_sum AS receipt_total
           FROM v_items v
           JOIN items i ON i.id = v.id
           JOIN receipts r ON r.id = v.receipt_id
          WHERE v.id = ?`,
      )
      .get(id) ?? null
  );
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

  return { stats, sellers, months, lastImport };
}
