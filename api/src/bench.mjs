// Замер точности классификатора на золотом наборе.
//
//   node api/src/bench.mjs                 — прогнать модель по умолчанию (lite)
//   node api/src/bench.mjs --model pro     — то же на yandexgpt
//   node api/src/bench.mjs --errors        — показать все расхождения с эталоном
//
// Считаются две точности сразу, и они не совпадают:
//   по позициям — доля верно определённых названий;
//   по деньгам  — доля верно определённого оборота.
// Вторая важнее: треть денег живёт в длинном хвосте разовых покупок, и модель,
// уверенно раскладывающая пиво, может ошибаться ровно там, где лежат суммы.
import { pathToFileURL } from 'node:url';
import { openDb, migrate } from './db.mjs';
import { loadCategories, flatten } from './categories.mjs';
import { loadGolden } from './golden.mjs';
import { completeJson, usage, usageLine } from './llm.mjs';

const BATCH = 40;

/** Промпт собирается из справочника: правим categories.json — меняется и промпт. */
export function buildPrompt(catalog) {
  const taxonomy = catalog.groups
    .map((g) => `${g.name}:\n${g.subcategories.map((s) => `  ${s.slug} — ${s.name}: ${s.hint}`).join('\n')}`)
    .join('\n');

  return `Ты классифицируешь позиции из кассовых чеков по справочнику категорий.

Названия обрезаны кассой, написаны сокращённо и в верхнем регистре — опирайся на бренд,
тип товара и продавца. Продавец указан в скобках и часто решает дело: «Тариф по билету»
у авиаагентства — это транспорт, а не развлечение.

Отвечай для каждой позиции её номером и slug'ом категории строго из списка ниже.

${taxonomy}`;
}

const buildSchema = (slugs) => ({
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          category: { type: 'string', enum: slugs },
        },
        required: ['n', 'category'],
      },
    },
  },
  required: ['items'],
});

export async function classify(items, { model = 'lite' } = {}) {
  const catalog = loadCategories();
  const slugs = flatten(catalog).map((c) => c.slug);
  const system = buildPrompt(catalog);
  const schema = buildSchema(slugs);
  const result = new Map();

  for (let offset = 0; offset < items.length; offset += BATCH) {
    const chunk = items.slice(offset, offset + BATCH);
    const user = chunk
      .map((it, i) => `${i + 1}. ${it.name}${it.seller ? ` (продавец: ${it.seller})` : ''}`)
      .join('\n');

    const { data } = await completeJson({ system, user, schema, model, maxTokens: 2000 })
      .catch(async (err) => {
        console.error(`  порция ${offset / BATCH + 1}: ${err.message}`);
        return { data: { items: [] } };
      });

    for (const row of data.items ?? []) {
      const item = chunk[row.n - 1];
      if (item) result.set(item.name_norm, row.category);
    }
    process.stderr.write(`  порция ${offset / BATCH + 1}/${Math.ceil(items.length / BATCH)}\r`);
  }

  return result;
}

/**
 * Жёсткое правило по продавцу перекрывает ответ модели. Меряем это отдельно:
 * модель в вакууме выглядит хуже, чем система целиком, а решение принимать
 * надо по системе.
 */
function applyRules(db, predicted) {
  const rules = new Map(
    db.prepare(`SELECT seller_inn, category_slug FROM seller_rules WHERE mode = 'always'`).all().map((r) => [r.seller_inn, r.category_slug]),
  );
  const sellerOf = new Map(
    db
      .prepare(
        `SELECT name_norm, seller_inn FROM (
           SELECT name_norm, seller_inn, COUNT(*) n FROM v_items GROUP BY name_norm, seller_inn ORDER BY n DESC
         ) GROUP BY name_norm`,
      )
      .all()
      .map((r) => [r.name_norm, r.seller_inn]),
  );

  const withRules = new Map(predicted);
  let overridden = 0;
  for (const [nameNorm] of predicted) {
    const rule = rules.get(sellerOf.get(nameNorm));
    if (rule && rule !== predicted.get(nameNorm)) {
      withRules.set(nameNorm, rule);
      overridden += 1;
    }
  }
  return { withRules, overridden };
}

