// Вход по почте и привязка почты к аккаунту — код из письма, без пароля.
//
// Почта — такой же способ войти, как Telegram: у человека может не быть Telegram вовсе.
// Вход: почта → капча → письмо с кодом из 6 цифр → код → токен. Незнакомая почта — новый
// аккаунт (как первый вход через Telegram). Привязка: вошедший человек добавляет почту к
// аккаунту тем же кодом — дальше входит любым способом в тот же аккаунт.
//
// Письмо может уйти кому угодно, поэтому всё против рассылки чужими руками: перед письмом
// без входа — Яндекс SmartCaptcha (SMARTCAPTCHA_SERVER_KEY, ключ клиента —
// SMARTCAPTCHA_CLIENT_KEY), лимиты на почту и на адрес, код живёт 10 минут, 5 попыток.
// Код и почта в журнале запросов — хешем.
import { randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { issueToken } from './auth.mjs';
import { createBudget } from './budgets.mjs';
import { sourceSlug } from './telegram.mjs';
import { loadEnv } from './llm.mjs';
import { sendMail, mailReady } from './mail.mjs';

const TTL_MS = 10 * 60_000; // сколько живёт код
const ATTEMPTS = 5; // попыток ввести код
const RESEND_MS = 60_000; // повторное письмо на ту же почту — не раньше
const PER_EMAIL_DAY = 5; // писем на одну почту в сутки
const PER_IP_HOUR = 10; // писем с одного адреса в час

const sha = (v) => createHash('sha256').update(String(v)).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

/** Почта к общему виду; не похожа на почту — null. */
export function normalizeEmail(v) {
  const email = String(v ?? '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

export function emailConfig() {
  loadEnv();
  return { ready: mailReady(), captcha: process.env.SMARTCAPTCHA_CLIENT_KEY || null };
}

/** Капча Яндекса: токен из браузера → проверка у Яндекса. Ключа нет — проверять нечем, пропускаем. */
async function captchaOk(token, ip) {
  loadEnv();
  const secret = process.env.SMARTCAPTCHA_SERVER_KEY;
  if (!secret) return true;
  if (!token) return false;
  try {
    const url = `https://smartcaptcha.yandexcloud.net/validate?secret=${encodeURIComponent(secret)}&token=${encodeURIComponent(token)}&ip=${encodeURIComponent(ip ?? '')}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    // Яндекс недоступен — не запираем всех снаружи, лимиты всё равно действуют
    if (!res.ok) return res.status >= 500;
    return (await res.json()).status === 'ok';
  } catch {
    return true;
  }
}

// Письмо — на языке приложения. Коротко: код крупно, что делать, если это не вы
const LETTER = {
  ru: {
    subject: (code) => `${code} — код для входа в Чекер`,
    link: (code) => `${code} — код, чтобы добавить почту в Чекер`,
    body: (code, link) => `${link ? 'Код, чтобы добавить эту почту к аккаунту Чекера' : 'Код для входа в Чекер'}: ${code}\n\nОн действует 10 минут. Если вы его не запрашивали — просто ничего не делайте.\n\n— Чекер, checkeris.fun`,
  },
  en: {
    subject: (code) => `${code} is your Checker sign-in code`,
    link: (code) => `${code} is your code to add this email to Checker`,
    body: (code, link) => `${link ? 'Code to add this email to your Checker account' : 'Your Checker sign-in code'}: ${code}\n\nIt is valid for 10 minutes. If you didn’t ask for it, just ignore this email.\n\n— Checker, checkeris.fun`,
  },
};
const html = (text, code) =>
  `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">`
  + text.split('\n\n').map((p) => `<p>${p.replace(code, `<b style="font-size:24px;letter-spacing:4px">${code}</b>`)}</p>`).join('')
  + '</div>';

/**
 * Отправить код. purpose: login — вход (нужна капча), link — привязка к вошедшему (userId).
 * Ответ одинаковый, есть такая почта или нет: по нему не узнать, кто пользуется Чекером.
 */
export async function sendCode(db, { email, purpose = 'login', userId = null, captcha = null, ip = '', lang = 'ru' }) {
  const addr = normalizeEmail(email);
  if (!addr) return { error: 'не похоже на почту', code: 'bad_email', status: 400 };
  if (!mailReady()) return { error: 'вход по почте пока не работает', code: 'off', status: 503 };
  if (purpose === 'link') {
    const taken = db.prepare('SELECT id FROM users WHERE email = ?').get(addr);
    if (taken && taken.id !== userId) return { error: 'эта почта уже привязана к другому аккаунту', code: 'taken', status: 409 };
  } else if (!(await captchaOk(captcha, ip))) {
    return { error: 'подтвердите, что вы не робот', code: 'captcha', status: 403 };
  }

  const now = Date.now();
  db.prepare('DELETE FROM email_codes WHERE expires_at < ?').run(iso(now - 86_400_000));
  const last = db.prepare('SELECT created_at FROM email_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1').get(addr);
  if (last && now - Date.parse(last.created_at) < RESEND_MS) return { error: 'письмо уже отправлено — подождите минуту', code: 'wait', status: 429 };
  const day = db.prepare('SELECT COUNT(*) AS n FROM email_codes WHERE email = ? AND created_at >= ?').get(addr, iso(now - 86_400_000)).n;
  const hour = db.prepare('SELECT COUNT(*) AS n FROM email_codes WHERE ip_hash = ? AND created_at >= ?').get(sha(ip), iso(now - 3_600_000)).n;
  if (day >= PER_EMAIL_DAY || hour >= PER_IP_HOUR) return { error: 'слишком много писем — попробуйте позже', code: 'limit', status: 429 };

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  // Прежние коды на эту почту гасим: действует только последний
  db.prepare('UPDATE email_codes SET used = 1 WHERE email = ? AND used = 0').run(addr);
  db.prepare(
    `INSERT INTO email_codes (email, code_hash, purpose, user_id, ip_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(addr, sha(`${addr}:${code}`), purpose, userId, sha(ip), iso(now), iso(now + TTL_MS));

  const L = LETTER[lang] ?? LETTER.ru;
  const link = purpose === 'link';
  const text = L.body(code, link);
  try {
    await sendMail({ to: addr, subject: (link ? L.link : L.subject)(code), text, html: html(text, code) });
  } catch (err) {
    console.error('почта:', err.message);
    db.prepare('DELETE FROM email_codes WHERE email = ? AND created_at = ?').run(addr, iso(now)); // не ушло — не считаем
    return { error: 'не получилось отправить письмо — попробуйте позже', code: 'send', status: 502 };
  }
  return { ok: true, email: addr };
}

/** Проверить код: верный — запись гасится, неверный — попытка списывается. */
function checkCode(db, addr, code, purpose, userId = null) {
  const row = db.prepare(
    `SELECT * FROM email_codes WHERE email = ? AND purpose = ? AND used = 0 AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`,
  ).get(addr, purpose, iso(Date.now()));
  if (!row || (purpose === 'link' && row.user_id !== userId)) return { error: 'код устарел — запросите новый', code: 'expired', status: 410 };
  if (row.attempts >= ATTEMPTS) return { error: 'слишком много попыток — запросите новый код', code: 'attempts', status: 429 };
  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(sha(`${addr}:${String(code ?? '').replace(/\D/g, '')}`), 'hex');
  if (!timingSafeEqual(expected, actual)) {
    db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const left = ATTEMPTS - row.attempts - 1;
    return { error: left > 0 ? `неверный код — осталось попыток: ${left}` : 'неверный код — запросите новый', code: left > 0 ? 'wrong' : 'attempts', left, status: 401 };
  }
  db.prepare('UPDATE email_codes SET used = 1 WHERE id = ?').run(row.id);
  return { ok: true };
}

/** Вход по коду. Незнакомая почта — новый аккаунт со своим бюджетом. */
export function loginByCode(db, { email, code, label = null, source = null }) {
  const addr = normalizeEmail(email);
  if (!addr) return { error: 'не похоже на почту', code: 'bad_email', status: 400 };
  const check = checkCode(db, addr, code, 'login');
  if (check.error) return check;

  let user = db.prepare('SELECT id, name, login FROM users WHERE email = ?').get(addr);
  let created = false;
  if (!user) {
    // Имя — начало почты: «anna.petrova@…» → «anna.petrova»; человек поменяет его в профиле
    const name = addr.split('@')[0].slice(0, 60);
    const id = Number(db.prepare(
      `INSERT INTO users (login, password, created_at, email, name, role, source) VALUES (?, '!', ?, ?, ?, 'user', ?)`,
    ).run(`mail:${addr}`, iso(Date.now()), addr, name, sourceSlug(source)).lastInsertRowid);
    createBudget(db, id); // свой бюджет с копией системного справочника
    user = { id, name, login: `mail:${addr}` };
    created = true;
  }
  const { token, expires_at } = issueToken(db, user.id, label ? String(label).slice(0, 40) : 'почта');
  return { token, expires_at, login: user.name ?? user.login, created };
}

/** Привязать почту к вошедшему: код пришёл на неё — значит, почта его. */
export function linkByCode(db, user, { email, code }) {
  const addr = normalizeEmail(email);
  if (!addr) return { error: 'не похоже на почту', code: 'bad_email', status: 400 };
  const check = checkCode(db, addr, code, 'link', user.id);
  if (check.error) return check;
  const taken = db.prepare('SELECT id FROM users WHERE email = ?').get(addr);
  if (taken && taken.id !== user.id) return { error: 'эта почта уже привязана к другому аккаунту', code: 'taken', status: 409 };
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(addr, user.id);
  return { ok: true, email: addr };
}
