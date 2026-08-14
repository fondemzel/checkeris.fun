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
