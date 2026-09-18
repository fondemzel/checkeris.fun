// Конвейер классификации позиций.
//
//   node api/src/classify.mjs --fill    — разметить неизвестные названия моделью (пишет в словарь)
//   node api/src/classify.mjs --apply   — пересчитать категории всех позиций всех пользователей
//   node api/src/classify.mjs --stats   — что чем определилось
//
// Ступени идут от самого надёжного к самому дорогому. Первая сработавшая
// побеждает — это и есть весь алгоритм:
//
//   1. ручная правка   — решение владельца позиции, отменить его не может ничто
//   2. GTIN            — штрихкод: тот же код = тот же товар, ошибок не бывает
//   3. жёсткое правило — продавец торгует одним («Тариф по билету» у авиаагентства)
//   4. словарь         — точное совпадение нормализованного названия
//   5. похожее         — символьные триграммы: «мандарины абхаз вес» ~ «мандарины вес»
//   6. запасное правило— супермаркет: если иначе не определилось, это еда
//
// Ступень 1 — личная, в кодах справочника владельца. Ступени 2–6 — общее знание,
// оно отвечает кодом системного справочника, а в личную категорию его переводят
// связи владельца (category_links). Если системная категория у человека ни с чем
// не связана, идём по цепочке запасных (fallback_slug); не нашлось и там — ступень
// считается несработавшей, и разметка спускается ниже.
//
// Модель в этот список не входит: она наполняет общий словарь, а не решает на месте.
// Вызывается она в двух случаях: пакетом из --fill и точечно из очереди сканирования
// (scan.mjs), когда у свежего чека попались незнакомые названия. В момент показа
// данных пользователю обращений к модели нет — только запросы к таблицам.
import { pathToFileURL } from 'node:url';
import { openDb, migrate } from './db.mjs';
import { dumpCatalog, flatten } from './categories.mjs';
import { completeJson, usageLine } from './llm.mjs';
import { buildPrompt } from './bench.mjs';

const NGRAM_THRESHOLD = 0.5; // ниже этого сходство перестаёт быть надёжным
const FILL_BATCH = 40;

const trigrams = (s) => {
  const set = new Set();
  const padded = ` ${s} `;
  for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
  return set;
};

/** Индекс похожих названий по общему словарю. Строится один раз на прогон. */
function buildNeighbourIndex(db) {
  const entries = db.prepare('SELECT name_norm, category_slug FROM dictionary').all();
  const grams = entries.map((e) => trigrams(e.name_norm));
  const index = new Map();
  grams.forEach((set, i) => {
    for (const g of set) {
      let bucket = index.get(g);
      if (!bucket) index.set(g, (bucket = []));
      bucket.push(i);
    }
  });

  return function nearest(nameNorm) {
    const set = trigrams(nameNorm);
    const hits = new Map();
    for (const g of set) {
      const bucket = index.get(g);
      if (!bucket) continue;
      for (const i of bucket) hits.set(i, (hits.get(i) ?? 0) + 1);
    }
    let best = 0;
    let bestIndex = -1;
    for (const [i, shared] of hits) {
      const jaccard = shared / (set.size + grams[i].size - shared);
      if (jaccard > best) {
        best = jaccard;
        bestIndex = i;
      }
    }
    return best >= NGRAM_THRESHOLD ? { category: entries[bestIndex].category_slug, similarity: best } : null;
  };
}

/** Общее знание — в кодах системного справочника. */
function loadTables(db) {
  const dict = new Map(db.prepare('SELECT name_norm, category_slug FROM dictionary').all().map((r) => [r.name_norm, r.category_slug]));
  const gtin = new Map(db.prepare('SELECT gtin, category_slug FROM gtin_map').all().map((r) => [r.gtin, r.category_slug]));
  const always = new Map();
  const fallback = new Map();
  for (const row of db.prepare('SELECT seller_inn, category_slug, mode FROM seller_rules').all()) {
    (row.mode === 'always' ? always : fallback).set(row.seller_inn, row.category_slug);
  }
  const sysFallback = new Map(
    db.prepare('SELECT slug, fallback_slug FROM sys_categories WHERE fallback_slug IS NOT NULL').all().map((r) => [r.slug, r.fallback_slug]),
  );
  return { dict, gtin, always, fallback, sysFallback };
}

