// Чек Озона из PDF — в том же виде, в каком чеки приходят из ФНС, чтобы дальше он шёл обычным
// путём импорта (saveReceipt): категории, защита от повторов по ФН/ФД/ФП, склейка с банком.
//
// Озон отдаёт чеки только PDF-файлами («Электронные чеки» в личном кабинете). Все они собраны
// по одному шаблону: страница, текст обычными строками, у шрифтов есть таблица соответствия
// знакам (ToUnicode). Поэтому разбор свой и короткий — без библиотек: распаковать потоки
// (zlib), перевести строки через таблицы шрифтов и прочитать чек по строкам.
//
// Изменит Озон шаблон — parseOzonPdf вернёт ошибку, а не кривой чек: без ФН, ФД, ФП, даты и
// итога чек не сохраняется.

import { inflateSync } from 'node:zlib';

const latin = (buf) => buf.toString('latin1');

/** Объекты PDF: номер → содержимое, включая упакованные в потоки объектов (ObjStm). */
function objects(pdf) {
  const objs = new Map();
  const re = /(\d+) 0 obj([\s\S]*?)endobj/g;
  const text = latin(pdf);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[0].indexOf('obj') + 3;
    objs.set(Number(m[1]), pdf.subarray(start, start + m[2].length));
  }
  for (const body of [...objs.values()]) {
    if (!latin(body).includes('/ObjStm')) continue;
    const first = Number(latin(body).match(/\/First (\d+)/)[1]);
    const s = stream(body);
    const head = latin(s.subarray(0, first)).trim().split(/\s+/).map(Number);
    for (let i = 0; i < head.length; i += 2) {
      const end = i + 3 < head.length ? head[i + 3] : s.length - first;
      objs.set(head[i], s.subarray(first + head[i + 1], first + end));
    }
  }
  return objs;
}

/** Распакованное содержимое потока объекта. */
function stream(body) {
  const text = latin(body);
  const at = text.search(/stream\r?\n/);
  if (at < 0) return Buffer.alloc(0);
  const start = at + text.slice(at).match(/stream\r?\n/)[0].length;
  const end = text.lastIndexOf('endstream');
  let data = body.subarray(start, end);
  // Перевод строки перед endstream в данные не входит
  while (data.length && (data[data.length - 1] === 0x0a || data[data.length - 1] === 0x0d)) data = data.subarray(0, -1);
  return /\/FlateDecode/.test(text.slice(0, at)) ? inflateSync(data) : data;
}

/** Таблица шрифта: код глифа → знак (из ToUnicode). */
function toUnicode(body) {
  const map = new Map();
  const t = latin(stream(body));
  for (const [, block] of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, a, u] of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(a, 16), utf16(u));
  }
  for (const [, block] of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, a, z, u] of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      for (let k = parseInt(a, 16); k <= parseInt(z, 16); k += 1) map.set(k, String.fromCodePoint(parseInt(u, 16) + k - parseInt(a, 16)));
    }
  }
  return map;
}

const utf16 = (hex) => Buffer.from(hex, 'hex').swap16().toString('utf16le');

/** Строка PDF в скобках: снимаем экранирование — \n, \(, \\ и восьмеричные \ddd. */
function unescape(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== 0x5c || i + 1 >= s.length) {
      out.push(s[i]);
      continue;
    }
    const n = s[i + 1];
    if (n >= 0x30 && n <= 0x37) {
      let j = i + 1;
      while (j < s.length && j < i + 4 && s[j] >= 0x30 && s[j] <= 0x37) j += 1;
      out.push(parseInt(latin(s.subarray(i + 1, j)), 8) & 0xff);
      i = j - 1;
    } else {
      out.push({ 0x6e: 10, 0x72: 13, 0x74: 9 }[n] ?? n);
      i += 1;
    }
  }
  return Buffer.from(out);
}

/** Текст страницы — строками, в порядке вывода. */
export function pdfLines(pdf) {
  const objs = objects(pdf);
  const page = [...objs.values()].find((b) => /\/Type \/Page\b/.test(latin(b)));
  if (!page) throw new Error('в PDF нет страницы');
  const pageText = latin(page);
  const fonts = new Map();
  const fontBlock = pageText.match(/\/Font <<([\s\S]*?)>>/)?.[1] ?? '';
  for (const [, name, num] of fontBlock.matchAll(/\/([^\s/]+) (\d+) 0 R/g)) {
    const tu = latin(objs.get(Number(num)) ?? Buffer.alloc(0)).match(/\/ToUnicode (\d+) 0 R/);
    if (tu) fonts.set(name, toUnicode(objs.get(Number(tu[1]))));
  }
  const contents = [...(pageText.match(/\/Contents \[?([^\]/]*)/)?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  const raw = Buffer.concat(contents.map((n) => stream(objs.get(n))));

  // Идём по байтам: шрифт меняется оператором Tf, строки выводятся (…) ' или (…) Tj
  const lines = [];
  let font = null;
  const text = latin(raw);
  const re = /\/(\S+) [\d.]+ Tf|\(((?:\\[\s\S]|[^\\)])*)\)\s*(?:'|Tj)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1]) {
      font = fonts.get(m[1]) ?? null;
      continue;
    }
    const start = m.index + 1;
    const bytes = unescape(raw.subarray(start, start + Buffer.byteLength(m[2], 'latin1')));
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) s += font?.get((bytes[i] << 8) | bytes[i + 1]) ?? '';
    lines.push(s.trim());
  }
  return lines.filter(Boolean);
}

