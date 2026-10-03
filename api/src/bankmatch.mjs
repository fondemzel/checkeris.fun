import { bankCategories } from './bankformat.mjs';
import { applyIncomeRules, setIncomeCategory, incomeKey } from './incomecats.mjs';

// Разбор операций банка: что из них трата, что доход, а что вообще не движение денег.
//
// Одна покупка картой существует дважды: чеком из ФНС (с товарами) и операцией банка.
// Считать её нужно один раз, поэтому операция, у которой нашёлся чек, помечается covered —
// в суммах расходов её представляет чек, а сама операция остаётся для истории.
//
// Виды (bank_ops.kind):
//   covered  — есть чек: сумма уже посчитана по чеку
//   expense  — трата без чека: переводы людям, ЖКХ, подписки, покупки за границей
//   income   — поступление
//   transfer — перевод между своими счетами: ни доход, ни расход
//
// Разметка идемпотентна: её можно гонять сколько угодно, результат тот же.

// Чек пробивают в момент оплаты, но время в кассе и в банке расходится: часы кассы,
// задержка авторизации. Полчаса — с запасом, а совпадение суммы до копейки делает
// ошибку маловероятной
const MINUTES = 30;

// Время у операций и чеков — московское без зоны; для разницы в минутах зона не важна
const minutes = (at) => Date.parse(`${String(at).slice(0, 19)}Z`) / 60_000;

/** Зачисление — возврат этой покупки: тот же продавец или то же описание. */
const same = (a, b) => Boolean(a && b) && a.trim().toLowerCase() === b.trim().toLowerCase();
const refund = (debit, credit) =>
  same(debit.merchant, credit.merchant) || same(debit.description, credit.description);

