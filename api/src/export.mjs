// Экспорт бюджета целиком: архив CSV для Excel — расходы, доходы, категории. Без фильтров и
// периода: в таблице человек сам разберётся, что ему нужно. Общий бюджет — со всеми тратами
// всех участников. Формат CSV — как у выгрузки кабинета (/api/export.csv): разделитель «;»,
// десятичная запятая, BOM — Excel открывает по двойному щелчку, без мастера импорта.
//
// Архив собирается здесь же, без библиотек: ZIP со сжатием deflate (zlib) и именами в UTF-8.
import { deflateRawSync, crc32 } from 'node:zlib';
import { listItems } from './queries.mjs';
import { spendingPurchases, listIncome } from './spending.mjs';

const SOURCE_NAMES = { receipt: 'чек', market: 'маркетплейс', manual: 'вручную', bank: 'банк' };
// Ставка НДС — как в выгрузке кабинета (server.mjs, NDS_LABELS); незнакомый код — числом
const NDS = { 1: '20%', 2: '10%', 3: '20/120', 4: '10/110', 5: '0%', 6: 'без НДС' };
const nds = (code) => NDS[code] ?? (code == null ? '' : String(code));

const money = (kopecks) => (Number(kopecks ?? 0) / 100).toFixed(2).replace('.', ',');
const cell = (value) => {
  const s = value == null ? '' : String(value);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV для Excel: BOM, «;», строки через CRLF. */
function csv(header, rows) {
  const lines = [header.join(';'), ...rows.map((r) => r.map(cell).join(';'))];
  return Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(lines.join('\r\n'), 'utf8')]);
}

/** Комментарии к покупкам: у позиции чека — по чеку и номеру позиции, у операции банка — свой. */
function notes(db, budgetId) {
  const items = new Map(
    db.prepare(
      `SELECT n.receipt_id, n.pos, n.note FROM item_notes n JOIN receipts r ON r.id = n.receipt_id WHERE r.budget_id = ?`,
    ).all(budgetId).map((n) => [`${n.receipt_id}:${n.pos}`, n.note]),
  );
  const ops = new Map(
    db.prepare('SELECT id, note FROM bank_ops WHERE budget_id = ? AND note IS NOT NULL').all(budgetId).map((o) => [o.id, o.note]),
  );
  return { items, ops };
}

function spendingCsv(db, budgetId, note) {
  const rows = spendingPurchases(db, budgetId, new URLSearchParams(), listItems);
  return csv(
    ['Дата', 'Время', 'Источник', 'Трата', 'Группа', 'Категория', 'Кол-во', 'Цена, ₽', 'Сумма, ₽', 'НДС', 'GTIN',
      'Продавец', 'ИНН', 'Точка', 'Счёт', 'Чек', 'Комментарий'],
    rows.map((r) => {
      const bank = r.source === 'bank';
      return [
        r.purchased_at.slice(0, 10),
        r.purchased_at.slice(11, 16),
        SOURCE_NAMES[r.source],
        r.name,
        r.group_name ?? '',
        r.category_name ?? '',
        bank ? '' : String(r.quantity).replace('.', ','),
        bank ? '' : money(r.price),
        money(r.sum),
        bank ? '' : nds(r.nds),
        r.gtin ?? '',
        bank ? '' : r.seller ?? '',
        bank ? '' : r.seller_inn ?? '',
        bank ? '' : r.retail_place ?? '',
        r.account_name ?? '',
        r.receipt_id ?? '',
        (bank ? note.ops.get(r.op_id) : note.items.get(`${r.receipt_id}:${r.pos}`)) ?? '',
      ];
    }),
  );
}

function incomeCsv(db, budgetId, note) {
  // Постранично: страница ограничена (MAX_PER_PAGE), а нужно всё
  const rows = [];
  for (let page = 1; ; page += 1) {
    const chunk = listIncome(db, budgetId, new URLSearchParams({ per: '500', page: String(page) })).rows;
    rows.push(...chunk);
    if (chunk.length < 500) break;
  }
  const cats = new Map(
    db.prepare(
      `SELECT c.slug, c.name, g.name AS group_name FROM income_cats c
         LEFT JOIN income_groups g ON g.budget_id = c.budget_id AND g.slug = c.group_slug
        WHERE c.budget_id = ?`,
    ).all(budgetId).map((c) => [c.slug, c]),
  );
  return csv(
    ['Дата', 'Время', 'Откуда', 'Описание', 'Группа', 'Категория', 'Счёт', 'Сумма, ₽', 'Комментарий'],
    rows.map((r) => {
      const c = cats.get(r.category_slug);
      return [
        r.purchased_at.slice(0, 10),
        r.purchased_at.slice(11, 16),
        r.name,
        r.description ?? '',
        c?.group_name ?? '',
        c?.name ?? '',
        r.account_name ?? '',
        money(r.sum),
        note.ops.get(r.op_id) ?? '',
      ];
    }),
  );
}

/** Справочник: расходы и доходы, группа и категория — в том порядке, что на экране. */
function categoriesCsv(db, budgetId) {
  const spend = db.prepare(
    `SELECT g.name AS group_name, c.name FROM categories c
       JOIN groups g ON g.budget_id = c.budget_id AND g.slug = c.group_slug
      WHERE c.budget_id = ? ORDER BY g.sort, c.sort`,
  ).all(budgetId);
  const income = db.prepare(
    `SELECT g.name AS group_name, c.name FROM income_cats c
       JOIN income_groups g ON g.budget_id = c.budget_id AND g.slug = c.group_slug
      WHERE c.budget_id = ? ORDER BY g.sort, c.sort`,
  ).all(budgetId);
  return csv(['Вид', 'Группа', 'Категория'], [
    ...spend.map((c) => ['расход', c.group_name, c.name]),
    ...income.map((c) => ['доход', c.group_name, c.name]),
  ]);
}

/** ZIP: файлы со сжатием deflate, имена в UTF-8 (флаг 11), время — сейчас. */
function zip(files) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // версия для распаковки
    head.writeUInt16LE(0x0800, 6); // имена в UTF-8
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    locals.push(head, nameBuf, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += head.length + nameBuf.length + packed.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBuf, end]);
}

/** Архив бюджета: { name, data } — имя файла с датой выгрузки и сам ZIP. */
export function exportBudget(db, budgetId, now = new Date()) {
  const note = notes(db, budgetId);
  const day = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  const data = zip([
    { name: 'Расходы.csv', data: spendingCsv(db, budgetId, note) },
    { name: 'Доходы.csv', data: incomeCsv(db, budgetId, note) },
    { name: 'Категории.csv', data: categoriesCsv(db, budgetId) },
  ]);
  return { name: `checker-${day}.zip`, data };
}
