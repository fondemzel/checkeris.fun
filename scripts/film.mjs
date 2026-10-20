// Съёмка роликов: ведёт Чекер в эмуляторе Android по сценарию — касания, свайпы, выделение
// элементов (film.spot в приложении) — и пишет экран. Страницу видно через отладку WebView:
// она включена только на эмуляторе (MainActivity).
//
//   node scripts/film.mjs eval "<js>"            — выполнить на странице и напечатать результат
//   node scripts/film.mjs login <токен>           — войти учётной записью для съёмки
//   node scripts/film.mjs run <сценарий.mjs> [--rec out.webm] [--today 2026-12-18]
//       — прогнать сценарий (и записать). --today — «сегодня» для страницы на время съёмки: так
//       нужный месяц демо-семьи — текущий (лимиты показывают «можно в день», а не «не начался»)
//
// Сценарий — модуль с export default async (f) => { … }, где f — команды ниже. Координаты —
// пиксели страницы; цель — селектор, 'text:Питание' или элемент (см. film.find в app.js).
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const ADB = process.env.ADB || 'C:/Users/fondemzel/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const DEVICE = process.env.FILM_DEVICE || 'emulator-5554';
const PORT = 9333;
const adb = (...args) => execFileSync(ADB, ['-s', DEVICE, ...args], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const socket = adb('shell', 'cat /proc/net/unix').match(/webview_devtools_remote_\d+/)?.[0];
  if (!socket) throw new Error('страница Чекера не найдена: приложение запущено? отладка включается только на эмуляторе');
  adb('forward', `tcp:${PORT}`, `localabstract:${socket}`);
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = pages.find((p) => p.type === 'page' && p.url.includes('checkeris.fun')) ?? pages[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error('не подключиться к странице'));
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, fail } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) fail(new Error(msg.error.message));
      else ok(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((ok, fail) => {
    id += 1;
    waiting.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => ws.close() };
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

const [cmd, arg, ...rest] = process.argv.slice(2);
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
    if (out) {
      // Запись — средствами эмулятора, со стороны компьютера: 60 кадров в секунду. Запись
      // внутри Android (screenrecord) на эмуляторе кодирует программно и успевает ~10–14
      // кадров (замер 20.10.2026). Файл — WebM, путь — на компьютере
      adb('emu', 'screenrecord', 'start', '--fps', '60', '--bit-rate', '24000000', resolve(out));
      rec = true;
      await sleep(600);
    }
    f.start = Date.now();
    await scenario(f);
    if (rec) {
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
}