/** Личное: ручные правки владельца и куда у него ведут системные категории. */
export function loadUserTables(db, userId) {
  return {
    overrides: new Map(
      db.prepare('SELECT name_norm, category_slug FROM user_dictionary WHERE user_id = ?').all(userId).map((r) => [r.name_norm, r.category_slug]),
    ),
    links: new Map(
      db.prepare('SELECT sys_slug, slug FROM category_links WHERE user_id = ?').all(userId).map((r) => [r.sys_slug, r.slug]),
    ),
  };
}

/** Системная категория → личная. Цепочка запасных короткая, ограничение — от циклов. */
function toPersonal(sysSlug, tables, user) {
  let slug = sysSlug;
  for (let hop = 0; slug && hop < 8; hop += 1) {
    const own = user.links.get(slug);
    if (own) return own;
    slug = tables.sysFallback.get(slug);
  }
  return null;
}

/**
 * Одна позиция → категория и то, чем она определилась.
 * Без user — в системных кодах: так --fill выясняет, чего не знает общее знание.
 */
export function resolve(item, tables, nearest, user = null) {
  if (user) {
    const own = user.overrides.get(item.name_norm);
    if (own) return { category: own, source: 'manual', confidence: 1 };
  }

  // Ступень общего знания срабатывает, только если её ответ есть и у владельца
  const hit = (sys, source, confidence) => {
    if (!sys) return null;
    const category = user ? toPersonal(sys, tables, user) : sys;
    return category ? { category, source, confidence } : null;
  };

  return (
    hit(item.gtin && tables.gtin.get(item.gtin), 'gtin', 1) ??
    hit(tables.always.get(item.seller_inn), 'rule', 0.95) ??
    hit(tables.dict.get(item.name_norm), 'dictionary', 0.9) ??
    (() => {
      const similar = nearest(item.name_norm);
      return similar ? hit(similar.category, 'ngram', similar.similarity) : null;
    })() ??
    hit(tables.fallback.get(item.seller_inn), 'rule-fallback', 0.5) ?? { category: null, source: 'unknown', confidence: 0 }
  );
}

const UPSERT_LABEL = `
  INSERT INTO item_labels (item_id, user_id, category_slug, source, confidence, updated_at)
  VALUES (:id, :user_id, :category, :source, :confidence, :now)
  ON CONFLICT (item_id) DO UPDATE SET
    category_slug = :category, source = :source, confidence = :confidence, updated_at = :now`;

/**
 * Разметка набора позиций. Позиции разных владельцев размечаются каждая по своей
 * лестнице; закреплённые метки (ручные траты) не трогаем — их категория пришла
 * из данных, а не выведена из названия, и восстановить её пересчётом невозможно.
 */