/** Переводы между своими счетами: банк помечает их сам, плюс пары «списание — зачисление». */
function markTransfers(db, budgetId) {
  // Банк знает про свои внутренние переводы. Вид, поставленный человеком или выключенным
  // счётом (kind_source), разметка не трогает — ни здесь, ни ниже
  db.prepare(
    `UPDATE bank_ops SET kind = 'transfer'
      WHERE budget_id = ? AND json_extract(raw, '$.isInner') = 1 AND kind_source IS NULL`,
  ).run(budgetId);

  // Внутренняя запись банка — зеркало настоящего перевода, а не он сам. Округление в
  // копилку Т-Банк отдаёт трижды: «Магнит» с пометкой isInner, «Перевод округлений»
  // с карты и зачисление в копилку. Если зачисление сцепится с зеркалом, настоящее
  // списание останется без пары и попадёт в траты. Поэтому зеркала в пары не берём,
  // а уже сцепленные с ними зачисления освобождаем — пусть найдут настоящую пару
  db.prepare(
    `UPDATE bank_ops SET pair_id = NULL
      WHERE budget_id = ? AND kind_source IS NULL AND pair_id IN (
        SELECT id FROM bank_ops WHERE budget_id = ? AND json_extract(raw, '$.isInner') = 1)`,
  ).run(budgetId, budgetId);
  db.prepare(
    `UPDATE bank_ops SET pair_id = NULL
      WHERE budget_id = ? AND pair_id IS NOT NULL AND json_extract(raw, '$.isInner') = 1`,
  ).run(budgetId);

  // Пара «списание — зачисление» — это либо возврат покупки (тот же продавец), либо деньги,
  // переложенные с одного своего счёта на другой. «Пришли и тут же ушли с того же счёта» —
  // не пара: приход и расход считаются каждый сам по себе. Раньше такие «транзиты» прятали
  // и покупки картой (госуслуги, «Автодор», АЗС), и платежи — ипотеку, колледж, УК.
  // Уже сведённые так пары расцепляем
  const wrong = db
    .prepare(
      `SELECT a.id AS debit, b.id AS credit, a.op_group AS g, a.account = b.account AS sameAccount,
              a.description AS d1, a.merchant AS m1, b.description AS d2, b.merchant AS m2
         FROM bank_ops a JOIN bank_ops b ON b.id = a.pair_id
        WHERE a.budget_id = ? AND a.direction = 'debit' AND a.kind_source IS NULL AND b.kind_source IS NULL`,
    )
    .all(budgetId)
    .filter((p) => (p.g === 'PAY' || p.sameAccount)
      && !refund({ description: p.d1, merchant: p.m1 }, { description: p.d2, merchant: p.m2 }));
  const unpair = db.prepare('UPDATE bank_ops SET pair_id = NULL, kind = NULL WHERE id = ?');
  for (const p of wrong) {
    unpair.run(p.debit);
    unpair.run(p.credit);
  }

  // Пара: то же число копеек ушло и пришло почти в ту же секунду — это перекладывание
  // из кармана в карман, например «Перевод округлений» в копилку.
  // Ищем группировкой по сумме, а не сравнением «каждая с каждой»: история банка — это
  // десятки тысяч операций, и попарное сравнение занимало минуты, пока сервер стоял
  const unpaired = db
    .prepare(
      `SELECT id, at, amount, direction, op_group, description, merchant, account FROM bank_ops
        WHERE budget_id = ? AND pair_id IS NULL AND kind_source IS NULL
          AND COALESCE(json_extract(raw, '$.isInner'), 0) <> 1
        ORDER BY at, id`,
    )
    .all(budgetId);
  const credits = new Map(); // сумма → зачисления
  for (const op of unpaired) {
    if (op.direction !== 'credit') continue;
    if (!credits.has(op.amount)) credits.set(op.amount, []);
    credits.get(op.amount).push({ ...op, t: minutes(op.at) });
  }

  // Перевод не бывает покупкой по чеку: если операции по ошибке достался чек, отпускаем его —
  // сопоставление ниже отдаст чек настоящей покупке
  const link = db.prepare(
    "UPDATE bank_ops SET pair_id = ?, kind = 'transfer', receipt_id = NULL WHERE id = ? AND pair_id IS NULL",
  );
  const taken = new Set();
  for (const op of unpaired) {
    if (op.direction !== 'debit') continue;
    const t = minutes(op.at);
    const match = (credits.get(op.amount) ?? []).find(
      (c) => !taken.has(c.id) && Math.abs(c.t - t) <= 5
        && (refund(op, c) || (op.op_group !== 'PAY' && c.account !== op.account)),
    );
    if (!match) continue;
    taken.add(op.id);
    taken.add(match.id);
    link.run(match.id, op.id);
    link.run(op.id, match.id);
  }
  return taken.size / 2;
}

/**
 * Маркетплейсы списывают деньги при заказе, а чек выдают при получении — через день-пять.
 * Поэтому оплату маркетплейсу склеиваем с его чеком (по ИНН площадки) в окне до недели
 * после оплаты, а не в получасе, как у магазина. Это общие реквизиты площадок, не чьи-то правила.
 */
const MARKETPLACES = [
  { name: /wildberries|(^|\s)wb\*/i, inns: ['7721546864', '9714053621'] },
  { name: /ozon|озон/i, inns: ['7704217370'] },
  { name: /yandex\s*market|яндекс\s*маркет/i, inns: ['9704254424'] },
];
const MARKET_AFTER = 7 * 24 * 60; // минут после оплаты, в которые ещё может прийти чек

/**
 * Операция ↔ чек: та же сумма до копейки и близкое время. Из нескольких кандидатов берём
 * ближайший по времени, и каждый чек достаётся только одной операции. Оплата маркетплейсу —
 * с его чеком в пределах недели после оплаты (MARKETPLACES).
 */
