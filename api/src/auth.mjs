// Вход в кабинет и API: пароли и токены.
//
// Проверка живёт здесь, а не в nginx (auth_basic), потому что приложению на телефоне
// нужен токен, который можно выдать, показать в списке и отозвать. Кабинет ходит с тем же
// токеном, чтобы механизм был один.
//
// Пароль хранится хешем scrypt с индивидуальной солью. Токен хранится хешем sha256:
// утечка базы не даёт войти. Сам токен показывается один раз — при выдаче.
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const TOKEN_DAYS = 90; // телефон не должен просить пароль каждую неделю

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Сравнение постоянного времени: обычное === подсказало бы длину совпадения. */
export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored ?? '').split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

export function findUser(db, login) {
  return db.prepare('SELECT id, login, password FROM users WHERE login = ?').get(String(login ?? '').trim());
}

/** Выдача токена. Возвращается один раз — в базе остаётся только его хеш. */
export function issueToken(db, userId, label = null) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + TOKEN_DAYS * 86400_000);
  db.prepare(
    'INSERT INTO tokens (hash, user_id, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(tokenHash(token), userId, label, now.toISOString(), expires.toISOString());
  return { token, expires_at: expires.toISOString() };
}

/** Пользователь по токену из заголовка, либо null. Просроченные токены чистятся здесь же. */
export function userByToken(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT t.hash, t.expires_at, u.id, u.login
         FROM tokens t JOIN users u ON u.id = t.user_id
        WHERE t.hash = ?`,
    )
    .get(tokenHash(token));
  if (!row) return null;

  if (new Date(row.expires_at) <= new Date()) {
    db.prepare('DELETE FROM tokens WHERE hash = ?').run(row.hash);
    return null;
  }

  // Отметка последнего использования: по ней видно живые устройства в списке токенов
  db.prepare('UPDATE tokens SET used_at = ? WHERE hash = ?').run(new Date().toISOString(), row.hash);
  return { id: row.id, login: row.login };
}

export const revokeToken = (db, token) =>
  db.prepare('DELETE FROM tokens WHERE hash = ?').run(tokenHash(token)).changes;

/** Токен из заголовка Authorization: Bearer <...>. */
export function bearer(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

export const hasUsers = (db) => db.prepare('SELECT COUNT(*) c FROM users').get().c > 0;
