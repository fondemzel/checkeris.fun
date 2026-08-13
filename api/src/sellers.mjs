// Ведение правил по продавцам (api/db/seller_rules.json).
//
// Правило по ИНН — единственный способ определить категорию там, где название
// позиции бесполезно: «Тариф по билету KUP7XEZL6K-1», «Премия по договору
// страхования №8806626746». Таких позиций мало, но это пятая часть оборота.
//
//   node api/src/sellers.mjs             — сводка: покрытие и что осталось
//   node api/src/sellers.mjs --check     — проверить файл правил на ошибки
//   node api/src/sellers.mjs --todo 30   — продавцы без правил, по обороту, с примерами
//   node api/src/sellers.mjs --suggest 20 — предложить правила через LLM (готовые строки JSON)
//
// --suggest ничего не записывает: печатает строки, которые вы вставляете в
// seller_rules.json сами, проверив глазами. Модель ошибается, ИНН — навсегда.
import { pathToFileURL } from 'node:url';
import { openDb, migrate } from './db.mjs';
import { loadCategories, loadSellerRules, flatten } from './categories.mjs';
import { completeJson, usageLine } from './llm.mjs';

const money = (kopecks) => (Number(kopecks ?? 0) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 0 });

/** Продавцы без правил, по убыванию оборота, с самыми частыми позициями. */
function pending(db, limit) {
  const sellers = db
    .prepare(
      `SELECT r.seller_inn AS inn, MIN(r.seller) AS seller, MIN(r.retail_place) AS place,
              COUNT(*) AS receipts, SUM(r.total_sum) AS turnover
         FROM receipts r
         LEFT JOIN seller_rules sr ON sr.seller_inn = r.seller_inn
        WHERE sr.seller_inn IS NULL
        GROUP BY r.seller_inn
        ORDER BY turnover DESC
        LIMIT ?`,
    )
    .all(limit);

  const topItems = db.prepare(
    `SELECT i.name FROM items i JOIN receipts r ON r.id = i.receipt_id
      WHERE r.seller_inn = ? GROUP BY i.name_norm ORDER BY COUNT(*) DESC LIMIT 5`,
  );

  return sellers.map((s) => ({ ...s, items: topItems.all(s.inn).map((r) => r.name.trim()) }));
}

function coverage(db) {
  const total = db.prepare('SELECT COUNT(*) c, SUM(sum) s FROM items').get();
  const byMode = db
    .prepare(
      `SELECT sr.mode, COUNT(*) c, SUM(i.sum) s
         FROM items i
         JOIN receipts r ON r.id = i.receipt_id
         JOIN seller_rules sr ON sr.seller_inn = r.seller_inn
        GROUP BY sr.mode`,
    )
    .all();
  const none = db
    .prepare(
      `SELECT COUNT(*) c, SUM(i.sum) s
         FROM items i
         JOIN receipts r ON r.id = i.receipt_id
         LEFT JOIN seller_rules sr ON sr.seller_inn = r.seller_inn
        WHERE sr.seller_inn IS NULL`,
    )
    .get();
  return { total, byMode, none };
}

/** Проверки файла правил: битые ссылки, дубли, правила на продавцов, которых нет в базе. */
function check(db, rules) {
  const categories = new Set(db.prepare('SELECT slug FROM categories').all().map((r) => r.slug));
  const problems = [];

  const seen = new Set();
  for (const rule of rules.rules) {
    if (!categories.has(rule.category)) problems.push(`неизвестная категория: ${rule.inn} → ${rule.category}`);
    if (!['always', 'fallback'].includes(rule.mode ?? 'fallback')) problems.push(`неизвестный режим: ${rule.inn} → ${rule.mode}`);
    if (seen.has(rule.inn)) problems.push(`дубль ИНН: ${rule.inn}`);
    seen.add(rule.inn);
  }

  const inBase = new Set(db.prepare('SELECT DISTINCT seller_inn FROM receipts').all().map((r) => r.seller_inn));
  const unused = rules.rules.filter((r) => !inBase.has(r.inn));
  return { problems, unused };
}

