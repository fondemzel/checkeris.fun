// Озон как источник чеков. Вход и загрузка — на телефоне, как у банков: приложение входит в
// личный кабинет Озона человеком, берёт список «Электронные чеки», скачивает новые PDF и шлёт
// сюда. Здесь PDF превращается в обычный чек (ozonpdf.mjs) и дальше идёт тем же путём, что
// чеки ФНС: категории, защита от повторов по ФН/ФД/ФП, склейка с операцией банка.
//
// Учёт — как у любого предоплаченного заказа: авансовый чек (оплата) — трата, чек о получении
// с «зачётом предоплаты» — те же деньги, второй раз не считается. Это уже делает учёт чеков.

import { parseOzonPdf } from './ozonpdf.mjs';
import { saveReceipt, importStatements } from './import.mjs';
import { classifyItems } from './classify.mjs';
import { askModel } from './scan.mjs';
import { matchBank } from './bankmatch.mjs';

const now = () => new Date().toISOString();

/** Подключение Озона у человека: строка в bank_links, как у банков, — для «обновляли N мин назад». */
function link(db, userId) {
  db.prepare(
    `INSERT INTO bank_links (user_id, bank, session_enc, status, login_at, last_ok_at, synced_at)
     VALUES (?, 'ozon', NULL, 'device', ?, ?, ?)
     ON CONFLICT (user_id, bank) DO UPDATE SET status = 'device', session_enc = NULL,
       last_ok_at = excluded.last_ok_at, synced_at = excluded.synced_at, fails = 0, expired_at = NULL`,
  ).run(userId, now(), now(), now());
  return db.prepare("SELECT id FROM bank_links WHERE user_id = ? AND bank = 'ozon'").get(userId).id;
}

/** Чеки Озона, которые уже здесь: приложение их не скачивает повторно. */
export function knownCheques(db, userId) {
  return db
    .prepare(
      `SELECT c.cheque_id FROM ozon_cheques c JOIN bank_links l ON l.id = c.link_id
        WHERE l.user_id = ? AND l.bank = 'ozon'`,
    )
    .all(userId)
    .map((r) => r.cheque_id);
}

/**
 * Принять один чек: PDF → чек → сохранить. Такой чек уже есть (пришёл из ФНС или раньше) —
 * не трогаем его, только запоминаем, что этот чек Озона учтён.
 */
export async function importCheque(db, user, { id, pdf }) {
  const chequeId = String(id ?? '').trim();
  if (!chequeId || !pdf) return { error: 'нужны id и pdf', status: 400 };
  let receipt;
  try {
    receipt = parseOzonPdf(Buffer.from(String(pdf), 'base64'));
  } catch (err) {
    return { error: err.message, status: 422 };
  }

  const linkId = link(db, user.id);
  const remember = db.prepare(
    `INSERT INTO ozon_cheques (link_id, cheque_id, receipt_id, purchased_at, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (link_id, cheque_id) DO UPDATE SET receipt_id = excluded.receipt_id`,
  );
  const existing = db
    .prepare('SELECT id FROM receipts WHERE budget_id = ? AND fiscal_drive = ? AND fiscal_doc = ? AND fiscal_sign = ?')
    .get(user.budget_id, receipt.fiscalDriveNumber, receipt.fiscalDocumentNumber, receipt.fiscalSign);
  if (existing) {
    remember.run(linkId, chequeId, existing.id, receipt.dateTime, now());
    return { known: true, receipt_id: existing.id };
  }

  const saved = saveReceipt(db, { _id: `ozon:${chequeId}`, receipt }, importStatements(db), user.budget_id, user.id);
  if (!saved?.id) return { error: 'чек не сохранился', status: 500 };
  remember.run(linkId, chequeId, saved.id, receipt.dateTime, now());
  classifyItems(db, saved.itemIds);
  await askModel(db, saved.itemIds, user.id); // незнакомые названия — модели, как у сканов
  matchBank(db, user.budget_id); // оплата Озону картой банка становится «покрыта чеком»
  return { created: true, receipt_id: saved.id, items: saved.itemIds.length };
}

/** Загрузка закончилась: отметить время — его видно в строке Озона в настройках. */
export function finishSync(db, userId) {
  link(db, userId);
  return { ok: true };
}