function matchReceipts(db, budgetId) {
  const ops = db
    .prepare(
      `SELECT id, at, amount, merchant, description FROM bank_ops
        WHERE budget_id = ? AND direction = 'debit' AND receipt_id IS NULL
          AND (kind IS NULL OR kind <> 'transfer') AND kind_source IS NULL
        ORDER BY at`,
    )
    .all(budgetId);
  if (!ops.length) return 0;

  // Чеки, ещё не отданные другой операции, — сразу все, сгруппированные по сумме: запрос
  // на каждую операцию при десятках тысяч операций держал сервер минутами
  const receipts = new Map();
  const free = db.prepare(
    `SELECT r.id, r.purchased_at, r.total_sum, r.seller_inn FROM receipts r
      WHERE r.budget_id = ? AND r.fiscal_drive <> 'manual'
        AND NOT EXISTS (SELECT 1 FROM bank_ops o WHERE o.budget_id = r.budget_id AND o.receipt_id = r.id)`,
  );
  for (const r of free.all(budgetId)) {
    if (!receipts.has(r.total_sum)) receipts.set(r.total_sum, []);
    receipts.get(r.total_sum).push({ id: r.id, t: minutes(r.purchased_at), inn: r.seller_inn });
  }

  const save = db.prepare("UPDATE bank_ops SET receipt_id = ?, kind = 'covered' WHERE id = ?");
  const taken = new Set();
  let matched = 0;
  for (const op of ops) {
    const t = minutes(op.at);
    const market = MARKETPLACES.find((m) => m.name.test(`${op.merchant ?? ''} ${op.description ?? ''}`));
    let best = null;
    for (const r of receipts.get(op.amount) ?? []) {
      if (taken.has(r.id)) continue;
      const gap = Math.abs(r.t - t);
      const later = market && market.inns.includes(r.inn) && r.t >= t - MINUTES && r.t - t <= MARKET_AFTER;
      if (gap > MINUTES && !later) continue;
      if (!best || gap < best.gap) best = { id: r.id, gap };
    }
    if (!best) continue;
    taken.add(best.id);
    save.run(best.id, op.id);
    matched += 1;
  }
  return matched;
}

// Перевод себе: банк так и пишет — «Себе в другой банк», «На свою карту»,
// «Перевод собственных средств». Округление — сдача с покупки в свою копилку, банк называет
// его то «Перевод округлений», то «Округление покупки»
const SELF = /(^|\s)себе(\s|$)|сво(ю|й|и|его)\s+(карт|сч[её]т)|между\s+сво|собственных\s+средств|округлени/i;

/**
 * Переводы своих денег — не трата и не доход. Узнаём их только по тому, что общее для всех:
 *   — по описанию: «Себе в другой банк», «Перевод собственных средств», округления;
 *   — по получателю: кому уходят переводы «себе», тот и есть владелец, и все переводы ему
 *     и от него — перекладывание своих денег.
 * Как считать наличные, переводы родным, пополнения со своего ИП — у каждого по-своему:
 * это решает сам человек в карточке операции (kind_source = manual), а не общая разметка.
 * Вид, выбранный человеком, не трогаем.
 */
function markSelfTransfers(db, budgetId) {
  const ops = db
    .prepare(
      `SELECT id, direction, description,
              json_extract(raw, '$.subcategory') AS subcategory,
              json_extract(raw, '$.payment.fieldsValues.maskedFIO') AS recipient,
              json_extract(raw, '$.senderDetails') AS sender
         FROM bank_ops
        WHERE budget_id = ? AND op_group IN ('TRANSFER', 'INCOME') AND kind_source IS NULL
          AND (kind IS NULL OR kind IN ('expense', 'income', 'covered'))`,
    )
    .all(budgetId);
  const self = (op) => SELF.test(op.description ?? '') || SELF.test(op.subcategory ?? '');
  const me = new Set(ops.filter((op) => op.direction === 'debit' && self(op) && op.recipient).map((op) => op.recipient));

  // Перевод себе чеком не оплачивают: если он по совпадению суммы забрал чек, чек отпускаем
  const mark = db.prepare("UPDATE bank_ops SET kind = 'transfer', receipt_id = NULL WHERE id = ?");
  let marked = 0;
  for (const op of ops) {
    const person = op.direction === 'debit' ? op.recipient : op.sender;
    if (!self(op) && !(person && me.has(person))) continue;
    mark.run(op.id);
    marked += 1;
  }
  return marked;
}

