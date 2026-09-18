// Вход через Telegram — со стороны основного сервера.
//
// До Telegram этот сервер не достаёт (хостинг режет соединения), поэтому с Telegram
// разговаривает бот на зарубежном сервере (bot/relay.mjs), а сюда он приходит
// подписанными запросами. Сам сервер в Telegram не ходит никогда.
//
//   1. Браузер: POST /api/auth/telegram/start → одноразовый код и ссылка t.me/<бот>?start=<код>
//   2. Человек открывает ссылку, бот спрашивает здесь, что за запрос (describe),
//      и показывает устройство: «Войти в Чекер с iPhone · Safari?» — [Войти] [Это не я]
//   3. Нажал «Войти» — бот присылает подтверждение (confirm), аккаунт находится или создаётся
//   4. Браузер, опрашивающий GET /api/auth/telegram/poll, получает токен — один раз
//
// Шаг 2 — защита от подмены входа: иначе чужой человек мог бы начать вход у себя,
// прислать ссылку жертве, и её «Start» впустил бы его в её аккаунт.
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { issueToken } from './auth.mjs';
import { provisionTaxonomy } from './taxonomy.mjs';
import { loadEnv } from './llm.mjs';

const TTL_MS = 10 * 60 * 1000; // сколько живёт код входа
const SKEW_MS = 5 * 60 * 1000; // насколько время в подписи бота может расходиться с нашим

const sha = (v) => createHash('sha256').update(String(v)).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

export function telegramConfig() {
  loadEnv();
  return {
    bot: process.env.TG_BOT_USERNAME || 'checker_costs_bot',
    secret: process.env.TG_RELAY_SECRET ?? '',
  };
}

export const telegramReady = () => telegramConfig().secret.length >= 32;

/** Устройство по User-Agent — грубо, ровно чтобы человек узнал свой запрос. */
export function deviceOf(ua = '') {
  const browser =
    /YaBrowser/.test(ua) ? 'Яндекс Браузер'
      : /Edg\//.test(ua) ? 'Edge'
        : /OPR\//.test(ua) ? 'Opera'
          : /Firefox\//.test(ua) ? 'Firefox'
            : /Chrome\//.test(ua) ? 'Chrome'
              : /Safari\//.test(ua) ? 'Safari'
                : 'браузер';
  const os =
    /iPhone/.test(ua) ? 'iPhone'
      : /iPad/.test(ua) ? 'iPad'
        : /Android/.test(ua) ? 'Android'
          : /Windows/.test(ua) ? 'Windows'
            : /Mac OS X/.test(ua) ? 'Mac'
              : /Linux/.test(ua) ? 'Linux'
                : 'устройство';
  return `${os} · ${browser}`;
}

/**
 * Начало входа. Код — 32 символа base64url: столько и таких символов пропускает
 * параметр start в ссылке на бота. Хранится хеш: утечка базы не даёт перехватить вход.
 */
export function startLogin(db, { ua, ip, linkUserId = null }) {
  const nonce = randomBytes(24).toString('base64url');
  const now = Date.now();
  db.prepare('DELETE FROM tg_logins WHERE expires_at < ?').run(iso(now - 86_400_000));
  db.prepare(
    `INSERT INTO tg_logins (nonce_hash, status, device, ip, link_user_id, created_at, expires_at)
     VALUES (?, 'pending', ?, ?, ?, ?, ?)`,
  ).run(sha(nonce), deviceOf(ua), ip ?? null, linkUserId, iso(now), iso(now + TTL_MS));

  // Две ссылки на одного бота: tg:// открывает приложение сразу, без страницы t.me
  // с кнопкой «Open in Telegram»; https://t.me — запасная, если приложения нет
  const { bot } = telegramConfig();
  return {
    nonce,
    app_url: `tg://resolve?domain=${bot}&start=${nonce}`,
    url: `https://t.me/${bot}?start=${nonce}`,
    expires_at: iso(now + TTL_MS),
  };
}

const find = (db, nonce) => db.prepare('SELECT * FROM tg_logins WHERE nonce_hash = ?').get(sha(nonce ?? ''));
const alive = (row) => row && row.status === 'pending' && row.expires_at > new Date().toISOString();

const EXPIRED = 'Ссылка для входа устарела. Нажмите «Войти через Telegram» ещё раз.';

/** Бот спрашивает, что за запрос, — чтобы показать человеку устройство до подтверждения. */
export function describeLogin(db, nonce) {
  const row = find(db, nonce);
  if (!alive(row)) return { ok: false, reply: EXPIRED };
  return { ok: true, device: row.device, link: Boolean(row.link_user_id), created_at: row.created_at };
}

/** Имя для обращения: как человек подписан в Telegram. */
function nameOf(tg) {
  const full = [tg.first_name, tg.last_name].filter(Boolean).join(' ').trim().slice(0, 80);
  return full || (tg.username ? `@${tg.username}` : `Telegram ${tg.id}`);
}

