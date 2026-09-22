// Т-Банк: вход и операции через веб-API интернет-банка.
//
// Официального API для частных клиентов у банка нет, поэтому идём тем же путём, что
// сайт tbank.ru: вход — в настоящем браузере (с июня 2024 банк не пускает без него),
// дальше — обычные GET-запросы с сессией из куки psid. Сессию держим живой пингом.
//
// Пароль от банка нигде не сохраняется: он нужен только во время входа.
import { openBrowser } from './cdp.mjs';

const BASE = 'https://www.tbank.ru';
const API = `${BASE}/api/common/v1`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** В поле телефона «+7» уже стоит: вводим 10 цифр, откуда бы ни пришёл номер. */
export function phoneDigits(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length === 11 && /^[78]/.test(digits) ? digits.slice(1) : digits;
}

/** Запрос к веб-API банка. Ответ банка — { resultCode, payload, errorMessage }. */
export async function call(sessionId, method, params = {}) {
  const q = new URLSearchParams({ origin: 'web,ib5,platform', ...params });
  if (sessionId) q.set('sessionid', sessionId);
  const res = await fetch(`${API}/${method}?${q}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw Object.assign(new Error(`Т-Банк: HTTP ${res.status}`), { status: res.status });
  const body = await res.json();
  if (body.resultCode !== 'OK') {
    throw Object.assign(new Error(`Т-Банк: ${body.errorMessage || body.resultCode}`), { code: body.resultCode });
  }
  return body.payload;
}

/** Жива ли сессия: банк отвечает уровнем доступа, у вошедшего клиента — CLIENT. */
export async function ping(sessionId) {
  try {
    const payload = await call(sessionId, 'ping');
    return payload?.accessLevel === 'CLIENT';
  } catch {
    return false;
  }
}

export const accounts = (sessionId) => call(sessionId, 'accounts_light_ib');

export const operations = (sessionId, account, from, to = new Date()) =>
  call(sessionId, 'operations', { account, start: String(from.getTime()), end: String(to.getTime()) });

export const shoppingReceipt = (sessionId, operationId) =>
  call(sessionId, 'shopping_receipt', { operationId: String(operationId) });

// Что видно на странице входа: поля и кнопки по их automation-id — так их размечает сам банк
const PROBE = `(() => {
  const shown = (el) => el && el.offsetParent !== null && !el.disabled;
  const ids = {};
  for (const el of document.querySelectorAll('[automation-id]')) {
    if (shown(el)) ids[el.getAttribute('automation-id')] = el.tagName.toLowerCase();
  }
  const text = (document.querySelector('h1, h2, [automation-id="title"]')?.innerText ?? '').slice(0, 120);
  const error = (document.querySelector('[automation-id="server-error"]')?.innerText ?? '').trim().slice(0, 300);
  return { url: location.href, ids, text, error };
})()`;

async function typeInto(page, automationId, value) {
  await page.evaluate(`(() => {
    const el = document.querySelector('[automation-id="${automationId}"]');
    el.focus();
    el.select?.();
  })()`);
  await page.send('Input.insertText', { text: value });
  await sleep(300);
  // Отправка — кнопкой формы, как человек; кнопки нет (код из СМС уходит сам) — Enter
  const clicked = await page.evaluate(`(() => {
    const b = document.querySelector('[automation-id="button-submit"]');
    if (!b || b.disabled || b.offsetParent === null) return false;
    b.click();
    return true;
  })()`);
  if (!clicked) {
    for (const type of ['keyDown', 'keyUp']) {
      await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
  }
}

async function sessionCookie(page) {
  const { cookies } = await page.send('Network.getCookies', { urls: [BASE] });
  return cookies.find((c) => c.name === 'psid')?.value ?? null;
}

/**
 * Вход. Спрашивает у человека то, что просит банк, через колбэки:
 *   ask('phone' | 'password' | 'code', подсказка) → строка
 *   log(сообщение) — что происходит, для отладки
 * Возвращает sessionId. Если застряли — кидает ошибку со снимком экрана в err.screenshot.
 */
export async function login({ ask, log = () => {}, headless = true, timeoutMs = 5 * 60_000 }) {
  const page = await openBrowser({ headless });
  try {
    await page.send('Page.navigate', { url: `${BASE}/login/` });
    const done = new Set();
    const started = Date.now();
    let lastChange = Date.now();
    let lastSeen = '';

    while (Date.now() - started < timeoutMs) {
      await sleep(700);

      // Вход завершён, когда сессия из куки отвечает как клиентская
      const sid = await sessionCookie(page);
      if (sid && (await ping(sid))) {
        log('вход выполнен');
        return sid;
      }

      let state;
      try {
        state = await page.evaluate(PROBE);
      } catch {
        continue; // страница перезагружается
      }
      const seen = `${state.url} ${Object.keys(state.ids).sort().join(',')}`;
      if (seen !== lastSeen) {
        lastSeen = seen;
        lastChange = Date.now();
        log(`страница: ${state.url} · ${state.text || '—'} · ${Object.keys(state.ids).join(', ') || 'нет полей'}`);
      }

      // Банк ответил ошибкой — ждать нечего: показываем её текст и снимок экрана
      if (state.error) {
        const shot = await page.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
        throw Object.assign(new Error(`Т-Банк ответил: ${state.error}`), { screenshot: shot?.data ?? null, state });
      }

      const has = (id) => Object.hasOwn(state.ids, id);
      if (has('phone-input') && !done.has('phone')) {
        done.add('phone');
        await typeInto(page, 'phone-input', phoneDigits(await ask('phone', 'Телефон, привязанный к Т-Банку')));
      } else if (has('otp-input')) {
        await typeInto(page, 'otp-input', await ask('code', 'Код из СМС от Т-Банка'));
        await sleep(4000); // дать странице принять код, иначе спросим его второй раз
      } else if (has('password-input') && !done.has('password')) {
        done.add('password');
        await typeInto(page, 'password-input', await ask('password', 'Пароль от Т-Банка'));
      } else if (has('cancel-button')) {
        // «Придумать код для входа» и подобные предложения — пропускаем
        await page.evaluate(`document.querySelector('[automation-id="cancel-button"]').click()`);
      } else if (Date.now() - lastChange > 45_000) {
        const shot = await page.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
        throw Object.assign(new Error(`вход застрял на странице ${state.url}`), {
          screenshot: shot?.data ?? null,
          state,
        });
      }
    }
    throw new Error('вход не уложился в отведённое время');
  } finally {
    await page.close();
  }
}