function score(items, predicted) {
  const rows = items.map((it) => ({ ...it, predicted: predicted.get(it.name_norm) ?? null }));
  const money = rows.reduce((a, b) => a + b.money, 0);
  const ok = rows.filter((r) => r.predicted === r.category);
  return {
    count: ok.length,
    total: rows.length,
    money: ok.reduce((a, b) => a + b.money, 0) / money,
  };
}

function report(golden, predicted, showErrors) {
  const rows = golden.items.map((it) => ({
    ...it,
    predicted: predicted.get(it.name_norm) ?? null,
    ok: predicted.get(it.name_norm) === it.category,
  }));

  const money = rows.reduce((a, b) => a + b.money, 0);
  const okMoney = rows.filter((r) => r.ok).reduce((a, b) => a + b.money, 0);
  const okCount = rows.filter((r) => r.ok).length;
  const missing = rows.filter((r) => !r.predicted).length;

  // Группа — более мягкая метрика: «Обувь вместо Одежды» дешевле, чем «Еда вместо Налогов»
  const group = (slug) => (slug ?? '').split('.')[0];
  const okGroup = rows.filter((r) => r.predicted && group(r.predicted) === group(r.category)).length;

  console.log(`\nточность по позициям: ${okCount}/${rows.length} = ${((okCount / rows.length) * 100).toFixed(1)}%`);
  console.log(`точность по группам:  ${okGroup}/${rows.length} = ${((okGroup / rows.length) * 100).toFixed(1)}%`);
  console.log(`точность по деньгам:  ${((okMoney / money) * 100).toFixed(1)}%`);
  if (missing) console.log(`без ответа модели:    ${missing}`);

  console.log('\nпо полосам (1 — дорогие позиции, 5 — копеечные):');
  for (let band = 1; band <= 5; band++) {
    const inBand = rows.filter((r) => r.band === band);
    if (!inBand.length) continue;
    const ok = inBand.filter((r) => r.ok).length;
    console.log(`  полоса ${band}: ${String(ok).padStart(2)}/${String(inBand.length).padEnd(3)} ${((ok / inBand.length) * 100).toFixed(0)}%`);
  }

  const errors = rows.filter((r) => !r.ok);
  if (errors.length) {
    console.log(`\nчастые ошибки (эталон → модель):`);
    const pairs = new Map();
    errors.forEach((r) => {
      const key = `${r.category} → ${r.predicted ?? 'нет ответа'}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    });
    [...pairs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .forEach(([pair, n]) => console.log(`  ${String(n).padStart(3)}  ${pair}`));
  }

  if (showErrors) {
    console.log('\nвсе расхождения:');
    errors
      .sort((a, b) => b.money - a.money)
      .forEach((r) =>
        console.log(
          `  ${(r.money / 100).toFixed(0).padStart(7)} ₽  ${r.name.slice(0, 42).padEnd(42)} эталон ${r.category.padEnd(22)} модель ${r.predicted ?? '—'}`,
        ),
      );
  }

  return { okCount, okGroup, okMoney, money, total: rows.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const modelIndex = argv.indexOf('--model');
  const model = modelIndex >= 0 ? argv[modelIndex + 1] : 'lite';

  const db = openDb();
  migrate(db);
  const golden = loadGolden();
  const labelled = golden.items.filter((i) => i.category);
  if (labelled.length < golden.items.length) {
    console.log(`внимание: размечено ${labelled.length} из ${golden.items.length}, замер только по размеченным`);
  }

  console.log(`модель: yandexgpt-${model === 'pro' ? 'pro' : 'lite'}, позиций: ${labelled.length}`);
  const started = Date.now();
  const predicted = await classify(labelled, { model });
  report({ items: labelled }, predicted, argv.includes('--errors'));

  const { withRules, overridden } = applyRules(db, predicted);
  const before = score(labelled, predicted);
  const after = score(labelled, withRules);
  console.log(`\nс жёсткими правилами по продавцу (перекрыто ответов: ${overridden}):`);
  console.log(
    `  по позициям ${((before.count / before.total) * 100).toFixed(1)}% → ${((after.count / after.total) * 100).toFixed(1)}%,` +
      `  по деньгам ${(before.money * 100).toFixed(1)}% → ${(after.money * 100).toFixed(1)}%`,
  );
  console.log(`\n${usageLine()}, время ${((Date.now() - started) / 1000).toFixed(0)}с`);

  db.close();
}
