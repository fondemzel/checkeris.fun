// Поддержка: человек пишет боту или из приложения — администратор отвечает в админке.
//
// Чекер в Telegram не ходит (telegram.mjs): бот приносит сюда каждое сообщение, которое не
// вход, подписанным запросом (/api/telegram/support). Сохраняем его в обращение, а бот шлёт
// администраторам уведомление: кто, начало сообщения, ссылка «Ответить в админке». Отвечают
// только в админке: когда в Telegram приходит десяток сообщений, ответ «на сообщение» легко
// отправить не тому. Вложения (скриншот, голосовое) бот копирует администраторам — в админке
// их не показать, в базе только пометка, файл остаётся в Telegram.
//
// Уведомлений не больше одного на волну: пока человек пишет подряд (меньше 10 минут между
// сообщениями) и ответа ещё нет, повторно не беспокоим. Из приложения (экран «Поддержка»)
// уведомление уходит через очередь бота (tg_outbox), как остальные сообщения Чекера.
//
// Ответ человеку оформлен одинаково: «💬 Поддержка Чекера», цитатой — его последний вопрос,
// ниже ответ. Видит его и в Telegram, и в приложении.
//
// Обращение — переписка с одним человеком: new — ждёт ответа, answered — ответили,
// closed — закрыто. Новое сообщение после закрытия начинает новое обращение.
import { notify } from './banks.mjs';

const SITE = (process.env.SITE_ORIGIN || 'https://checkeris.fun').replace(/\/$/, '');
const ACK = 'Спасибо! Получили ваше сообщение — ответим здесь же, обычно в течение дня.';
const REPLY_HEAD = '💬 <b>Поддержка Чекера</b>';
const HOURLY = 30; // больше сообщений в час от одного человека не принимаем: защита от потока
const QUIET_MS = 10 * 60_000; // пауза, после которой новое сообщение снова стоит уведомления
const now = () => new Date().toISOString();
const html = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const KINDS = ['text', 'photo', 'document', 'voice', 'video', 'video_note', 'audio', 'sticker', 'other'];
const KIND_NAME = { photo: 'фото', document: 'файл', voice: 'голосовое', video: 'видео', video_note: 'кружок', audio: 'аудио', sticker: 'стикер', other: 'вложение' };
const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text);
const adminLink = (id) => `${SITE}/admin/#/support/${id}`;

const admins = (db) =>
  db.prepare("SELECT id, telegram_id FROM users WHERE role = 'admin' AND telegram_id IS NOT NULL").all();

/**
 * Начало ответа человеку: заголовок и цитата — его последний вопрос (до ответа), чтобы было
 * видно, на что отвечают. Вложение без текста цитируется словом: «[фото]».
 */
function replyPrefix(db, threadId) {
  const q = db.prepare('SELECT text, kind FROM support_messages WHERE thread_id = ? AND from_admin = 0 ORDER BY id DESC LIMIT 1').get(threadId);
  if (!q) return REPLY_HEAD;
  const quote = q.text ? clip(q.text, 300) : `[${KIND_NAME[q.kind] ?? 'вложение'}]`;
  return `${REPLY_HEAD}\n<blockquote>${html(quote)}</blockquote>`;
}

/** Кто написал — одной строкой: имя, ник, номер обращения, откуда. */
function whoLine(db, thread, { fromApp = false } = {}) {
  const u = thread.user_id ? db.prepare('SELECT name, login, tg_username FROM users WHERE id = ?').get(thread.user_id) : null;
  const name = html(u ? (u.name ?? u.login) : (thread.tg_name ?? 'Без имени'));
  const nick = u?.tg_username ?? thread.tg_username;
  const where = fromApp ? ' · из приложения' : u ? '' : ' · без аккаунта';
  return `<b>${name}</b>${nick ? ` · @${html(nick)}` : ''} · обращение #${thread.id}${where}`;
}

/** Уведомление администратору: новое сообщение, его начало цитатой и ссылка в админку. */
function notice(db, thread, { text, kind }, opts) {
  const quote = text ? clip(text, 300) : `[${KIND_NAME[kind] ?? 'вложение'}]`;
  return `💬 <b>Новое сообщение в поддержку</b>\n${whoLine(db, thread, opts)}\n<blockquote>${html(quote)}</blockquote>\n`
    + `<a href="${adminLink(thread.id)}">Ответить в админке</a>`;
}

