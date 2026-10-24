// Ролик 0 «Чекер за минуту» — действия подряд (текст и раскадровка — 00-overview.md).
// node scripts/film.mjs run docs/video/00-overview.film.mjs --phone --token <токен> \
//   --today 2026-12-18 --theme dark --pace 2 [--rec video/00-overview/raw/дубль.mp4]
//   пробный прогон с записью: --phone-rec video/00-overview/raw/прогон.mp4
//
// Режиссура (с 22.10.2026): только ключевые экраны и анимации, без пауз «под голос» — темп и
// растяжку сцен задаёт монтаж. Перед каждым нажатием выделение сначала ложится туда, куда нажмём
// (press), важное на экране — тоже сначала выделяется (show). Ждём только конца анимаций.
import { BEAT, spotSoon, show, press, pressTab, FAKE_SCAN, FEED_QR, AS_APP } from './film-kit.mjs';

const FAB = '#fab';
const REST = '.ring-ic[data-ring^="summary|~"]'; // «Остальное» — мелкие группы, слитые в один сектор
const MODE = '[data-mode-toggle]';

export default async (f) => {
  // Перед кадром: «Расход» кольцом, сводка — столбиками, подмена скана
  await f.eval(`localStorage.setItem('checker.mode', 'ring'), localStorage.setItem('checker.anaView', 'bars'), true`);
  await f.eval(FAKE_SCAN);

  // Вступление: май — в нём поездка; кольцо расходов заливается, выделение — на кольцо
  await f.eval(`film.tab('summary', { mode: 'ring', src: '', sg: '', from: '2026-05-01', to: '2026-05-31' })`);
  await f.wait(1300); // заливка кольца
  await show(f, '.ring-box');

  // Скан: «+» тянут вверх — сканер — QR чека «Ленты» в рамке — «Добавлено»
  await spotSoon(f, FAB, { pad: 4 });
  await f.wait(BEAT);
  const fab = await f.eval(`film.rect('#fab')`);
  await f.down(FAB);
  await f.move({ x: fab.x, y: fab.y - 150 }, 800); // медленно: видно, как растёт полоса
  await f.wait(150);
  await f.up();
  await f.until(`!!document.querySelector('.scanner')`, 3000);
  await spotSoon(f, '.scanner-frame', { pad: 14 });
  await f.wait(600);
  await f.eval(FEED_QR); // «камера считала код»
  await f.until(`location.search.includes('screen=added')`, 8000);
  await show(f, '#screen .sheet-list', { pad: 2 }, BEAT * 3); // позиции и их категории: еда, корм, химия

  // Вручную: «+» — экран «Добавить», выделение — на ручную трату и ручной доход
  await press(f, FAB);
  await show(f, ['[data-screen="manual"]', '[data-screen="income_add"]'], {}, BEAT * 3);

  // Ноябрь, «Остальное»: мелкие группы разом — покупки по чекам, с маркетплейсов и из банка в
  // одном списке, как говорит голос. Кольцо — «Остальное» — его кольцо — список
  await pressTab(f, 'summary', { mode: 'ring', src: '', sg: '', from: '2026-11-01', to: '2026-11-30' });
  await f.wait(1200);
  await press(f, REST, { pad: 2 });
  await f.wait(900); // кольцо «Остального» рисуется на месте общего
  await press(f, MODE);
  await show(f, '#screen .list', { pad: 0 });

  // Настройки: бюджет на двоих и банки — как в приложении
  await f.eval(AS_APP);
  await pressTab(f, 'settings', {});
  await f.wait(500);
  for (const row of ['Бюджет', 'Банки']) await show(f, `text:${row}`, { up: 'button, a, .row', pad: 2 });
  await f.eval(`(delete window.Checker, true)`); // дальше — снова браузер

  // Сводка — сразу октябрь — декабрь столбиками: после рождения ребёнка неровные недели и перерасход
  await pressTab(f, 'stats', { src: '', sg: '', from: '2026-10-01', to: '2026-12-31' }); // отборы «Расхода» общие со сводкой — снимаем
  await f.wait(1300); // столбики растут
  await spotSoon(f, '.ana-card', { pad: 2 });
  const plot = await f.eval(`film.rect('.ana-plot')`);
  await f.down({ x: plot.left + plot.w * 0.62, y: plot.y });
  await f.move({ x: plot.left + plot.w * 0.42, y: plot.y }, 1200); // подсказка едет по столбикам
  await f.wait(300);
  await f.up();
  // Блок групп целиком не выделяем: он выше экрана — вырез шире экрана, и выделение будто пропадает.
  // «Питомцы» — с перерасходом: выделение сразу переезжает на эту строку и едет с ней, пока экран
  // докручивает её на середину. Финал — без раскрытия группы
  await f.spot('[data-ana="pets"]', { pad: 2 });
  await f.eval(`document.querySelector('[data-ana="pets"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), true`);
  await f.wait(2200);
  await f.clear();
  await f.wait(600);
};
