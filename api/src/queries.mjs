// Построение SQL для кабинета: фильтры, сортировка, пагинация.
// Все значения передаются параметрами — конкатенации пользовательского ввода нет,
// сортировка берётся только из белого списка колонок.
//
// Каждая функция получает бюджет — хозяина данных. Условие по нему ставит buildFilters,
// и без бюджета он не работает вовсе: забытый фильтр — это чужие чеки на экране,
// поэтому такой запрос должен падать, а не молча отдавать всё.
import { classifyItems } from './classify.mjs';

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

/** Код «без группы» и «без категории»: у неразмеченного своего slug нет. */
export const NONE = '-';

/**
 * Общие фильтры для чеков и позиций.
 * @param budgetId бюджет — обязателен
 * @param prefix префикс колонок: 'r.' для таблицы receipts, '' для представления v_items
 */
export function buildFilters(params, { budgetId, prefix = '', searchItems = false } = {}) {
  if (!Number.isInteger(budgetId)) throw new Error('buildFilters: не указан бюджет');
  const where = [`${prefix}budget_id = :uid`];
  const args = { uid: budgetId };

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

  // Происхождение чека: вбит руками или отсканирован с телефона. Только для списка чеков
  const kind = params.get('kind');
  if (!searchItems && kind === 'manual') where.push(`${prefix}fiscal_drive = 'manual'`);
  if (!searchItems && kind === 'scan') {
    where.push(`EXISTS (SELECT 1 FROM scan_jobs s WHERE s.receipt_id = ${prefix}id)`);
  }

  // Категории есть только у позиций: у чека их столько же, сколько строк.
  if (searchItems) {
    // «-» — неразмеченное: у такой группы нет кода, а показать её содержимое нужно
    const group = (params.get('group') ?? '').trim();
    if (group === NONE) where.push(`${prefix}group_slug IS NULL`);
    else if (group) {
      where.push(`${prefix}group_slug = :group`);
      args.group = group;
    }
    const category = (params.get('category') ?? '').trim();
    if (category === NONE) where.push(`${prefix}category_slug IS NULL`);
    else if (category) {
      where.push(`${prefix}category_slug = :category`);
      args.category = category;
    }
    // Отдельный фильтр на неразмеченное: это рабочий режим, а не край выборки
    if (params.get('uncategorized') === '1') where.push(`${prefix}category_slug IS NULL`);

    // Раскрытие схлопнутой строки: позиции одного названия
    const nameNorm = params.get('name_norm');
    if (nameNorm) {
      where.push(`${prefix}name_norm = :name_norm`);
      args.name_norm = nameNorm;
    }
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

  return { sql: `WHERE ${where.join(' AND ')}`, args };
}

/**
 * Чек считается тратой, если это не возврат и он не закрыт зачётом аванса.
 * Предоплаченная покупка выдаёт два чека — платёж и отгрузку, — и деньги ушли только
 * по первому; второй повторил бы сумму. То же выражение зашито в v_items как counted.
 */
const COUNTED = '(r.operation_type <> 2 AND r.prepaid_sum = 0)';

export function listReceipts(db, budgetId, params) {
  const { sql: whereSql, args } = buildFilters(params, { budgetId, prefix: 'r.' });
  const { sort, dir, column } = parseSort(params, RECEIPT_SORTS, 'date');
  const { page, per, offset } = parsePaging(params);

  const rows = db
    .prepare(
      `SELECT r.id, r.purchased_at, r.purchased_date, r.seller, r.seller_inn, r.retail_place,
              r.retail_address, r.operation_type, r.total_sum, r.cash_sum, r.ecash_sum,
              r.prepaid_sum, r.item_count, r.items_sum, r.internet_sign,
              ${COUNTED} AS counted, r.fiscal_drive = 'manual' AS manual, r.added_by,
              (SELECT COALESCE(u.name, u.login) FROM users u WHERE u.id = r.added_by) AS author,
              -- у ручной записи продавца нет, её имя — то, что купили
              CASE WHEN r.fiscal_drive = 'manual'
                   THEN (SELECT i.name FROM items i WHERE i.receipt_id = r.id ORDER BY i.pos LIMIT 1) END AS title
         FROM receipts r
         ${whereSql}
        ORDER BY ${column} ${dir}, r.id ${dir}
        LIMIT :limit OFFSET :offset`,
    )
    .all({ ...args, limit: per, offset });

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(CASE WHEN ${COUNTED} THEN r.total_sum ELSE 0 END), 0) AS sum,
              COALESCE(SUM(CASE WHEN ${COUNTED} THEN 0 ELSE r.total_sum END), 0) AS excluded_sum,
              COALESCE(SUM(CASE WHEN ${COUNTED} THEN 0 ELSE 1 END), 0) AS excluded_count,
              COALESCE(SUM(r.item_count), 0) AS items
         FROM receipts r
         ${whereSql}`,
    )
    .get(args);

  return { rows, totals, page, per, sort, dir: dir.toLowerCase() };
}

export function listItems(db, budgetId, params) {
  const { sql: whereSql, args } = buildFilters(params, { budgetId, searchItems: true });
  const { sort, dir, column } = parseSort(params, ITEM_SORTS, 'date');
  const { page, per, offset } = parsePaging(params);

  const rows = db
    .prepare(
      `SELECT id, receipt_id, pos, name, name_norm, quantity, unit, price, sum, nds, product_type, gtin,
              purchased_at, purchased_date, seller, seller_inn, retail_place, operation_type,
              prepaid_sum, counted,
              category_slug, category_name, category_source, group_slug, group_name,
              EXISTS (SELECT 1 FROM item_notes n WHERE n.receipt_id = v_items.receipt_id AND n.pos = v_items.pos) AS has_note
         FROM v_items
         ${whereSql}
        ORDER BY ${column} ${dir}, id ${dir}
        LIMIT :limit OFFSET :offset`,
    )
    .all({ ...args, limit: per, offset });

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(CASE WHEN counted = 1 THEN sum ELSE 0 END), 0) AS sum,
              COALESCE(SUM(CASE WHEN counted = 1 THEN 0 ELSE sum END), 0) AS excluded_sum,
              COALESCE(SUM(CASE WHEN counted = 1 THEN 0 ELSE 1 END), 0) AS excluded_count,
              COUNT(DISTINCT receipt_id) AS receipts
         FROM v_items
         ${whereSql}`,
    )
    .get(args);

  return { rows, totals, page, per, sort, dir: dir.toLowerCase() };
}