// Деньги в чеке: «1774,00», «≡1774,00» (значок «≡» в таблице шрифта бывает не описан) → копейки
const money = (s) => {
  const m = String(s ?? '').replace(/\s/g, '').match(/(\d+)[,.](\d{2})$/);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
};

/** Сумма из строки после подписи: «ИТОГ» → следующая строка с деньгами. */
const after = (lines, label) => {
  const i = lines.findIndex((l) => l === label || l.startsWith(`${label} `));
  if (i < 0) return null;
  for (let j = i + 1; j < Math.min(lines.length, i + 3); j += 1) {
    const v = money(lines[j]);
    if (v != null) return v;
  }
  return null;
};

/** Значение после подписи «ФН:», «ФД:», «ФПД:» — следующая строка. */
const field = (lines, label) => {
  const i = lines.indexOf(label);
  return i >= 0 ? lines[i + 1] ?? null : null;
};

/**
 * Чек Озона → объект в формате чека ФНС (receipt): то, что понимает saveReceipt.
 * Бросает ошибку, если не нашлись реквизиты — значит, шаблон другой.
 */
export function parseOzonPdf(pdf) {
  const lines = pdfLines(pdf);
  const when = lines.find((l) => /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/.test(l));
  const fn = field(lines, 'ФН:');
  const fd = field(lines, 'ФД:');
  const fp = field(lines, 'ФПД:');
  const total = after(lines, 'ИТОГ');
  if (!when || !/^\d{16}$/.test(fn ?? '') || !/^\d+$/.test(fd ?? '') || !/^\d+$/.test(fp ?? '') || total == null) {
    throw new Error('не похоже на чек Озона: нет реквизитов');
  }
  const [d, t] = when.split(' ');
  const [day, month, year] = d.split('.');

  // Товары: «1.» → название (строк может быть несколько) → «1 x 1774,00» → сумма. Ниже —
  // НДС и продавец позиции; блок кончается на следующем номере или на «ИТОГ»
  const items = [];
  const end = lines.indexOf('ИТОГ');
  for (let i = 0; i < end; i += 1) {
    if (!/^\d+\.$/.test(lines[i])) continue;
    const qtyAt = lines.slice(i + 1, end).findIndex((l) => /^[\d,.]+ x [\d\s,.]+$/.test(l));
    if (qtyAt < 0) continue;
    const name = lines.slice(i + 1, i + 1 + qtyAt).join(' ').trim();
    const [qty, price] = lines[i + 1 + qtyAt].split(' x ');
    const sum = money(lines[i + 2 + qtyAt]);
    const block = lines.slice(i + 3 + qtyAt, (() => {
      const next = lines.slice(i + 1, end).findIndex((l) => /^\d+\.$/.test(l));
      return next < 0 ? end : i + 1 + next;
    })());
    // Продавец позиции — строка после «ИНН продавца:»; у Озона он указан не у каждой
    const innAt = block.findIndex((l) => l.startsWith('ИНН продавца:'));
    const providerInn = innAt < 0 ? null : block[innAt].replace('ИНН продавца:', '').trim();
    const provider = innAt < 0 ? null : block[innAt + 1];
    items.push({
      name,
      quantity: Number(qty.replace(',', '.')) || 1,
      price: money(price) ?? sum,
      sum,
      ...(providerInn && /^\d+$/.test(providerInn) && !/^0+$/.test(providerInn) ? { providerInn } : {}),
      ...(provider ? { providerData: { providerName: provider } } : {}),
    });
  }

  const refund = lines.includes('Возврат прихода');
  return {
    dateTime: `${year}-${month}-${day}T${t}:00`,
    fiscalDriveNumber: fn,
    fiscalDocumentNumber: Number(fd),
    fiscalSign: Number(fp),
    operationType: refund ? 2 : 1,
    totalSum: total,
    // «Зачет предварительной оплаты» — чек о получении: деньги уже учтены авансовым чеком
    prepaidSum: after(lines, 'Зачет предварительной оплаты') ?? 0,
    ecashTotalSum: after(lines, 'Безналичными') ?? 0,
    user: lines.find((l) => /ООО|ОАО|АО\b/.test(l) && !l.startsWith('ИНН')) ?? 'Интернет Решения, ООО',
    userInn: lines.find((l) => /^ИНН \d{10,12}$/.test(l))?.slice(4) ?? null,
    retailPlace: lines.find((l) => /^https?:\/\//.test(l)) ?? 'https://www.ozon.ru/',
    kktRegId: field(lines, 'РН ККТ:'),
    requestNumber: Number(lines.find((l) => l.startsWith('Кассовый чек №'))?.replace(/\D/g, '')) || null,
    internetSign: 1,
    items,
  };
}