/**
 * Стоит ли беспокоить: да, если обращение уже отвечено или человек молчал дольше паузы. Пока
 * он пишет подряд и ответа нет — одного уведомления хватит. Смотрим до записи нового сообщения.
 */
function worthNotice(db, thread) {
  if (thread.status !== 'new') return true;
  const prev = db.prepare('SELECT created_at FROM support_messages WHERE thread_id = ? AND from_admin = 0 ORDER BY id DESC LIMIT 1').get(thread.id);
  return !prev || Date.now() - Date.parse(prev.created_at) >= QUIET_MS;
}

/** Открытое обращение этого человека или новое. */
function threadFor(db, telegram, userId) {
  const open = db
    .prepare("SELECT * FROM support_threads WHERE telegram_id = ? AND status <> 'closed' ORDER BY id DESC LIMIT 1")
    .get(telegram.id);
  if (open) return { thread: open, created: false };
  const name = [telegram.first_name, telegram.last_name].filter(Boolean).join(' ').trim().slice(0, 80) || null;
  const id = Number(db.prepare(
    `INSERT INTO support_threads (user_id, telegram_id, tg_name, tg_username, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'new', ?, ?)`,
  ).run(userId, telegram.id, name, telegram.username ? String(telegram.username).slice(0, 64) : null, now(), now()).lastInsertRowid);
  return { thread: db.prepare('SELECT * FROM support_threads WHERE id = ?').get(id), created: true };
}

/**
 * Сообщение боту, которое не вход. Бот присылает: telegram (кто), message_id, text (текст или
 * подпись), kind. Ответ — что боту сделать:
 *   { action: 'notify', admins, text, copy, ack } — администраторам: text (уведомление; пусто —
 *       не беспокоить), copy — следом копия вложения; человеку — ack, если обращение новое
 *   { action: 'hint', text }  — администратору: отвечать — в админке
 *   { action: 'ignore' }      — слишком много сообщений подряд
 */
export function supportIncoming(db, { telegram, message_id, text, kind }) {
  const tgId = Number(telegram?.id);
  if (!Number.isSafeInteger(tgId) || tgId <= 0) return { action: 'ignore' };
  const user = db.prepare('SELECT id, role FROM users WHERE telegram_id = ?').get(tgId);
  const body = String(text ?? '').slice(0, 4000) || null;
  const type = KINDS.includes(kind) ? kind : 'other';

  // Администратор пишет боту — скорее всего, отвечает на уведомление. Отвечают в админке
  if (user?.role === 'admin') {
    return { action: 'hint', text: `Отвечать на обращения — в админке: ${SITE}/admin/#/support` };
  }

  const hour = new Date(Date.now() - 3_600_000).toISOString();
  const recent = db.prepare(
    `SELECT COUNT(*) AS n FROM support_messages m JOIN support_threads t ON t.id = m.thread_id
      WHERE t.telegram_id = ? AND m.from_admin = 0 AND m.created_at >= ?`,
  ).get(tgId, hour).n;
  if (recent >= HOURLY) return { action: 'ignore' };

  const { thread, created } = threadFor(db, { ...telegram, id: tgId }, user?.id ?? null);
  const loud = created || worthNotice(db, thread);
  addMessage(db, thread.id, { fromAdmin: false, text: body, kind: type, userMsg: Number(message_id) || null });
  // Человек написал после ответа — снова ждёт ответа
  db.prepare("UPDATE support_threads SET status = 'new', updated_at = ? WHERE id = ?").run(now(), thread.id);
  const full = { ...thread, user_id: thread.user_id ?? user?.id ?? null };
  const copy = type !== 'text';
  return {
    action: 'notify',
    admins: admins(db).map((a) => a.telegram_id),
    // Вложение посреди волны — без большого уведомления, но с подписью, чьё оно
    text: loud ? notice(db, full, { text: body, kind: type }) : copy ? `📎 ${whoLine(db, full)}` : null,
    copy,
    // Без аккаунта — скорее всего, не получилось войти: сразу подскажем как
    ack: created ? (user ? ACK : `${ACK}\n\nЕсли не получается войти: откройте ${SITE}/m и нажмите «Войти через Telegram».`) : null,
  };
}

