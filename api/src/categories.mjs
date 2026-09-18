// Системный справочник категорий: файл ↔ база. Инструмент администратора.
//
// Системный справочник — язык общего знания (словарь, штрихкоды, правила продавцов,
// промпт модели) и шаблон, который копируется каждому новому пользователю. Личные
// справочники пользователей живут отдельно (taxonomy.mjs) и отсюда не меняются.
//
// ИСТОЧНИК ПРАВДЫ — БАЗА (sys_groups, sys_categories). categories.json — начальное
// наполнение пустой базы и способ держать справочник в истории git.
//
//   node api/src/categories.mjs --show              — что сейчас в системном справочнике
//   node api/src/categories.mjs --check             — проверить файл, ничего не меняя
//   node api/src/categories.mjs --export            — база → файл, чтобы закоммитить
//   node api/src/categories.mjs --sync              — файл → база
//   node api/src/categories.mjs --from-user <логин> — личный справочник → системный
//
// Про поля:
//   name — подпись в интерфейсе, меняется свободно: разметка держится на slug.
//   hint — подсказка модели, из неё собирается промпт классификации.
//   slug — ключ. На него ссылаются словарь, правила по продавцам, штрихкоды и разметка.
//          Неизменен. Группу задаёт group_slug, а не префикс slug'а: категорию переносят
//          между группами, и slug при этом остаётся прежним.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, migrate, API_ROOT } from './db.mjs';

const CATEGORIES_PATH = resolve(API_ROOT, 'db', 'categories.json');
const SELLER_RULES_PATH = resolve(API_ROOT, 'db', 'seller_rules.json');

