// Импорт ручных трат из CSV: то, чего в чеках ФНС нет — аренда, кредиты, налоги,
// наличные, переводы. Категория в файле уже проставлена человеком.
//
//   node api/src/import_manual.mjs                       — залить api/data/fns_out/manual_data.csv
//   node api/src/import_manual.mjs путь/к/файлу.csv
//   node api/src/import_manual.mjs --check               — только разобрать и проверить
//   node api/src/import_manual.mjs --user <логин> ...    — в чей бюджет (по умолчанию первого пользователя)
//
// Формат строки, без заголовка:
//   название,сумма в рублях,количество,дата YYYY-MM-DD,,категория
// Пятая колонка не используется, название может быть пустым.
//
// Каждая строка становится чеком с одной позицией. Настоящих ФН/ФД/ФП у неё нет,
// поэтому ключ идемпотентности собирается из самой строки: повторный запуск обновит
// записи, а не создаст вторые. Порядок строк в файле на ключ не влияет.
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
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

/** Названия категорий из файла → slug'и справочника бюджета. Несовпадение — ошибка файла, не молчим. */
function resolveCategories(db, rows, budgetId) {
  const known = new Map(
    db.prepare('SELECT slug, name FROM categories WHERE budget_id = ?').all(budgetId).map((r) => [normalizeName(r.name), r.slug]),
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

export function importManual(db, budgetId, file = DEFAULT_FILE, addedBy = null) {
  const { rows, problems, skipped } = parseCsv(readFileSync(file, 'utf8'));
  problems.push(...resolveCategories(db, rows, budgetId));
  if (problems.length) throw new Error(`файл не прошёл проверку:\n  ${problems.join('\n  ')}`);

  const findReceipt = db.prepare(
    'SELECT id FROM receipts WHERE budget_id = ? AND fiscal_drive = ? AND fiscal_doc = ? AND fiscal_sign = ?',
  );
  const insertReceipt = db.prepare(`
    INSERT INTO receipts (
      budget_id, added_by, source_id, fiscal_drive, fiscal_doc, fiscal_sign, purchased_at, purchased_date,
      seller, operation_type, total_sum, cash_sum, item_count, items_sum
    ) VALUES (
      :budget_id, :added_by, :source_id, :fiscal_drive, :fiscal_doc, :fiscal_sign, :purchased_at, :purchased_date,
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
    INSERT INTO item_labels (item_id, budget_id, category_slug, source, confidence, updated_at)
    VALUES (:item_id, :budget_id, :slug, 'pinned', 1, :now)
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
        budget_id: budgetId,
        added_by: addedBy,
        source_id: `manual:${key.fiscal_doc}`,
        purchased_at: `${row.date}T12:00:00`,
        purchased_date: row.date,
        seller: SELLER,
        sum: row.sum,
      };

      const existing = findReceipt.get(budgetId, key.fiscal_drive, key.fiscal_doc, key.fiscal_sign);
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
      pinLabel.run({ item_id: itemId, budget_id: budgetId, slug: row.slug, now });
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

// ── трата, вбитая с телефона ────────────────────────────────
// Та же запись, что у строки файла: чек с одной позицией и закреплённой категорией.
// Ключ у неё случайный — повторять её нечему, а совпасть с ключом строки файла
// хеш-кусок и случайное число на миллиард практически не могут; на всякий случай проверяем.

const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

export function addManual(db, budgetId, body, addedBy = null) {
  const rubles = Number(String(body.sum ?? '').replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(rubles) || rubles <= 0 || rubles > 100_000_000) return { error: 'укажите сумму', status: 400 };
  const sum = Math.round(rubles * 100);

  const date = String(body.date ?? '');
  if (!isDay(date)) return { error: 'укажите дату', status: 400 };
  const time = /^\d{2}:\d{2}$/.test(body.time ?? '') ? body.time : '12:00';

  const category = db
    .prepare('SELECT slug, name FROM categories WHERE budget_id = ? AND slug = ?')
    .get(budgetId, String(body.category ?? ''));
  if (!category) return { error: 'выберите категорию', status: 400 };

  const quantity = Number(body.quantity) > 0 ? Number(body.quantity) : 1;
  const name = String(body.name ?? '').trim().slice(0, 200) || category.name;

  const taken = db.prepare(
    "SELECT 1 FROM receipts WHERE budget_id = ? AND fiscal_drive = 'manual' AND fiscal_doc = ? AND fiscal_sign = ?",
  );
  let key;
  do {
    const bytes = randomBytes(8);
    key = { doc: bytes.readUInt32BE(0) % 1_000_000_000, sign: bytes.readUInt32BE(4) % 1_000_000_000 };
  } while (taken.get(budgetId, key.doc, key.sign));

  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const receipt = db
      .prepare(
        `INSERT INTO receipts (
           budget_id, added_by, source_id, fiscal_drive, fiscal_doc, fiscal_sign, purchased_at, purchased_date,
           seller, operation_type, total_sum, cash_sum, item_count, items_sum
         ) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, 1, ?, ?, 1, ?)`,
      )
      .run(budgetId, addedBy, `manual:app:${key.doc}`, key.doc, key.sign, `${date}T${time}:00`, date, SELLER, sum, sum, sum);
    const receiptId = Number(receipt.lastInsertRowid);

    const item = db
      .prepare(
        `INSERT INTO items (receipt_id, pos, name, name_norm, quantity, price, sum)
         VALUES (?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(receiptId, name, normalizeName(name), quantity, Math.round(sum / quantity), sum);
    const itemId = Number(item.lastInsertRowid);

    db.prepare(
      `INSERT INTO item_labels (item_id, budget_id, category_slug, source, confidence, updated_at)
       VALUES (?, ?, ?, 'pinned', 1, ?)`,
    ).run(itemId, budgetId, category.slug, now);

    // Комментарий — сразу при записи: как у любого товара, он держится за чек и позицию
    const note = String(body.note ?? '').trim().slice(0, 1000);
    if (note) {
      db.prepare('INSERT INTO item_notes (receipt_id, pos, note, updated_at) VALUES (?, 1, ?, ?)').run(receiptId, note, now);
    }

    db.exec('COMMIT');
    return { id: receiptId, item_id: itemId };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Удаление ручной траты — только ручной: чек ФНС удалять незачем, он настоящий.
 * Строка из manual_data.csv после удаления вернётся при следующем импорте файла.
 */
export function deleteManual(db, budgetId, id) {
  const receipt = db.prepare('SELECT fiscal_drive FROM receipts WHERE id = ? AND budget_id = ?').get(id, budgetId);
  if (!receipt) return { error: 'чек не найден', status: 404 };
  if (receipt.fiscal_drive !== 'manual') return { error: 'удалить можно только ручную запись', status: 409 };
  db.prepare('DELETE FROM receipts WHERE id = ?').run(id); // позиции и метки уходят каскадом
  return { ok: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--user');
  const login = at >= 0 ? argv[at + 1] : null;
  const file = argv.find((a, i) => !a.startsWith('--') && !(at >= 0 && i === at + 1)) ?? DEFAULT_FILE;
  const db = openDb();
  migrate(db);
  const user = login
    ? db.prepare('SELECT id, login, budget_id FROM users WHERE login = ?').get(login)
    : db.prepare('SELECT id, login, budget_id FROM users ORDER BY id LIMIT 1').get();
  if (!user) throw new Error(login ? `нет пользователя «${login}»` : 'нет ни одного пользователя — заведите: users.mjs --add');

  if (argv.includes('--check')) {
    const { rows, problems, skipped } = parseCsv(readFileSync(file, 'utf8'));
    problems.push(...resolveCategories(db, rows, user.budget_id));
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
    const r = importManual(db, user.budget_id, file, user.id);
    reportSkipped(r.skipped);
    console.log(
      `ручные траты: строк ${r.rows} (новых ${r.created}, обновлено ${r.updated}), ` +
        `на ${(r.total / 100).toLocaleString('ru-RU')} ₽`,
    );
  }
  db.close();
}
