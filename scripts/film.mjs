// Съёмка роликов: ведёт Чекер по сценарию — касания, свайпы, выделение элементов (film.spot
// в приложении) — и пишет экран. Где: в Chrome с экраном телефона (--browser — плавнее всего:
// эмулятор в записи терял кадры) или в эмуляторе Android (страницу видно через отладку
// WebView: она включена только на эмуляторе, MainActivity).
//
//   --phone [--token <токен>]   — Chrome на подключённом телефоне (FILM_DEVICE — его номер в adb),
//       страница во весь экран, без адресной строки. Запись — scrcpy (SCRCPY — путь): кодирует
//       аппаратно сам телефон, кадры не теряются. Учётная запись — та, что войдёт в Chrome
//       телефона (--token); приложение Чекер и его синхронизация банков не затрагиваются
//   --browser --token <токен>  — Chrome на компьютере: 412×915 точек, плотность телефона
//       (видео 1080×2400), касания, шрифт Roboto, как на Android. Запись — кадрами самого
//       браузера (screencast) в ffmpeg, MP4 60 к/с
//
//   node scripts/film.mjs eval "<js>"            — выполнить на странице и напечатать результат
//   node scripts/film.mjs login <токен>           — войти учётной записью для съёмки
//   node scripts/film.mjs run <сценарий.mjs> [--rec out.webm] [--today 2026-12-18]
//       — прогнать сценарий (и записать). --today — «сегодня» для страницы на время съёмки: так
//       нужный месяц демо-семьи — текущий (лимиты показывают «можно в день», а не «не начался»)
//
// Сценарий — модуль с export default async (f) => { … }, где f — команды ниже. Координаты —
// пиксели страницы; цель — селектор, 'text:Питание' или элемент (см. film.find в app.js).
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ADB = process.env.ADB || 'C:/Users/fondemzel/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const DEVICE = process.env.FILM_DEVICE || 'emulator-5554';
const PORT = 9333;
const adb = (...args) => execFileSync(ADB, ['-s', DEVICE, ...args], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] ?? true : null;
};
const BROWSER = argv.includes('--browser');
const PHONE = argv.includes('--phone');
const SCRCPY = process.env.SCRCPY || 'scrcpy';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SITE = 'https://checkeris.fun/m/';
// Экран телефона: 412×915 точек при плотности 2,625 → 1080×2400 пикселей
const VIEW = { width: 412, height: 915, deviceScaleFactor: 1080 / 412, mobile: true };

/** Соединение со страницей по протоколу отладки: команды и события. */
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error('не подключиться к странице'));
  });
  let id = 0;
  const waiting = new Map();
  const listeners = new Set();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, fail } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) fail(new Error(msg.error.message));
      else ok(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}) => new Promise((ok, fail) => {
    id += 1;
    waiting.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, on: (l) => listeners.add(l), close: () => ws.close() };
}

/** Chrome на компьютере с экраном телефона: вход учётной записью для съёмки, шрифт Android. */
async function openChrome() {
  const token = flag('token') ?? process.env.FILM_TOKEN;
  if (!token) throw new Error('нужен --token учётной записи для съёмки');
  const port = 9556;
  const proc = spawn(CHROME, [`--user-data-dir=${mkdtempSync(join(tmpdir(), 'checker-film-'))}`, `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', '--lang=ru-RU', `--window-size=${VIEW.width},${VIEW.height}`,
    // Плотность телефона и у самого окна: иначе кадры записи — в точках страницы (412×915)
    `--force-device-scale-factor=${VIEW.deviceScaleFactor}`, '--force-color-profile=srgb',
    '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  process.once('exit', () => proc.kill());
  let page = null;
  for (let i = 0; i < 50 && !page; i += 1) {
    await sleep(200);
    const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => []);
    page = list.find((p) => p.type === 'page');
  }
  const cdp = await attach(page.webSocketDebuggerUrl);
  cdp.proc = proc;
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', VIEW);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    acceptLanguage: 'ru-RU,ru',
  });
  // Шрифт — как на Android (Roboto): в Windows приложение взяло бы Segoe UI
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => { const s = document.createElement('style');
      s.textContent = "@import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700&display=block'); html, body, button, input, textarea, select { font-family: Roboto, sans-serif !important; }";
      document.documentElement.appendChild(s); })();`,
  });
  await cdp.send('Page.navigate', { url: SITE });
  await sleep(2500);
  await cdp.send('Runtime.evaluate', { expression: `localStorage.setItem('checker.token', ${JSON.stringify(token)})` });
  await cdp.send('Page.navigate', { url: `${SITE}?screen=summary` });
  await sleep(4000);
  return cdp;
}

