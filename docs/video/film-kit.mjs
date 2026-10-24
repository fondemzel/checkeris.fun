// Общие приёмы сценариев съёмки (NN-тема.film.mjs). Режиссура — docs/video/README.md:
// перед каждым нажатием выделение сначала ложится на цель (press), важное на экране тоже
// сначала выделяется (show), смена экрана островом — выделение растворяется (pressTab).

export const TAB = (name) => `.tab[data-tab="${name}"]`;
export const BEAT = 450; // такт: выделение встало — нажатие (с --pace 2 — 0,9 с)

/** Выделение — как только элемент появился в разметке (экран ещё выезжает): рамка едет с ним. */
export const spotSoon = async (f, target, opts) => {
  const all = (Array.isArray(target) ? target : [target]).map((t) => `!!film.find(${JSON.stringify(t)})`).join(' && ');
  await f.until(all, 3000);
  return f.spot(target, opts);
};

/** Показать важное: выделить и дать задержаться взгляду. */
export const show = async (f, target, opts = {}, hold = BEAT * 2) => {
  await spotSoon(f, target, { pad: 4, ...opts });
  await f.wait(hold);
};

/** Нажать: сначала выделение на цели, такт — и нажатие. */
export const press = async (f, target, opts = {}) => {
  await spotSoon(f, target, { pad: 4, ...opts });
  await f.wait(BEAT);
  await f.tap(target);
};

/**
 * Кнопка острова с заданным видом экрана (кольцом, периодом, без отборов) — как нажатие: отметка
 * касания и перетекание капсулы. Экран сменился — выделение растворяется.
 */
export const pressTab = async (f, name, extra) => {
  await spotSoon(f, TAB(name), { pad: 2 });
  await f.wait(BEAT);
  const r = await f.eval(`film.rect(${JSON.stringify(TAB(name))})`);
  await f.eval(`(film.touch.down(${r.x}, ${r.y}), film.tab(${JSON.stringify(name)}, ${JSON.stringify(extra)}, true), setTimeout(() => film.touch.up(), 120), true)`);
  await f.clear();
};

/** Лист снизу встал на место: пока выезжает, нажатие уходит мимо (за край экрана). */
export const sheetSettled = (f) => f.until(`(() => { const r = document.querySelector('.picker-box')?.getBoundingClientRect(); return r && Math.abs(r.bottom - innerHeight) < 2; })()`, 3000);

// Скан без записи в базу. Чек — настоящий чек демо-семьи: «Лента», 15 мая — продукты, корм и
// бытовая химия, шесть позиций (demo.mjs); строку QR собираем из его даты и суммы. Ответ сервера на
// /api/scan подменяем: задание через 2,5 с «готово» и указывает на этот чек — его и покажет
// «Добавлено». Строка уходит в сканер так же, как с камеры: рамка с QR и утолщениями — в кадре
export const FAKE_SCAN = `(() => {
  const real = window.fetch;
  let done = 0;
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/api/scan') && opts.method === 'POST') {
      done = Date.now() + 2500;
      return new Response(JSON.stringify({ job: { id: 900001, status: 'sent' } }), { headers: { 'content-type': 'application/json' } });
    }
    if (u.endsWith('/api/scan/900001')) {
      const job = Date.now() >= done ? { id: 900001, status: 'done', receipt_id: window.__scanReceipt } : { id: 900001, status: 'sent' };
      return new Response(JSON.stringify({ job }), { headers: { 'content-type': 'application/json' } });
    }
    return real(url, opts);
  };
  return true;
})()`;
// Сканер открыт — выбрать чек и отправить его строку, как если бы её считала камера (форма
// ручного ввода остаётся скрытой: отправляем её программно)
export const FEED_QR = `(async () => {
  const s = document.querySelector('.scanner');
  if (!s) return false;
  const token = localStorage.getItem('checker.token');
  const list = await fetch('/api/receipts?from=2026-05-15&to=2026-05-15&per=50', { headers: { authorization: 'Bearer ' + token } }).then((r) => r.json());
  const r = list.rows.find((x) => x.retail_place === 'Лента') ?? list.rows[0];
  window.__scanReceipt = r.id;
  const t = r.purchased_at.slice(0, 16).replace(/[-:]/g, '');
  s.querySelector('textarea').value = 't=' + t + '&s=' + (r.total_sum / 100).toFixed(2) + '&fn=9999078900000004&i=' + (500 + r.id % 400) + '&fp=' + (100000 + r.id) + '&n=1';
  s.querySelector('#scanner-typed').requestSubmit();
  return true;
})()`;

// «Настройки» в приложении: банки и резервная копия видны только там. На время сцены — мост
// приложения (как в проверках shot.mjs): подключены Т-Банк, Сбер и Озон, копия — сегодня ночью
export const AS_APP = `(window.Checker = {
  info: () => JSON.stringify({ app: 'android', version: '0.7.13', banks: { tbank: 'active', sber: 'active', ozon: 'active', wb: 'off' } }),
  backupInfo: () => JSON.stringify({ every: 1, last: '2026-12-18T03:12:00', size: 486000 }),
  bankAccounts() {}, sberAccounts() {}, historyStatus: () => '{}', sberHistoryStatus: () => '{}',
}, true)`;
