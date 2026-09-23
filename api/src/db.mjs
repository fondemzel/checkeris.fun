// Подключение к SQLite (встроенный node:sqlite, без внешних зависимостей).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionTaxonomy } from './taxonomy.mjs';
import { placeKey } from './geo.mjs';

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
 * Хозяин данных — бюджет. Базы прошлых версий устроены иначе:
 *   single — однопользовательская: у данных нет владельца вовсе (до 0.26);
 *   users  — хозяин данных пользователь, user_id (0.26–0.28).
 * Перестройка не укладывается в ADD COLUMN: меняются ключи уникальности и внешние
 * ключи. Поэтому старые таблицы отодвигаются в сторону (*_old), схема создаёт новые,
 * и данные переносятся. Если перенос оборвётся, *_old останутся на месте и следующий
 * запуск продолжит с того же места.
 */
export function migrate(db) {
  prepareMove(db);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  addUserColumns(db);
  finishMove(db);
  fillPlaceKeys(db); // после переноса: иначе у перенесённых чеков ключей не будет до следующего запуска
  repairScanErrors(db);
}

/** Вход через Telegram, роли и бюджеты. Индекс — здесь: в старой базе колонки появляются только сейчас. */
function addUserColumns(db) {
  addColumn(db, 'users', 'telegram_id', 'INTEGER');
  addColumn(db, 'users', 'tg_username', 'TEXT');
  addColumn(db, 'users', 'name', 'TEXT');
  addColumn(db, 'users', 'name_set', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'role', "TEXT NOT NULL DEFAULT 'user'");
  addColumn(db, 'users', 'budget_id', 'INTEGER REFERENCES budgets (id)');
  addColumn(db, 'users', 'home_budget_id', 'INTEGER REFERENCES budgets (id)');
  addColumn(db, 'tg_logins', 'client', 'TEXT');
  addColumn(db, 'tg_logins', 'confirm_hash', 'TEXT');
  addColumn(db, 'tg_logins', 'tg_identity', 'TEXT');
  addColumn(db, 'tg_logins', 'bot_chat', 'INTEGER');
  addColumn(db, 'tg_logins', 'bot_msg', 'INTEGER');
  addColumn(db, 'tg_outbox', 'delete_msg', 'INTEGER');
  addColumn(db, 'receipts', 'place_key', 'TEXT');
  addColumn(db, 'bank_ops', 'kind', 'TEXT');
  addColumn(db, 'bank_ops', 'receipt_id', 'INTEGER');
  addColumn(db, 'bank_ops', 'pair_id', 'INTEGER');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram ON users (telegram_id)');
  // Первый пользователь — владелец проекта: без квот и с правом на системный справочник
  db.exec(`UPDATE users SET role = 'admin'
            WHERE id = (SELECT MIN(id) FROM users)
              AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`);
}