/** Остальное: приход — доход, расход без чека — трата. */
function classifyRest(db, budgetId) {
  db.prepare(
    `UPDATE bank_ops
        SET kind = CASE WHEN direction = 'credit' THEN 'income' ELSE 'expense' END
      WHERE budget_id = ? AND kind IS NULL`,
  ).run(budgetId);
}

/** Полный проход по бюджету. Вызывается после загрузки операций и после нового чека. */
export function matchBank(db, budgetId) {
  db.exec('BEGIN');
  try {
    applyKindMarks(db, budgetId); // выбор человека — первым: дальше разметка его не трогает
    const transfers = markTransfers(db, budgetId);
    const self = markSelfTransfers(db, budgetId);
    const receipts = matchReceipts(db, budgetId);
    classifyRest(db, budgetId);
    const categorized = applyRules(db, budgetId);
    applyIncomeRules(db, budgetId);
    const byBank = applyBankCategories(db, budgetId);
    db.exec('COMMIT');
    return { transfers, self, receipts, categorized, byBank };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** «Такая же операция»: у трат — тот же продавец, у поступлений — то же описание. */
const sameKey = (op) => (op.direction === 'credit' ? incomeKey(op) : ruleKey(op));

/**
 * Пометки человека «это перевод себе — для всех таких же» (bank_kind_marks): ставим вид
 * операциям, которые он не отмечал по одной. Пометку сняли — её операции возвращаются
 * к обычной разметке. Покупки с чеком не трогаем: это точно покупки. Пары «списание —
 * зачисление» (переводы, возвраты) тоже: разметка их уже свела, и пометка сломала бы пару.
 */
function applyKindMarks(db, budgetId) {
  const marks = new Map(
    db.prepare('SELECT key, kind FROM bank_kind_marks WHERE budget_id = ?').all(budgetId).map((m) => [m.key, m.kind]),
  );
  const ops = db
    .prepare(
      `SELECT id, direction, merchant, description, kind, kind_source,
              json_extract(raw, '$.senderDetails') AS sender
         FROM bank_ops
        WHERE budget_id = ? AND receipt_id IS NULL AND pair_id IS NULL
          AND (kind_source = 'rule' OR (kind_source IS NULL AND ? > 0))`,
    )
    .all(budgetId, marks.size);
  const mark = db.prepare("UPDATE bank_ops SET kind = ?, kind_source = 'rule' WHERE id = ?");
  const reset = db.prepare('UPDATE bank_ops SET kind = NULL, kind_source = NULL WHERE id = ?');
  let changed = 0;
  for (const op of ops) {
    const kind = marks.get(sameKey(op));
    if (kind && (op.kind !== kind || op.kind_source !== 'rule')) {
      mark.run(kind, op.id);
      changed += 1;
    } else if (!kind && op.kind_source === 'rule') {
      reset.run(op.id);
    }
  }
  return changed;
}

/**
 * Вид операции, выбранный человеком: перевод себе или «не учитывать». only = false у перевода —
 * для всех таких же, и для будущих: пометка запоминается (bank_kind_marks).
 */
export function setOpKind(db, budgetId, id, kind, only = true) {
  const op = db
    .prepare(
      `SELECT id, direction, merchant, description, json_extract(raw, '$.senderDetails') AS sender
         FROM bank_ops WHERE id = ? AND budget_id = ?`,
    )
    .get(id, budgetId);
  if (!op) return { error: 'operation not found', status: 404 };
  // Поступление тоже бывает переводом себе — из другого банка, — тогда это не доход
  const allowed = op.direction === 'debit' ? ['transfer', 'excluded', 'expense'] : ['transfer', 'excluded', 'income'];
  if (!allowed.includes(kind)) return { error: 'unknown kind', status: 400 };
  db.prepare("UPDATE bank_ops SET kind = ?, kind_source = 'manual', receipt_id = NULL WHERE id = ?").run(kind, id);
  const key = sameKey(op);
  if (only || kind !== 'transfer' || !key) return { kind, affected: 1 };
  db.prepare(
    `INSERT INTO bank_kind_marks (budget_id, key, kind, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (budget_id, key) DO UPDATE SET kind = excluded.kind, updated_at = excluded.updated_at`,
  ).run(budgetId, key, kind, new Date().toISOString());
  return { kind, affected: 1 + applyKindMarks(db, budgetId) };
}

/**
 * Человек выбрал категорию операции, отмеченной переводом или «не учитывать», — значит, это
 * снова трата (или доход). «Для всех» снимает и пометку, иначе она вернёт перевод обратно.
 * true — пометку сняли: остальные её операции надо разметить заново.
 */
function restoreKind(db, budgetId, op, only) {
  if (op.kind !== 'transfer' && op.kind !== 'excluded') return false;
  const kind = op.direction === 'credit' ? 'income' : 'expense';
  db.prepare("UPDATE bank_ops SET kind = ?, kind_source = 'manual' WHERE id = ?").run(kind, op.id);
  op.kind = kind;
  if (only) return false;
  const sender = db.prepare("SELECT json_extract(raw, '$.senderDetails') AS s FROM bank_ops WHERE id = ?").get(op.id).s;
  const key = sameKey({ ...op, sender });
  return key ? db.prepare('DELETE FROM bank_kind_marks WHERE budget_id = ? AND key = ?').run(budgetId, key).changes > 0 : false;
}

/**
 * Ключ правила: продавец, а если его нет — описание операции. Приводим к общему виду,
 * чтобы «МОСЭНЕРГОСБЫТ» и «Мосэнергосбыт » были одним и тем же.
 */
export function ruleKey(op) {
  const raw = String(op.merchant || op.description || '').toLowerCase().replace(/ё/g, 'е');
  const key = raw.replace(/[^a-zа-я0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return key.length >= 2 ? key : null;
}

/**
 * Разложить траты без чека по категориям, которые человек уже выбирал для этих продавцов.
 * Выбор человека сильнее категории банка: его правило её перекрывает.
 */
export function applyRules(db, budgetId) {
  const ops = db
    .prepare(
      `SELECT id, merchant, description FROM bank_ops
        WHERE budget_id = ? AND kind = 'expense' AND (category_slug IS NULL OR category_source IN ('bank', 'rule'))`,
    )
    .all(budgetId);
  const rule = db.prepare('SELECT category_slug FROM bank_rules WHERE budget_id = ? AND key = ?');
  // Размеченное прежним правилом тоже переписываем: человек сменил категорию продавца.
  // Считаем только то, что изменилось
  const save = db.prepare(
    "UPDATE bank_ops SET category_slug = ?, category_source = 'rule' WHERE id = ? AND (category_slug IS NOT ? OR category_source IS NOT 'rule')",
  );
  let done = 0;
  for (const op of ops) {
    const key = ruleKey(op);
    const found = key && rule.get(budgetId, key);
    if (!found) continue;
    done += Number(save.run(found.category_slug, op.id, found.category_slug).changes);
  }
  return done;
}

/**
 * Что не разложили правила — по категории банка («Супермаркеты» → «Еда»), если она
 * однозначна. Словарь у каждого банка свой (bankformat.mjs); категории нет в бюджете —
 * пропускаем.
 */
function applyBankCategories(db, budgetId) {
  const own = new Set(db.prepare('SELECT slug FROM categories WHERE budget_id = ?').all(budgetId).map((c) => c.slug));
  const ops = db
    .prepare(
      `SELECT o.id, o.bank_category, l.bank FROM bank_ops o JOIN bank_links l ON l.id = o.link_id
        WHERE o.budget_id = ? AND o.kind = 'expense' AND o.category_slug IS NULL AND o.bank_category IS NOT NULL`,
    )
    .all(budgetId);
  const save = db.prepare("UPDATE bank_ops SET category_slug = ?, category_source = 'bank' WHERE id = ?");
  let done = 0;
  for (const op of ops) {
    // У банка в названиях бывают неразрывные пробелы: «Ремонт и мебель»
    const slug = bankCategories(op.bank)[op.bank_category.replace(/\s+/g, ' ').trim()];
    if (!slug || !own.has(slug)) continue;
    save.run(slug, op.id);
    done += 1;
  }
  return done;
}

/**
 * Категория траты без чека: человек выбрал её сам. Запоминаем для этого продавца и сразу
 * размечаем все его операции — и прошлые, и те, что придут позже (applyRules).
 */
export function setOpCategory(db, budgetId, id, slug, only = false) {
  const op = db.prepare('SELECT * FROM bank_ops WHERE id = ? AND budget_id = ?').get(id, budgetId);
  if (!op) return { error: 'operation not found', status: 404 };
  const unmarked = restoreKind(db, budgetId, op, only);
  // Поступление: у доходов свой справочник и свои правила — по отправителю
  const result = op.direction === 'credit' ? setIncomeCategory(db, budgetId, op, slug, only) : categorize(db, budgetId, op, slug, only);
  if (unmarked && !result.error) matchBank(db, budgetId); // операции снятой пометки — снова траты
  return result;
}

function categorize(db, budgetId, op, slug, only) {
  const id = op.id;

  const category = slug
    ? db
        .prepare(
          `SELECT c.slug, c.name, c.group_slug, g.name AS group_name
             FROM categories c JOIN groups g ON g.budget_id = c.budget_id AND g.slug = c.group_slug
            WHERE c.budget_id = ? AND c.slug = ?`,
        )
        .get(budgetId, slug)
    : null;
  if (slug && !category) return { error: 'unknown category', status: 400 };

  // Только эта трата: правило продавца не трогаем, ручная метка его перекрывает
  const key = only ? null : ruleKey(op);
  const at = new Date().toISOString();
  db.exec('BEGIN');
  try {
    if (!slug) {
      // Сняли категорию: забываем и правило, иначе оно вернёт её обратно
      if (key) db.prepare('DELETE FROM bank_rules WHERE budget_id = ? AND key = ?').run(budgetId, key);
      db.prepare('UPDATE bank_ops SET category_slug = NULL, category_source = NULL WHERE id = ?').run(id);
      db.exec('COMMIT');
      return { category: null, affected: 1 };
    }

    if (key) {
      db.prepare(
        `INSERT INTO bank_rules (budget_id, key, category_slug, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (budget_id, key) DO UPDATE SET category_slug = excluded.category_slug,
           updated_at = excluded.updated_at`,
      ).run(budgetId, key, slug, at);
    }
    db.prepare("UPDATE bank_ops SET category_slug = ?, category_source = 'manual' WHERE id = ?").run(slug, id);
    const affected = key ? 1 + applyRules(db, budgetId) : 1;
    db.exec('COMMIT');
    return { category, affected };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Сводка по видам за период: сколько потрачено, получено и переложено между счетами. */
export function bankTotals(db, budgetId, from, to) {
  return db
    .prepare(
      `SELECT kind, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS sum
         FROM bank_ops
        WHERE budget_id = ? AND at BETWEEN ? AND ?
        GROUP BY kind`,
    )
    .all(budgetId, `${from}T00:00:00`, `${to}T23:59:59`);
}
