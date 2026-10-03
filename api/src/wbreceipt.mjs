// Чек Wildberries: страница receipt.wb.ru (обычный HTML, без входа) → объект в формате чека
// ФНС, как у ozonpdf.mjs. Страницу скачивает приложение по ссылке из списка «Электронные чеки».
//
// Устройство страницы: шапка (вид операции, продавец, ИНН, сайт, дата), товары блоками
// products-item (номер, название, служебный код, цена, количество, сумма, НДС, способ расчёта,
// продавец-поверенный) и подвал парами «property-name → property-value» (Итого, Электронными,
// РН ККТ, № ФД, № ФН, ФПД).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#34': '"', '#39': "'", '#43': '+' };

const decode = (s) =>
  s.replace(/&(#?\w+);/g, (m, name) => ENTITIES[name] ?? (name.startsWith('#') ? String.fromCodePoint(Number(name.slice(1))) : m));

/** Текст куска страницы построчно: без тегов, пустых строк и лишних пробелов. */
const lines = (html) =>
  decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '\n'))
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

// «4096.00» → копейки
const money = (s) => {
  const m = String(s ?? '').replace(/\s/g, '').match(/^(\d+)[.,](\d{2})$/);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
};

/** Подвал: «Итого» → «8580.00» и так далее, по парам property-name/property-value. */
function properties(html) {
  const out = new Map();
  const re = /class="property-name[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div class="property-value[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  for (const m of html.matchAll(re)) {
    const name = lines(m[1]).join(' ');
    if (!out.has(name)) out.set(name, lines(m[2]).join(' '));
  }
  return out;
}

/**
 * Служебный код позиции WB под названием: «eBR.r5819…0.0» или числовой «7102204579419043225.0.0».
 * В название он не входит — иначе название не узнать ни словарём, ни по похожим.
 */
export const WB_CODE = /^(\w+\.)?r?[0-9a-f]{12,}\.\d+\.\d+$/i;

/** Один товар: блок products-item. */
function item(block) {
  const l = lines(block);
  // [№, название…, код вида eBR.r….0.0, цена, кол., сумма, НДС, способ расчёта, …]
  const codeAt = l.findIndex((s) => WB_CODE.test(s));
  const priceAt = l.findIndex((s, i) => i > 1 && money(s) != null);
  if (priceAt < 0) return null;
  const nameEnd = codeAt > 0 && codeAt < priceAt ? codeAt : priceAt;
  const name = l.slice(1, nameEnd).join(' ').trim();
  const price = money(l[priceAt]);
  const quantity = Number(String(l[priceAt + 1]).replace(',', '.')) || 1;
  const sum = money(l[priceAt + 2]) ?? price;
  const innAt = l.findIndex((s) => s.startsWith('ИНН продавца'));
  const providerInn = innAt < 0 ? null : l[innAt].replace(/\D/g, '');
  const provider = innAt < 0 ? null : l[innAt + 1];
  return {
    name,
    quantity,
    price,
    sum,
    ...(providerInn ? { providerInn } : {}),
    ...(provider ? { providerData: { providerName: provider } } : {}),
  };
}

/**
 * Страница чека WB → чек в формате ФНС (то, что понимает saveReceipt).
 * Бросает ошибку, если нет реквизитов — значит, шаблон другой.
 */
export function parseWbHtml(html) {
  const text = String(html ?? '');
  const props = properties(text);
  const fn = props.get('№ ФН');
  const fd = props.get('№ ФД');
  const fp = props.get('ФПД');
  const total = money(props.get('Итого'));
  const all = lines(text);
  const when = all.find((l) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(l));
  if (!when || !/^\d{16}$/.test(fn ?? '') || !/^\d+$/.test(fd ?? '') || !/^\d+$/.test(fp ?? '') || total == null) {
    throw new Error('не похоже на чек Wildberries: нет реквизитов');
  }

  const items = text
    .split(/<div class="products-item\b/)
    .slice(1)
    .map((block) => item(block.slice(block.indexOf('>') + 1).split(/<div class="section"/)[0]))
    .filter(Boolean);

  // Шапка: вид операции, продавец, «ИНН …», сайт — до таблицы товаров
  const head = lines(text.split(/class="products-header"/)[0]);
  const kind = head.find((l) => /^(Приход|Возврат прихода|Расход|Возврат расхода)$/.test(l)) ?? 'Приход';
  const innAt = head.findIndex((l) => /^ИНН \d{10,12}$/.test(l));
  const prepaid = [...props].find(([name]) => /предоплат|аванс/i.test(name));

  return {
    dateTime: `${when.replace(' ', 'T')}:00`,
    fiscalDriveNumber: fn,
    fiscalDocumentNumber: Number(fd),
    fiscalSign: Number(fp),
    operationType: { Приход: 1, 'Возврат прихода': 2, Расход: 3, 'Возврат расхода': 4 }[kind],
    totalSum: total,
    // Зачёт предоплаты — деньги уже учтены чеком аванса, второй раз не считаются
    prepaidSum: prepaid ? money(prepaid[1]) ?? 0 : 0,
    ecashTotalSum: money(props.get('Электронными')) ?? 0,
    cashTotalSum: money(props.get('Наличными')) ?? 0,
    user: innAt > 0 ? head[innAt - 2] ?? head[innAt - 1] : 'Wildberries',
    userInn: innAt >= 0 ? head[innAt].slice(4) : null,
    retailPlace: head.find((l) => /wildberries/i.test(l) && !/\s/.test(l)) ?? 'wildberries.ru',
    kktRegId: props.get('РН ККТ') ?? null,
    requestNumber: Number(head.find((l) => /^Чек №\d+$/.test(l))?.replace(/\D/g, '')) || null,
    shiftNumber: Number(head.find((l) => /^Смена №\d+$/.test(l))?.replace(/\D/g, '')) || null,
    internetSign: 1,
    items,
  };
}
