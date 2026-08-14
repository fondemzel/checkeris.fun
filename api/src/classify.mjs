// Конвейер классификации позиций.
//
//   node api/src/classify.mjs --fill    — разметить неизвестные названия моделью (пишет в словарь)
//   node api/src/classify.mjs --apply   — пересчитать категории всех позиций
//   node api/src/classify.mjs --stats   — что чем определилось
//
// Ступени идут от самого надёжного к самому дорогому. Первая сработавшая
// побеждает — это и есть весь алгоритм:
//
//   1. ручная правка   — решение пользователя, отменить его не может ничто
//   2. GTIN            — штрихкод: тот же код = тот же товар, ошибок не бывает
//   3. жёсткое правило — продавец торгует одним («Тариф по билету» у авиаагентства)
//   4. словарь         — точное совпадение нормализованного названия
//   5. похожее         — символьные триграммы: «мандарины абхаз вес» ~ «мандарины вес»
//   6. запасное правило— супермаркет: если иначе не определилось, это еда
//
// Модель в этот список не входит: она работает офлайн (--fill) и наполняет
// словарь. В момент показа чека пользователю обращений к модели нет — только
// запросы к таблицам, то есть миллисекунды.
import { pathToFileURL } from 'node:url';
import { openDb, migrate } from './db.mjs';
import { loadCategories, flatten } from './categories.mjs';
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

/** Индекс похожих названий по словарю. Строится один раз на прогон. */
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

function loadTables(db) {
  const dict = new Map();
  const manual = new Map();
  for (const row of db.prepare('SELECT name_norm, category_slug, source FROM dictionary').all()) {
    dict.set(row.name_norm, row.category_slug);
    if (row.source === 'manual') manual.set(row.name_norm, row.category_slug);
  }

  const gtin = new Map(db.prepare('SELECT gtin, category_slug FROM gtin_map').all().map((r) => [r.gtin, r.category_slug]));
  const always = new Map();
  const fallback = new Map();
  for (const row of db.prepare('SELECT seller_inn, category_slug, mode FROM seller_rules').all()) {
    (row.mode === 'always' ? always : fallback).set(row.seller_inn, row.category_slug);
  }
  return { dict, manual, gtin, always, fallback };
}

/** Одна позиция → категория и то, чем она определилась. */
export function resolve(item, tables, nearest) {
  const manual = tables.manual.get(item.name_norm);
  if (manual) return { category: manual, source: 'manual', confidence: 1 };

  const byGtin = item.gtin && tables.gtin.get(item.gtin);
  if (byGtin) return { category: byGtin, source: 'gtin', confidence: 1 };

  const byRule = tables.always.get(item.seller_inn);
  if (byRule) return { category: byRule, source: 'rule', confidence: 0.95 };

  const byDict = tables.dict.get(item.name_norm);
  if (byDict) return { category: byDict, source: 'dictionary', confidence: 0.9 };

  const similar = nearest(item.name_norm);
  if (similar) return { category: similar.category, source: 'ngram', confidence: similar.similarity };

  const byFallback = tables.fallback.get(item.seller_inn);
  if (byFallback) return { category: byFallback, source: 'rule-fallback', confidence: 0.5 };

  return { category: null, source: 'unknown', confidence: 0 };
}

/**
 * Пересчёт разметки всех позиций. Таблица item_labels производная, её не жалко —
 * кроме закреплённых меток: у ручных трат категория пришла из данных, а не выведена
 * из названия, и восстановить её пересчётом невозможно.
 */
function apply(db) {
  const tables = loadTables(db);
  const nearest = buildNeighbourIndex(db);
  const items = db
    .prepare(
      `SELECT v.id, v.name_norm, v.gtin, v.seller_inn
         FROM v_item_categories v
         LEFT JOIN item_labels l ON l.item_id = v.id
        WHERE l.source IS NULL OR l.source <> 'pinned'`,
    )
    .all();

  const upsert = db.prepare(`
    INSERT INTO item_labels (item_id, category_slug, source, confidence, updated_at)
    VALUES (:id, :category, :source, :confidence, :now)
    ON CONFLICT (item_id) DO UPDATE SET
      category_slug = :category, source = :source, confidence = :confidence, updated_at = :now`);

  const now = new Date().toISOString();
  const counts = {};
  db.exec('BEGIN');
  try {
    for (const item of items) {
      const { category, source, confidence } = resolve(item, tables, nearest);
      upsert.run({ id: item.id, category, source, confidence, now });
      counts[source] = (counts[source] ?? 0) + 1;
    }
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

/** Названия, которые не берёт ни одна дешёвая ступень — их и отдаём модели. */
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

async function fill(db, { limit, model = 'lite' }) {
  const names = unknownNames(db, limit);
  if (!names.length) {
    console.log('неизвестных названий нет — словарь покрывает всё');
    return;
  }

  const catalog = loadCategories();
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

  const money = names.reduce((a, b) => a + b.money, 0);
  console.log(`к разметке ${names.length} названий (${(money / 100).toFixed(0)} ₽ оборота), модель ${model}`);

  let written = 0;
  for (let offset = 0; offset < names.length; offset += FILL_BATCH) {
    const chunk = names.slice(offset, offset + FILL_BATCH);
    const user = chunk
      .map((it, i) => `${i + 1}. ${it.name.trim()}${it.seller ? ` (продавец: ${it.seller.slice(0, 40)})` : ''}`)
      .join('\n');

    let data;
    try {
      ({ data } = await completeJson({ system, user, schema, model, maxTokens: 2000 }));
    } catch (err) {
      console.error(`\n  порция ${offset / FILL_BATCH + 1}: ${err.message}`);
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

    process.stderr.write(`  порция ${Math.floor(offset / FILL_BATCH) + 1}/${Math.ceil(names.length / FILL_BATCH)}, записано ${written}\r`);
  }

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
  console.log(`\nв словаре ${dict} названий`);

  const top = db
    .prepare(
      `SELECT g.name AS group_name, COUNT(*) n, SUM(i.sum) s
         FROM item_labels l
         JOIN items i      ON i.id = l.item_id
         JOIN categories c ON c.slug = l.category_slug
         JOIN groups g     ON g.slug = c.group_slug
        GROUP BY c.group_slug ORDER BY s DESC LIMIT 12`,
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
