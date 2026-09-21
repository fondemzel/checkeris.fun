// Импорт выгрузки «Проверка чеков» (ФНС) в SQLite.
//
//   node api/src/import.mjs                       — все файлы из api/data/fns_out
//   node api/src/import.mjs path/to/extract.json  — конкретные файлы
//   node api/src/import.mjs --user <логин> ...    — чьи это чеки (по умолчанию первый пользователь)
//
// Повторный запуск безопасен: чек опознаётся по тройке ФН/ФД/ФП в пределах владельца
// и обновляется, а не дублируется.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, migrate, API_ROOT, DB_PATH } from './db.mjs';
import { placeKey } from './geo.mjs';

const DEFAULT_DIR = resolve(API_ROOT, 'data', 'fns_out');

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? null : String(v).trim());
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Нормализация названия для поиска: нижний регистр, ё→е, схлопнутые пробелы. */
export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/** dateTime из ФНС приходит строкой ISO без таймзоны, изредка — unix-секундами. */
function toIsoLocal(value) {
  if (typeof value === 'number') return new Date(value * 1000).toISOString().slice(0, 19);
  const s = String(value ?? '').trim();
  if (!s) return null;
  return s.length === 16 ? `${s}:00` : s.slice(0, 19);
}

function collectFiles(args) {
  if (args.length) return args.map((p) => resolve(process.cwd(), p));
  let entries = [];
  try {
    entries = readdirSync(DEFAULT_DIR);
  } catch {
    throw new Error(`Каталог с выгрузками не найден: ${DEFAULT_DIR}`);
  }
  return entries.filter((f) => f.toLowerCase().endsWith('.json')).map((f) => join(DEFAULT_DIR, f));
}

/**
 * Сохранение одного чека. Вынесено отдельно, потому что чеки приходят двумя путями:
 * выгрузкой из приложения ФНС и сканированием QR через Открытые API. Разбор,
 * идемпотентность по ФН/ФД/ФП и запись позиций у них общие.
 *
 * Возвращает null, если в записи нет чека (например, служебная строка выгрузки).
 */
