// Ролик 7 «Сводка» — действия подряд (текст — 07-summary.md).
import { BEAT, spotSoon, show, press, pressTab } from './film-kit.mjs';

const VIEW = '[data-ana-view]';

/** Палец ведёт подсказку по графику справа налево. */
const scrub = async (f) => {
  const plot = await f.eval(`film.rect('.ana-plot')`);
  await f.down({ x: plot.left + plot.w * 0.8, y: plot.y });
  await f.move({ x: plot.left + plot.w * 0.3, y: plot.y }, 1500);
  await f.wait(300);
  await f.up();
};

export default async (f) => {
  await f.eval(`localStorage.setItem('checker.anaView', 'bars'), true`);
  await f.eval(`film.tab('summary', { mode: 'ring', src: '', sg: '', from: '2026-12-01', to: '2026-12-31' })`);
  await f.wait(900);

  // Сводка: год по месяцам — этот год против прошлого
  await pressTab(f, 'stats', { src: '', sg: '', step: '', from: '2026-01-01', to: '2026-12-31' });
  await f.wait(1300);
  await show(f, '.ana-card', { pad: 2 });
  await scrub(f);

  // Деление столбиков — попап: по кварталам
  await press(f, '.ana-step-btn', { pad: 4 });
  await spotSoon(f, '.quick-menu', { pad: 2 });
  await f.wait(BEAT);
  await press(f, 'text:По кварталам', { up: 'button', pad: 2 });
  await f.wait(1300);
  await show(f, '.ana-card', { pad: 2 });

  // Три месяца; линии — накопительно, прогноз пунктиром, доходы зелёным
  await f.clear();
  await f.eval(`film.tab('stats', { src: '', sg: '', step: '', from: '2026-10-01', to: '2026-12-31' })`);
  await f.wait(1300);
  await press(f, VIEW, { pad: 4 });
  await f.wait(1500);
  await show(f, '.ana-card', { pad: 2 });
  await scrub(f);

  // Группы: этот период против прошлого, перерасход — штриховкой; группа — её категории и график
  await f.spot('[data-ana="food"]', { pad: 2 });
  await f.eval(`document.querySelector('[data-ana="food"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), true`);
  await f.wait(1600);
  await f.tap('[data-ana="food"]');
  await f.wait(1500);
  await show(f, '.ana-card', { pad: 2 });
  await f.clear();
  await f.eval(`localStorage.setItem('checker.anaView', 'bars'), true`); // вид графика — как был
  await f.wait(600);
};
