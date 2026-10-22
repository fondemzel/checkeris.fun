// Ролик 0 «Чекер за минуту» — действия по секундам (текст и раскадровка — 00-overview.md).
// node scripts/film.mjs run docs/video/00-overview.film.mjs --phone --token <токен> \
//   --today 2026-12-18 --theme dark --pace 2 [--rec video/00/raw/дубль.mp4]
// f.at(с) ждёт отметки времени ролика: темп задаёт озвучка. Координаты — пиксели страницы;
// у краёв экрана не начинать: там системный жест «назад».
const TAB = (name) => `.tab[data-tab="${name}"]`;
const FAB = '#fab';
const FOOD = '.ring-ic[data-ring="summary|food"]';
const MODE = '[data-mode-toggle]';
const SORT = '[data-drop][aria-label="Сортировка"]';
const FILTER = '[data-drop][aria-label="Фильтр"]';
const VIEW = '[data-ana-view]';

// Выделение — на опережение: как только элемент появился в разметке (экран ещё выезжает)
const spotSoon = async (f, target, opts) => {
  const all = (Array.isArray(target) ? target : [target]).map((t) => `!!film.find(${JSON.stringify(t)})`).join(' && ');
  await f.until(all, 3000);
  return f.spot(target, opts);
};

// Кнопка острова с заданным видом экрана: кольцом, без отборов «Расхода». Нажатие — с отметкой
// касания и перетеканием капсулы, как настоящее
const tapTab = async (f, name, extra) => {
  const r = await f.eval(`film.rect(${JSON.stringify(TAB(name))})`);
  await f.eval(`(film.touch.down(${r.x}, ${r.y}), film.tab(${JSON.stringify(name)}, ${JSON.stringify(extra)}, true), setTimeout(() => film.touch.up(), 120), true)`);
};