/** Запись кадров браузера: каждый кадр — с отметкой времени; паузы заполняются прошлым кадром. */
function screencast(cdp, out) {
  const ffmpegExe = process.env.FFMPEG
    || execFileSync('python', ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();
  const ff = spawn(ffmpegExe, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '60', '-i', '-',
    '-vf', 'scale=1080:2400:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-pix_fmt', 'yuv420p', resolve(out)], { stdio: ['pipe', 'inherit', 'inherit'] });
  let t0 = null;
  let written = 0;
  let last = null;
  let got = 0;
  cdp.on((msg) => {
    if (msg.method !== 'Page.screencastFrame') return;
    const { data, metadata, sessionId } = msg.params;
    cdp.send('Page.screencastFrameAck', { sessionId });
    got += 1;
    const ts = metadata.timestamp;
    t0 ??= ts;
    const index = Math.round((ts - t0) * 60);
    // Кадр приходит, когда экран изменился: до его места в ролике тянем прошлый
    while (last && written < index) {
      ff.stdin.write(last);
      written += 1;
    }
    last = Buffer.from(data, 'base64');
    if (written <= index) {
      ff.stdin.write(last);
      written += 1;
    }
  });
  return {
    start: () => cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 1080, maxHeight: 2400, everyNthFrame: 1 }),
    async stop(seconds) {
      await cdp.send('Page.stopScreencast');
      while (last && written < seconds * 60) {
        ff.stdin.write(last);
        written += 1;
      }
      ff.stdin.end();
      await new Promise((ok) => ff.on('close', ok));
      return { got, written };
    },
  };
}

/** Chrome на телефоне: открыть Чекер, найти вкладку по отладке, войти, развернуть во весь экран. */
async function openPhone() {
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `${SITE}?screen=summary`, 'com.android.chrome');
  await sleep(3000);
  adb('forward', 'tcp:9334', 'localabstract:chrome_devtools_remote');
  // Chrome только что открылся — отладка отвечает не сразу
  let page = null;
  for (let i = 0; i < 20 && !page; i += 1) {
    const pages = await fetch('http://127.0.0.1:9334/json').then((r) => r.json()).catch(() => []);
    page = pages.find((p) => p.type === 'page' && p.url.includes('checkeris.fun'));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('вкладка Чекера в Chrome телефона не найдена');
  // Адрес в списке — без порта (ws://localhost/…): подставляем проброшенный
  const cdp = await attach(`ws://127.0.0.1:9334/devtools/page/${page.id}`);
  await cdp.send('Page.enable');
  const token = flag('token') ?? process.env.FILM_TOKEN;
  if (token) {
    // Язык — русский: Chrome телефона может быть на английском, а ролик — на русском
    await cdp.send('Runtime.evaluate', { expression: `localStorage.setItem('checker.token', ${JSON.stringify(token)}), localStorage.setItem('checker.lang', 'ru')` });
    await cdp.send('Page.reload');
    await sleep(4000);
  }
  return cdp;
}

/** Во весь экран — без адресной строки и строки состояния. Браузер разрешает это только по
 *  касанию человека: ставим обработчик и касаемся заголовка (касание по отладке — настоящее). */
async function fullscreen(f) {
  // Клик этого касания гасим: оно служебное и ничего не должно нажать (попав в значок
  // «демо-режим», оно открыло вопрос «Выключить демо-режим?», 21.10.2026). И касаемся пустого
  // поля у левого края, между краем экрана и карточками
  await f.eval(`(addEventListener('touchend', () => document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}), { once: true, capture: true }),
    addEventListener('click', (e) => { e.stopImmediatePropagation(); e.preventDefault(); }, { once: true, capture: true }), true)`);
  await f.tap({ x: 4, y: Math.round(await f.eval('innerHeight / 2')) });
  // Chrome несколько секунд показывает подсказку «чтобы выйти из полноэкранного режима…» —
  // ждём, пока уйдёт, чтобы не попала в кадр
  await sleep(11000); // замер 21.10.2026: подсказка держится ~9 с
  return f.eval('!!document.fullscreenElement');
}

