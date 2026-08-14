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

/** Создаёт таблицы, если их ещё нет. Идемпотентно. */
export function migrate(db) {
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  addColumn(db, 'categories', 'icon', 'TEXT');
}

/** CREATE TABLE IF NOT EXISTS не добавит колонку в уже существующую таблицу — дописываем вручную. */
function addColumn(db, table, column, type) {
  const exists = db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
