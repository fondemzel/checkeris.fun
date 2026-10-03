// Предоплата: магазин выдаёт два чека на одну покупку. Чек оплаты (аванс) — при заказе, по нему
// уходят деньги. Чек получения — при выдаче, с «зачётом предоплаты»: те же товары, денег нет.
// Считать деньги нужно один раз, а показывать — один набор товаров:
//
//   — чек получения повторяет товары своего чека оплаты → это дубль: не считается и не видно
//     в ленте (receipts.prepay_kind = 'dup');
//   — чек оплаты безликий («Получение аванса» одной строкой), а товары — только в чеке
//     получения → считаем товары чека получения, а «Получение аванса» — нет
//     (receipts.prepaid_by у чека получения указывает на чек оплаты);
//   — пары не нашлось (чека оплаты нет) → как раньше: товары видны, в сумму не входят.
//
// Связь ищем у любого продавца по общим признакам чека, это не правила для кого-то одного.

const PLACEHOLDER = /получение аванса|предоплат|^аванс/i;
const SERVICE = /доставк|обработка заказа|сборка заказа/i; // у чека оплаты их может не быть
const WINDOW = 90 * 24 * 3600 * 1000; // чек получения — не позже трёх месяцев после оплаты
const MAX_PARTS = 12; // столько чеков получения перебираем, собирая сумму аванса

const t = (iso) => Date.parse(iso);

/** Набор чеков получения ровно на сумму аванса: по порядку времени, перебором. */
function subsetFor(total, list) {
  const pool = list.slice(0, MAX_PARTS);
  const pick = [];
  const walk = (i, left) => {
    if (left === 0) return true;
    if (i >= pool.length || left < 0) return false;
    pick.push(pool[i]);
    if (walk(i + 1, left - pool[i].prepaid_sum)) return true;
    pick.pop();
    return walk(i + 1, left);
  };
  return walk(0, total) ? pick : null;
}

/** Разметить пары «оплата — получение» бюджета заново. Быстро: всё в памяти, один проход. */
export function linkPrepaid(db, budgetId) {
  const receipts = db
    .prepare(
      `SELECT id, seller_inn, purchased_at, total_sum, prepaid_sum, prepay_kind, prepaid_by FROM receipts
        WHERE budget_id = ? AND operation_type = 1 AND fiscal_drive <> 'manual'
        ORDER BY purchased_at, id`,
    )
    .all(budgetId);
  const settles = receipts.filter((r) => r.prepaid_sum > 0);
  if (!settles.length) return { dup: 0, paid: 0 };

  const items = new Map();
  for (const i of db
    .prepare(
      `SELECT i.receipt_id, i.name, i.name_norm FROM items i JOIN receipts r ON r.id = i.receipt_id
        WHERE r.budget_id = ? AND r.operation_type = 1`,
    )
    .all(budgetId)) {
    if (!items.has(i.receipt_id)) items.set(i.receipt_id, []);
    items.get(i.receipt_id).push(i);
  }
  const advances = receipts.filter((r) => r.prepaid_sum === 0);
  const placeholder = (r) => (items.get(r.id) ?? []).length > 0 && items.get(r.id).every((i) => PLACEHOLDER.test(i.name));
  const before = (s) => advances.filter((a) =>
    a.seller_inn === s.seller_inn && t(a.purchased_at) <= t(s.purchased_at) && t(s.purchased_at) - t(a.purchased_at) < WINDOW);

  const result = new Map(); // id чека получения → { kind, by }
  // 1. Дубли: товары чека получения уже есть в чеке оплаты того же продавца
  for (const s of settles) {
    const names = new Set(before(s).flatMap((a) => (items.get(a.id) ?? []).map((i) => i.name_norm)));
    const goods = (items.get(s.id) ?? []).filter((i) => !SERVICE.test(i.name));
    const hit = goods.filter((i) => names.has(i.name_norm)).length;
    if (goods.length && hit >= Math.ceil(goods.length / 2)) result.set(s.id, { kind: 'dup', by: null });
  }
  // 2. Безликий аванс: чеки получения, которые в сумме дают ровно его
  for (const a of advances.filter(placeholder)) {
    const after = settles.filter((s) =>
      !result.has(s.id) && s.seller_inn === a.seller_inn
      && t(s.purchased_at) >= t(a.purchased_at) && t(s.purchased_at) - t(a.purchased_at) < WINDOW);
    const parts = subsetFor(a.total_sum, after);
    if (parts) for (const s of parts) result.set(s.id, { kind: 'paid', by: a.id });
  }

  const save = db.prepare('UPDATE receipts SET prepay_kind = ?, prepaid_by = ? WHERE id = ?');
  let dup = 0;
  let paid = 0;
  for (const s of settles) {
    const r = result.get(s.id) ?? { kind: null, by: null };
    if (r.kind === 'dup') dup += 1;
    if (r.kind === 'paid') paid += 1;
    if (r.kind !== s.prepay_kind || r.by !== s.prepaid_by) save.run(r.kind, r.by, s.id);
  }
  return { dup, paid };
}
