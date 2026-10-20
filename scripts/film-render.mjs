// Ролик покадрово: Chrome в «детерминированном» режиме сам ведёт время — просим кадр на
// 1/60 с, он рисует ровно его, кадр уходит в ffmpeg. Плавность не зависит от скорости машины:
// даже если кадр рисуется полсекунды, в видео — ровные 60 к/с. Запись эмулятора в реальном
// времени теряла кадры (замер 21.10.2026: ~45 к/с в движении и подвисания до 0,1 с).
//
//   node scripts/film-render.mjs <сценарий.mjs> --out ролик.mp4 --token <токен> [--today 2026-12-18]
//
// Сценарий — тот же, что для эмулятора (scripts/film.mjs): f.at, wait, tap, swipe, down/move/up,
// type, spot, clear, until, go, eval. Время сценария — время ролика.
// Нужны chrome-headless-shell (покадровое управление есть только в нём) и ffmpeg:
//   npx @puppeteer/browsers install chrome-headless-shell@stable --path <папка>   → CHROME_SHELL
//   pip install imageio-ffmpeg                                                      → FFMPEG
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SCENARIO = args[0];
const OUT = resolve(opt('out', 'film.mp4'));
const TOKEN = opt('token', process.env.FILM_TOKEN);
const TODAY = opt('today');
const SITE = opt('site', 'https://checkeris.fun/m/');
const CHROME = process.env.CHROME_SHELL;
const FFMPEG = process.env.FFMPEG
  || execFileSync('python', ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();

// Экран — как у телефона: 412×915 точек при плотности 2,625 → видео 1080×2400 (как запись эмулятора)
const W = 412;
const H = 915;
const DPR = 1080 / 412;
const FPS = 60;
const FRAME = 1000 / FPS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SCENARIO || !TOKEN || !CHROME) {
  console.log('нужно: сценарий, --token, переменная CHROME_SHELL (путь к chrome-headless-shell)');
  process.exit(1);
}

// ── браузер ──
const profile = mkdtempSync(join(tmpdir(), 'checker-film-'));
const PORT = 9555;
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--lang=ru-RU',
  // Детерминированный режим: кадр рисуется только по нашему запросу и целиком
  '--enable-begin-frame-control', '--run-all-compositor-stages-before-draw', '--disable-threaded-animation',
  '--disable-threaded-scrolling', '--disable-checker-imaging', '--disable-new-content-rendering-timeout',
  '--disable-image-animation-resync', '--hide-scrollbars', `--window-size=${W},${H}`, '--force-color-profile=srgb',
  'about:blank',
], { stdio: 'ignore' });
process.once('exit', () => chrome.kill());

let version = null;
for (let i = 0; i < 50 && !version; i += 1) {
  await sleep(200);
  version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((ok) => (ws.onopen = ok));
let id = 0;
const waiting = new Map();
const listeners = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) {
    const { ok, fail } = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) fail(new Error(`${msg.error.message}`));
    else ok(msg.result);
  } else if (msg.method) {
    for (const l of [...listeners]) l(msg);
  }
};
let session = null;
const send = (method, params = {}, sid = session) => new Promise((ok, fail) => {
  id += 1;
  waiting.set(id, { ok, fail });
  ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
});
const once = (method) => new Promise((ok) => {
  const l = (msg) => {
    if (msg.method === method && msg.sessionId === session) {
      listeners.splice(listeners.indexOf(l), 1);
      ok(msg.params);
    }
  };
  listeners.push(l);
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank', enableBeginFrameControl: true, width: W, height: H }, null);
session = (await send('Target.attachToTarget', { targetId, flatten: true }, null)).sessionId;
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
  acceptLanguage: 'ru-RU,ru',
});
// Шрифт — как на Android (Roboto): в Windows приложение взяло бы Segoe UI
const early = [`(() => { const s = document.createElement('style');
  s.textContent = "@import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700&display=block'); html, body, button, input, textarea, select { font-family: Roboto, sans-serif !important; }";
  document.documentElement.appendChild(s); })();`];
if (TODAY) {
  early.push(`(() => { const D = Date; const shift = D.parse('${TODAY}T14:00:00') - D.now();
    class FilmDate extends D { constructor(...a) { if (a.length) super(...a); else super(D.now() + shift); } static now() { return D.now() + shift; } }
    window.Date = FilmDate; })();`);
}
for (const source of early) await send('Page.addScriptToEvaluateOnNewDocument', { source });

// ── время и кадры ──
// Виртуальное время стоит, пока мы его не двинем; пока грузятся данные — ждёт их (в ролике
// данные появляются сразу). Каждый кадр: +1/60 с времени, отрисовка, снимок
let frameTime = 1000;
let frames = 0;
let ffmpeg = null;
let recording = false;
await send('Emulation.setVirtualTimePolicy', { policy: 'pause' });

