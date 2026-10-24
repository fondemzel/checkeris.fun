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