/**
 * Подтверждение из бота. approve=false — человек нажал «Это не я»: код гасится,
 * и опрашивающий браузер получает отказ.
 */
export function confirmLogin(db, { nonce, telegram, approve }) {
  const row = find(db, nonce);
  if (!alive(row)) return { ok: false, reply: EXPIRED };

  const now = new Date().toISOString();
  const close = (status, reply, extra = {}) => {
    db.prepare('UPDATE tg_logins SET status = ?, confirmed_at = ? WHERE nonce_hash = ?').run(status, now, row.nonce_hash);
    return { ok: status === 'confirmed', reply, ...extra };
  };

  if (!approve) {
    return close('rejected', 'Вход отменён. Если вы не нажимали «Войти через Telegram», просто не открывайте такие ссылки.');
  }

  const tgId = Number(telegram?.id);
  if (!Number.isSafeInteger(tgId) || tgId <= 0) return { ok: false, reply: 'Не удалось опознать аккаунт Telegram.' };
  const name = nameOf(telegram);
  const username = telegram.username ? String(telegram.username).slice(0, 64) : null;
  const owner = db.prepare('SELECT id FROM users WHERE telegram_id = ?').get(tgId);

  // Привязка к уже вошедшему аккаунту
  if (row.link_user_id) {
    if (owner && owner.id !== row.link_user_id) {
      return close('rejected', 'Этот Telegram уже привязан к другому аккаунту Чекера.');
    }
    db.prepare('UPDATE users SET telegram_id = ?, tg_username = ?, name = COALESCE(name, ?) WHERE id = ?')
      .run(tgId, username, name, row.link_user_id);
    db.prepare('UPDATE tg_logins SET user_id = ? WHERE nonce_hash = ?').run(row.link_user_id, row.nonce_hash);
    return close('confirmed', 'Telegram привязан к аккаунту Чекера. Теперь можно входить кнопкой «Войти через Telegram».');
  }

  // Вход; незнакомый Telegram — это регистрация, отдельного шага для неё нет
  let userId = owner?.id;
  let created = false;
  db.exec('BEGIN');
  try {
    if (userId) {
      db.prepare('UPDATE users SET tg_username = ?, name = ? WHERE id = ?').run(username, name, userId);
    } else {
      const res = db
        .prepare(
          `INSERT INTO users (login, password, created_at, telegram_id, tg_username, name, role)
           VALUES (?, '!', ?, ?, ?, ?, 'user')`,
        )
        .run(`tg:${tgId}`, now, tgId, username, name);
      userId = Number(res.lastInsertRowid);
      provisionTaxonomy(db, userId);
      created = true;
    }
    db.prepare('UPDATE tg_logins SET user_id = ?, created = ? WHERE nonce_hash = ?').run(userId, created ? 1 : 0, row.nonce_hash);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return close(
    'confirmed',
    created
      ? `Добро пожаловать в Чекер, ${name}! Вернитесь в приложение — вход уже выполнен.`
      : `Готово, ${name}. Вернитесь в приложение — вход выполнен.`,
    { created },
  );
}

/**
 * Опрос со стороны браузера. Токен выдаётся ровно один раз: подтверждённая запись
 * тут же гасится, и повторный опрос тем же кодом ничего не даст.
 */
export function pollLogin(db, nonce) {
  const row = find(db, nonce);
  if (!row) return { status: 'unknown' };
  if (row.status === 'pending') return { status: row.expires_at > new Date().toISOString() ? 'pending' : 'expired' };
  if (row.status !== 'confirmed') return { status: row.status };

  const taken = db
    .prepare("UPDATE tg_logins SET status = 'used' WHERE nonce_hash = ? AND status = 'confirmed'")
    .run(row.nonce_hash).changes;
  if (!taken) return { status: 'used' };

  if (row.link_user_id) return { status: 'linked' };

  const user = db.prepare('SELECT login, name FROM users WHERE id = ?').get(row.user_id);
  const { token, expires_at } = issueToken(db, row.user_id, 'telegram');
  return { status: 'ok', token, expires_at, login: user.name ?? user.login, created: Boolean(row.created) };
}

/**
 * Подпись запросов бота: HMAC-SHA256 общим секретом от «время.тело». Время защищает
 * от повтора перехваченного запроса, а коды входа одноразовые сами по себе.
 */
export function verifyRelay(ts, signature, rawBody) {
  const { secret } = telegramConfig();
  if (secret.length < 32 || !ts || !signature) return false;
  if (!/^\d+$/.test(String(ts)) || Math.abs(Date.now() - Number(ts) * 1000) > SKEW_MS) return false;
  if (!/^[0-9a-f]{64}$/.test(String(signature))) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest();
  return timingSafeEqual(Buffer.from(signature, 'hex'), expected);
}
