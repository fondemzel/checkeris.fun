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
const DINING = '[data-section="food.dining"]'; // раздел «Рестораны и кафе» в списке
const SORT = '[data-drop][aria-label="Сортировка"]';
const FILTER = '[data-drop][aria-label="Фильтр"]';

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
  await f.eval(`film.tab('summary', { mode: 'ring' })`); // экран рисуется заново — кольцо заливается в кадре
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

  // 13–18 с. «Свайп — соседний месяц. Декабрь, конечно, дороже: праздничный стол.»
  // Назад — один раз, в кольцо «Питания» (экран плавно уезжает), и месяцы листаем в нём:
  // второй «назад», к общему кольцу, переключал кольца резко
  await f.at(13.0);
  await f.eval('history.back()');
  await f.at(14.6); // после «назад» экран доигрывает переход — свайп раньше не примется
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
  await spotSoon(f, '.quick', { pad: 2 }); // попап только начал расти — рамка растёт с ним
  await f.wait(700);
  await f.move('text:Год', 520);
  await f.wait(250);
  await f.up();
  await f.clear(); // попап уходит — и выделение с ним

  // 23–29 с. «Кнопка справа переключает кольцо на список…» — список по категориям
  await f.at(22.8);
  await f.spot(MODE, { pad: 4 });
  await f.at(23.6);
  await f.tap(MODE); // списком
  await spotSoon(f, '#screen .list', { pad: 0 }); // весь список разделов
  await f.at(26.6);
  await f.spot(DINING, { pad: 2 });
  await f.at(27.2);
  await f.tap(DINING); // раздел раскрывается
  await f.at(28.4);
  await f.clear();

  // 29–33 с. «Сортировка меняет порядок…» — по дате: покупки по дням
  await f.at(29.0);
  await f.spot(SORT, { pad: 4 });
  await f.at(29.6);
  await f.tap(SORT);
  await spotSoon(f, '.quick-menu', { pad: 2 }); // попап растёт из кнопки — рамка растёт с ним
  await f.at(31.0);
  await f.tap('text:По дате');
  await f.wait(200);
  await f.clear();

  // 33–37 с. «Фильтр оставляет покупки из одного источника…» — только чеки
  await f.at(33.2);
  await f.spot(FILTER, { pad: 4 });
  await f.at(33.8);
  await f.tap(FILTER);
  await spotSoon(f, '.sheet-box', { pad: 0 });
  await f.at(35.2);
  await f.tap('text:Только чеки'); // икра — из чека «Перекрёстка»: поиск ниже её найдёт
  await f.wait(200);
  await f.clear();

  // 37–44 с. «Поиск находит покупки по названию… В карточке покупки…»
  await f.at(37.2);
  await f.spot(SEARCH, { pad: 3 });
  await f.tap('#q');
  await f.wait(300);
  await f.type('икра', { every: 140 });
  await f.wait(400);
  await f.hideKeyboard();
  // По дате разделы — дни, обычно раскрыты; свёрнут — раскрыть первый
  if (!(await f.until(`!!film.find(${JSON.stringify(ICRA)})`, 1200))) await f.tap('#screen [data-section]');
  await spotSoon(f, ICRA, { up: '.row', pad: 2 }); // вся строка покупки
  await f.at(40.8);
  await f.tap(ICRA);
  // Весь блок «Комментарий»; карточка выезжает — рамка едет с ней
  await spotSoon(f, 'text:Не открывать до 31-го!', { up: '.card', pad: 2 });

  // 44–50 с. «Если для группы задан лимит…»
  await f.at(44.0);
  await f.clear();
  await f.eval(`localStorage.setItem('checker.mode', 'ring'), true`);
  // Снова декабрь, кольцо; отбор по источнику снят — при отборе лимит не показывается
  await f.eval(`film.tab('summary', { mode: 'ring', src: '', from: '2026-12-01', to: '2026-12-31' })`);
  await f.at(45.6);
  await f.tap(FOOD);
  await f.wait(150);
  await spotSoon(f, '.lim-card', { pad: 4 }); // рамка — на лимит сразу, дальше едет с лентой
  await f.at(46.6);
  await f.swipe({ x: 200, y: 650 }, { dx: 0, dy: -380 }, 700); // вниз, к карточке лимита

  // 50–54 с. «Чекер. Учёт расходов по чекам и операциям банков.» — заставка при монтаже
  await f.at(50.5);
  await f.clear();
  await f.at(53.5);
};