function addMessage(db, threadId, { fromAdmin, authorId = null, text = null, kind = 'text', userMsg = null }) {
  db.prepare(
    `INSERT INTO support_messages (thread_id, from_admin, author_id, text, kind, user_msg, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(threadId, fromAdmin ? 1 : 0, authorId, text, kind, userMsg, now());
  if (fromAdmin) db.prepare("UPDATE support_threads SET status = 'answered', updated_at = ? WHERE id = ?").run(now(), threadId);
  else db.prepare('UPDATE support_threads SET updated_at = ? WHERE id = ?').run(now(), threadId);
}

// ── админка ──────────────────────────────────────────────

const preview = (m) => (m ? (m.text ? m.text.slice(0, 140) : `[${KIND_NAME[m.kind] ?? 'вложение'}]`) : '');

/** Обращения: сначала ждущие ответа, затем по свежести. */
export function supportList(db) {
  const threads = db.prepare(
    `SELECT t.*, COALESCE(u.name, u.login) AS user_name,
            (SELECT COUNT(*) FROM support_messages m WHERE m.thread_id = t.id) AS messages
       FROM support_threads t LEFT JOIN users u ON u.id = t.user_id
      ORDER BY CASE t.status WHEN 'new' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END, t.updated_at DESC`,
  ).all();
  const last = db.prepare('SELECT * FROM support_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1');
  return threads.map((t) => {
    const m = last.get(t.id);
    return {
      id: t.id,
      user_id: t.user_id,
      name: t.user_name ?? t.tg_name ?? 'Без имени',
      tg_username: t.tg_username,
      status: t.status,
      created_at: t.created_at,
      updated_at: t.updated_at,
      messages: t.messages,
      last: preview(m),
      last_from_admin: Boolean(m?.from_admin),
    };
  });
}

/** Одно обращение с перепиской. */
export function supportThread(db, id) {
  const t = db.prepare(
    `SELECT t.*, COALESCE(u.name, u.login) AS user_name FROM support_threads t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?`,
  ).get(Number(id));
  if (!t) return null;
  const messages = db.prepare(
    `SELECT m.id, m.from_admin, m.text, m.kind, m.created_at, COALESCE(a.name, a.login) AS author
       FROM support_messages m LEFT JOIN users a ON a.id = m.author_id
      WHERE m.thread_id = ? ORDER BY m.id`,
  ).all(t.id).map((m) => ({ ...m, from_admin: Boolean(m.from_admin), kind_name: KIND_NAME[m.kind] ?? null }));
  return {
    id: t.id,
    user_id: t.user_id,
    name: t.user_name ?? t.tg_name ?? 'Без имени',
    tg_username: t.tg_username,
    status: t.status,
    created_at: t.created_at,
    messages,
  };
}

/** Ответ из админки: человеку — через очередь бота, администраторам в Telegram — копией для истории. */
export function supportReply(db, admin, id, text) {
  const t = db.prepare('SELECT * FROM support_threads WHERE id = ?').get(Number(id));
  if (!t) return { error: 'нет такого обращения', status: 404 };
  const body = String(text ?? '').trim().slice(0, 4000);
  if (!body) return { error: 'пустой ответ', status: 400 };
  const prefix = replyPrefix(db, t.id);
  addMessage(db, t.id, { fromAdmin: true, authorId: admin.id, text: body, kind: 'text' });
  if (t.telegram_id) {
    db.prepare('INSERT INTO tg_outbox (chat_id, text, html, created_at) VALUES (?, ?, 1, ?)').run(t.telegram_id, `${prefix}\n\n${html(body)}`, now());
  }
  for (const a of admins(db)) {
    if (a.id !== admin.id) notify(db, a.id, `↩︎ Ответ из админки на обращение #${t.id}:\n\n${body}`);
  }
  return { ok: true };
}

