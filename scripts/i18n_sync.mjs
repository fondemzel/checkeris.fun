#!/usr/bin/env node
// Сверяет английские тексты с русскими: site/m/i18n/ru.js → site/m/i18n/en.js
//
// Правится только русский файл. Скрипт смотрит, что в нём изменилось, и приводит
// английский в тот же вид:
//   — появилась надпись → в en.js добавляется пустая строка и русский текст комментарием;
//   — надпись удалили → пропадает и из en.js;
//   — русский текст поменяли → перевод помечается устаревшим (его видно в отчёте),
//     а до нового перевода на экране показывается русский вариант.
//
// Чем перевод был сделан, помнит .en-source.json рядом: в нём русский текст на момент
// перевода. Без него нельзя отличить «перевели» от «русский с тех пор изменили».
//
// Запуск:
//   node scripts/i18n_sync.mjs            — свериться и переписать en.js
//   node scripts/i18n_sync.mjs --check    — только показать расхождения, ничего не менять
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'site', 'm', 'i18n');
const EN_FILE = join(DIR, 'en.js');
const SOURCE_FILE = join(DIR, '.en-source.json');

const checkOnly = process.argv.includes('--check');

const { ru } = await import(pathToFileURL(join(DIR, 'ru.js')));
const { en } = existsSync(EN_FILE) ? await import(pathToFileURL(EN_FILE)) : { en: {} };
const source = existsSync(SOURCE_FILE) ? JSON.parse(readFileSync(SOURCE_FILE, 'utf8')) : {};

const at = (obj, path) => path.split('.').reduce((node, key) => node?.[key], obj);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const added = [];
const changed = [];
const removed = [];
const nextSource = {};

/** Английское дерево по образцу русского: перевод берём, пока он не устарел. */
function build(rusNode, path = '') {
  const out = {};
  for (const [key, rus] of Object.entries(rusNode)) {
    const full = path ? `${path}.${key}` : key;
    if (rus && typeof rus === 'object' && !Array.isArray(rus)) {
      out[key] = build(rus, full);
      continue;
    }
    const translated = at(en, full);
    const wasFrom = source[full];
    // Перевода нет в памяти (файл правили руками) — считаем его свежим, а не устаревшим
    if (translated != null && translated !== '' && (wasFrom === undefined || same(wasFrom, rus))) {
      out[key] = translated; // перевод в силе
      nextSource[full] = rus;
    } else if (translated != null && translated !== '') {
      changed.push(full); // русский поменяли — перевод устарел
      out[key] = Array.isArray(rus) ? [] : '';
    } else {
      added.push(full);
      out[key] = Array.isArray(rus) ? [] : '';
    }
  }
  return out;
}

/** Что было переведено, а в русском больше не встречается. */
function findRemoved(enNode, path = '') {
  for (const [key, value] of Object.entries(enNode ?? {})) {
    const full = path ? `${path}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      findRemoved(value, full);
      continue;
    }
    if (at(ru, full) === undefined) removed.push(full);
  }
}

const result = build(ru);
findRemoved(en);

// ── запись ────────────────────────────────────────────────
const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Рядом с непереведённой надписью оставляем русскую — чтобы было что переводить. */
function serialize(node, rusNode, indent = '  ') {
  const lines = [];
  for (const [key, value] of Object.entries(node)) {
    const rus = rusNode?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${indent}${key}: {`);
      lines.push(serialize(value, rus, `${indent}  `));
      lines.push(`${indent}},`);
      continue;
    }
    if (Array.isArray(value)) {
      const filled = value.length ? value.map(quote).join(', ') : '';
      const hint = value.length ? '' : ` // ${JSON.stringify(rus)}`;
      lines.push(`${indent}${key}: [${filled}],${hint}`);
      continue;
    }
    const hint = value === '' ? ` // ${rus}` : '';
    lines.push(`${indent}${key}: ${quote(value)},${hint}`);
  }
  return lines.join('\n');
}

const header = `// Английские тексты. Файл собирает scripts/i18n_sync.mjs по site/m/i18n/ru.js —
// руками правятся только сами переводы: состав и порядок надписей скрипт всё равно
// приведёт обратно в соответствие с русским файлом.
//
// Пустая строка — не переведено: рядом комментарием русский текст. Пока перевода нет,
// на экране показывается русский вариант.

export const en = {
`;

const body = `${serialize(result, ru)}\n};\n`;

if (checkOnly) {
  console.log('проверка, файлы не менялись');
} else {
  writeFileSync(EN_FILE, header + body, 'utf8');
  writeFileSync(SOURCE_FILE, `${JSON.stringify(nextSource, null, 1)}\n`, 'utf8');
}

const total = Object.keys(nextSource).length + added.length + changed.length;
console.log(`надписей: ${total}, переведено: ${Object.keys(nextSource).length}`);
const show = (title, list) => {
  if (!list.length) return;
  console.log(`\n${title}: ${list.length}`);
  for (const path of list.slice(0, 40)) console.log(`  ${path}`);
  if (list.length > 40) console.log(`  … и ещё ${list.length - 40}`);
};
show('новые, нужен перевод', added);
show('русский изменился, перевод устарел', changed);
show('удалены из русского', removed);
if (!added.length && !changed.length && !removed.length) console.log('всё сходится');
