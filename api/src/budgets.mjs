// Бюджеты: у каждого человека один текущий бюджет — свой или общий, семейный.
//
// Бюджет — хозяин данных: чеков, сканов, справочника категорий, ручных правок.
// Человек, вступивший в чужой бюджет, видит и правит его данные; свой прежний
// бюджет (home_budget_id) при этом никуда не девается и возвращается, если человек
// выйдет или его исключат.
//
// Владелец бюджета приглашает и исключает участников, переименовывает бюджет.
// Участники добавляют траты, правят категории и могут выйти сами.
import { randomBytes, createHash } from 'node:crypto';
import { provisionTaxonomy } from './taxonomy.mjs';
import { classifyItems } from './classify.mjs';

const INVITE_DAYS = 7;
const sha = (v) => createHash('sha256').update(String(v)).digest('hex');
const now = () => new Date().toISOString();
const fail = (status, error) => ({ error, status });

const userRow = (db, id) => db.prepare('SELECT id, login, name, budget_id, home_budget_id FROM users WHERE id = ?').get(id);
const budgetRow = (db, id) => db.prepare('SELECT id, name, owner_id FROM budgets WHERE id = ?').get(id);
const membersOf = (db, id) => db.prepare('SELECT COUNT(*) c FROM users WHERE budget_id = ?').get(id).c;

/**
 * Бюджет новому человеку: свой, с копией системного справочника. Своей транзакции
 * не открывает — её держит вызывающий (регистрация через Telegram, users.mjs).
 */
export function createBudget(db, userId, name = 'Мой бюджет') {
  const res = db.prepare('INSERT INTO budgets (name, owner_id, created_at) VALUES (?, ?, ?)').run(name, userId, now());
  const budgetId = Number(res.lastInsertRowid);
  provisionTaxonomy(db, budgetId);
  db.prepare('UPDATE users SET budget_id = ?, home_budget_id = COALESCE(home_budget_id, ?) WHERE id = ?')
    .run(budgetId, budgetId, userId);
  return budgetId;
}

/** У человека нет бюджета (заведён до бюджетов или его бюджет удалён) — выдаём. */
export function ensureBudget(db, userId) {
  const user = userRow(db, userId);
  if (!user) return null;
  if (user.budget_id && budgetRow(db, user.budget_id)) return user.budget_id;
  if (user.home_budget_id && budgetRow(db, user.home_budget_id)) {
    db.prepare('UPDATE users SET budget_id = home_budget_id WHERE id = ?').run(userId);
    return user.home_budget_id;
  }
  db.prepare('UPDATE users SET home_budget_id = NULL WHERE id = ?').run(userId);
  return createBudget(db, userId);
}

/** Бюджет глазами участника: состав, кто владелец, активные приглашения (их видит владелец). */
export function getBudget(db, user) {
  const budget = budgetRow(db, user.budget_id);
  if (!budget) return fail(404, 'бюджет не найден');
  const isOwner = budget.owner_id === user.id;

  const members = db
    .prepare(
      `SELECT u.id, COALESCE(u.name, u.login) AS name, u.tg_username,
              (SELECT COUNT(*) FROM receipts r WHERE r.budget_id = ? AND r.added_by = u.id) AS receipts
         FROM users u WHERE u.budget_id = ? ORDER BY u.id`,
    )
    .all(budget.id, budget.id)
    .map((m) => ({ ...m, is_owner: m.id === budget.owner_id, is_me: m.id === user.id }));

  const invites = isOwner
    ? db
        .prepare(
          `SELECT id, created_at, expires_at FROM invites
            WHERE budget_id = ? AND used_by IS NULL AND revoked = 0 AND expires_at > ?
            ORDER BY id DESC`,
        )
        .all(budget.id, now())
    : [];

  return {
    id: budget.id,
    name: budget.name,
    is_owner: isOwner,
    // Свой ли это бюджет: из своего выйти нельзя, можно только принять чужой
    is_home: user.home_budget_id === budget.id,
    members,
    invites,
  };
}

export function renameBudget(db, user, name) {
  const budget = budgetRow(db, user.budget_id);
  if (budget?.owner_id !== user.id) return fail(403, 'переименовать бюджет может только владелец');
  const clean = String(name ?? '').trim().slice(0, 60);
  if (!clean) return fail(400, 'нужно название');
  db.prepare('UPDATE budgets SET name = ? WHERE id = ?').run(clean, budget.id);
  return { name: clean };
}