export function loadCategories(file = CATEGORIES_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadSellerRules(file = SELLER_RULES_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Правила по ИНН продавца. Ссылки на несуществующие категории — ошибка файла, не молчим. */
export function syncSellerRules(db, catalog) {
  const known = new Set(db.prepare('SELECT slug FROM sys_categories').all().map((r) => r.slug));
  const bad = catalog.rules.filter((r) => !known.has(r.category));
  if (bad.length) {
    throw new Error(`неизвестные категории в seller_rules.json: ${bad.map((r) => `${r.inn}→${r.category}`).join(', ')}`);
  }

  const upsert = db.prepare(`
    INSERT INTO seller_rules (seller_inn, category_slug, mode, note, updated_at)
    VALUES (:inn, :category, :mode, :note, :now)
    ON CONFLICT (seller_inn) DO UPDATE SET
      category_slug = :category, mode = :mode, note = :note, updated_at = :now`);

  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const r of catalog.rules) {
      upsert.run({ inn: r.inn, category: r.category, mode: r.mode ?? 'fallback', note: r.note ?? null, now });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const always = catalog.rules.filter((r) => r.mode === 'always').length;
  return { total: catalog.rules.length, always, fallback: catalog.rules.length - always };
}

/** Плоский список подкатегорий с контекстом группы — в этом виде их удобно и хранить, и класть в промпт. */
export function flatten(catalog) {
  const rows = [];
  catalog.groups.forEach((group, gi) => {
    group.subcategories.forEach((sub, si) => {
      rows.push({
        slug: sub.slug,
        group_slug: group.slug,
        group_name: group.name,
        name: sub.name,
        hint: sub.hint ?? null,
        sort: gi * 100 + si,
      });
    });
  });
  return rows;
}

/** Группы отдельным списком: они самостоятельные записи, а не свойства категорий. */
export function flattenGroups(catalog) {
  return catalog.groups.map((group, gi) => ({
    slug: group.slug,
    name: group.name,
    icon: group.icon ?? null,
    color: group.color ?? null,
    sort: gi * 100,
  }));
}

/** Справочник из базы в том же виде, в каком лежит в файле — для --export. */
export function dumpCatalog(db) {
  const groups = db.prepare('SELECT slug, name, icon, color FROM sys_groups ORDER BY sort, slug').all();
  const cats = db.prepare('SELECT slug, group_slug, name, hint FROM sys_categories ORDER BY sort, slug').all();
  return {
    groups: groups.map((g) => ({
      slug: g.slug,
      name: g.name,
      icon: g.icon ?? undefined,
      color: g.color ?? undefined,
      subcategories: cats
        .filter((c) => c.group_slug === g.slug)
        .map((c) => ({ slug: c.slug, name: c.name, hint: c.hint ?? undefined })),
    })),
  };
}

/**
 * Проверка файла до записи в базу. Опечатка в справочнике тише всего ломает
 * именно разметку: категория «есть», но не та, и заметить это можно через месяц.
 */
export function validate(catalog) {
  const problems = [];
  if (!Array.isArray(catalog.groups) || !catalog.groups.length) {
    problems.push('в файле нет групп (ожидается массив groups)');
    return problems;
  }

  const slugs = new Set();
  const groupSlugs = new Set();

  for (const group of catalog.groups) {
    const where = `группа «${group.name ?? group.slug ?? '?'}»`;
    if (!group.slug) problems.push(`${where}: нет slug`);
    if (!group.name) problems.push(`${where}: нет name`);
    if (group.slug && groupSlugs.has(group.slug)) problems.push(`${where}: slug «${group.slug}» повторяется`);
    if (group.slug) groupSlugs.add(group.slug);
    if (group.slug && !/^[a-z][a-z0-9_]*$/.test(group.slug)) {
      problems.push(`${where}: slug «${group.slug}» — только латиница в нижнем регистре`);
    }
    if (!Array.isArray(group.subcategories) || !group.subcategories.length) {
      problems.push(`${where}: нет подкатегорий`);
      continue;
    }

    for (const sub of group.subcategories) {
      const what = `${where}, подкатегория «${sub.name ?? sub.slug ?? '?'}»`;
      if (!sub.slug) problems.push(`${what}: нет slug`);
      if (!sub.name) problems.push(`${what}: нет name`);
      if (!sub.hint) problems.push(`${what}: нет hint — модель будет угадывать по одному названию`);
      if (sub.slug && slugs.has(sub.slug)) problems.push(`${what}: slug «${sub.slug}» повторяется`);
      if (sub.slug) slugs.add(sub.slug);
      // Префикс slug'а группу больше не задаёт: категорию можно перенести, а slug неизменен.
      // Требуем только формат — иначе опечатка вроде пробела всплывёт лишь в разметке.
      if (sub.slug && !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(sub.slug)) {
        problems.push(`${what}: slug «${sub.slug}» — только латиница в нижнем регистре, цифры, _ и .`);
      }
    }
  }

  return problems;
}

/** Что осиротеет, если категорию убрать из файла. */
export function orphanUsage(db, slug) {
  const count = (sql) => db.prepare(sql).get(slug).c;
  return {
    dictionary: count('SELECT COUNT(*) c FROM dictionary WHERE category_slug = ?'),
    users: count('SELECT COUNT(*) c FROM category_links WHERE sys_slug = ?'),
    sellers: count('SELECT COUNT(*) c FROM seller_rules WHERE category_slug = ?'),
    gtin: count('SELECT COUNT(*) c FROM gtin_map WHERE category_slug = ?'),
  };
}

export function syncCategories(db, catalog) {
  const problems = validate(catalog);
  if (problems.length) {
    throw new Error(`справочник не прошёл проверку:\n  ${problems.join('\n  ')}`);
  }

  const rows = flatten(catalog);
  const upsertGroup = db.prepare(`
    INSERT INTO sys_groups (slug, name, icon, color, sort)
    VALUES (:slug, :name, :icon, :color, :sort)
    ON CONFLICT (slug) DO UPDATE SET
      name = :name, icon = :icon, color = :color, sort = :sort`);

  const upsert = db.prepare(`
    INSERT INTO sys_categories (slug, group_slug, name, hint, sort)
    VALUES (:slug, :group_slug, :name, :hint, :sort)
    ON CONFLICT (slug) DO UPDATE SET
      group_slug = :group_slug, name = :name, hint = :hint, sort = :sort`);

  db.exec('BEGIN');
  try {
    for (const group of flattenGroups(catalog)) upsertGroup.run(group);
    for (const { group_name, ...row } of rows) upsert.run(row);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const known = new Set(rows.map((r) => r.slug));
  const orphans = db
    .prepare('SELECT slug FROM sys_categories')
    .all()
    .map((r) => r.slug)
    .filter((slug) => !known.has(slug));

  return { total: rows.length, groups: catalog.groups.length, orphans };
}

function show(db) {
  const rows = db
    .prepare(
      `SELECT g.name AS group_name, c.name, c.slug, c.fallback_slug,
              (SELECT COUNT(*) FROM dictionary d WHERE d.category_slug = c.slug) AS dict,
              (SELECT COUNT(*) FROM category_links k WHERE k.sys_slug = c.slug) AS users
         FROM sys_categories c JOIN sys_groups g ON g.slug = c.group_slug
        ORDER BY g.sort, c.sort`,
    )
    .all();

  let group = null;
  for (const r of rows) {
    if (r.group_name !== group) {
      group = r.group_name;
      console.log(`\n${group}`);
    }
    const stats = `  словарь: ${r.dict}, пользователей: ${r.users}${r.fallback_slug ? `, запасная: ${r.fallback_slug}` : ''}`;
    console.log(`  ${r.name.padEnd(38)} ${r.slug.padEnd(26)}${stats}`);
  }
  console.log(`\nвсего подкатегорий: ${rows.length}`);
}

/**
 * Личный справочник → системный. Так администратор улучшает шаблон и язык модели,
 * работая в обычном разделе «Категории» кабинета.
 *
 * Что переносится: названия, значки, цвета, порядок, группа категорий — для категорий,
 * связанных с системными один к одному. Категории, созданные пользователем, становятся
 * системными с тем же кодом, и связь у этого пользователя проставляется сразу.
 * Что не переносится: удаления. Системную категорию убрать нельзя — на неё ссылается
 * общее знание и справочники других пользователей; такие случаи печатаются.
 */
export function publishFromUser(db, userId) {
  const groups = db.prepare('SELECT slug, name, icon, color, shade_from, shade_to, sort FROM groups WHERE user_id = ?').all(userId);
  const cats = db.prepare('SELECT slug, group_slug, name, hint, sort FROM categories WHERE user_id = ?').all(userId);
  const linkedTo = new Map(
    db.prepare('SELECT sys_slug, slug FROM category_links WHERE user_id = ?').all(userId).map((r) => [r.sys_slug, r.slug]),
  );
  const sysSlugs = new Set(db.prepare('SELECT slug FROM sys_categories').all().map((r) => r.slug));

  const report = { groups: 0, updated: 0, added: [], merged: [], skipped: [] };
  const upsertGroup = db.prepare(`
    INSERT INTO sys_groups (slug, name, icon, color, shade_from, shade_to, sort)
    VALUES (:slug, :name, :icon, :color, :shade_from, :shade_to, :sort)
    ON CONFLICT (slug) DO UPDATE SET name = :name, icon = :icon, color = :color,
      shade_from = :shade_from, shade_to = :shade_to, sort = :sort`);
  const updateCat = db.prepare('UPDATE sys_categories SET group_slug = ?, name = ?, hint = ?, sort = ? WHERE slug = ?');
  const insertCat = db.prepare('INSERT INTO sys_categories (slug, group_slug, name, hint, sort) VALUES (?, ?, ?, ?, ?)');
  const link = db.prepare('INSERT OR REPLACE INTO category_links (user_id, sys_slug, slug) VALUES (?, ?, ?)');

  db.exec('BEGIN');
  try {
    for (const g of groups) {
      upsertGroup.run(g);
      report.groups += 1;
    }
    for (const c of cats) {
      if (linkedTo.get(c.slug) === c.slug) {
        updateCat.run(c.group_slug, c.name, c.hint, c.sort, c.slug);
        report.updated += 1;
      } else if (!sysSlugs.has(c.slug)) {
        insertCat.run(c.slug, c.group_slug, c.name, c.hint, c.sort);
        link.run(userId, c.slug, c.slug);
        report.added.push(c.name);
      } else {
        // Код занят системной категорией, которая у пользователя ведёт в другое место
        report.skipped.push(`${c.name} (${c.slug})`);
      }
    }
    // Системные категории, которые пользователь слил в другие
    for (const [sys, slug] of linkedTo) {
      if (sys !== slug) report.merged.push(`${sys} → ${slug}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return report;
}

const usage = () =>
  [
    'Системный справочник категорий — шаблон для новых пользователей и язык модели.',
    '',
    '  --show               что сейчас в базе',
    '  --check              проверить categories.json, ничего не меняя',
    '  --export             база → файл (закоммитить)',
    '  --sync               файл → база',
    '  --from-user <логин>  личный справочник пользователя → системный',
  ].join('\n');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb();
  migrate(db);

  if (process.argv.includes('--check')) {
    const catalog = loadCategories();
    const problems = validate(catalog);
    if (problems.length) {
      console.log('в categories.json есть ошибки:');
      problems.forEach((p) => console.log('  ' + p));
      process.exitCode = 1;
    } else {
      const rows = flatten(catalog);
      console.log(`файл в порядке: ${catalog.groups.length} групп, ${rows.length} подкатегорий`);

      // Что в базе есть, а в файле уже нет — покажем цену удаления
      const known = new Set(rows.map((r) => r.slug));
      const orphans = db
        .prepare('SELECT slug, name FROM sys_categories')
        .all()
        .filter((r) => !known.has(r.slug));
      if (orphans.length) {
        console.log('\nв файле больше нет, но в базе используется:');
        for (const o of orphans) {
          const use = orphanUsage(db, o.slug);
          console.log(
            `  ${o.slug} («${o.name}»): словарь ${use.dictionary}, пользователей ${use.users},` +
              ` правил ${use.sellers}, штрихкодов ${use.gtin}`,
          );
        }
        console.log('  прогон скрипта их не удалит — разберите вручную');
      }
    }
  } else if (process.argv.includes('--show')) {
    show(db);
  } else if (process.argv.includes('--from-user')) {
    const login = process.argv[process.argv.indexOf('--from-user') + 1];
    const user = db.prepare('SELECT id, login FROM users WHERE login = ?').get(String(login ?? ''));
    if (!user) {
      console.log(`нет пользователя «${login ?? ''}»`);
      process.exitCode = 1;
    } else {
      const r = publishFromUser(db, user.id);
      console.log(`из справочника «${user.login}» в системный: групп ${r.groups}, категорий обновлено ${r.updated}`);
      if (r.added.length) console.log(`  новые системные категории: ${r.added.join(', ')}`);
      if (r.merged.length) console.log(`  у пользователя слиты (в системном остались): ${r.merged.join(', ')}`);
      if (r.skipped.length) console.log(`  пропущены — код занят другой системной категорией: ${r.skipped.join(', ')}`);
      console.log('новые пользователи получат этот справочник; модель размечает уже в нём');
    }
  } else if (process.argv.includes('--export')) {
    // База → файл. Правки из кабинета живут в базе, в репозиторий их приносит эта команда.
    const catalog = dumpCatalog(db);
    const existing = JSON.parse(readFileSync(CATEGORIES_PATH, 'utf8'));
    const next = { ...existing, groups: catalog.groups };
    writeFileSync(CATEGORIES_PATH, `${JSON.stringify(next, null, 2)}\n`);
    const subs = catalog.groups.reduce((n, g) => n + g.subcategories.length, 0);
    console.log(`выгружено в ${CATEGORIES_PATH}: ${catalog.groups.length} групп, ${subs} подкатегорий`);
    console.log('проверьте git diff и закоммитьте');
  } else if (process.argv.includes('--sync')) {
    const { total, groups, orphans } = syncCategories(db, loadCategories());
    console.log(`справочник загружен: ${groups} групп, ${total} подкатегорий`);

    const rules = syncSellerRules(db, loadSellerRules());
    console.log(`правила по продавцам: ${rules.total} (жёстких ${rules.always}, запасных ${rules.fallback})`);
    if (orphans.length) {
      console.log(`\nв базе остались категории, которых больше нет в файле: ${orphans.join(', ')}`);
      console.log('они не удалены — на них могут ссылаться словарь и разметка; разберите вручную');
    }
  } else {
    console.log(usage());
  }
  db.close();
}