/** Предложить правила для непокрытых продавцов. Печатает строки для вставки в файл. */
async function suggest(db, limit) {
  const catalog = loadCategories();
  const slugs = flatten(catalog).map((c) => c.slug);
  const taxonomy = catalog.groups
    .map((g) => `${g.name}:\n${g.subcategories.map((s) => `  ${s.slug} — ${s.name}: ${s.hint}`).join('\n')}`)
    .join('\n');

  const sellers = pending(db, limit);
  if (!sellers.length) {
    console.log('все продавцы из базы уже покрыты правилами');
    return;
  }

  const system = `Ты размечаешь продавцов из кассовых чеков: по названию организации, торговой точке и типичным позициям определяешь категорию.

СНАЧАЛА реши режим — это важнее самой категории:

  skip     — у продавца может продаваться ЧТО УГОДНО и предсказать категорию нельзя.
             Это маркетплейсы (Ozon / «Интернет решения», Wildberries / «РВБ» / «Вайлдберриз»,
             Яндекс Маркет, СберМегаМаркет) и универсальные интернет-магазины.
             Для них правило вредно: оно будет систематически врать. Категорию всё равно
             укажи любую подходящую — при skip она не используется.
  always   — продавец торгует ровно одной категорией: АЗС, аптека, такси, оператор связи,
             автосервис, фитнес-клуб, страховая, кинотеатр, табачный киоск.
             Правило перекрывает даже разметку по названию позиции.
  fallback — смешанный, но предсказуемый ассортимент: супермаркет, магазин у дома,
             хозяйственный. Правило сработает, только если позицию не определили иначе.

Ориентируйся на торговую точку и примеры позиций: домен вида ozon.ru или wildberries.ru —
почти всегда skip, адрес магазина — always или fallback.

Категории:
${taxonomy}`;

  const list = sellers
    .map(
      (s, i) =>
        `${i + 1}. ${s.seller} | точка: ${s.place ?? '—'} | оборот ${money(s.turnover)} ₽ за ${s.receipts} чек.\n   позиции: ${s.items.join(' / ') || '—'}`,
    )
    .join('\n');

  const schema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer' },
            category: { type: 'string', enum: slugs },
            mode: { type: 'string', enum: ['always', 'fallback', 'skip'] },
          },
          required: ['n', 'category', 'mode'],
        },
      },
    },
    required: ['items'],
  };

  const { data } = await completeJson({ system, user: list, schema, maxTokens: 4000 });
  const byIndex = new Map((data.items ?? []).map((r) => [r.n, r]));

  console.log('// проверьте глазами и вставьте нужное в api/db/seller_rules.json\n');
  sellers.forEach((s, i) => {
    const r = byIndex.get(i + 1);
    if (!r) return console.log(`// ${s.seller} — модель не ответила`);
    if (r.mode === 'skip') return console.log(`// ${s.seller} — ассортимент любой, правило не нужно`);
    const note = `${s.seller.replace(/ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ|АКЦИОНЕРНОЕ ОБЩЕСТВО/g, '').trim().slice(0, 40)}`;
    console.log(
      `{ "inn": "${s.inn}", "category": "${r.category}", "mode": "${r.mode}", "note": "${note.replace(/"/g, "'")}" },` +
        `   // оборот ${money(s.turnover)} ₽ · ${s.items[0]?.slice(0, 34) ?? ''}`,
    );
  });
  console.log(`\n// ${usageLine()}`);
}

function summary(db) {
  const { total, byMode, none } = coverage(db);
  const pct = (c, s) => `${((c / total.c) * 100).toFixed(1)}% позиций, ${((s / total.s) * 100).toFixed(1)}% денег`;

  console.log('покрытие правилами по продавцам:');
  for (const mode of ['always', 'fallback']) {
    const row = byMode.find((r) => r.mode === mode) ?? { c: 0, s: 0 };
    console.log(`  ${mode.padEnd(9)} ${pct(row.c, row.s)}`);
  }
  console.log(`  без правил ${pct(none.c, none.s)}`);

  const rest = pending(db, 5);
  if (rest.length) {
    console.log('\nкрупнейшие продавцы без правил:');
    rest.forEach((s) => console.log(`  ${money(s.turnover).padStart(9)} ₽  ${s.seller.slice(0, 44)}`));
    console.log('\n  node api/src/sellers.mjs --todo 30      посмотреть список с примерами позиций');
    console.log('  node api/src/sellers.mjs --suggest 20   предложить правила через LLM');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const num = (flag, def) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? Number(argv[i + 1]) || def : def;
  };

  const db = openDb();
  migrate(db);

  if (argv.includes('--check')) {
    const { problems, unused } = check(db, loadSellerRules());
    if (problems.length) {
      console.log('ошибки в seller_rules.json:');
      problems.forEach((p) => console.log('  ' + p));
    } else {
      console.log('ошибок в файле правил нет');
    }
    if (unused.length) {
      console.log(`\nправила на продавцов, которых нет в базе (${unused.length}) — не ошибка, просто ещё не встречались:`);
      unused.forEach((r) => console.log(`  ${r.inn}  ${r.note ?? ''}`));
    }
  } else if (argv.includes('--todo')) {
    const rows = pending(db, num('--todo', 30));
    rows.forEach((s) => {
      console.log(`\n${money(s.turnover)} ₽ · ${s.receipts} чек. · ИНН ${s.inn}`);
      console.log(`  ${s.seller}`);
      console.log(`  точка: ${s.place ?? '—'}`);
      console.log(`  позиции: ${s.items.join(' / ') || '—'}`);
    });
    console.log(`\nвсего показано ${rows.length}`);
  } else if (argv.includes('--suggest')) {
    await suggest(db, num('--suggest', 20));
  } else {
    summary(db);
  }

  db.close();
}
