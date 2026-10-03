// Магазины как источник чеков: Озон и Wildberries. Вход и загрузка — на телефоне, как у банков:
// приложение входит в личный кабинет человеком, берёт список «Электронные чеки», скачивает
// новые чеки и шлёт сюда. Здесь чек превращается в обычный (Озон — PDF, ozonpdf.mjs; WB —
// страница чека, wbreceipt.mjs) и дальше идёт тем же путём, что чеки ФНС: категории, защита
// от повторов по ФН/ФД/ФП, склейка с операцией банка.
//
// Учёт — как у любого предоплаченного заказа: авансовый чек (оплата) — трата, чек о получении
// с «зачётом предоплаты» — те же деньги, второй раз не считается. Это уже делает учёт чеков.

import { parseOzonPdf } from './ozonpdf.mjs';
import { parseWbHtml } from './wbreceipt.mjs';
import { saveReceipt, importStatements } from './import.mjs';
import { classifyItems } from './classify.mjs';
import { askModel } from './scan.mjs';
import { matchBank } from './bankmatch.mjs';

const now = () => new Date().toISOString();

/** Как из присланного получить чек: у каждого магазина свой вид. */
const PARSERS = {
  ozon: (body) => parseOzonPdf(Buffer.from(String(body.pdf ?? ''), 'base64')),
  wb: (body) => parseWbHtml(body.html),
};

export const knownShop = (shop) => Object.hasOwn(PARSERS, shop);

/** Подключение магазина у человека: строка в bank_links, как у банков, — для «обновляли N мин назад». */
function link(db, userId, shop) {
  db.prepare(
    `INSERT INTO bank_links (user_id, bank, session_enc, status, login_at, last_ok_at, synced_at)
     VALUES (?, ?, NULL, 'device', ?, ?, ?)
     ON CONFLICT (user_id, bank) DO UPDATE SET status = 'device', session_enc = NULL,
       last_ok_at = excluded.last_ok_at, synced_at = excluded.synced_at, fails = 0, expired_at = NULL`,
  ).run(userId, shop, now(), now(), now());
  return db.prepare('SELECT id FROM bank_links WHERE user_id = ? AND bank = ?').get(userId, shop).id;
}

/** Чеки магазина, которые уже здесь: приложение их не скачивает повторно. */
export function knownCheques(db, userId, shop) {
  return db
    .prepare(
      `SELECT c.cheque_id FROM shop_cheques c JOIN bank_links l ON l.id = c.link_id
        WHERE l.user_id = ? AND l.bank = ?`,
    )
    .all(userId, shop)
    .map((r) => r.cheque_id);
}

/**
 * Принять один чек: разобрать → сохранить. Такой чек уже есть (пришёл из ФНС или раньше) —
 * не трогаем его, только запоминаем, что этот чек магазина учтён.
 */
export async function importCheque(db, user, shop, body) {
  const chequeId = String(body?.id ?? '').trim();
  if (!chequeId) return { error: 'нужен id чека', status: 400 };
  let receipt;
  try {
    receipt = PARSERS[shop](body);
  } catch (err) {
    return { error: err.message, status: 422 };
  }

  const linkId = link(db, user.id, shop);
  const remember = db.prepare(
    `INSERT INTO shop_cheques (link_id, cheque_id, receipt_id, purchased_at, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (link_id, cheque_id) DO UPDATE SET receipt_id = excluded.receipt_id`,
  );
  const existing = db
    .prepare('SELECT id FROM receipts WHERE budget_id = ? AND fiscal_drive = ? AND fiscal_doc = ? AND fiscal_sign = ?')
    .get(user.budget_id, receipt.fiscalDriveNumber, receipt.fiscalDocumentNumber, receipt.fiscalSign);
  if (existing) {
    remember.run(linkId, chequeId, existing.id, receipt.dateTime, now());
    return { known: true, receipt_id: existing.id };
  }

  const saved = saveReceipt(db, { _id: `${shop}:${chequeId}`, receipt }, importStatements(db), user.budget_id, user.id);
  if (!saved?.id) return { error: 'чек не сохранился', status: 500 };
  remember.run(linkId, chequeId, saved.id, receipt.dateTime, now());
  classifyItems(db, saved.itemIds);
  await askModel(db, saved.itemIds, user.id); // незнакомые названия — модели, как у сканов
  matchBank(db, user.budget_id); // оплата магазину картой банка становится «покрыта чеком»
  return { created: true, receipt_id: saved.id, items: saved.itemIds.length };
}

/** Загрузка закончилась: отметить время — его видно в строке магазина в настройках. */
export function finishSync(db, userId, shop) {
  link(db, userId, shop);
  return { ok: true };
}

/** Итог мастера истории: сколько чеков магазина здесь и за какие годы. */
export function shopStats(db, userId, shop) {
  const from = `FROM shop_cheques c JOIN bank_links l ON l.id = c.link_id
                JOIN receipts r ON r.id = c.receipt_id WHERE l.user_id = :user AND l.bank = :shop`;
  const args = { user: userId, shop };
  const total = db
    .prepare(`SELECT COUNT(DISTINCT r.id) AS count, MIN(r.purchased_at) AS first, MAX(r.purchased_at) AS last ${from}`)
    .get(args);
  const items = db.prepare(`SELECT COUNT(*) AS count FROM items WHERE receipt_id IN (SELECT r.id ${from})`).get(args).count;
  const years = db
    .prepare(`SELECT substr(r.purchased_at, 1, 4) AS year, COUNT(DISTINCT r.id) AS count ${from} GROUP BY year ORDER BY year DESC`)
    .all(args);
  return { shop, total, items, years };
}
