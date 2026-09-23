// Операции разных банков → один вид строки bank_ops.
//
// Каждый банк описан двумя вещами:
//   fields — какие поля его ответа храним. Остальное (логотипы, цвета, служебная аналитика,
//            реквизиты получателей) не нужно и раздувает базу в пять раз. Тот же список
//            есть в приложении (адаптер банка): телефон режет ответ ещё до отправки
//   parse  — сокращённый ответ → поля строки bank_ops
//
// В базе (bank_ops.raw) лежит сокращённый ответ банка, а не результат разбора: разбор
// можно улучшить задним числом, не загружая историю заново.
//
// Новый банк — новая запись в ADAPTERS и адаптер в приложении, остальное общее.

// Время банка — миллисекунды UTC; у чеков — московское время без зоны. Приводим к нему
const moscow = (ms) =>
  ms ? new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).replace(' ', 'T') : null;
const kopecks = (money) => (money?.value == null ? null : Math.round(Math.abs(money.value) * 100));

const ADAPTERS = {
  tbank: {
    fields: [
      'id', 'account', 'accountName', 'type', 'status', 'group', 'subgroup.id', 'subcategory', 'isInner',
      'operationTime.milliseconds', 'debitingTime.milliseconds',
      'amount.value', 'amount.currency.name', 'accountAmount.value', 'accountAmount.currency.name',
      'cardNumber', 'description', 'merchant.name', 'brand.id', 'brand.name', 'merchantKey', 'mcc',
      'spendingCategory.id', 'spendingCategory.name', 'category.name', 'categoryInfo.metacategory.name',
      'senderDetails', 'payment.comment', 'payment.fieldsValues.message', 'payment.fieldsValues.maskedFIO',
      'payment.fieldsValues.recipientShortName', 'payment.fieldsValues.receiverBankName',
      'refund.type', 'hasShoppingReceipt', 'loyaltyBonusSummary.amount',
    ],
    parse: (op) => ({
      ext_id: String(op.id),
      account: String(op.account),
      at: moscow(op.operationTime?.milliseconds),
      debited_at: moscow(op.debitingTime?.milliseconds),
      direction: op.type === 'Debit' ? 'debit' : 'credit',
      amount: kopecks(op.amount) ?? 0,
      currency: op.amount?.currency?.name ?? 'RUB',
      account_amount: kopecks(op.accountAmount),
      status: op.status ?? null,
      op_group: op.group ?? null,
      mcc: Number(op.mcc) || null,
      description: op.description ?? null,
      merchant: op.merchant?.name ?? op.brand?.name ?? null,
      bank_category: op.spendingCategory?.name ?? op.category?.name ?? null,
      card: op.cardNumber ? String(op.cardNumber).slice(-4) : null,
      has_receipt: op.hasShoppingReceipt ? 1 : 0,
    }),
    valid: (op) => Boolean(op?.id && op.operationTime?.milliseconds),
  },
};

export const knownBank = (bank) => Object.hasOwn(ADAPTERS, bank);

/** Оставить только нужные поля. Повторное сокращение ничего не меняет. */
export function trimOp(bank, op) {
  const out = {};
  for (const path of ADAPTERS[bank].fields) {
    const parts = path.split('.');
    let value = op;
    for (const p of parts) value = value?.[p];
    if (value === undefined || value === null || value === '') continue;
    let target = out;
    for (const p of parts.slice(0, -1)) target = target[p] ??= {};
    target[parts.at(-1)] = value;
  }
  return out;
}

export const parseOp = (bank, op) => ADAPTERS[bank].parse(op);
export const validOp = (bank, op) => ADAPTERS[bank].valid(op);