export function saveReceipt(db, row, stmts, budgetId, addedBy = null) {
  // БСО (бланк строгой отчётности, code 4) лежит под ключом bso — структура та же, что у чека
  const doc = row?.ticket?.document ?? row?.document ?? row;
  const receipt = doc?.receipt ?? doc?.bso ?? row?.receipt;
  const fiscalDrive = str(receipt?.fiscalDriveNumber);
  const purchasedAt = toIsoLocal(receipt?.dateTime);
  if (!receipt || !fiscalDrive || !purchasedAt) return null;

  const items = Array.isArray(receipt.items) ? receipt.items : [];
  const itemsSum = items.reduce((acc, it) => acc + int(it?.sum), 0);

  const values = {
    budget_id: budgetId,
    added_by: addedBy,
    source_id: str(row?._id) ?? null,
    fiscal_drive: fiscalDrive,
    fiscal_doc: int(receipt.fiscalDocumentNumber),
    fiscal_sign: int(receipt.fiscalSign),
    created_at: str(row?.createdAt) ?? null,
    purchased_at: purchasedAt,
    purchased_date: purchasedAt.slice(0, 10),
    seller: str(receipt.user) ?? null,
    seller_inn: str(receipt.userInn) ?? null,
    retail_place: str(receipt.retailPlace) ?? null,
    retail_address: str(receipt.retailPlaceAddress) ?? null,
    place_key: placeKey(receipt.retailPlaceAddress),
    kkt_reg_id: str(receipt.kktRegId) ?? null,
    operation_type: int(receipt.operationType) || 1,
    taxation_type: int(receipt.appliedTaxationType ?? receipt.taxationType),
    total_sum: int(receipt.totalSum),
    cash_sum: int(receipt.cashTotalSum),
    ecash_sum: int(receipt.ecashTotalSum),
    prepaid_sum: int(receipt.prepaidSum),
    credit_sum: int(receipt.creditSum),
    provision_sum: int(receipt.provisionSum),
    // расчётные ставки (18/118, 10/110) кладём в тот же процентный «карман»
    nds_18: int(receipt.nds18) + int(receipt.nds18118),
    nds_10: int(receipt.nds10) + int(receipt.nds10110),
    nds_0: int(receipt.nds0),
    nds_no: int(receipt.ndsNo),
    shift_number: int(receipt.shiftNumber),
    request_number: int(receipt.requestNumber),
    operator: str(receipt.operator) ?? null,
    buyer: str(receipt.buyerPhoneOrAddress) ?? null,
    internet_sign: int(receipt.internetSign),
    item_count: items.length,
    items_sum: itemsSum,
    raw: JSON.stringify(receipt),
  };

  const existing = stmts.findReceipt.get(budgetId, values.fiscal_drive, values.fiscal_doc, values.fiscal_sign);
  let receiptId;
  let created = false;
  if (existing) {
    stmts.updateReceipt.run({ ...values, id: existing.id });
    stmts.deleteItems.run(existing.id);
    receiptId = existing.id;
  } else {
    const res = stmts.insertReceipt.run(values);
    receiptId = Number(res.lastInsertRowid);
    created = true;
  }

  const itemIds = [];
  items.forEach((it, index) => {
    const saved = stmts.insertItem.run({
      receipt_id: receiptId,
      pos: index + 1,
      name: str(it?.name) ?? '',
      name_norm: normalizeName(it?.name),
      quantity: num(it?.quantity) || 1,
      unit: str(it?.unit) ?? null,
      price: int(it?.price),
      sum: int(it?.sum),
      nds: it?.nds == null ? null : int(it.nds),
      nds_sum: it?.ndsSum == null ? null : int(it.ndsSum),
      product_type: it?.productType == null ? null : int(it.productType),
      payment_type: it?.paymentType == null ? null : int(it.paymentType),
      gtin: it?.productCodeData?.gtin == null ? null : String(it.productCodeData.gtin),
      provider_inn: str(it?.providerInn) ?? null,
    });
    itemIds.push(Number(saved.lastInsertRowid));
  });

  return { id: receiptId, itemIds, created };
}

function importFile(db, file, stmts, budgetId, addedBy) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [parsed];

  let seen = 0;
  let created = 0;
  let updated = 0;
  let itemsTotal = 0;
  let skipped = 0;

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const saved = saveReceipt(db, row, stmts, budgetId, addedBy);
      if (!saved) {
        skipped += 1;
        continue;
      }
      seen += 1;
      itemsTotal += saved.itemIds.length;
      if (saved.created) created += 1;
      else updated += 1;
    }

    stmts.logImport.run(basename(file), new Date().toISOString(), seen, created, updated, itemsTotal);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { seen, created, updated, itemsTotal, skipped };
}

