// Ролик 1 «Куда уходят деньги» — действия по секундам (текст и раскадровка — 01-expenses.md).
// node scripts/film.mjs run docs/video/01-expenses.film.mjs --today 2026-12-18 --rec out.mp4
// f.at(с) ждёт отметки времени ролика: темп задаёт озвучка, а не скорость эмулятора.
// Координаты свайпов — пиксели страницы (экран эмулятора ≈ 412×839); у краёв не начинать:
// там системный жест «назад».
const TAB = '.tab[data-tab="summary"]';
const FOOD = '.ring-ic[data-ring="summary|food"]';
const GROCERIES = '.ring-ic[data-ring="summary-cat|food.groceries"]';
const MODE = '[data-mode-toggle]';
const ICRA = 'text:Икра красная горбуши 140 г';
const FOOD_LIST = '[data-section="food.groceries"]'; // раздел «Еда» в списке — раскрывается нажатием

const SEARCH = '#screen label.search'; // всё поле поиска, со значком

// Выделение — на опережение: ставим, как только элемент появился в разметке (экран ещё
// выезжает, лента ещё листается). Рамка едет вместе с ним и к остановке уже на месте
const spotSoon = async (f, target, opts) => {
  await f.until(`!!film.find(${JSON.stringify(target)})`, 3000);
  return f.spot(target, opts);
};

export default async (f) => {
  // Перед кадром: вид «кольцо», экран «Расход» за текущий месяц
  await f.eval(`localStorage.setItem('checker.mode', 'ring'), true`);

  // 0–3 с. «Куда уходят деньги? Чекер показывает это одним кольцом.»
  await f.go('?screen=summary'); // экран открывается заново — кольцо заливается в кадре
  await f.at(1.4);
  await f.spot('.ring-box', { pad: 4 });

  // 3–8 с. «Нажмите на группу — и видно, из чего она сложилась.»
  await f.at(3.2);
  await f.spot(FOOD);
  await f.at(4.4);
  await f.tap(FOOD);
  await f.wait(120);
  await spotSoon(f, '.ring-box', { pad: 4 }); // кольцо группы рисуется на месте общего

  // 8–13 с. «Ещё нажатие — и вот каждая покупка, до пакета молока. Чеки Чекер разбирает сам.»
  await f.at(8.0);
  await f.spot(GROCERIES);
  await f.at(9.0);
  await f.tap(GROCERIES);
  await spotSoon(f, FOOD_LIST, { pad: 2 }); // список выезжает — рамка едет с ним
  await f.at(9.9);
  await f.tap(FOOD_LIST); // раскрыть: видны сами покупки
  await f.at(10.4);
  await f.clear(); // покупки — во весь экран

  // 13–18 с. «Свайп — соседний месяц. Декабрь, конечно, дороже: подарки.»
  await f.at(13.0);
  await f.eval('history.back()');
  await f.at(13.8);
  await f.eval('history.back()');
  await f.at(15.0); // после «назад» экран доигрывает переход — свайп раньше не примется
  await f.swipe({ x: 90, y: 600 }, { dx: 240 }, 360); // вправо — ноябрь
  await f.until(`location.search.includes('2026-11-01')`);
  await f.at(16.8);
  await f.swipe({ x: 320, y: 600 }, { dx: -240 }, 360); // влево — снова декабрь
  // Под нагрузкой записи свайп иногда приходит, пока предыдущий ещё доигрывает, — тогда повтор
  if (!(await f.until(`location.search.includes('2026-12-01')`, 900))) await f.swipe({ x: 320, y: 600 }, { dx: -240 }, 360);

  // 18–23 с. «Задержите палец на „Расходе“ — и сразу неделя, месяц или год.»
  await f.at(18.5);
  await f.spot(TAB, { pad: 2 });
  await f.at(19.1);
  await f.down(TAB);
  await f.wait(650); // попап вырос
  await f.spot('.quick', { pad: 2 });
  await f.wait(400);
  await f.move('text:Год', 520);
  await f.wait(250);
  await f.up();
  await f.at(22.3);
  await f.clear();

  // 23–30 с. «Любая покупка находится поиском. А к любой можно оставить заметку.»
  await f.at(22.8);
  await f.tap(MODE); // списком
  await f.at(23.2);
  await f.spot(SEARCH, { pad: 3 });
  await f.tap('#q');
  await f.wait(300);
  await f.type('икра', { every: 140 });
  await f.wait(400);
  await f.hideKeyboard();
  await f.tap(FOOD_LIST); // найденное — в свёрнутом разделе «Еда»
  await spotSoon(f, ICRA);
  await f.at(26.8);
  await f.tap(ICRA);
  await spotSoon(f, 'text:Не открывать до 31-го!', { pad: 10 }); // карточка выезжает — рамка с ней

  // 30–36 с. «Задайте лимит — и Чекер подскажет, сколько ещё можно тратить в день.»
  await f.at(30.0);
  await f.clear();
  await f.eval(`localStorage.setItem('checker.mode', 'ring'), true`);
  await f.go('?screen=summary'); // снова декабрь, кольцо
  await f.at(31.6);
  await f.tap(FOOD);
  await f.wait(150);
  await spotSoon(f, '.lim-card', { pad: 4 }); // рамка — на лимит сразу, дальше едет с лентой
  await f.at(32.6);
  await f.swipe({ x: 200, y: 650 }, { dx: 0, dy: -380 }, 700); // вниз, к карточке лимита

  // 36–40 с. «Чекер. Траты сами раскладываются по полочкам.» — заставка накладывается при монтаже
  await f.at(36.5);
  await f.clear();
  await f.at(39.5);
};
