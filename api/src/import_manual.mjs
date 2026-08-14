// Импорт ручных трат из CSV: то, чего в чеках ФНС нет — аренда, кредиты, налоги,
// наличные, переводы. Категория в файле уже проставлена человеком.
//
//   node api/src/import_manual.mjs                       — залить api/data/fns_out/manual_data.csv
//   node api/src/import_manual.mjs путь/к/файлу.csv
//   node api/src/import_manual.mjs --check               — только разобрать и проверить
//
// Формат строки, без заголовка:
//   название,сумма в рублях,количество,дата YYYY-MM-DD,,категория
// Пятая колонка не используется, название может быть пустым.
//
// Каждая строка становится чеком с одной позицией. Настоящих ФН/ФД/ФП у неё нет,
// поэтому ключ идемпотентности собирается из самой строки: повторный запуск обновит
// записи, а не создаст вторые. Порядок строк в файле на ключ не влияет.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, migrate, API_ROOT } from './db.mjs';
import { normalizeName } from './import.mjs';

const DEFAULT_FILE = resolve(API_ROOT, 'data', 'fns_out', 'manual_data.csv');
const SELLER = 'Ручная запись';

/** Ключ строки: хеш содержимого плюс номер повтора — одинаковые траты в один день бывают. */
function rowKey(row, seen) {
  const base = [row.date, row.sum, row.name, row.category].join('|');
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  const hash = createHash('sha1').update(`${base}|${n}`).digest();
  return {
    fiscal_drive: 'manual',
    // ФД и ФП в базе целые, поэтому берём куски хеша; коллизия на 372 строках исключена
    fiscal_doc: hash.readUInt32BE(0) % 1_000_000_000,
    fiscal_sign: hash.readUInt32BE(4) % 1_000_000_000,
  };
}

/**
 * Разбор файла. Строку с неразборчивой суммой или датой не тащим в базу и не роняем
 * из-за неё весь импорт — выгрузки из таблиц приносят то #N/A, то пустую ячейку.
 * Такие строки возвращаются отдельно, чтобы их было видно, а не потеряно.
 */
export function parseCsv(text) {
  const rows = [];
  const problems = [];
  const skipped = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const cells = line.split(',');
    if (cells.length < 6) {
      problems.push(`строка ${i + 1}: ожидалось 6 колонок, а их ${cells.length}`);
      return;
    }
    const [name, sum, quantity, date, , category] = cells;
    const rubles = Number(sum);
    const row = {
      line: i + 1,
      name: name.trim(),
      sum: Math.round(rubles * 100),
      quantity: Number(quantity) || 1,
      date,
      category: category.trim(),
      raw: line,
    };

    const why = !Number.isFinite(rubles) || rubles <= 0
      ? `непонятная сумма «${sum}»`
      : !/^\d{4}-\d{2}-\d{2}$/.test(date)
        ? `непонятная дата «${date}»`
        : !row.category
          ? 'не указана категория'
          : null;

    if (why) skipped.push({ ...row, why });
    else rows.push(row);
  });

  return { rows, problems, skipped };
}

/** Названия категорий из файла → slug'и справочника. Несовпадение — ошибка файла, не молчим. */
function resolveCategories(db, rows) {
  const known = new Map(
    db.prepare('SELECT slug, name FROM categories').all().map((r) => [normalizeName(r.name), r.slug]),
  );
  const problems = [];
  for (const row of rows) {
    row.slug = known.get(normalizeName(row.category));
    if (!row.slug) problems.push(`строка ${row.line}: в справочнике нет категории «${row.category}»`);
  }
  return problems;
}

/** Пропущенные строки печатаем целиком: их нужно поправить в источнике, а не забыть. */
function reportSkipped(skipped) {
  if (!skipped.length) return;
  console.log(`пропущено строк: ${skipped.length} — данные в них не разобрать`);
  for (const s of skipped) console.log(`  строка ${s.line}: ${s.why}\n    ${s.raw}`);
  console.log();
}

