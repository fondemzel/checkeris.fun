// Ролик 1 «Экран „Расход“» — действия подряд (текст и раскадровка — 01-expenses.md).
// node scripts/film.mjs run docs/video/01-expenses.film.mjs --phone --token <токен> \
//   --today 2026-12-18 --theme dark --pace 2 --phone-rec video/01-expenses/raw/прогон.mp4
//
// Режиссура (с 23.10.2026, как у ролика 0): ключевые экраны подряд, без пауз под голос — растяжку
// задаёт монтаж; перед каждым нажатием — выделение на цели, смена экрана островом — растворение.
// Данные — демо-семья Артёма и Кати, декабрь (ребёнку два месяца, Новый год на носу).
// Координаты свайпов — пиксели страницы; у краёв экрана не начинать: там системный жест «назад».
import { BEAT, TAB, spotSoon, show, press, sheetSettled } from './film-kit.mjs';

const FOOD = '.ring-ic[data-ring="summary|food"]';
const TRANSPORT = '.ring-ic[data-ring="summary|transport"]';
const GROCERIES = '.ring-ic[data-ring="summary-cat|food.groceries"]';
const FOOD_LIST = '[data-section="food.groceries"]'; // раздел «Еда» в списке — раскрывается нажатием
const DINING = '[data-section="food.dining"]'; // «Рестораны и кафе»
const MODE = '[data-mode-toggle]';
const SORT = '[data-drop][aria-label="Сортировка"]';
const FILTER = '[data-drop][aria-label="Фильтр"]';
const SEARCH = '#screen label.search'; // всё поле поиска, со значком
const ICRA = 'text:Икра красная горбуши 140 г';

export default async (f) => {
  // Перед кадром: вид «кольцо», «Расход» за декабрь без отборов
  await f.eval(`localStorage.setItem('checker.mode', 'ring'), true`);

  // Кольцо расходов: группы
  await f.eval(`film.tab('summary', { mode: 'ring', src: '', sg: '', from: '2026-12-01', to: '2026-12-31' })`);
  await f.wait(1300); // заливка кольца
  await show(f, '.ring-box');

  // Группа → её кольцо: категории
  await press(f, FOOD, { pad: 2 });
  await f.wait(300);
  await show(f, '.ring-box'); // кольцо группы рисуется на месте общего — рамка уже на нём

  // Категория → список покупок, раздел раскрыт
  await press(f, GROCERIES, { pad: 2 });
  await press(f, FOOD_LIST, { pad: 2 });
  await f.wait(500);
  await f.clear(); // покупки — во весь экран
  await f.wait(BEAT * 3);

  // Свайп — соседний месяц и обратно. Назад — один раз, в кольцо «Питания»: второй «назад»
  // к общему кольцу переключал кольца резко
  await f.eval('history.back()');
  await f.wait(1600); // переход доигрывает — свайп раньше не примется
  await f.swipe({ x: 90, y: 600 }, { dx: 240 }, 360); // вправо — ноябрь
  await f.until(`location.search.includes('2026-11-01')`);
  await f.wait(1500);
  await f.swipe({ x: 320, y: 600 }, { dx: -240 }, 360); // влево — снова декабрь
  // Под нагрузкой записи свайп иногда приходит, пока предыдущий ещё доигрывает, — тогда повтор
  if (!(await f.until(`location.search.includes('2026-12-01')`, 900))) await f.swipe({ x: 320, y: 600 }, { dx: -240 }, 360);
  await f.wait(1200);

  // Долгое нажатие на «Расход» — попап периода, палец ведут к «Году»
  await spotSoon(f, TAB('summary'), { pad: 2 });
  await f.wait(BEAT);
  await f.down(TAB('summary'));
  await spotSoon(f, '.quick', { pad: 2 }); // попап только начал расти — рамка растёт с ним
  await f.wait(700);
  await f.move('text:Год', 520);
  await f.wait(250);
  await f.up();
  await f.clear(); // попап уходит — и выделение с ним
  await f.wait(1200);

  // Кольцо → список по категориям, раздел «Рестораны и кафе» раскрывается
  await press(f, MODE);
  await show(f, '#screen .list', { pad: 0 });
  await press(f, DINING, { pad: 2 });
  await f.wait(600);
  await f.clear();

  // Сортировка: по дате — разделы становятся днями
  await press(f, SORT);
  await spotSoon(f, '.quick-menu', { pad: 2 }); // попап растёт из кнопки — рамка с ним
  await f.wait(BEAT);
  await press(f, 'text:По дате', { up: 'button', pad: 2 });
  await f.wait(500);
  await f.clear();

  // Фильтр: только чеки — плиткой в листе, галочка показывает
  await press(f, FILTER);
  await sheetSettled(f);
  await spotSoon(f, '.picker-box', { pad: 0 });
  await f.wait(BEAT);
  await press(f, '[data-fsrc="receipt"]', { pad: 2 });
  await press(f, '[data-filt-apply]');
  await f.wait(500);
  await show(f, '.stuck-head .total-note', { pad: 6 }); // что отобрано

  // Поиск «икра» — карточка покупки с комментарием
  await spotSoon(f, SEARCH, { pad: 3 });
  await f.tap('#q');
  await f.wait(300);
  await f.type('икра', { every: 140 });
  await f.wait(400);
  await f.hideKeyboard();
  // По дате разделы — дни; найденное — в «30 декабря»: раскрыть, если свёрнут
  await f.until(`!!film.find('text:30 декабря')`, 3000);
  if (!(await f.until(`!!film.find(${JSON.stringify(ICRA)})`, 300))) await f.tap('text:30 декабря');
  await press(f, ICRA, { up: '.row', pad: 2 }); // вся строка покупки
  await show(f, 'text:Не открывать до 31-го!', { up: '.card', pad: 2 }, BEAT * 3); // блок «Комментарий»

  // Лимит: кольцо «Транспорта» за декабрь, без отборов — карточка лимита под кольцом. У «Питания» в
  // декабре перерасход, и карточка показала бы его, а голос говорит «сколько можно в день»
  await f.clear();
  await f.eval(`localStorage.setItem('checker.mode', 'ring'), true`);
  await f.eval(`film.tab('summary', { mode: 'ring', src: '', sg: '', q: '', from: '2026-12-01', to: '2026-12-31' })`);
  await f.wait(1300);
  await press(f, TRANSPORT, { pad: 2 });
  await f.wait(300);
  await spotSoon(f, '.lim-card', { pad: 4 }); // рамка — на лимит сразу, дальше едет с лентой
  await f.swipe({ x: 200, y: 650 }, { dx: 0, dy: -380 }, 700); // вниз, к карточке лимита
  await f.wait(BEAT * 4);
  await f.clear();
  await f.wait(600);
};