// Сортировка схлопнутого списка: у группы нет одной даты и одной суммы, поэтому
// каждая колонка сортируется по своему агрегату — дата по последней покупке, сумма по итогу.
const GROUP_SORTS = {
  date: 'MAX(purchased_at)',
  name: 'name_norm',
  sum: 'SUM(sum)',
  price: 'AVG(price)',
  quantity: 'SUM(quantity)',
  seller: 'MIN(seller)',
};

/**
 * Список позиций, схлопнутый по названию: одна строка на название, количество и сумма
 * сложены. Схлопывать на клиенте нельзя — одинаковые названия разбросаны по всей выборке,
 * а список тянется порциями, так что часть строк ещё не загружена.
 *
 * `first_id` — позиция, чью карточку открывает клик по строке. SQLite при MAX() отдаёт
 * значения остальных колонок из той же строки, поэтому это ровно верхняя позиция группы.
 */
export function listItemGroups(db, budgetId, params) {
  const { sql: whereSql, args } = buildFilters(params, { budgetId, searchItems: true });
  const { sort, dir } = parseSort(params, GROUP_SORTS, 'date');
  const { page, per, offset } = parsePaging(params);

  const rows = db
    .prepare(
      `SELECT name_norm,
              name,
              id AS first_id,
              COUNT(*) AS positions,
              COALESCE(SUM(quantity), 0) AS quantity,
              COALESCE(SUM(CASE WHEN counted = 1 THEN sum ELSE 0 END), 0) AS sum,
              COALESCE(SUM(CASE WHEN counted = 1 THEN 0 ELSE 1 END), 0) AS excluded_count,
              MAX(purchased_at) AS purchased_at,
              MIN(purchased_at) AS first_at,
              MAX(manual) AS manual,
              -- хотя бы у одной покупки группы есть комментарий: в ленте это видно пометкой
              MAX(EXISTS (SELECT 1 FROM item_notes n WHERE n.receipt_id = v_items.receipt_id AND n.pos = v_items.pos)) AS has_note,
              unit,
              category_slug, category_name, category_source, group_slug, group_name
         FROM v_items
         ${whereSql}
        GROUP BY name_norm
        ORDER BY ${GROUP_SORTS[sort]} ${dir}, name_norm ${dir}
        LIMIT :limit OFFSET :offset`,
    )
    .all({ ...args, limit: per, offset });

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COUNT(DISTINCT name_norm) AS names,
              COALESCE(SUM(CASE WHEN counted = 1 THEN sum ELSE 0 END), 0) AS sum,
              COALESCE(SUM(CASE WHEN counted = 1 THEN 0 ELSE sum END), 0) AS excluded_sum,
              COALESCE(SUM(CASE WHEN counted = 1 THEN 0 ELSE 1 END), 0) AS excluded_count,
              COUNT(DISTINCT receipt_id) AS receipts
         FROM v_items
         ${whereSql}`,
    )
    .get(args);

  // Пагинация идёт по названиям, а не по позициям: иначе подгрузка по скроллу собьётся.
  // Сколько всего позиций за ними стоит, сводка берёт из positions.
  return {
    rows,
    totals: { ...totals, positions: totals.count, count: totals.names },
    page,
    per,
    sort,
    dir: dir.toLowerCase(),
  };
}

// Разрезы сводки. Ключ группировки и порядок задаются здесь, а не приходят из запроса:
// подстановка в GROUP BY чужой строки — прямой путь к инъекции.
const SUMMARY_BY = {
  group: { key: 'v.group_slug', order: 'sum DESC' },
  category: { key: 'v.category_slug', order: 'sum DESC' },
  month: { key: "substr(v.purchased_date, 1, 7)", order: 'key ASC' },
  seller: { key: 'v.seller_inn', order: 'sum DESC' },
};

/**
 * Сводка: сколько потрачено в разрезе групп, категорий, месяцев или продавцов.
 * Ради одного числа «за май на Питание 64 043 ₽» иначе пришлось бы выкачать 735 строк —
 * на телефоне это бессмысленно, поэтому складывает база.
 *
 * Фильтры те же, что у списков, поэтому сводка и список всегда об одном и том же.
 * Названия и цвета отдаются вместе с числами: клиенту не нужен второй запрос.
 */
/**
 * Траты без чека — второй источник расходов. Чек показывает, что куплено, банк — что
 * деньги ушли; в сводке они складываются. Покупки, у которых чек нашёлся (kind = covered),
 * сюда не попадают: их уже посчитали по чеку. Переводы между своими счетами — тоже.
 */
function bankExpenses(db, budgetId, params, by) {
  const from = params.get('from');
  const to = params.get('to');
  if (!isDate(from) || !isDate(to)) return [];

  // Разрезы «продавец» у банка нет: там нет ИНН, только название. Месяц и категории есть
  const key = {
    group: "(SELECT c.group_slug FROM categories c WHERE c.budget_id = o.budget_id AND c.slug = o.category_slug)",
    category: 'o.category_slug',
    month: "substr(o.at, 1, 7)",
  }[by];
  if (!key) return [];

  const where = ["o.budget_id = :budgetId", "o.kind = 'expense'", 'o.at BETWEEN :from AND :to'];
  const args = { budgetId, from: `${from}T00:00:00`, to: `${to}T23:59:59` };

  // Фильтры по группе и категории действуют и здесь: иначе, провалившись в группу,
  // человек увидел бы чужие траты
  const group = (params.get('group') ?? '').trim();
  if (group === NONE) where.push(`${key === 'o.category_slug' ? 'o.category_slug' : key} IS NULL`);
  else if (group) {
    where.push(
      `o.category_slug IN (SELECT c.slug FROM categories c WHERE c.budget_id = o.budget_id AND c.group_slug = :group)`,
    );
    args.group = group;
  }
  const category = (params.get('category') ?? '').trim();
  if (category === NONE) where.push('o.category_slug IS NULL');
  else if (category) {
    where.push('o.category_slug = :category');
    args.category = category;
  }
  if ((params.get('uncategorized') ?? '') === '1') where.push('o.category_slug IS NULL');

  return db
    .prepare(
      `SELECT ${key} AS key, COUNT(*) AS count, COALESCE(SUM(o.amount), 0) AS sum
         FROM bank_ops o WHERE ${where.join(' AND ')} GROUP BY 1`,
    )
    .all(args);
}

/** Сложить строки сводки из чеков и из банка: ключ разреза один и тот же. */
function mergeBank(rows, bank, names) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const extra of bank) {
    const row = byKey.get(extra.key);
    if (row) {
      row.sum += extra.sum;
      row.count += extra.count;
      row.bank_sum = (row.bank_sum ?? 0) + extra.sum;
      continue;
    }
    // Такой категории в чеках не было: строка появляется целиком из банка
    const fresh = { key: extra.key, count: extra.count, receipts: 0, sum: extra.sum, excluded_sum: 0, bank_sum: extra.sum, ...(names.get(extra.key) ?? {}) };
    rows.push(fresh);
    byKey.set(extra.key, fresh);
  }
  return rows.sort((a, b) => b.sum - a.sum);
}

export function summary(db, budgetId, params) {
  // prefix: колонки берутся из v_items под псевдонимом v — иначе они спорят с groups
  const { sql: whereSql, args } = buildFilters(params, { budgetId, searchItems: true, prefix: 'v.' });
  const by = Object.hasOwn(SUMMARY_BY, params.get('by')) ? params.get('by') : 'group';
  const { key, order } = SUMMARY_BY[by];

  const extra = {
    group: ', g.name AS name, g.icon AS icon, g.color AS color, g.shade_from, g.shade_to',
    category: ', v.category_name AS name, v.group_slug',
    month: '',
    seller: ', MIN(v.seller) AS name',
  }[by];

  const join = by === 'group' ? 'LEFT JOIN groups g ON g.budget_id = v.budget_id AND g.slug = v.group_slug' : '';

  const rows = db
    .prepare(
      `SELECT ${key} AS key,
              COUNT(*) AS count,
              COUNT(DISTINCT v.receipt_id) AS receipts,
              COALESCE(SUM(CASE WHEN v.counted = 1 THEN v.sum ELSE 0 END), 0) AS sum,
              COALESCE(SUM(CASE WHEN v.counted = 1 THEN 0 ELSE v.sum END), 0) AS excluded_sum
              ${extra}
         FROM v_items v
         ${join}
         ${whereSql}
        GROUP BY 1
        ORDER BY ${order}`,
    )
    .all(args);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COUNT(DISTINCT v.receipt_id) AS receipts,
              COALESCE(SUM(CASE WHEN v.counted = 1 THEN v.sum ELSE 0 END), 0) AS sum,
              COALESCE(SUM(CASE WHEN v.counted = 1 THEN 0 ELSE v.sum END), 0) AS excluded_sum
         FROM v_items v
         ${whereSql}`,
    )
    .get(args);

  // Второй источник расходов — траты без чека. Названия и цвета берём из справочника:
  // в v_items такой категории может не быть вовсе
  const bank = bankExpenses(db, budgetId, params, by);
  if (bank.length) {
    const names = new Map(
      by === 'group'
        ? db
            .prepare('SELECT slug AS key, name, icon, color, shade_from, shade_to FROM groups WHERE budget_id = ?')
            .all(budgetId)
            .map((g) => [g.key, g])
        : by === 'category'
          ? db
              .prepare('SELECT slug AS key, name, group_slug FROM categories WHERE budget_id = ?')
              .all(budgetId)
              .map((c) => [c.key, c])
          : [],
    );
    mergeBank(rows, bank, names);
    totals.sum += bank.reduce((s, r) => s + r.sum, 0);
    totals.count += bank.reduce((s, r) => s + r.count, 0);
    totals.bank_sum = bank.reduce((s, r) => s + r.sum, 0);
    totals.bank_count = bank.reduce((s, r) => s + r.count, 0);
  }

  return { by, rows, totals };
}

