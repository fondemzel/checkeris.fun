// Золотой набор: выборка названий для замера точности классификатора.
//
//   node api/src/golden.mjs --sample 200   — собрать выборку в api/db/golden.json
//   node api/src/golden.mjs --show         — показать набор с разметкой
//   node api/src/golden.mjs --stats        — сколько размечено, как распределено
//
// Выборка стратифицирована ПО ДЕНЬГАМ, а не по частоте. Если брать по частоте,
// набор забьётся ходовой мелочью (пиво, молоко, пакеты) и ничего не скажет о
// точности там, где лежит оборот: в длинном хвосте разовых дорогих покупок.
//
// Названия делятся на 5 полос, каждая — пятая часть всего оборота: первая полоса
// это несколько десятков дорогих позиций, последняя — тысячи копеечных. Из каждой
// берём поровну. Так набор одинаково хорошо меряет и голову, и хвост.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, migrate, API_ROOT } from './db.mjs';

const GOLDEN_PATH = resolve(API_ROOT, 'db', 'golden.json');
const BANDS = 5;

export function loadGolden(file = GOLDEN_PATH) {
  if (!existsSync(file)) throw new Error(`нет ${file} — соберите набор: node api/src/golden.mjs --sample 200`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Детерминированный псевдослучайный выбор: набор должен воспроизводиться. */
function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(db, size, seed = 42) {
  const names = db
    .prepare(
      `SELECT i.name_norm,
              MIN(i.name) AS name,
              COUNT(*) AS n,
              SUM(i.sum) AS money,
              (SELECT r.seller FROM items x JOIN receipts r ON r.id = x.receipt_id
                WHERE x.name_norm = i.name_norm LIMIT 1) AS seller,
              (SELECT x.gtin FROM items x WHERE x.name_norm = i.name_norm AND x.gtin IS NOT NULL LIMIT 1) AS gtin
         FROM items i
        GROUP BY i.name_norm
        ORDER BY money DESC`,
    )
    .all();

  const total = names.reduce((acc, r) => acc + r.money, 0);
  const perBand = total / BANDS;
  const bands = Array.from({ length: BANDS }, () => []);

  let cumulative = 0;
  for (const row of names) {
    const band = Math.min(BANDS - 1, Math.floor(cumulative / perBand));
    bands[band].push(row);
    cumulative += row.money;
  }

  const random = mulberry32(seed);
  const picked = [];
  const perBandSize = Math.floor(size / BANDS);

  bands.forEach((band, index) => {
    const pool = [...band];
    const take = Math.min(perBandSize, pool.length);
    for (let i = 0; i < take; i++) {
      const j = Math.floor(random() * pool.length);
      const row = pool.splice(j, 1)[0];
      picked.push({
        name: row.name.trim(),
        name_norm: row.name_norm,
        seller: (row.seller ?? '').replace(/ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ|АКЦИОНЕРНОЕ ОБЩЕСТВО/g, '').trim(),
        gtin: row.gtin ?? null,
        count: row.n,
        money: row.money,
        band: index + 1,
        category: null, // заполняется человеком — это эталон
      });
    }
  });

  return {
    version: 1,
    seed,
    comment:
      'Эталонная разметка для замера точности. Выборка стратифицирована по деньгам: 5 полос, каждая = 20% оборота. Поле category заполняется человеком и является истиной для замера.',
    items: picked,
  };
}

function stats(golden) {
  const labelled = golden.items.filter((i) => i.category);
  const money = golden.items.reduce((a, b) => a + b.money, 0);
  const labelledMoney = labelled.reduce((a, b) => a + b.money, 0);
  console.log(`в наборе ${golden.items.length} названий, размечено ${labelled.length}`);
  console.log(`деньги набора: ${(money / 100).toFixed(0)} ₽, из них размечено ${(labelledMoney / 100).toFixed(0)} ₽`);

  for (let band = 1; band <= BANDS; band++) {
    const rows = golden.items.filter((i) => i.band === band);
    const done = rows.filter((i) => i.category).length;
    const avg = rows.reduce((a, b) => a + b.money, 0) / rows.length / 100;
    console.log(`  полоса ${band}: ${rows.length} названий, размечено ${done}, средняя сумма ${avg.toFixed(0)} ₽`);
  }

  if (labelled.length) {
    const byCat = new Map();
    labelled.forEach((i) => byCat.set(i.category, (byCat.get(i.category) ?? 0) + 1));
    console.log('\nраспределение эталона по категориям:');
    [...byCat.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([slug, n]) => console.log(`  ${String(n).padStart(4)}  ${slug}`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const db = openDb();
  migrate(db);

  if (argv.includes('--sample')) {
    const i = argv.indexOf('--sample');
    const size = Number(argv[i + 1]) || 200;
    const golden = sample(db, size);
    writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + '\n');
    console.log(`выборка собрана: ${golden.items.length} названий → api/db/golden.json`);
    stats(golden);
  } else if (argv.includes('--show')) {
    loadGolden().items.forEach((i, n) =>
      console.log(`${String(n + 1).padStart(3)}. [${i.band}] ${(i.category ?? '—').padEnd(22)} ${i.name.slice(0, 44).padEnd(44)} ${(i.money / 100).toFixed(0).padStart(7)} ₽  ${i.seller.slice(0, 24)}`),
    );
  } else {
    stats(loadGolden());
  }

  db.close();
}
