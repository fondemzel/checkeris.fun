// Подключение к SQLite (встроенный node:sqlite, без внешних зависимостей).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionTaxonomy } from './taxonomy.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export const API_ROOT = resolve(here, '..');
export const PROJECT_ROOT = resolve(API_ROOT, '..');
export const DB_PATH = process.env.CHECKER_DB || resolve(API_ROOT, 'data', 'checker.db');
export const SCHEMA_PATH = resolve(API_ROOT, 'db', 'schema.sql');

export function openDb({ readonly = false } = {}) {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH, { readOnly: readonly });
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * Создаёт таблицы, если их ещё нет, и доводит старые базы до текущей схемы. Идемпотентно.
 *
 * Разделение по пользователям не укладывается в ADD COLUMN: у чека и скана меняется
 * ключ уникальности, у разметки — внешний ключ, а справочник становится системным.
 * Поэтому старые таблицы сначала отодвигаются в сторону (*_old), схема создаёт новые,
 * и данные переносятся. Если перенос оборвётся, *_old останутся на месте и следующий
 * запуск продолжит с того же места.
 */
export function migrate(db) {
  prepareSplit(db);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  finishSplit(db);
  repairScanErrors(db);
}

const tableExists = (db, name) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

const hasColumn = (db, table, column) =>
  Boolean(db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column));

const columnsOf = (db, table) => db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((r) => r.name);