export function getReceipt(db, budgetId, id) {
  const receipt = db
    .prepare(
      `SELECT id, purchased_at, purchased_date, seller, seller_inn, retail_place, retail_address,
              kkt_reg_id, fiscal_drive, fiscal_doc, fiscal_sign, operation_type, taxation_type,
              total_sum, cash_sum, ecash_sum, prepaid_sum, credit_sum, nds_18, nds_10, nds_0, nds_no,
              shift_number, operator, buyer, internet_sign, item_count, items_sum, added_by,
              (SELECT COALESCE(u.name, u.login) FROM users u WHERE u.id = receipts.added_by) AS author
         FROM receipts WHERE id = ? AND budget_id = ?`,
    )
    .get(id, budgetId);
  if (!receipt) return null;
  // Категория идёт вместе с позицией: после сканирования её сразу показывают на правку
  receipt.items = db
    .prepare(
      `SELECT id, pos, name, quantity, unit, price, sum, nds, nds_sum, product_type, gtin, provider_inn,
              category_slug, category_name, category_source, group_slug, group_name
         FROM v_items WHERE receipt_id = ? ORDER BY pos`,
    )
    .all(id);
  return receipt;
}

/** Позиция со всеми реквизитами — для карточки товара в правой панели. */
/** Комментарий к товару. Пустой — удалить. Держится за чек и номер позиции. */
export function setItemNote(db, budgetId, id, note) {
  const item = db
    .prepare('SELECT i.receipt_id, i.pos FROM items i JOIN receipts r ON r.id = i.receipt_id WHERE i.id = ? AND r.budget_id = ?')
    .get(id, budgetId);
  if (!item) return { error: 'item not found', status: 404 };
  const text = String(note ?? '').trim().slice(0, 1000);
  if (!text) {
    db.prepare('DELETE FROM item_notes WHERE receipt_id = ? AND pos = ?').run(item.receipt_id, item.pos);
    return { note: null };
  }
  db.prepare(
    `INSERT INTO item_notes (receipt_id, pos, note, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (receipt_id, pos) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
  ).run(item.receipt_id, item.pos, text, new Date().toISOString());
  return { note: text };
}

export function getItem(db, budgetId, id) {
  return (
    db
      .prepare(
        `SELECT v.*, i.nds_sum, i.provider_inn,
                (SELECT n.note FROM item_notes n WHERE n.receipt_id = v.receipt_id AND n.pos = v.pos) AS note,
                (SELECT COUNT(*) FROM items x JOIN receipts rx ON rx.id = x.receipt_id
                  WHERE x.name_norm = v.name_norm AND rx.budget_id = v.budget_id) AS same_name_count,
                (CASE WHEN r.internet_sign = 0 AND p.status = 'ok' THEN p.lat END) AS place_lat,
                (CASE WHEN r.internet_sign = 0 AND p.status = 'ok' THEN p.lon END) AS place_lon,
                (CASE WHEN r.internet_sign = 0 AND p.status = 'ok' THEN p.qc_geo END) AS place_qc,
                (CASE WHEN r.internet_sign = 0 AND p.status = 'ok' THEN p.result END) AS place_address,
                r.internet_sign,
                r.fiscal_drive AS receipt_drive,
                r.item_count AS receipt_items
           FROM v_items v
           JOIN items i ON i.id = v.id
           JOIN receipts r ON r.id = v.receipt_id
           LEFT JOIN places p ON p.key = r.place_key
          WHERE v.id = ? AND v.budget_id = ?`,
      )
      .get(id, budgetId) ?? null
  );
}

/**
 * Ручное назначение категории из карточки товара.
 *
 * Правка делается не по одной позиции, а по нормализованному названию: пользователь
 * решает, что значит «Сыр Российский 45%», а не что значит эта конкретная строка чека.
 * Решение принадлежит бюджету — пишется в budget_dictionary, верхнюю ступень его лестницы
 * в classify.mjs; в семейном бюджете оно общее для всех участников, на другие бюджеты
 * не влияет. Метки всех позиций бюджета с этим названием обновляются здесь же,
 * чтобы экран не ждал пересчёта.
 *
 * Пустой slug снимает ручное решение: позиции заново проходят лестницу.
 */
export function setItemCategory(db, budgetId, id, slug) {
  const item = db
    .prepare(
      `SELECT i.id, i.name, i.name_norm FROM items i JOIN receipts r ON r.id = i.receipt_id
        WHERE i.id = ? AND r.budget_id = ?`,
    )
    .get(id, budgetId);
  if (!item) return { error: 'item not found', status: 404 };

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

  const sameName = db
    .prepare(
      `SELECT i.id FROM items i JOIN receipts r ON r.id = i.receipt_id
        WHERE r.budget_id = ? AND i.name_norm = ?`,
    )
    .all(budgetId, item.name_norm)
    .map((r) => r.id);

  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    if (category) {
      db.prepare(
        `INSERT INTO budget_dictionary (budget_id, name_norm, category_slug, updated_at)
         VALUES (:uid, :name_norm, :slug, :now)
         ON CONFLICT (budget_id, name_norm) DO UPDATE SET category_slug = :slug, updated_at = :now`,
      ).run({ uid: budgetId, name_norm: item.name_norm, slug: category.slug, now });

      const label = db.prepare(
        `INSERT INTO item_labels (item_id, budget_id, category_slug, source, confidence, updated_at)
         VALUES (?, ?, ?, 'manual', 1, ?)
         ON CONFLICT (item_id) DO UPDATE SET
           category_slug = excluded.category_slug, source = 'manual', confidence = 1, updated_at = excluded.updated_at`,
      );
      for (const itemId of sameName) label.run(itemId, budgetId, category.slug, now);
    } else {
      db.prepare('DELETE FROM budget_dictionary WHERE budget_id = ? AND name_norm = ?').run(budgetId, item.name_norm);
      classifyItems(db, sameName);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { item_id: item.id, name: item.name, name_norm: item.name_norm, category, affected: sameName.length };
}

/** Справочные данные для фильтров и шапки кабинета. */
export function getMeta(db, budgetId) {
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS receipts,
              COALESCE(SUM(CASE WHEN ${COUNTED} THEN r.total_sum ELSE 0 END), 0) AS sum,
              COALESCE(SUM(r.item_count), 0) AS items,
              MIN(r.purchased_date) AS date_from,
              MAX(r.purchased_date) AS date_to
         FROM receipts r WHERE r.budget_id = ?`,
    )
    .get(budgetId);

  const sellers = db
    .prepare(
      `SELECT seller_inn, MIN(seller) AS seller, COUNT(*) AS receipts, SUM(total_sum) AS sum
         FROM receipts
        WHERE budget_id = ? AND seller_inn IS NOT NULL AND seller_inn <> ''
        GROUP BY seller_inn
        ORDER BY sum DESC`,
    )
    .all(budgetId);

  const months = db
    .prepare(
      `SELECT substr(purchased_date, 1, 7) AS month, COUNT(*) AS receipts, SUM(total_sum) AS sum
         FROM receipts
        WHERE budget_id = ?
        GROUP BY month
        ORDER BY month`,
    )
    .all(budgetId);

  // Журнал импортов общий и ведётся из консоли: путь к файлу пользователю не нужен
  const lastImport = db.prepare('SELECT imported_at FROM imports ORDER BY id DESC LIMIT 1').get() ?? null;

  // Справочник для чипсов: группы и вложенные подкатегории, с числом размеченных позиций
  const rows = db
    .prepare(
      `SELECT c.slug, c.name, c.group_slug, g.name AS group_name, g.icon, g.color, g.shade_from, g.shade_to,
              (SELECT COUNT(*) FROM item_labels l WHERE l.budget_id = c.budget_id AND l.category_slug = c.slug) AS items
         FROM categories c JOIN groups g ON g.budget_id = c.budget_id AND g.slug = c.group_slug
        WHERE c.budget_id = ?
        ORDER BY g.sort, g.slug, c.sort`,
    )
    .all(budgetId);

  const groups = [];
  for (const row of rows) {
    let group = groups.find((g) => g.slug === row.group_slug);
    if (!group) {
      groups.push(
        (group = {
          slug: row.group_slug,
          name: row.group_name,
          icon: row.icon,
          color: row.color,
          shade_from: row.shade_from,
          shade_to: row.shade_to,
          items: 0,
          subcategories: [],
        }),
      );
    }
    group.subcategories.push({ slug: row.slug, name: row.name, items: row.items });
    group.items += row.items;
  }

  const uncategorized = db
    .prepare('SELECT COUNT(*) c FROM v_items WHERE budget_id = ? AND category_slug IS NULL')
    .get(budgetId).c;

  // Бюджет: клиенту нужно знать, общий ли он, — тогда у чеков показывается автор
  const budget = db
    .prepare(
      `SELECT b.id, b.name, (SELECT COUNT(*) FROM users u WHERE u.budget_id = b.id) AS members
         FROM budgets b WHERE b.id = ?`,
    )
    .get(budgetId);

  return { stats, sellers, months, lastImport, categories: groups, uncategorized, budget };
}