/** Подготовленные запросы импорта. Нужны и файловому импорту, и очереди сканирования. */
export function importStatements(db) {
  const stmts = {
    findReceipt: db.prepare(
      'SELECT id FROM receipts WHERE budget_id = ? AND fiscal_drive = ? AND fiscal_doc = ? AND fiscal_sign = ?',
    ),
    insertReceipt: db.prepare(`
      INSERT INTO receipts (
        budget_id, added_by, source_id, fiscal_drive, fiscal_doc, fiscal_sign, created_at, purchased_at, purchased_date,
        seller, seller_inn, retail_place, retail_address, place_key, kkt_reg_id, operation_type, taxation_type,
        total_sum, cash_sum, ecash_sum, prepaid_sum, credit_sum, provision_sum,
        nds_18, nds_10, nds_0, nds_no, shift_number, request_number, operator, buyer, internet_sign,
        item_count, items_sum, raw
      ) VALUES (
        :budget_id, :added_by, :source_id, :fiscal_drive, :fiscal_doc, :fiscal_sign, :created_at, :purchased_at, :purchased_date,
        :seller, :seller_inn, :retail_place, :retail_address, :place_key, :kkt_reg_id, :operation_type, :taxation_type,
        :total_sum, :cash_sum, :ecash_sum, :prepaid_sum, :credit_sum, :provision_sum,
        :nds_18, :nds_10, :nds_0, :nds_no, :shift_number, :request_number, :operator, :buyer, :internet_sign,
        :item_count, :items_sum, :raw
      )`),
    updateReceipt: db.prepare(`
      UPDATE receipts SET
        source_id = :source_id, created_at = :created_at, purchased_at = :purchased_at,
        purchased_date = :purchased_date, seller = :seller, seller_inn = :seller_inn,
        retail_place = :retail_place, retail_address = :retail_address, place_key = :place_key, kkt_reg_id = :kkt_reg_id,
        operation_type = :operation_type, taxation_type = :taxation_type, total_sum = :total_sum,
        cash_sum = :cash_sum, ecash_sum = :ecash_sum, prepaid_sum = :prepaid_sum,
        credit_sum = :credit_sum, provision_sum = :provision_sum, nds_18 = :nds_18, nds_10 = :nds_10,
        nds_0 = :nds_0, nds_no = :nds_no, shift_number = :shift_number, request_number = :request_number,
        operator = :operator, buyer = :buyer, internet_sign = :internet_sign, item_count = :item_count,
        items_sum = :items_sum, raw = :raw
      WHERE id = :id`),
    deleteItems: db.prepare('DELETE FROM items WHERE receipt_id = ?'),
    insertItem: db.prepare(`
      INSERT INTO items (
        receipt_id, pos, name, name_norm, quantity, unit, price, sum,
        nds, nds_sum, product_type, payment_type, gtin, provider_inn
      ) VALUES (
        :receipt_id, :pos, :name, :name_norm, :quantity, :unit, :price, :sum,
        :nds, :nds_sum, :product_type, :payment_type, :gtin, :provider_inn
      )`),
    logImport: db.prepare(`
      INSERT INTO imports (file, imported_at, receipts_seen, receipts_new, receipts_upd, items_total)
      VALUES (?, ?, ?, ?, ?, ?)`),
  };

  // UPDATE не трогает ключ ФН/ФД/ФП, но получает тот же объект значений, что и INSERT.
  stmts.updateReceipt.setAllowUnknownNamedParameters(true);
  return stmts;
}

export function runImport(files, login = null) {
  const db = openDb();
  migrate(db);
  const user = login
    ? db.prepare('SELECT id, login, budget_id FROM users WHERE login = ?').get(login)
    : db.prepare('SELECT id, login, budget_id FROM users ORDER BY id LIMIT 1').get();
  if (!user) throw new Error(login ? `нет пользователя «${login}»` : 'нет ни одного пользователя — заведите: users.mjs --add');
  console.log(`чеки пользователя «${user.login}» — в его бюджет #${user.budget_id}`);
  const stmts = importStatements(db);

  const totals = { seen: 0, created: 0, updated: 0, itemsTotal: 0, skipped: 0 };
  for (const file of files) {
    if (!statSync(file).isFile()) continue;
    const res = importFile(db, file, stmts, user.budget_id, user.id);
    console.log(
      `${basename(file)}: чеков ${res.seen} (новых ${res.created}, обновлено ${res.updated}), ` +
        `позиций ${res.itemsTotal}${res.skipped ? `, пропущено записей ${res.skipped}` : ''}`,
    );
    for (const key of Object.keys(totals)) totals[key] += res[key];
  }

  const stats = db
    .prepare('SELECT COUNT(*) c, MIN(purchased_date) a, MAX(purchased_date) b FROM receipts WHERE budget_id = ?')
    .get(user.budget_id);
  const itemCount = db
    .prepare('SELECT COUNT(*) c FROM items i JOIN receipts r ON r.id = i.receipt_id WHERE r.budget_id = ?')
    .get(user.budget_id).c;
  console.log(`\nБаза: ${DB_PATH}`);
  console.log(`В бюджете: чеков ${stats.c}, позиций ${itemCount}, период ${stats.a} — ${stats.b}`);
  db.close();
  return totals;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--user');
  const login = at >= 0 ? argv[at + 1] : null;
  runImport(collectFiles(at >= 0 ? argv.filter((_, i) => i !== at && i !== at + 1) : argv), login);
}