/** Приглашение: одноразовая ссылка на неделю. В базе — хеш кода. */
export function createInvite(db, user, origin) {
  const budget = budgetRow(db, user.budget_id);
  if (budget?.owner_id !== user.id) return fail(403, 'приглашать может только владелец бюджета');
  const code = randomBytes(18).toString('base64url');
  const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString();
  const res = db
    .prepare('INSERT INTO invites (code_hash, budget_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha(code), budget.id, user.id, now(), expires);
  return { id: Number(res.lastInsertRowid), url: `${origin}/m/?invite=${code}`, expires_at: expires };
}

export function revokeInvite(db, user, inviteId) {
  const budget = budgetRow(db, user.budget_id);
  if (budget?.owner_id !== user.id) return fail(403, 'отзывать приглашения может только владелец');
  const n = db.prepare('UPDATE invites SET revoked = 1 WHERE id = ? AND budget_id = ?').run(inviteId, budget.id).changes;
  return n ? { revoked: true } : fail(404, 'приглашение не найдено');
}

function liveInvite(db, code) {
  const invite = db.prepare('SELECT * FROM invites WHERE code_hash = ?').get(sha(code ?? ''));
  if (!invite) return fail(404, 'приглашение не найдено');
  if (invite.revoked) return fail(410, 'приглашение отозвано');
  if (invite.used_by) return fail(410, 'приглашение уже использовано');
  if (invite.expires_at <= now()) return fail(410, 'срок приглашения истёк');
  return { invite };
}

/**
 * Что за приглашение — показать перед согласием: чей бюджет, сколько людей, и есть ли
 * у приглашённого свои чеки, которые можно перенести.
 */
export function describeInvite(db, user, code) {
  const { invite, error, status } = liveInvite(db, code);
  if (error) return { error, status };
  const budget = budgetRow(db, invite.budget_id);
  if (!budget) return fail(410, 'бюджет удалён');
  const owner = budget.owner_id ? userRow(db, budget.owner_id) : null;

  const already = user.budget_id === budget.id;
  // Перенести можно только из своего бюджета: чеки чужого общего бюджета — не его
  const canMove = !already && user.budget_id === user.home_budget_id;
  const own = canMove ? db.prepare('SELECT COUNT(*) c FROM receipts WHERE budget_id = ?').get(user.budget_id).c : 0;

  return {
    budget: budget.name,
    owner: owner ? owner.name ?? owner.login : null,
    members: membersOf(db, budget.id),
    already,
    own_receipts: own,
    // Владелец бюджета, где есть другие люди, уйти не может: бюджет остался бы без хозяина
    blocked: ownsSharedBudget(db, user) ? 'вы владелец бюджета, где есть другие участники — сначала исключите их' : null,
  };
}

const ownsSharedBudget = (db, user) => {
  const budget = budgetRow(db, user.budget_id);
  return budget?.owner_id === user.id && membersOf(db, budget.id) > 1;
};

/**
 * Перенос чеков из своего бюджета в общий. Чек, который в общем уже есть (тот же
 * ФН/ФД/ФП — его отсканировал кто-то из семьи), остаётся на месте. Разметка
 * пересчитывается по справочнику общего бюджета: ручные правки прежнего бюджета
 * туда не переезжают. Ручные траты (закреплённые метки) переносят категорию —
 * по тому же коду или через системную категорию, из которой она произошла.
 */
function moveReceipts(db, from, to) {
  const ids = db
    .prepare(
      `SELECT r.id FROM receipts r
        WHERE r.budget_id = ?
          AND NOT EXISTS (SELECT 1 FROM receipts t WHERE t.budget_id = ? AND t.fiscal_drive = r.fiscal_drive
                            AND t.fiscal_doc = r.fiscal_doc AND t.fiscal_sign = r.fiscal_sign)`,
    )
    .all(from, to)
    .map((r) => r.id);
  if (!ids.length) return { moved: 0, skipped: db.prepare('SELECT COUNT(*) c FROM receipts WHERE budget_id = ?').get(from).c };

  const list = ids.join(',');
  // Ручные траты: категория — данные, а не вывод из названия, её надо сохранить
  const pinned = db
    .prepare(
      `SELECT l.item_id, l.category_slug FROM item_labels l JOIN items i ON i.id = l.item_id
        WHERE i.receipt_id IN (${list}) AND l.source = 'pinned'`,
    )
    .all();
  const targetHas = db.prepare('SELECT 1 FROM categories WHERE budget_id = ? AND slug = ?');
  const viaSystem = db.prepare(
    `SELECT t.slug FROM category_links f JOIN category_links t ON t.sys_slug = f.sys_slug AND t.budget_id = ?
      WHERE f.budget_id = ? AND f.slug = ? LIMIT 1`,
  );
  const mapped = pinned.map((p) => ({
    item_id: p.item_id,
    slug: targetHas.get(to, p.category_slug) ? p.category_slug : viaSystem.get(to, from, p.category_slug)?.slug ?? null,
  }));

  const itemIds = db.prepare(`SELECT id FROM items WHERE receipt_id IN (${list})`).all().map((r) => r.id);
  db.prepare(`DELETE FROM item_labels WHERE item_id IN (SELECT id FROM items WHERE receipt_id IN (${list}))`).run();
  db.prepare(`UPDATE receipts SET budget_id = ? WHERE id IN (${list})`).run(to);
  // Сканы едут вместе со своими чеками; зависшие и с ошибкой (чека ещё нет) — тоже,
  // если в общем такого нет. Скан чека-дубликата остаётся рядом со своим чеком
  db.prepare(
    `UPDATE scan_jobs SET budget_id = ?
      WHERE budget_id = ? AND (receipt_id IS NULL OR receipt_id IN (${list}))
        AND NOT EXISTS (SELECT 1 FROM scan_jobs t WHERE t.budget_id = ?
          AND t.fiscal_drive = scan_jobs.fiscal_drive AND t.fiscal_doc = scan_jobs.fiscal_doc
          AND t.fiscal_sign = scan_jobs.fiscal_sign)`,
  ).run(to, from, to);

  const pin = db.prepare(
    `INSERT INTO item_labels (item_id, budget_id, category_slug, source, confidence, updated_at)
     VALUES (?, ?, ?, 'pinned', 1, ?)`,
  );
  const stamp = now();
  for (const p of mapped) if (p.slug) pin.run(p.item_id, to, p.slug, stamp);
  const pinnedIds = new Set(mapped.filter((p) => p.slug).map((p) => p.item_id));
  classifyItems(db, itemIds.filter((id) => !pinnedIds.has(id)));

  return { moved: ids.length, skipped: db.prepare('SELECT COUNT(*) c FROM receipts WHERE budget_id = ?').get(from).c };
}

/** Принять приглашение. move — перенести свои чеки в общий бюджет. */
export function acceptInvite(db, user, code, { move = false } = {}) {
  const info = describeInvite(db, user, code);
  if (info.error) return info;
  if (info.already) return fail(409, 'вы уже в этом бюджете');
  if (info.blocked) return fail(409, info.blocked);

  const { invite } = liveInvite(db, code);
  let result = { moved: 0, skipped: 0 };
  db.exec('BEGIN');
  try {
    if (move && info.own_receipts) result = moveReceipts(db, user.budget_id, invite.budget_id);
    db.prepare('UPDATE users SET budget_id = ? WHERE id = ?').run(invite.budget_id, user.id);
    db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?').run(user.id, now(), invite.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { joined: info.budget, ...result };
}

/** Вернуть человека в его собственный бюджет (выход сам или исключение владельцем). */
function sendHome(db, userId) {
  const user = userRow(db, userId);
  if (user.home_budget_id && budgetRow(db, user.home_budget_id)) {
    db.prepare('UPDATE users SET budget_id = home_budget_id WHERE id = ?').run(userId);
  } else {
    db.prepare('UPDATE users SET home_budget_id = NULL WHERE id = ?').run(userId);
    createBudget(db, userId);
  }
}

export function leaveBudget(db, user) {
  const budget = budgetRow(db, user.budget_id);
  if (!budget) return fail(404, 'бюджет не найден');
  if (budget.owner_id === user.id) return fail(409, 'владелец не выходит из своего бюджета — можно исключить участников');
  db.exec('BEGIN');
  try {
    sendHome(db, user.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { left: budget.name };
}

export function removeMember(db, user, memberId) {
  const budget = budgetRow(db, user.budget_id);
  if (budget?.owner_id !== user.id) return fail(403, 'исключать может только владелец бюджета');
  if (memberId === user.id) return fail(400, 'себя исключить нельзя');
  const member = userRow(db, memberId);
  if (!member || member.budget_id !== budget.id) return fail(404, 'такого участника нет');
  db.exec('BEGIN');
  try {
    sendHome(db, memberId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { removed: member.name ?? member.login };
}

/**
 * Удаление аккаунта. Общие траты семьи не пропадают: если в бюджете остаются люди,
 * он переходит к самому давнему из них; пустой бюджет удаляется со всеми данными.
 * Свой «спящий» бюджет, в котором никого нет, удаляется тоже.
 */
export function deleteAccount(db, userId) {
  const user = userRow(db, userId);
  if (!user) return fail(404, 'пользователь не найден');

  db.exec('BEGIN');
  try {
    const budgets = [...new Set([user.budget_id, user.home_budget_id].filter(Boolean))];
    db.prepare('UPDATE users SET budget_id = NULL, home_budget_id = NULL WHERE id = ?').run(userId);
    for (const id of budgets) {
      const budget = budgetRow(db, id);
      if (!budget) continue;
      const heir = db.prepare('SELECT id FROM users WHERE budget_id = ? ORDER BY id LIMIT 1').get(id);
      if (heir) {
        if (budget.owner_id === userId) db.prepare('UPDATE budgets SET owner_id = ? WHERE id = ?').run(heir.id, id);
      } else {
        // Никого не осталось — чеки, справочник и правки уходят каскадом
        db.prepare('UPDATE users SET home_budget_id = NULL WHERE home_budget_id = ?').run(id);
        db.prepare('DELETE FROM budgets WHERE id = ?').run(id);
      }
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { deleted: true };
}