export function importManual(db, file = DEFAULT_FILE) {
  const { rows, problems, skipped } = parseCsv(readFileSync(file, 'utf8'));
  problems.push(...resolveCategories(db, rows));
  if (problems.length) throw new Error(`файл не прошёл проверку:\n  ${problems.join('\n  ')}`);

  const findReceipt = db.prepare(
    'SELECT id FROM receipts WHERE fiscal_drive = ? AND fiscal_doc = ? AND fiscal_sign = ?',
  );
  const insertReceipt = db.prepare(`
    INSERT INTO receipts (
      source_id, fiscal_drive, fiscal_doc, fiscal_sign, purchased_at, purchased_date,
      seller, operation_type, total_sum, cash_sum, item_count, items_sum
    ) VALUES (
      :source_id, :fiscal_drive, :fiscal_doc, :fiscal_sign, :purchased_at, :purchased_date,
      :seller, 1, :sum, :sum, 1, :sum
    )`);
  const updateReceipt = db.prepare(`
    UPDATE receipts SET purchased_at = :purchased_at, purchased_date = :purchased_date,
      seller = :seller, total_sum = :sum, cash_sum = :sum, item_count = 1, items_sum = :sum
     WHERE id = :id`);
  // В UPDATE идут не все поля из args — ключ и source_id при обновлении не меняются
  updateReceipt.setAllowUnknownNamedParameters(true);
  const deleteItems = db.prepare('DELETE FROM items WHERE receipt_id = ?');
  const insertItem = db.prepare(`
    INSERT INTO items (receipt_id, pos, name, name_norm, quantity, price, sum)
    VALUES (:receipt_id, 1, :name, :name_norm, :quantity, :price, :sum)`);
  // Категория здесь не догадка, а данные: закрепляем за позицией, чтобы пересчёт её не трогал
  const pinLabel = db.prepare(`
    INSERT INTO item_labels (item_id, category_slug, source, confidence, updated_at)
    VALUES (:item_id, :slug, 'pinned', 1, :now)
    ON CONFLICT (item_id) DO UPDATE SET category_slug = :slug, source = 'pinned', confidence = 1, updated_at = :now`);

  const now = new Date().toISOString();
  const seen = new Map();
  let created = 0;
  let updated = 0;

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const key = rowKey(row, seen);
      const args = {
        ...key,
        source_id: `manual:${key.fiscal_doc}`,
        purchased_at: `${row.date}T12:00:00`,
        purchased_date: row.date,
        seller: SELLER,
        sum: row.sum,
      };

      const existing = findReceipt.get(key.fiscal_drive, key.fiscal_doc, key.fiscal_sign);
      let receiptId;
      if (existing) {
        updateReceipt.run({ ...args, id: existing.id });
        deleteItems.run(existing.id);
        receiptId = existing.id;
        updated += 1;
      } else {
        insertReceipt.run(args);
        receiptId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
        created += 1;
      }

      // Пустое название в файле встречается: подставляем категорию, иначе строка безымянна
      const name = row.name || row.category;
      insertItem.run({
        receipt_id: receiptId,
        name,
        name_norm: normalizeName(name),
        quantity: row.quantity,
        price: Math.round(row.sum / row.quantity),
        sum: row.sum,
      });
      const itemId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
      pinLabel.run({ item_id: itemId, slug: row.slug, now });
    }

    db.prepare(
      `INSERT INTO imports (file, imported_at, receipts_seen, receipts_new, receipts_upd, items_total)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(file, now, rows.length, created, updated, rows.length);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const total = rows.reduce((s, r) => s + r.sum, 0);
  return { rows: rows.length, created, updated, total, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--')) ?? DEFAULT_FILE;
  const db = openDb();
  migrate(db);

  if (argv.includes('--check')) {
    const { rows, problems, skipped } = parseCsv(readFileSync(file, 'utf8'));
    problems.push(...resolveCategories(db, rows));
    reportSkipped(skipped);
    if (problems.length) {
      console.log('ошибки в файле:');
      problems.forEach((p) => console.log('  ' + p));
      process.exitCode = 1;
    } else {
      const total = rows.reduce((s, r) => s + r.sum, 0);
      const dates = rows.map((r) => r.date).sort();
      console.log(
        `файл в порядке: ${rows.length} строк на ${(total / 100).toLocaleString('ru-RU')} ₽, ` +
          `${dates[0]} — ${dates[dates.length - 1]}`,
      );
    }
  } else {
    const r = importManual(db, file);
    reportSkipped(r.skipped);
    console.log(
      `ручные траты: строк ${r.rows} (новых ${r.created}, обновлено ${r.updated}), ` +
        `на ${(r.total / 100).toLocaleString('ru-RU')} ₽`,
    );
  }
  db.close();
}