async function connect() {
  if (BROWSER) return openChrome();
  if (PHONE) return openPhone();
  const socket = adb('shell', 'cat /proc/net/unix').match(/webview_devtools_remote_\d+/)?.[0];
  if (!socket) throw new Error('страница Чекера не найдена: приложение запущено? отладка включается только на эмуляторе');
  adb('forward', `tcp:${PORT}`, `localabstract:${socket}`);
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = pages.find((p) => p.type === 'page' && p.url.includes('checkeris.fun')) ?? pages[0];
  return attach(page.webSocketDebuggerUrl);
}

function commands(cdp) {
  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const where = async (target) => {
    if (target && typeof target === 'object' && 'x' in target) return target;
    const r = await evaluate(`film.rect(${JSON.stringify(target)})`);
    if (!r) throw new Error(`на экране нет: ${target}`);
    return r;
  };
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map(({ x, y }) => ({ x, y, radiusX: 8, radiusY: 8, force: 1, id: 0 })),
  });
  // Плавное движение пальца: кадр раз в 16 мс, с замедлением к концу, как у человека. Шаги
  // идут по часам, ответа страницы на каждый не ждём: под нагрузкой записи ответ приходит
  // через ~60 мс, и жест в 0,36 с растягивался до 1,4 с (замер 20.10.2026)
  const glide = async (from, to, ms) => {
    const steps = Math.max(2, Math.round(ms / 16));
    const t0 = Date.now();
    const sent = [];
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const k = 1 - (1 - t) ** 2;
      sent.push(touch('touchMove', [{ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }]));
      const next = t0 + (i * ms) / steps - Date.now();
      if (next > 0) await sleep(next);
    }
    await Promise.all(sent);
  };
  return {
    eval: evaluate,
    wait: sleep,
    /** Пауза до отметки времени ролика (секунды от начала сценария) — держит темп озвучки. */
    async at(seconds) {
      const left = this.start + seconds * 1000 - Date.now();
      if (left > 0) await sleep(left);
      // Опоздали к отметке — темп разойдётся с озвучкой: видно, какой шаг не успевает
      else if (left < -150) console.log(`опоздание к ${seconds} с: ${(-left / 1000).toFixed(2)} с`);
    },
    /** Ждать, пока на странице не станет верно условие (смена периода, открытие экрана). */
    async until(expr, timeout = 4000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await evaluate(expr)) return true;
        await sleep(100);
      }
      console.log(`не дождались: ${expr}`);
      return false;
    },
    async tap(target, { hold = 90 } = {}) {
      const p = await where(target);
      // Chrome на телефоне из голых касаний «клик» не собирает — нужен жест касания целиком
      if (PHONE) return cdp.send('Input.synthesizeTapGesture', { x: p.x, y: p.y, duration: hold, gestureSourceType: 'touch' });
      await touch('touchStart', [p]);
      await sleep(hold);
      await touch('touchEnd', []);
    },
    async swipe(from, to, ms = 320) {
      const a = await where(from);
      const b = typeof to === 'object' && 'dx' in to ? { x: a.x + to.dx, y: a.y + (to.dy ?? 0) } : await where(to);
      await touch('touchStart', [a]);
      await glide(a, b, ms);
      await touch('touchEnd', []);
    },
    // Палец по частям: опустить, провести, отпустить — между ними можно переводить выделение
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
    /** Убрать экранную клавиатуру: поле теряет фокус, текст в нём остаётся. */
    hideKeyboard: () => evaluate('document.activeElement?.blur(), true'),
    /** Долгое нажатие; then — куда, не отпуская, провести палец (пункт попапа). */
    async press(target, { hold = 650, then = null, ms = 380 } = {}) {
      const a = await where(target);
      await touch('touchStart', [a]);
      await sleep(hold);
      if (then) await glide(a, await where(then), ms);
      await sleep(150);
      await touch('touchEnd', []);
    },
    async type(text, { every = 90 } = {}) {
      for (const ch of text) {
        await cdp.send('Input.insertText', { text: ch });
        await sleep(every);
      }
    },
    spot: (target, opts = {}) => evaluate(`film.spot(${JSON.stringify(target)}, ${JSON.stringify(opts)})`),
    clear: () => evaluate('film.clear()'),
    /** Открыть экран по адресу (без истории касаний): подготовка кадра. */
    go: (query) => evaluate(`(location.search = ${JSON.stringify(query)}, true)`),
  };
}