// Скан без записи в базу: ответ сервера на /api/scan подменяем — задание через 2,5 с «готово»
// и указывает на настоящий чек демо-семьи (8 позиций, «Тандер», 12 декабря), его и покажет
// «Добавлено». Строка QR уходит в сканер так же, как с камеры: рамка с QR и утолщениями — в кадре
const FAKE_SCAN = `(() => {
  const real = window.fetch;
  let done = 0;
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/api/scan') && opts.method === 'POST') {
      const list = await real('/api/receipts?from=2026-12-01&to=2026-12-18&per=200', { headers: opts.headers }).then((r) => r.json());
      const pick = list.rows.find((r) => r.total_sum === 232297) ?? list.rows.find((r) => !r.manual && r.item_count >= 6) ?? list.rows[0]; // тот же чек, что в QR
      done = Date.now() + 2500;
      window.__scanReceipt = pick.id;
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
const QR = 't=20261212T1354&s=2322.97&fn=9999078900000004&i=571&fp=100571&n=1';
// Сканер открыт — строка уходит так, как если бы её считала камера (форма ручного ввода
// остаётся скрытой: отправляем её программно)
const FEED_QR = `(() => {
  const s = document.querySelector('.scanner');
  if (!s) return false;
  s.querySelector('textarea').value = ${JSON.stringify(QR)};
  s.querySelector('#scanner-typed').requestSubmit();
  return true;
})()`;

export default async (f) => {
  // Перед кадром: «Расход» кольцом, графики — линиями, подмена скана
  await f.eval(`localStorage.setItem('checker.mode', 'ring'), localStorage.setItem('checker.anaView', 'line'), true`);
  await f.eval(FAKE_SCAN);

  // 0–6 с. «Чекер — учёт домашних финансов. Траты и доходы собираются сами — из чеков, банков
  // и маркетплейсов, — и видно, куда уходят деньги.»
  await f.eval(`film.tab('summary', { mode: 'ring', src: '', sg: '' })`); // кольцо заливается в кадре
  await f.at(3.5);
  await f.spot('.ring-box', { pad: 4 });
  await f.at(5.5);
  await f.spot(FAB, { pad: 4 });

  // 6–17 с. «Трату с чеком добавить проще всего: покупки из него сами разложатся по категориям.
  // А с подключённым банком траты появятся и без скана.» — плюс тянут вверх: сканер
  await f.at(6.0);
  const fab = await f.eval(`film.rect('#fab')`);
  await f.down(FAB);
  await f.move({ x: fab.x, y: fab.y - 150 }, 800); // медленно: видно, как растёт полоса
  await f.wait(150);
  await f.up();
  await f.until(`!!document.querySelector('.scanner')`, 3000);
  await spotSoon(f, '.scanner-frame', { pad: 14 });
  await f.at(8.6);
  await f.eval(FEED_QR); // «камера считала код»
  await f.until(`location.search.includes('screen=added')`, 8000);
  await spotSoon(f, '#screen .sheet-list', { pad: 4 });
  await f.at(14.5);
  await f.clear();

  // 17–21 с. «Если нет чека, можно добавить трату или доход вручную.»
  await f.at(17.0);
  await f.tap(FAB);
  await spotSoon(f, ['[data-screen="manual"]', '[data-screen="income_add"]'], { pad: 4 });
  await f.at(20.5);
  await f.clear();

  // 21–30 с. «В разделе «Расход» видно, на что потратились деньги. Разбирать покупки не нужно:
  // Чекер сам знает, что молоко — это продукты.»
  await f.at(21.0);
  await f.tap(TAB('summary'));
  await f.at(22.5);
  await spotSoon(f, '.ring-box', { pad: 4 });
  await f.at(24.0);
  await f.tap(FOOD);
  await f.wait(120);
  await spotSoon(f, '.ring-box', { pad: 4 }); // кольцо группы рисуется на месте общего
  await f.at(26.3);
  await f.tap(MODE); // списком
  await spotSoon(f, '#screen .list', { pad: 0 });
  await f.at(29.5);
  await f.clear();

  // 30–36 с. «Удобная сортировка и фильтрация трат.»
  await f.at(30.0);
  await f.tap(SORT);
  await spotSoon(f, '.quick-menu', { pad: 2 }); // попап растёт из кнопки — рамка с ним
  await f.at(31.0);
  await f.tap('text:По сумме');
  await f.wait(250);
  await f.clear();
  await f.at(31.8);
  await f.tap(FILTER);
  await spotSoon(f, '.picker-box', { pad: 0 });
  // Плитки нажимаем, когда лист встал: пока он выезжает, нажатие уходит мимо (прогон 2 — за край экрана)
  await f.until(`(() => { const r = document.querySelector('.picker-box')?.getBoundingClientRect(); return r && Math.abs(r.bottom - innerHeight) < 2; })()`, 3000);
  // «Питание» уже выбрано (список открыт из его кольца) — его не трогаем: нажатие сняло бы выбор.
  // Из чеков в декабре у демо-семьи больше всего «Питания» (84 позиции) и «Детей» (11): список
  // остаётся полным. «Банк» в декабре почти пустой — ЖКХ одной строкой
  await f.at(32.8);
  await f.tap('[data-fsrc="receipt"]');
  await f.at(33.5);
  await f.tap('[data-fsg="deti"]');
  await f.at(34.2);
  await f.tap('[data-filt-apply]');
  await f.wait(500);
  await spotSoon(f, '.stuck-head .total-note', { pad: 6 });
  await f.at(35.8);
  await f.clear();

  // 36–39 с. «Доходы — так же, по группам.»
  await f.at(36.0);
  await tapTab(f, 'income', { mode: 'ring' }); // «Расход» мы оставили списком — а доходы кольцом
  await f.at(37.0);
  await spotSoon(f, '.ring-box', { pad: 4 });
  await f.at(38.8);
  await f.clear();

  // 39–47 с. «Бюджет можно вести как одному, так и всей семьёй, а лимиты подскажут, где пора притормозить.»
  await f.at(39.0);
  await f.tap(TAB('settings'));
  await f.at(40.0);
  await spotSoon(f, 'text:Бюджет', { up: 'button, a, .row', pad: 2 });
  await f.at(43.5);
  await spotSoon(f, 'text:Лимиты', { up: 'button, a, .row', pad: 2 });
  await f.at(46.5);
  await f.clear();

  // 47–54 с. «Аналитика сравнивает с прошлым месяцем и подсказывает, сколько выйдет к концу этого.»
  await f.at(47.0);
  await tapTab(f, 'stats', { src: '', sg: '' }); // отборы «Расхода» общие с аналитикой — снимаем
  await f.at(48.3);
  await spotSoon(f, '.ana-card', { pad: 2 });
  const plot = await f.eval(`film.rect('.ana-plot')`);
  await f.at(49.2);
  await f.down({ x: plot.left + plot.w * 0.62, y: plot.y });
  await f.move({ x: plot.left + plot.w * 0.42, y: plot.y }, 1400); // подсказка едет по дням
  await f.wait(500);
  await f.up();
  await f.at(53.5);
  await f.clear();

  // 54–57 с. «А по дням видно, когда ушло больше обычного.»
  await f.at(54.0);
  await f.tap(VIEW);
  await spotSoon(f, '.ana-card', { pad: 2 });
  await f.at(56.8);
  await f.clear();

  // 57–63 с. «Группы показывают, откуда разница и где лимит уже превышен.»
  await f.at(57.0);
  await f.eval(`document.querySelector('#screen .ana-row')?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), true`);
  await f.at(57.3);
  await spotSoon(f, '#screen .ana-row', { up: '.card', pad: 2 });
  await f.at(60.0);
  // Строка с перерасходом — выделить; нажать — на «Питание»: его категории и график самые
  // насыщенные (у группы с перерасходом в декабре бывает одна покупка — финал выходил пустым)
  if (await f.eval(`!!document.querySelector('#screen .ana-over')`)) {
    await f.eval(`film.spot(document.querySelector('#screen .ana-over').closest('.ana-row'), { pad: 2 })`);
  }
  await f.at(61.5);
  await f.tap('[data-ana="food"]');

  // 63–67 с. Заставка — при монтаже
  await f.at(63.0);
  await f.clear();
  await f.eval(`localStorage.setItem('checker.anaView', 'line'), true`); // вид графика — как был
  await f.at(66.5);
};
