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
import { linkFunnelRegistration } from './funnel.mjs';

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

// Письмо — на языке приложения. Короткое: что это за код, сам код крупно в рамке, срок,
// «если это не вы». Текстовая часть — для клиентов без HTML; HTML — в стиле приложения.
const LETTER = {
  ru: {
    subject: (code) => `${code} — код для входа в Чекер`,
    link: (code) => `${code} — код, чтобы добавить почту в Чекер`,
    lead: (link) => (link ? 'Код, чтобы добавить эту почту к аккаунту Чекера' : 'Код для входа в Чекер'),
    note: 'Он действует 10 минут. Если вы его не запрашивали — просто ничего не делайте.',
    sign: '— Чекер, checkeris.fun',
  },
  en: {
    subject: (code) => `${code} is your Checker sign-in code`,
    link: (code) => `${code} is your code to add this email to Checker`,
    lead: (link) => (link ? 'Code to add this email to your Checker account' : 'Your Checker sign-in code'),
    note: 'It is valid for 10 minutes. If you didn’t ask for it, just ignore this email.',
    sign: '— Checker, checkeris.fun',
  },
};

// Письмо без HTML (почтовые клиенты без разметки): то же содержание простым текстом
const plain = (L, code, link) => `${L.lead(link)}: ${code}\n\n${L.note}\n\n${L.sign}`;

// Акцент приложения (site/m/styles.css --accent) и его оттенки, вписанные готовым цветом:
// в письме нельзя сослаться на переменные CSS, поэтому значения — явные
const ACCENT = '#2a69b8';
const TEXT = '#1a1e23';
const MUTED = '#565e6b';
const CARD = '#fcfcfd';
const CODE_BG = '#eef3fa'; // ≈ accent-soft на белом: светлая подложка под кодом

/**
 * Письмо в стиле приложения: шапка «Чекер», код крупно в рамке (его удобно выделить и
 * скопировать — моноширинный, с заметным интервалом), пояснение и подпись. Вёрстка на
 * таблицах с инлайновыми стилями: Gmail и другие режут внешний CSS и часто flex.
 */
const htmlMail = (L, code, link) => `<!doctype html>
<html lang="${L === LETTER.en ? 'en' : 'ru'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#e9ecf0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9ecf0">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;background:${CARD};border:1px solid #cfd4db;border-radius:16px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
      <tr><td style="padding:24px 28px 8px">
        <div style="font-size:17px;font-weight:700;color:${TEXT};letter-spacing:.2px">Чекер</div>
      </td></tr>
      <tr><td style="padding:4px 28px 0;font-size:15px;line-height:1.5;color:${TEXT}">
        ${L.lead(link)}:
      </td></tr>
      <tr><td align="center" style="padding:18px 28px 8px">
        <div style="display:inline-block;padding:14px 22px;background:${CODE_BG};border:1px solid ${ACCENT};border-radius:12px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:${TEXT};-webkit-user-select:all;user-select:all">${code}</div>
      </td></tr>
      <tr><td style="padding:12px 28px 4px;font-size:13px;line-height:1.5;color:${MUTED}">
        ${L.note}
      </td></tr>
      <tr><td style="padding:16px 28px 24px;border-top:1px solid #e4e7eb">
        <a href="https://checkeris.fun" style="font-size:13px;color:${ACCENT};text-decoration:none">${L.sign}</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;


/**
 * Отправить код. purpose: login — вход (нужна капча), link — привязка к вошедшему (userId).
 * Ответ одинаковый, есть такая почта или нет: по нему не узнать, кто пользуется Чекером.
 */
export async function sendCode(db, { email, purpose = 'login', userId = null, captcha = null, captchaVerified = false, ip = '', lang = 'ru' }) {
  const addr = normalizeEmail(email);
  if (!addr) return { error: 'не похоже на почту', code: 'bad_email', status: 400 };
  if (!mailReady()) return { error: 'вход по почте пока не работает', code: 'off', status: 503 };
  if (purpose === 'link') {
    const taken = db.prepare('SELECT id FROM users WHERE email = ?').get(addr);
    if (taken && taken.id !== userId) return { error: 'эта почта уже привязана к другому аккаунту', code: 'taken', status: 409 };
  } else if (!captchaVerified && !(await captchaOk(captcha, ip))) {
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
  try {
    await sendMail({ to: addr, subject: (link ? L.link : L.subject)(code), text: plain(L, code, link), html: htmlMail(L, code, link) });
  } catch (err) {
    console.error('почта:', err.message);
    db.prepare('DELETE FROM email_codes WHERE email = ? AND created_at = ?').run(addr, iso(now)); // не ушло — не считаем
    return { error: 'не получилось отправить письмо — попробуйте позже', code: 'send', status: 502 };
  }
  return { ok: true, email: addr };
}

/**
 * Первый шаг входа по почте. Известному адресу сразу отправляем код; новый адрес
 * возвращаем на экран подтверждения регистрации и ничего не отправляем до согласия.
 */
export async function prepareEmailLogin(db, { email, captcha = null, ip = '', lang = 'ru' }) {
  const addr = normalizeEmail(email);
  if (!addr) return { error: 'не похоже на почту', code: 'bad_email', status: 400 };
  if (!mailReady()) return { error: 'вход по почте пока не работает', code: 'off', status: 503 };
  if (!(await captchaOk(captcha, ip))) return { error: 'подтвердите, что вы не робот', code: 'captcha', status: 403 };

  const exists = Boolean(db.prepare('SELECT 1 FROM users WHERE email = ?').get(addr));
  if (!exists) return { ok: true, registration_required: true, email: addr };

  const sent = await sendCode(db, { email: addr, captchaVerified: true, ip, lang });
  return sent.error ? sent : { ...sent, registration_required: false };
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
export function loginByCode(db, { email, code, label = null, source = null, visitor = null }) {
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
    linkFunnelRegistration(db, id, visitor);
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
