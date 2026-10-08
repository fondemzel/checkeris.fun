// Траты в валюте. Банк присылает сумму в валюте покупки («70 TRY»), а учёт идёт в рублях:
// без пересчёта 70 лир складывались с рублями как «70 ₽». Здесь каждая валютная операция
// получает рублёвую сумму (amount, currency = RUB), а исходная остаётся рядом
// (orig_amount, orig_currency) — её видно в карточке.
//
// Откуда рубли, по точности:
//   — сам банк: Т-Банк списал с рублёвой карты (accountAmount в RUB), Сбер прислал nationalAmount;
//   — курс ЦБ на день операции: списание с валютной карты (евро → рубли) или банк рублей не дал.
// Курсы ЦБ запоминаются (fx_rates): каждый день спрашиваем один раз.

const RUB = new Set(['RUB', 'RUR']);
const kop = (v) => Math.round(Math.abs(Number(v)) * 100);

/** Курсы ЦБ на день: { EUR: 89.12, TRY: 2.71, … } — рублей за единицу валюты. */
async function ratesOn(db, day) {
  const rows = db.prepare('SELECT code, rub FROM fx_rates WHERE day = ?').all(day);
  if (rows.length) return Object.fromEntries(rows.map((r) => [r.code, r.rub]));
  const [y, m, d] = day.split('-');
  const res = await fetch(`https://www.cbr.ru/scripts/XML_daily.asp?date_req=${d}/${m}/${y}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`ЦБ ответил ${res.status}`);
  // Ответ — XML в windows-1251; нам нужны только латинские коды и числа
  const xml = new TextDecoder('windows-1251').decode(await res.arrayBuffer());
  const out = {};
  for (const v of xml.matchAll(/<Valute[^>]*>([\s\S]*?)<\/Valute>/g)) {
    const code = v[1].match(/<CharCode>(\w+)<\/CharCode>/)?.[1];
    const nominal = Number(v[1].match(/<Nominal>(\d+)<\/Nominal>/)?.[1] ?? 1);
    const value = Number(v[1].match(/<Value>([\d,]+)<\/Value>/)?.[1]?.replace(',', '.'));
    if (code && value) out[code] = value / nominal;
  }
  if (!Object.keys(out).length) throw new Error('ЦБ не дал курсов');
  const save = db.prepare('INSERT OR REPLACE INTO fx_rates (day, code, rub) VALUES (?, ?, ?)');
  for (const [code, rub] of Object.entries(out)) save.run(day, code, rub);
  return out;
}

/** Рублёвая сумма операции в копейках или null, если узнать нельзя. */
async function rubOf(db, op, bank) {
  const raw = JSON.parse(op.raw ?? '{}');
  if (bank === 'tbank') {
    const acc = raw.accountAmount;
    if (RUB.has(acc?.currency?.name)) return kop(acc.value);
    // Списали с валютной карты — переводим списанное (оно точнее суммы покупки)
    if (acc?.value != null && acc?.currency?.name) {
      const rates = await ratesOn(db, op.at.slice(0, 10));
      const rate = rates[acc.currency.name];
      return rate ? kop(acc.value * rate) : null;
    }
  }
  if (bank === 'sber' && RUB.has(raw.nationalAmount?.currencyCode)) return kop(raw.nationalAmount.amount);
  const rates = await ratesOn(db, op.at.slice(0, 10));
  const rate = rates[op.currency];
  return rate ? Math.round(op.amount * rate) : null;
}

/**
 * Перевести в рубли валютные операции, которые ещё не переведены. Идемпотентно: повторная
 * загрузка операции снова ставит ей валюту банка — и она переводится заново.
 */
export async function convertForeign(db) {
  const ops = db
    .prepare(
      `SELECT o.id, o.at, o.amount, o.currency, o.raw, l.bank FROM bank_ops o JOIN bank_links l ON l.id = o.link_id
        WHERE o.currency NOT IN ('RUB', 'RUR') AND o.amount <> 0`,
    )
    .all();
  const save = db.prepare(
    "UPDATE bank_ops SET orig_amount = amount, orig_currency = currency, amount = ?, currency = 'RUB' WHERE id = ?",
  );
  let done = 0;
  for (const op of ops) {
    try {
      const rub = await rubOf(db, op, op.bank);
      if (rub == null) continue;
      save.run(rub, op.id);
      done += 1;
    } catch (err) {
      console.error(`валюта: операция #${op.id} (${op.currency}, ${op.at.slice(0, 10)}) — ${err.message}`);
    }
  }
  return done;
}
