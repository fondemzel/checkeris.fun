// Ролик 6 «Жесты острова» — действия подряд (текст — 06-gestures.md).
import { BEAT, TAB, spotSoon, FAKE_SCAN } from './film-kit.mjs';

const FAB = '#fab';

/** Долгое нажатие на кнопку острова — попап периода, палец ведут к пункту. */
const hold = async (f, tab, item) => {
  await spotSoon(f, TAB(tab), { pad: 2 });
  await f.wait(BEAT);
  await f.down(TAB(tab));
  await spotSoon(f, '.quick', { pad: 2 }); // попап только начал расти — рамка растёт с ним
  await f.wait(700);
  await f.move(`text:${item}`, 520);
  await f.wait(250);
  await f.up();
  await f.clear();
  await f.wait(1300);
};

export default async (f) => {
  await f.eval(`localStorage.setItem('checker.mode', 'ring'), true`);
  await f.eval(FAKE_SCAN);
  await f.eval(`film.tab('summary', { mode: 'ring', src: '', sg: '', from: '2026-12-01', to: '2026-12-31' })`);
  await f.wait(1500);

  // Долгое нажатие на «Расход»: неделя, затем снова месяц
  await hold(f, 'summary', 'Неделя');
  await hold(f, 'summary', 'Месяц');

  // Свайп по острову — соседняя вкладка и обратно
  const tabs = await f.eval(`film.rect('.tabs')`);
  await spotSoon(f, '.tabs', { pad: 4 });
  await f.wait(BEAT);
  await f.swipe({ x: tabs.x + 60, y: tabs.y }, { dx: -200 }, 380); // к «Доходу»
  await f.wait(1500);
  await f.swipe({ x: tabs.x - 60, y: tabs.y }, { dx: 200 }, 380); // обратно
  await f.wait(1500);
  await f.clear();

  // «+» вверх — сразу сканер
  await spotSoon(f, FAB, { pad: 4 });
  await f.wait(BEAT);
  const fab = await f.eval(`film.rect('#fab')`);
  await f.down(FAB);
  await f.move({ x: fab.x, y: fab.y - 150 }, 900);
  await f.wait(200);
  await f.up();
  await f.until(`!!document.querySelector('.scanner')`, 3000);
  await f.wait(1500);
  await f.eval(`(document.querySelector('.scanner [data-close]')?.click(), true)`);
  await f.wait(800);
};
