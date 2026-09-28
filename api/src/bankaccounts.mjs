// Счета банка и выбор человека: с каких брать операции.
//
// Список приходит из приложения (мастер подключения показывает его человеку), выбор
// хранится здесь. Операции выключенного счёта сервер не принимает — даже от старой версии
// приложения, которая ещё не умеет спрашивать, — а уже загруженные помечает «не учитывать»
// (kind = excluded, kind_source = account). Включили счёт обратно — пометка снимается,
// и разметка раскладывает его операции заново.
//
// Счёт, которого здесь ещё нет (открыли новую карту), берётся: так человек не пропустит
// траты, а убрать лишнее может в любой момент.
import { matchBank } from './bankmatch.mjs';

const now = () => new Date().toISOString();

const linkOf = (db, userId, bank) =>
  db.prepare('SELECT l.id, u.budget_id FROM bank_links l JOIN users u ON u.id = l.user_id WHERE l.user_id = ? AND l.bank = ?')
    .get(userId, bank);

/** Счета подключения с выбором и числом загруженных операций. */
export function listAccounts(db, userId, bank) {
  const link = linkOf(db, userId, bank);
  if (!link) return { accounts: [] };
  const accounts = db
    .prepare(
      `SELECT a.account AS id, a.name, a.type, a.currency, a.created, a.enabled,
              (SELECT COUNT(*) FROM bank_ops o WHERE o.link_id = a.link_id AND o.account = a.account) AS ops,
              -- Докуда история уже загружена: повторная выгрузка начинается отсюда, а не с нуля
              (SELECT MIN(o.at) FROM bank_ops o WHERE o.link_id = a.link_id AND o.account = a.account) AS first,
              (SELECT MAX(o.at) FROM bank_ops o WHERE o.link_id = a.link_id AND o.account = a.account) AS last,
              -- Последние цифры карты: в списке счетов их нет, зато они есть у операций
              (SELECT o.card FROM bank_ops o
                WHERE o.link_id = a.link_id AND o.account = a.account AND o.card IS NOT NULL
                ORDER BY o.at DESC LIMIT 1) AS card
         FROM bank_accounts a WHERE a.link_id = ?
        ORDER BY a.enabled DESC, ops DESC, a.name`,
    )
    .all(link.id)
    .map((a) => ({ ...a, enabled: Boolean(a.enabled) }));
  return { accounts };
}

/**
 * Список счетов из банка и выбор человека. accounts — [{ id, name, type, currency, created,
 * enabled }]; enabled не указан — не трогаем прежний выбор (новый счёт — включён).
 */
export function saveAccounts(db, userId, bank, accounts) {
  // Первое подключение: счета выбирают раньше, чем приходит первая операция
  db.prepare(
    `INSERT OR IGNORE INTO bank_links (user_id, bank, session_enc, status, login_at) VALUES (?, ?, NULL, 'device', ?)`,
  ).run(userId, bank, now());
  const link = linkOf(db, userId, bank);
  if (!link) return { error: 'bank not connected', status: 404 };
  const upsert = db.prepare(
    `INSERT INTO bank_accounts (link_id, account, name, type, currency, created, enabled, updated_at)
     VALUES (:link, :account, :name, :type, :currency, :created, :enabled, :now)
     ON CONFLICT (link_id, account) DO UPDATE SET
       name = COALESCE(excluded.name, name), type = COALESCE(excluded.type, type),
       currency = COALESCE(excluded.currency, currency), created = COALESCE(excluded.created, created),
       enabled = CASE WHEN :keep THEN enabled ELSE excluded.enabled END, updated_at = excluded.updated_at`,
  );
  db.exec('BEGIN');
  try {
    for (const a of accounts ?? []) {
      const account = String(a?.id ?? '').trim();
      if (!account) continue;
      upsert.run({
        link: link.id,
        account,
        name: a.name ? String(a.name).slice(0, 100) : null,
        type: a.type ? String(a.type).slice(0, 40) : null,
        currency: a.currency ? String(a.currency).slice(0, 10) : null,
        created: Number(a.created) || null,
        enabled: a.enabled === false ? 0 : 1,
        keep: a.enabled === undefined ? 1 : 0,
        now: now(),
      });
    }
    applyChoice(db, link);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  // Вернувшиеся в учёт операции заново проходят разметку: чеки, переводы, категории
  matchBank(db, link.budget_id);
  return listAccounts(db, userId, bank);
}

/** Операции выключенных счетов — «не учитывать», включённых — вернуть в разметку. */
function applyChoice(db, link) {
  db.prepare(
    `UPDATE bank_ops SET kind = 'excluded', kind_source = 'account'
      WHERE link_id = :link AND (kind_source IS NULL OR kind_source <> 'manual')
        AND account IN (SELECT account FROM bank_accounts WHERE link_id = :link AND enabled = 0)`,
  ).run({ link: link.id });
  // Найденные раньше чек и пара перевода остаются — по ним вид и восстанавливается
  db.prepare(
    `UPDATE bank_ops
        SET kind = CASE WHEN receipt_id IS NOT NULL THEN 'covered' WHEN pair_id IS NOT NULL THEN 'transfer' END,
            kind_source = NULL
      WHERE link_id = :link AND kind_source = 'account'
        AND account NOT IN (SELECT account FROM bank_accounts WHERE link_id = :link AND enabled = 0)`,
  ).run({ link: link.id });
}

/** Счета, по которым операции уже есть, а записи о счёте ещё нет: заводим включёнными. */
export function rememberLoadedAccounts(db) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO bank_accounts (link_id, account, name, enabled, updated_at)
       SELECT link_id, account, MAX(account_name), 1, ? FROM bank_ops GROUP BY link_id, account`,
    )
    .run(now()).changes;
}

/** Счета, с которых операции не берём: для приёма операций. */
export function disabledAccounts(db, linkId) {
  return new Set(
    db.prepare('SELECT account FROM bank_accounts WHERE link_id = ? AND enabled = 0').all(linkId).map((r) => r.account),
  );
}