const [cmd, arg, ...rest] = argv;
const cdp = await connect();
const f = commands(cdp);
try {
  if (cmd === 'eval') {
    console.log(JSON.stringify(await f.eval(arg), null, 1));
  } else if (cmd === 'login') {
    await f.eval(`localStorage.setItem('checker.token', ${JSON.stringify(arg)}); location.reload(); true`);
    console.log('вошли — страница перезагружается');
  } else if (cmd === 'run') {
    const scenario = (await import(pathToFileURL(resolve(arg)).href)).default;
    const todayAt = rest.indexOf('--today');
    if (todayAt >= 0) {
      // Сдвиг часов страницы: Date и Date.now идут от выбранного дня, время суток — днём
      const shift = `(() => { const D = Date; const shift = D.parse('${rest[todayAt + 1]}T14:00:00') - D.now();
        class FilmDate extends D { constructor(...a) { if (a.length) super(...a); else super(D.now() + shift); } static now() { return D.now() + shift; } }
        window.Date = FilmDate; })();`;
      await cdp.send('Page.enable');
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: shift });
      await f.eval(`(location.href = location.pathname + '?screen=summary', true)`);
      await sleep(6000);
    }
    const recAt = rest.indexOf('--rec');
    const out = recAt >= 0 ? rest[recAt + 1] : null;
    let rec = null;
    if (PHONE) console.log('во весь экран:', await fullscreen(f));
    if (out && PHONE) {
      // scrcpy пишет экран телефона сам (аппаратный кодек), без окна; до 90 с — сценарий короче
      rec = spawn(SCRCPY, ['-s', DEVICE, '--no-window', '--no-audio', '--video-codec=h264', '--video-bit-rate=40M',
        '--max-fps=60', '--time-limit=90', `--record=${resolve(out)}.mkv`], { stdio: 'ignore' });
      await sleep(2500); // scrcpy запускает сервер на телефоне
      rec.lead = Date.now();
    } else if (out && BROWSER) {
      rec = screencast(cdp, out);
      await rec.start();
    } else if (out) {
      // Запись — средствами эмулятора, со стороны компьютера: 60 кадров в секунду. Запись
      // внутри Android (screenrecord) на эмуляторе кодирует программно и успевает ~10–14
      // кадров (замер 20.10.2026). Файл — WebM, путь — на компьютере
      adb('emu', 'screenrecord', 'start', '--fps', '60', '--bit-rate', '24000000', resolve(out));
      rec = true;
      await sleep(600);
    }
    f.start = Date.now();
    await scenario(f);
    if (rec && PHONE) {
      // Запись остановить нечем, кроме предела времени: ждём его и режем ролик по сценарию
      const lead = (f.start - rec.lead) / 1000 + 1.0; // +1 с: scrcpy начинает писать не сразу
      const length = (Date.now() - f.start) / 1000 + 0.5;
      console.log('ждём конца записи scrcpy…');
      await new Promise((ok) => rec.on('close', ok));
      const ffmpegExe = process.env.FFMPEG
        || execFileSync('python', ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();
      execFileSync(ffmpegExe, ['-y', '-loglevel', 'error', '-ss', lead.toFixed(2), '-i', `${resolve(out)}.mkv`, '-t', length.toFixed(2),
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', '60', resolve(out)]);
      rmSync(`${resolve(out)}.mkv`, { force: true });
      console.log('записано:', resolve(out));
    } else if (rec && BROWSER) {
      await sleep(400);
      const { got, written } = await rec.stop((Date.now() - f.start) / 1000);
      console.log(`записано: ${resolve(out)} — ${written} кадров, из них новых от браузера ${got}`);
    } else if (rec) {
      await sleep(600);
      adb('emu', 'screenrecord', 'stop');
      await sleep(1500);
      console.log('записано:', resolve(out));
    }
  } else {
    console.log('команды: eval, login, run — см. начало файла');
  }
} catch (err) {
  console.log('сбой:', err.message);
  process.exitCode = 1;
} finally {
  cdp.close();
  cdp.proc?.kill();
}