/** CREATE TABLE IF NOT EXISTS не добавит колонку в уже существующую таблицу. */
function addColumn(db, table, column, definition) {
  if (tableExists(db, table) && !hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Индексы уезжают вместе с таблицей под прежними именами, и CREATE INDEX IF NOT EXISTS
// из схемы решил бы, что они уже есть. Убираем, схема создаст их на новых таблицах.
const OLD_INDEXES = [
  'idx_receipts_date', 'idx_receipts_at', 'idx_receipts_inn', 'idx_receipts_source',
  'idx_scan_jobs_status', 'idx_item_labels_category', 'idx_item_labels_source', 'idx_categories_group',
];

/** Шаг 1, до схемы: база однопользовательская — отодвигаем то, что будет перестроено. */
function prepareSplit(db) {
  if (!tableExists(db, 'receipts') || hasColumn(db, 'receipts', 'user_id')) return;

  // Колонки из прошлых миграций: без них перенос не найдёт, что копировать
  addColumn(db, 'groups', 'shade_from', 'INTEGER NOT NULL DEFAULT 25');
  addColumn(db, 'groups', 'shade_to', 'INTEGER NOT NULL DEFAULT 85');
  addColumn(db, 'scan_jobs', 'error_code', 'TEXT');
  addColumn(db, 'scan_jobs', 'retries', 'INTEGER NOT NULL DEFAULT 0');

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('DROP VIEW IF EXISTS v_items; DROP VIEW IF EXISTS v_item_categories;');

    // Эти таблицы перестраиваются. Ссылки на них из других таблиц переписывать нельзя:
    // items должна и дальше ссылаться на «receipts» — то есть на новую таблицу
    db.exec('PRAGMA legacy_alter_table = ON');
    for (const table of ['receipts', 'scan_jobs', 'item_labels']) {
      if (tableExists(db, table)) db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
    }

    // А справочник становится системным целиком, и ссылки словаря, штрихкодов
    // и правил продавцов должны уехать вслед за ним — здесь переписывание нужно
    db.exec('PRAGMA legacy_alter_table = OFF');
    db.exec('ALTER TABLE groups RENAME TO sys_groups');
    db.exec('ALTER TABLE categories RENAME TO sys_categories');
    db.exec('ALTER TABLE sys_categories ADD COLUMN fallback_slug TEXT REFERENCES sys_categories (slug)');

    for (const index of OLD_INDEXES) db.exec(`DROP INDEX IF EXISTS ${index}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF');
    db.exec('PRAGMA foreign_keys = ON');
  }
  console.error('схема: база переводится на нескольких пользователей…');
}

/**
 * Владелец существующих данных — первый пользователь. Если пользователей нет вовсе,
 * заводим служебного без пароля: данные не должны остаться ничьими.
 */
function ownerId(db) {
  const first = db.prepare('SELECT MIN(id) AS id FROM users').get().id;
  if (first) return first;
  const res = db
    .prepare("INSERT INTO users (login, password, created_at) VALUES ('owner', '!', ?)")
    .run(new Date().toISOString());
  console.error('схема: пользователей не было — данные отданы служебному «owner», задайте ему пароль');
  return Number(res.lastInsertRowid);
}

/** Перенос строк: только колонки, которые есть и там и там, плюс владелец. */
function copyRows(db, from, to, owner) {
  const target = new Set(columnsOf(db, to));
  const cols = columnsOf(db, from).filter((c) => target.has(c) && c !== 'user_id');
  const list = cols.join(', ');
  return db.prepare(`INSERT INTO ${to} (${list}, user_id) SELECT ${list}, ? FROM ${from}`).run(owner).changes;
}

/** Шаг 2, после схемы: новые таблицы созданы — переносим данные и проверяем связи. */
function finishSplit(db) {
  if (!tableExists(db, 'receipts_old')) return;

  const owner = ownerId(db);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    const receipts = copyRows(db, 'receipts_old', 'receipts', owner);
    const scans = tableExists(db, 'scan_jobs_old') ? copyRows(db, 'scan_jobs_old', 'scan_jobs', owner) : 0;

    // Справочник владельца — копия системного: коды совпадают, разметка остаётся верной
    provisionTaxonomy(db, owner);

    const labels = tableExists(db, 'item_labels_old')
      ? db
          .prepare(
            `INSERT INTO item_labels (item_id, user_id, category_slug, source, confidence, updated_at)
             SELECT item_id, ?, category_slug, source, confidence, updated_at FROM item_labels_old`,
          )
          .run(owner).changes
      : 0;

    // Ручные правки были решениями владельца — становятся его личными. В общем словаре
    // они остаются как выверенное знание: иначе новые пользователи потеряли бы эти названия
    const manual = db
      .prepare(
        `INSERT INTO user_dictionary (user_id, name_norm, category_slug, updated_at)
         SELECT ?, name_norm, category_slug, updated_at FROM dictionary WHERE source = 'manual'`,
      )
      .run(owner).changes;

    for (const table of ['item_labels_old', 'scan_jobs_old', 'receipts_old']) {
      if (tableExists(db, table)) db.exec(`DROP TABLE ${table}`);
    }

    // Позиции должны ссылаться на новую таблицу чеков, а не на отодвинутую
    const itemsParent = db.prepare("SELECT \"table\" FROM pragma_foreign_key_list('items')").get()?.table;
    if (itemsParent !== 'receipts') throw new Error(`items ссылается на «${itemsParent}», а не на receipts`);

    const broken = db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) {
      const where = [...new Set(broken.map((b) => `${b.table}→${b.parent}`))].join(', ');
      throw new Error(`после переноса нарушены связи (${broken.length}): ${where}`);
    }

    db.exec('COMMIT');
    console.error(
      `схема: данные отданы пользователю #${owner} — чеков ${receipts}, сканов ${scans}, ` +
        `меток ${labels}, ручных правок ${manual}`,
    );
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Первые версии клали в ошибку скана весь вложенный ответ ФНС вместе с разметкой.
 * Достаём из него код и текст. Заодно гасим next_at у старых ошибок: раньше он
 * оставался от опроса, а теперь непустой next_at у ошибки означает «повторить».
 */
function repairScanErrors(db) {
  const broken = db.prepare("SELECT id, error FROM scan_jobs WHERE status = 'failed' AND error LIKE '%<Code>%'").all();
  const update = db.prepare('UPDATE scan_jobs SET error = ?, error_code = ?, next_at = NULL WHERE id = ?');
  for (const row of broken) {
    const code = /<Code>([^<]*)<\/Code>/.exec(row.error)?.[1] ?? null;
    const message = /<Message>([^<]*)/.exec(row.error)?.[1] ?? row.error;
    update.run(message.trim(), code, row.id);
  }
  // Назначенный повтор всегда идёт с кодом отказа; без кода next_at — остаток опроса
  db.exec("UPDATE scan_jobs SET next_at = NULL WHERE status = 'failed' AND error_code IS NULL AND next_at IS NOT NULL");
  // Ошибки «данных ещё нет», случившиеся до автоповторов, переспрашиваем один раз.
  // retries = 0 бывает только у них: новый отказ сразу получает повтор и счётчик 1
  db.prepare(
    `UPDATE scan_jobs SET next_at = ?
      WHERE status = 'failed' AND retries = 0 AND next_at IS NULL AND error_code IN ('455', '544')`,
  ).run(new Date().toISOString());
}
