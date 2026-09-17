// Подключение к SQLite (встроенный node:sqlite, без внешних зависимостей).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Создаёт таблицы, если их ещё нет, и доводит старые базы до текущей схемы. Идемпотентно. */
export function migrate(db) {
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  extractGroups(db);
  addColumn(db, 'groups', 'shade_from', 'INTEGER NOT NULL DEFAULT 25');
  addColumn(db, 'groups', 'shade_to', 'INTEGER NOT NULL DEFAULT 85');
  addColumn(db, 'scan_jobs', 'error_code', 'TEXT');
  addColumn(db, 'scan_jobs', 'retries', 'INTEGER NOT NULL DEFAULT 0');
  repairScanErrors(db);
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

/** CREATE TABLE IF NOT EXISTS не добавит колонку в уже существующую таблицу. */
function addColumn(db, table, column, definition) {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const hasColumn = (db, table, column) =>
  Boolean(db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column));

/**
 * Раньше группа была набором колонок в categories (group_name, icon, color).
 * Переносим её в свою таблицу и убираем дубли: без отдельной записи группу
 * нельзя ни переименовать одним действием, ни завести пустой.
 */
function extractGroups(db) {
  if (!hasColumn(db, 'categories', 'group_name')) return;

  db.exec('BEGIN');
  try {
    db.exec(`
      INSERT INTO groups (slug, name, icon, color, sort)
      SELECT group_slug, MIN(group_name), MIN(icon), MIN(color), MIN(sort)
        FROM categories
       GROUP BY group_slug
      ON CONFLICT (slug) DO NOTHING`);

    // Представления уже пересозданы без этих колонок, поэтому DROP COLUMN пройдёт
    for (const column of ['group_name', 'icon', 'color']) {
      if (hasColumn(db, 'categories', column)) db.exec(`ALTER TABLE categories DROP COLUMN ${column}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.error(`схема: группы вынесены в отдельную таблицу (${db.prepare('SELECT COUNT(*) c FROM groups').get().c})`);
}
