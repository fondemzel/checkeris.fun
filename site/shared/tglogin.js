// Вход через Telegram в браузере — общий для мобильной версии и кабинета.
//
// Кнопка входа — обычная ссылка на бота с заранее полученным кодом, а не скрипт,
// который сначала спрашивает сервер: Safari на iPhone не откроет Telegram из кода,
// выполненного после ожидания ответа. Поэтому код берётся, как только показан экран
// входа, и обновляется незадолго до истечения.
//
// Пока человек в Telegram, страница опрашивает сервер. Если она перезагрузилась
// (ярлык на экране телефона так делает), код лежит в localStorage и опрос продолжается.

const KEY = 'checker.tg-login';

export const TG_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/>' +
  '<path d="m21.854 2.147-10.94 10.939"/></svg>';

const FAIL = {
  expired: 'Время на вход истекло — попробуйте ещё раз',
  rejected: 'Вход отменён в Telegram',
  used: 'Этот вход уже использован — попробуйте ещё раз',
  unknown: 'Запрос на вход не найден — попробуйте ещё раз',
};

const fresh = (v) => v && v.expires_at > new Date(Date.now() + 30_000).toISOString();

/** Начатый вход, если он ещё жив: к нему возвращаемся после перезагрузки страницы. */
export function pendingLogin() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return v?.waiting && fresh(v) ? v : null;
  } catch {
    return null;
  }
}

function remember(value) {
  try {
    if (value) localStorage.setItem(KEY, JSON.stringify(value));
    else localStorage.removeItem(KEY);
  } catch {
    /* приватный режим — просто не переживём перезагрузку */
  }
}

/** Новый код входа. С токеном и link=true — привязка Telegram к вошедшему аккаунту. */
export async function requestLogin({ token = null, link = false } = {}) {
  const res = await fetch('/api/auth/telegram/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ link }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

/**
 * Держит ссылку на бота готовой: получает код и обновляет его до истечения.
 * Возвращает функцию, которая останавливает обновление.
 */
export function keepLinkReady(anchor, { onError } = {}) {
  let timer = null;
  let stopped = false;
  const refresh = async () => {
    if (stopped) return;
    try {
      const login = await requestLogin();
      anchor.href = login.url;
      anchor.dataset.nonce = login.nonce;
      anchor.dataset.expires = login.expires_at;
      anchor.classList.remove('disabled');
      timer = setTimeout(refresh, Math.max(60_000, Date.parse(login.expires_at) - Date.now() - 60_000));
    } catch (err) {
      anchor.classList.add('disabled');
      onError?.(err);
    }
  };
  refresh();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** Человек нажал ссылку: запоминаем код, чтобы дождаться подтверждения даже после перезагрузки. */
export function markWaiting(anchor) {
  const value = { nonce: anchor.dataset.nonce, url: anchor.href, expires_at: anchor.dataset.expires, waiting: true };
  remember(value);
  return value;
}

export const forgetLogin = () => remember(null);

/**
 * Ждём подтверждения в боте: опрос раз в 2 секунды и сразу, как только человек
 * вернулся на страницу. onDone получает { token, login, created } или { status: 'linked' }.
 */
export function waitLogin(nonce, { onDone, onFail }) {
  let stopped = false;
  let timer = null;

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };

  const tick = async () => {
    if (stopped) return;
    clearTimeout(timer);
    try {
      const res = await fetch(`/api/auth/telegram/poll?nonce=${encodeURIComponent(nonce)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({ status: 'unknown' }));
      if (stopped) return;
      if (data.status === 'pending') {
        timer = setTimeout(tick, 2000);
        return;
      }
      stop();
      forgetLogin();
      if (data.status === 'ok' || data.status === 'linked') onDone(data);
      else onFail(FAIL[data.status] ?? 'Вход не состоялся — попробуйте ещё раз');
    } catch {
      timer = setTimeout(tick, 4000); // сеть моргнула — не сдаёмся
    }
  };

  function onVisible() {
    if (document.visibilityState === 'visible') tick();
  }

  document.addEventListener('visibilitychange', onVisible);
  tick();
  return stop;
}