export function supportStatus(db, id, status) {
  if (!['new', 'answered', 'closed'].includes(status)) return { error: 'неизвестное состояние', status: 400 };
  const changed = db.prepare('UPDATE support_threads SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), Number(id)).changes;
  return changed ? { ok: true } : { error: 'нет такого обращения', status: 404 };
}

/** Для меню и обзора: сколько ждут ответа. */
export const supportWaiting = (db) => db.prepare("SELECT COUNT(*) AS n FROM support_threads WHERE status = 'new'").get().n;

/** Обращения одного человека — на его странице в админке. */
export const supportOfUser = (db, userId) =>
  supportList(db).filter((t) => t.user_id === Number(userId));

// ── приложение: свои обращения ───────────────────────────

/** Обращения человека: сначала с непрочитанным ответом, затем по свежести. */
export function supportMine(db, user) {
  const threads = db.prepare('SELECT * FROM support_threads WHERE user_id = ? ORDER BY updated_at DESC').all(user.id);
  const last = db.prepare('SELECT * FROM support_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1');
  const first = db.prepare('SELECT * FROM support_messages WHERE thread_id = ? AND from_admin = 0 ORDER BY id LIMIT 1');
  return threads
    .map((t) => {
      const m = last.get(t.id);
      return {
        id: t.id,
        status: t.status,
        created_at: t.created_at,
        updated_at: t.updated_at,
        title: preview(first.get(t.id)) || 'Обращение',
        last: preview(m),
        last_from_admin: Boolean(m?.from_admin),
        unread: unreadIn(db, t),
      };
    })
    .sort((a, b) => (b.unread > 0) - (a.unread > 0));
}

const unreadIn = (db, t) =>
  db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE thread_id = ? AND from_admin = 1 AND created_at > ?')
    .get(t.id, t.user_seen_at ?? '').n;

/** Сколько ответов человек ещё не видел — для строки в настройках. */
export function supportUnread(db, userId) {
  return db.prepare('SELECT * FROM support_threads WHERE user_id = ?').all(userId).reduce((n, t) => n + unreadIn(db, t), 0);
}

/** Своё обращение с перепиской. Открыл — ответы прочитаны. */
export function supportMineThread(db, user, id) {
  const t = db.prepare('SELECT * FROM support_threads WHERE id = ? AND user_id = ?').get(Number(id), user.id);
  if (!t) return null;
  db.prepare('UPDATE support_threads SET user_seen_at = ? WHERE id = ?').run(now(), t.id);
  const messages = db.prepare('SELECT id, from_admin, text, kind, created_at FROM support_messages WHERE thread_id = ? ORDER BY id').all(t.id)
    .map((m) => ({ ...m, from_admin: Boolean(m.from_admin), kind_name: KIND_NAME[m.kind] ?? null }));
  return { id: t.id, status: t.status, created_at: t.created_at, messages, telegram: Boolean(t.telegram_id) };
}

/**
 * Сообщение из приложения: в своё открытое обращение (thread_id) или новое. Администраторам —
 * уведомление через очередь бота (с той же паузой, что из Telegram).
 */
export function supportFromApp(db, user, { thread_id = null, text }) {
  const body = String(text ?? '').trim().slice(0, 4000);
  if (!body) return { error: 'пустое сообщение', status: 400 };
  const hour = new Date(Date.now() - 3_600_000).toISOString();
  const recent = db.prepare(
    `SELECT COUNT(*) AS n FROM support_messages m JOIN support_threads t ON t.id = m.thread_id
      WHERE t.user_id = ? AND m.from_admin = 0 AND m.created_at >= ?`,
  ).get(user.id, hour).n;
  if (recent >= HOURLY) return { error: 'слишком много сообщений подряд — попробуйте через час', status: 429 };

  const me = db.prepare('SELECT id, name, login, telegram_id, tg_username FROM users WHERE id = ?').get(user.id);
  let thread = thread_id
    ? db.prepare("SELECT * FROM support_threads WHERE id = ? AND user_id = ? AND status <> 'closed'").get(Number(thread_id), user.id)
    : null;
  const created = !thread;
  if (!thread) {
    const id = Number(db.prepare(
      `INSERT INTO support_threads (user_id, telegram_id, tg_name, tg_username, status, created_at, updated_at, user_seen_at)
       VALUES (?, ?, ?, ?, 'new', ?, ?, ?)`,
    ).run(me.id, me.telegram_id ?? 0, me.name ?? me.login, me.tg_username, now(), now(), now()).lastInsertRowid);
    thread = db.prepare('SELECT * FROM support_threads WHERE id = ?').get(id);
  }
  const loud = created || worthNotice(db, thread);
  addMessage(db, thread.id, { fromAdmin: false, text: body, kind: 'text' });
  db.prepare("UPDATE support_threads SET status = 'new', updated_at = ?, user_seen_at = ? WHERE id = ?").run(now(), now(), thread.id);

  if (loud) {
    const text = notice(db, thread, { text: body, kind: 'text' }, { fromApp: true });
    const add = db.prepare('INSERT INTO tg_outbox (chat_id, text, html, created_at) VALUES (?, ?, 1, ?)');
    for (const a of admins(db)) add.run(a.telegram_id, text, now());
  }
  return { ok: true, thread_id: thread.id, created };
}
