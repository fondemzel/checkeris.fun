// Управление Chrome по протоколу DevTools — без npm-зависимостей: WebSocket в Node встроен.
//
// Нужен для одного: войти в интернет-банк так же, как человек в браузере. Банки закрыли
// вход «голыми» запросами, а страница входа в настоящем браузере работает. Браузер
// живёт минуту — пока идёт вход, — и закрывается.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/chrome/chrome',
  '/opt/chrome-headless-shell/chrome-headless-shell',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

export function chromePath() {
  const found = CANDIDATES.find((p) => p && existsSync(p));
  if (!found) throw new Error('не найден Chrome: укажите путь в CHROME_PATH');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Запуск Chrome без окна и подключение к нему. Возвращает страницу:
 * { send, evaluate, close } — send шлёт команду DevTools в контексте вкладки.
 */
export async function openBrowser({ headless = true } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'checker-chrome-'));
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--window-size=1280,900',
    '--lang=ru-RU',
  ];
  if (headless) args.push('--headless=new');
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');

  const proc = spawn(chromePath(), [...args, 'about:blank'], { stdio: 'ignore' });

  // Chrome сам выбирает порт и пишет его в профиль
  let port;
  for (let i = 0; i < 100 && !port; i += 1) {
    await sleep(100);
    const file = join(profile, 'DevToolsActivePort');
    if (existsSync(file)) port = readFileSync(file, 'utf8').split('\n')[0];
  }
  if (!port) {
    proc.kill();
    throw new Error('Chrome не запустился');
  }

  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('нет связи с Chrome'));
  });

  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const wait = msg.id && pending.get(msg.id);
    if (!wait) return;
    pending.delete(msg.id);
    if (msg.error) wait.reject(new Error(`${msg.error.message}`));
    else wait.resolve(msg.result);
  };

  const raw = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const { targetId } = await raw('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => raw(method, params, sessionId);

  // Без окна Chrome называет себя HeadlessChrome — банку это ни к чему
  const { userAgent } = await raw('Browser.getVersion');
  await send('Network.setUserAgentOverride', {
    userAgent: userAgent.replace('HeadlessChrome', 'Chrome'),
    acceptLanguage: 'ru-RU,ru',
  });
  await send('Page.enable');
  await send('Network.enable');

  /** Выполнить выражение на странице и вернуть значение. */
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'ошибка на странице');
    return res.result.value;
  };

  const close = async () => {
    try {
      await raw('Browser.close');
    } catch {
      proc.kill();
    }
    ws.close();
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // Windows держит файлы профиля ещё мгновение — не страшно, это временный каталог
    }
  };

  return { send, evaluate, close };
}