function label(db, items) {
  const tables = loadTables(db);
  const nearest = buildNeighbourIndex(db);
  const users = new Map();
  const upsert = db.prepare(UPSERT_LABEL);
  const now = new Date().toISOString();
  const counts = {};

  for (const item of items) {
    let user = users.get(item.user_id);
    if (!user) users.set(item.user_id, (user = loadUserTables(db, item.user_id)));
    const { category, source, confidence } = resolve(item, tables, nearest, user);
    upsert.run({ id: item.id, user_id: item.user_id, category, source, confidence, now });
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
}

const ITEMS_TO_LABEL = `
  SELECT v.id, v.user_id, v.name_norm, v.gtin, v.seller_inn
    FROM v_item_categories v
    LEFT JOIN item_labels l ON l.item_id = v.id
   WHERE (l.source IS NULL OR l.source <> 'pinned')`;

/** Пересчёт разметки всех позиций всех пользователей. */
function apply(db) {
  const items = db.prepare(ITEMS_TO_LABEL).all();
  let counts;
  db.exec('BEGIN');
  try {
    counts = label(db, items);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  // Закреплённые в пересчёте не участвовали, но в сводке их видеть надо
  const pinned = db.prepare("SELECT COUNT(*) c FROM item_labels WHERE source = 'pinned'").get().c;
  if (pinned) counts.pinned = pinned;
  return counts;
}

/**
 * Разметка нескольких позиций — для только что отсканированного чека или после
 * правки справочника. Полный пересчёт тут не нужен: он строит индекс по всему
 * словарю ради десяти строк.
 */
export function classifyItems(db, itemIds) {
  if (!itemIds?.length) return {};
  const placeholders = itemIds.map(() => '?').join(',');
  const items = db.prepare(`${ITEMS_TO_LABEL} AND v.id IN (${placeholders})`).all(...itemIds);
  return label(db, items);
}

/**
 * Названия, которые не берёт ни одна дешёвая ступень общего знания, — их и отдаём модели.
 * Смотрим в системных кодах: модель пополняет общий словарь, личные правки ей не помеха.
 */
function unknownNames(db, limit) {
  const tables = loadTables(db);
  const nearest = buildNeighbourIndex(db);

  const rows = db
    .prepare(
      `SELECT i.name_norm, MIN(i.name) AS name, COUNT(*) AS n, SUM(i.sum) AS money,
              (SELECT r.seller FROM items x JOIN receipts r ON r.id = x.receipt_id
                WHERE x.name_norm = i.name_norm LIMIT 1) AS seller,
              (SELECT r.seller_inn FROM items x JOIN receipts r ON r.id = x.receipt_id
                WHERE x.name_norm = i.name_norm LIMIT 1) AS seller_inn,
              (SELECT x.gtin FROM items x WHERE x.name_norm = i.name_norm AND x.gtin IS NOT NULL LIMIT 1) AS gtin
         FROM items i GROUP BY i.name_norm ORDER BY money DESC`,
    )
    .all();

  // Модели отдаём только то, что не решается дешевле. Запасное правило по
  // продавцу здесь не в счёт: оно грубое, и уточнить его моделью полезно.
  return rows
    .filter((row) => {
      const r = resolve(row, tables, nearest);
      return r.source === 'unknown' || r.source === 'rule-fallback';
    })
    .slice(0, limit);
}

/**
 * Разметка списка названий моделью и запись в словарь.
 * Вынесено из CLI, потому что тем же путём идёт сканирование: у свежего чека
 * бывает одно-два названия, которых словарь не видел, и спрашивать про них
 * модель надо сразу, а не ждать ручного прогона.
 *
 * Ручные записи не перетираются: ON CONFLICT пропускает source='manual'.
 */
export async function fillNames(db, names, { model = 'lite', onBatch = null } = {}) {
  if (!names.length) return { written: 0 };

  // Системный справочник из базы: модель пишет в общий словарь, а он живёт в системных кодах
  const catalog = dumpCatalog(db);
  const slugs = flatten(catalog).map((c) => c.slug);
  const system = buildPrompt(catalog);
  const schema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { n: { type: 'integer' }, category: { type: 'string', enum: slugs } },
          required: ['n', 'category'],
        },
      },
    },
    required: ['items'],
  };

  const insert = db.prepare(`
    INSERT INTO dictionary (name_norm, category_slug, source, confidence, votes, updated_at)
    VALUES (:name_norm, :category, 'llm', 0.8, 1, :now)
    ON CONFLICT (name_norm) DO UPDATE SET
      category_slug = :category, source = 'llm', updated_at = :now
      WHERE dictionary.source != 'manual'`);

  let written = 0;
  const failures = [];

  for (let offset = 0; offset < names.length; offset += FILL_BATCH) {
    const chunk = names.slice(offset, offset + FILL_BATCH);
    const user = chunk
      .map((it, i) => `${i + 1}. ${it.name.trim()}${it.seller ? ` (продавец: ${it.seller.slice(0, 40)})` : ''}`)
      .join('\n');

    let data;
    try {
      ({ data } = await completeJson({ system, user, schema, model, maxTokens: 2000 }));
    } catch (err) {
      failures.push(err.message);
      continue;
    }

    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const row of data.items ?? []) {
        const item = chunk[row.n - 1];
        if (!item) continue;
        insert.run({ name_norm: item.name_norm, category: row.category, now });
        written += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    onBatch?.(Math.floor(offset / FILL_BATCH) + 1, Math.ceil(names.length / FILL_BATCH), written);
  }

  return { written, failures };
}