/** Ключ места у чеков, пришедших раньше, чем появились места. Идемпотентно. */
function fillPlaceKeys(db) {
  db.exec('CREATE INDEX IF NOT EXISTS idx_receipts_place ON receipts (place_key)');
  const rows = db
    .prepare("SELECT id, retail_address FROM receipts WHERE place_key IS NULL AND retail_address IS NOT NULL AND retail_address <> ''")
    .all();
  if (!rows.length) return;
  const set = db.prepare('UPDATE receipts SET place_key = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) set.run(placeKey(r.retail_address), r.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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
  'idx_receipts_date', 'idx_receipts_user_date', 'idx_receipts_at', 'idx_receipts_inn', 'idx_receipts_source',
  'idx_scan_jobs_status', 'idx_scan_jobs_user', 'idx_item_labels_category', 'idx_item_labels_source',
  'idx_categories_group',
];

// Что перестраивается. Справочник однопользовательской базы не перестраивается,
// а становится системным — это отдельный путь ниже.
const DATA_TABLES = ['receipts', 'scan_jobs', 'item_labels'];
const BUDGET_TABLES = ['groups', 'categories', 'category_links', 'user_dictionary'];

/** Какая перед нами база: текущая (null), однопользовательская или с хозяином-пользователем. */
function layoutOf(db, table = 'receipts') {
  if (!tableExists(db, table) || hasColumn(db, table, 'budget_id')) return null;
  return hasColumn(db, table, 'user_id') ? 'users' : 'single';
}

/** Шаг 1, до схемы: отодвигаем то, что будет перестроено. */
function prepareMove(db) {
  const layout = layoutOf(db);
  if (!layout) return;

  // Колонки из прошлых миграций: без них перенос не найдёт, что копировать
  addColumn(db, 'groups', 'shade_from', 'INTEGER NOT NULL DEFAULT 25');
  addColumn(db, 'groups', 'shade_to', 'INTEGER NOT NULL DEFAULT 85');
  addColumn(db, 'scan_jobs', 'error_code', 'TEXT');
  addColumn(db, 'scan_jobs', 'retries', 'INTEGER NOT NULL DEFAULT 0');

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('DROP VIEW IF EXISTS v_items; DROP VIEW IF EXISTS v_item_categories;');

    // Перестраиваемые таблицы. Ссылки на них из других таблиц переписывать нельзя:
    // items должна и дальше ссылаться на «receipts» — то есть на новую таблицу
    db.exec('PRAGMA legacy_alter_table = ON');
    const moving = layout === 'users' ? [...DATA_TABLES, ...BUDGET_TABLES] : DATA_TABLES;
    for (const table of moving) {
      if (tableExists(db, table)) db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
    }

    if (layout === 'single') {
      // Справочник становится системным целиком, и ссылки словаря, штрихкодов
      // и правил продавцов должны уехать вслед за ним — здесь переписывание нужно
      db.exec('PRAGMA legacy_alter_table = OFF');
      db.exec('ALTER TABLE groups RENAME TO sys_groups');
      db.exec('ALTER TABLE categories RENAME TO sys_categories');
      db.exec('ALTER TABLE sys_categories ADD COLUMN fallback_slug TEXT REFERENCES sys_categories (slug)');
    }

    for (const index of OLD_INDEXES) db.exec(`DROP INDEX IF EXISTS ${index}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF');
    db.exec('PRAGMA foreign_keys = ON');
  }
  console.error(`схема: данные переводятся на бюджеты (была база «${layout}»)…`);
}

/**
 * Перенос строк: колонки, которые есть в обеих таблицах, плюс заданные выражения
 * для новых (budget_id = прежний user_id и т. п.). Выражения — наши, не ввод.
 */
function copyRows(db, from, to, mapping = {}) {
  const source = new Set(columnsOf(db, from));
  const pairs = columnsOf(db, to)
    .map((col) => [col, mapping[col] ?? (source.has(col) ? col : null)])
    .filter(([, expr]) => expr !== null);
  const cols = pairs.map(([col]) => col).join(', ');
  const exprs = pairs.map(([, expr]) => expr).join(', ');
  return db.prepare(`INSERT INTO ${to} (${cols}) SELECT ${exprs} FROM ${from}`).run().changes;
}

/** У каждого пользователя без бюджета появляется свой, с тем же номером, что у него самого. */
function giveBudgets(db) {
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    // Данные не должны остаться ничьими: заводим служебного пользователя без пароля
    db.prepare("INSERT INTO users (login, password, created_at) VALUES ('owner', '!', ?)").run(new Date().toISOString());
    console.error('схема: пользователей не было — данные отданы служебному «owner», задайте ему пароль');
  }
  db.exec(`INSERT INTO budgets (id, name, owner_id, created_at)
           SELECT id, 'Мой бюджет', id, created_at FROM users
            WHERE budget_id IS NULL AND id NOT IN (SELECT id FROM budgets)`);
  db.exec('UPDATE users SET budget_id = id, home_budget_id = id WHERE budget_id IS NULL');
}

/** Шаг 2, после схемы: новые таблицы созданы — переносим данные и проверяем связи. */
function finishMove(db) {
  const layout = layoutOf(db, 'receipts_old');
  if (!layout) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    giveBudgets(db);
    let report;

    if (layout === 'users') {
      // Номер бюджета совпадает с номером пользователя: прежний user_id и есть budget_id
      report = {
        receipts: copyRows(db, 'receipts_old', 'receipts', { budget_id: 'user_id', added_by: 'user_id' }),
        scans: copyRows(db, 'scan_jobs_old', 'scan_jobs', { budget_id: 'user_id', user_id: 'user_id' }),
        groups: copyRows(db, 'groups_old', 'groups', { budget_id: 'user_id' }),
        categories: copyRows(db, 'categories_old', 'categories', { budget_id: 'user_id' }),
        links: copyRows(db, 'category_links_old', 'category_links', { budget_id: 'user_id' }),
        edits: copyRows(db, 'user_dictionary_old', 'budget_dictionary', { budget_id: 'user_id' }),
        labels: copyRows(db, 'item_labels_old', 'item_labels', { budget_id: 'user_id' }),
      };
    } else {
      // Однопользовательская база: всё — первому пользователю, справочник — копия системного
      const owner = String(db.prepare('SELECT MIN(id) AS id FROM users').get().id);
      provisionTaxonomy(db, Number(owner));
      report = {
        receipts: copyRows(db, 'receipts_old', 'receipts', { budget_id: owner, added_by: owner }),
        scans: tableExists(db, 'scan_jobs_old')
          ? copyRows(db, 'scan_jobs_old', 'scan_jobs', { budget_id: owner, user_id: owner })
          : 0,
        labels: tableExists(db, 'item_labels_old')
          ? copyRows(db, 'item_labels_old', 'item_labels', { budget_id: owner })
          : 0,
        // Ручные правки были решениями владельца — становятся правками его бюджета.
        // В общем словаре они остаются как выверенное знание
        edits: db
          .prepare(
            `INSERT INTO budget_dictionary (budget_id, name_norm, category_slug, updated_at)
             SELECT ?, name_norm, category_slug, updated_at FROM dictionary WHERE source = 'manual'`,
          )
          .run(Number(owner)).changes,
      };
    }

    // Дети раньше родителей: так порядок удаления не спотыкается о ссылки
    for (const table of ['item_labels_old', 'user_dictionary_old', 'category_links_old', 'categories_old',
      'groups_old', 'scan_jobs_old', 'receipts_old']) {
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
    console.error(`схема: данные переведены на бюджеты — ${Object.entries(report).map(([k, v]) => `${k} ${v}`).join(', ')}`);
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