async function step(shoot = recording) {
  const done = once('Emulation.virtualTimeBudgetExpired');
  await send('Emulation.setVirtualTimePolicy', { policy: 'pauseIfNetworkFetchesPending', budget: FRAME });
  await done;
  frameTime += FRAME;
  const r = await send('HeadlessExperimental.beginFrame', {
    frameTimeTicks: frameTime, interval: FRAME, ...(shoot ? { screenshot: { format: 'jpeg', quality: 95 } } : {}),
  });
  if (shoot) {
    if (r.screenshotData) {
      last = Buffer.from(r.screenshotData, 'base64');
    }
    // Кадр без изменений браузер не присылает — повторяем прошлый
    if (last) await write(last);
    frames += 1;
  }
}
let last = null;
const write = (buf) => new Promise((ok) => (ffmpeg.stdin.write(buf) ? ok() : ffmpeg.stdin.once('drain', ok)));
const frameSteps = async (ms) => {
  for (let n = Math.round(ms / FRAME); n > 0; n -= 1) await step();
};

const evaluate = async (expr) => {
  // Пока выражение ждёт (промис), время должно идти: отправляем, а кадры двигаем, пока не ответит
  let result = null;
  let settled = false;
  const p = send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    .then((r) => { result = r; settled = true; }, (e) => { result = { exceptionDetails: { text: e.message } }; settled = true; });
  for (let i = 0; i < 600 && !settled; i += 1) {
    await sleep(0);
    if (!settled) await step();
  }
  await p;
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
// Касание: команду — без ожидания (она ждёт кадра), кадр — и тогда ответ
const touch = async (type, points) => {
  const p = send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map(({ x, y }) => ({ x, y, radiusX: 8, radiusY: 8, force: 1, id: 0 })),
  });
  await step();
  await p;
};
const where = async (target) => {
  if (target && typeof target === 'object' && 'x' in target) return target;
  const r = await evaluate(`film.rect(${JSON.stringify(target)})`);
  if (!r) throw new Error(`на экране нет: ${target}`);
  return r;
};
const glide = async (from, to, ms) => {
  const steps = Math.max(2, Math.round(ms / FRAME));
  for (let i = 1; i <= steps; i += 1) {
    const k = 1 - (1 - i / steps) ** 2;
    await touch('touchMove', [{ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }]);
  }
};

const f = {
  eval: evaluate,
  wait: frameSteps,
  async at(seconds) {
    const target = Math.round(seconds * FPS);
    if (frames > target + 6) console.log(`опоздание к ${seconds} с: ${((frames - target) / FPS).toFixed(2)} с`);
    while (frames < target) await step();
  },
  async until(expr, timeout = 4000) {
    for (let n = Math.round(timeout / FRAME); n > 0; n -= 1) {
      if (await evaluate(expr)) return true;
      await step();
    }
    console.log(`не дождались: ${expr}`);
    return false;
  },
  async tap(target) {
    const p = await where(target);
    await touch('touchStart', [p]);
    await frameSteps(80);
    await touch('touchEnd', []);
  },
  async swipe(from, to, ms = 320) {
    const a = await where(from);
    const b = typeof to === 'object' && 'dx' in to ? { x: a.x + to.dx, y: a.y + (to.dy ?? 0) } : await where(to);
    await touch('touchStart', [a]);
    await glide(a, b, ms);
    await touch('touchEnd', []);
  },
  async down(target) {
    this.finger = await where(target);
    await touch('touchStart', [this.finger]);
  },
  async move(target, ms = 380) {
    const to = await where(target);
    await glide(this.finger, to, ms);
    this.finger = to;
  },
  async up() {
    await touch('touchEnd', []);
    this.finger = null;
  },
  async press(target, { hold = 650, then = null, ms = 380 } = {}) {
    await this.down(target);
    await frameSteps(hold);
    if (then) await this.move(then, ms);
    await frameSteps(150);
    await this.up();
  },
  async type(text, { every = 90 } = {}) {
    for (const ch of text) {
      const p = send('Input.insertText', { text: ch });
      await step();
      await p;
      await frameSteps(every - FRAME);
    }
  },
  hideKeyboard: () => evaluate('document.activeElement?.blur(), true'),
  spot: (target, o = {}) => evaluate(`film.spot(${JSON.stringify(target)}, ${JSON.stringify(o)})`),
  clear: () => evaluate('film.clear()'),
  // Переход по адресу: страница грузится, время идёт кадрами
  async go(query) {
    const loaded = once('Page.loadEventFired');
    await send('Page.navigate', { url: SITE + query });
    let ok = false;
    loaded.then(() => (ok = true));
    for (let i = 0; i < 1200 && !ok; i += 1) await step();
    await frameSteps(200);
  },
};

try {
  // Вход: токен — в хранилище страницы, затем сценарий (его первый go — уже в кадре)
  await f.go('');
  await evaluate(`localStorage.setItem('checker.token', ${JSON.stringify(TOKEN)}), true`);
  await f.go('?screen=summary');
  await frameSteps(1500);
  ffmpeg = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', String(FPS), OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
  recording = true;
  const t0 = Date.now();
  const scenario = (await import(pathToFileURL(resolve(SCENARIO)).href)).default;
  await scenario(f);
  ffmpeg.stdin.end();
  await new Promise((ok) => ffmpeg.on('close', ok));
  console.log(`готово: ${OUT} — ${frames} кадров (${(frames / FPS).toFixed(1)} с), рендер ${((Date.now() - t0) / 1000).toFixed(0)} с`);
} catch (err) {
  console.log('сбой:', err.message);
  process.exitCode = 1;
} finally {
  ffmpeg?.stdin.end();
  ws.close();
  chrome.kill();
}