async function fill(db, { limit, model = 'lite' }) {
  const names = unknownNames(db, limit);
  if (!names.length) {
    console.log('неизвестных названий нет — словарь покрывает всё');
    return;
  }

  const money = names.reduce((a, b) => a + b.money, 0);
  console.log(`к разметке ${names.length} названий (${(money / 100).toFixed(0)} ₽ оборота), модель ${model}`);

  const { written, failures } = await fillNames(db, names, {
    model,
    onBatch: (i, total, done) => process.stderr.write(`  порция ${i}/${total}, записано ${done}
`),
  });

  for (const f of failures) console.error(`\n  порция не разобралась: ${f}`);
  console.log(`\nв словарь записано ${written} названий; ${usageLine()}`);
}

function stats(db) {
  const total = db.prepare('SELECT COUNT(*) c, SUM(sum) s FROM items').get();
  const rows = db
    .prepare(
      `SELECT l.source, COUNT(*) c, SUM(i.sum) s
         FROM item_labels l JOIN items i ON i.id = l.item_id
        GROUP BY l.source ORDER BY c DESC`,
    )
    .all();

  if (!rows.length) return console.log('разметки нет — запустите: node api/src/classify.mjs --apply');

  console.log('чем определились позиции:');
  const titles = {
    manual: 'ручная правка',
    pinned: 'из ручных трат',
    gtin: 'штрихкод',
    rule: 'жёсткое правило',
    dictionary: 'словарь',
    ngram: 'похожее название',
    'rule-fallback': 'запасное правило',
    unknown: 'НЕ ОПРЕДЕЛЕНО',
  };
  for (const row of rows) {
    console.log(
      `  ${(titles[row.source] ?? row.source).padEnd(18)} ${String(row.c).padStart(6)} поз. (${((row.c / total.c) * 100).toFixed(1)}%),` +
        ` ${((row.s / total.s) * 100).toFixed(1)}% денег`,
    );
  }

  const dict = db.prepare('SELECT COUNT(*) c FROM dictionary').get().c;
  const own = db.prepare('SELECT COUNT(*) c, COUNT(DISTINCT user_id) u FROM user_dictionary').get();
  console.log(`\nв общем словаре ${dict} названий; личных правок ${own.c} у ${own.u} польз.`);

  // Группы у каждого свои, поэтому складываем по названию группы
  const top = db
    .prepare(
      `SELECT g.name AS group_name, COUNT(*) n, SUM(i.sum) s
         FROM item_labels l
         JOIN items i      ON i.id = l.item_id
         JOIN categories c ON c.user_id = l.user_id AND c.slug = l.category_slug
         JOIN groups g     ON g.user_id = c.user_id AND g.slug = c.group_slug
        GROUP BY g.name ORDER BY s DESC LIMIT 12`,
    )
    .all();
  if (top.length) {
    console.log('\nрасходы по группам:');
    top.forEach((r) =>
      console.log(`  ${(r.s / 100).toFixed(0).padStart(9)} ₽  ${String(r.n).padStart(6)} поз.  ${r.group_name}`),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const num = (flag, def) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? Number(argv[i + 1]) : def;
  };

  const db = openDb();
  migrate(db);

  if (argv.includes('--fill')) {
    const modelIndex = argv.indexOf('--model');
    await fill(db, { limit: num('--fill', Infinity), model: modelIndex >= 0 ? argv[modelIndex + 1] : 'lite' });
    console.log('\nпересчитываю разметку позиций…');
    const counts = apply(db);
    console.log(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', '));
  } else if (argv.includes('--apply')) {
    const counts = apply(db);
    console.log('разметка пересчитана: ' + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', '));
  } else {
    stats(db);
  }

  db.close();
}
