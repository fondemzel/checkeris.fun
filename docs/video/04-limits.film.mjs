// Ролик 4 «Лимиты» — действия подряд (текст — 04-limits.md).
// Демо-база только для чтения: лист правки лимита открываем и закрываем, не сохраняя.
import { BEAT, show, press, pressTab } from './film-kit.mjs';

const TRANSPORT = '.ring-ic[data-ring="summary|transport"]';
const KIDS = '.ring-ic[data-ring="summary|deti"]';

export default async (f) => {
  await f.eval(`localStorage.setItem('checker.mode', 'ring'), localStorage.setItem('checker.anaView', 'bars'), true`);
  // Декабрь кольцом: под кольцом — лимиты всех групп
  await f.eval(`film.tab('summary', { mode: 'ring', src: '', sg: '', from: '2026-12-01', to: '2026-12-31' })`);
  await f.wait(1300);
  await show(f, '.lim-card', { pad: 4 }, BEAT * 3);

  // Группа в пределах лимита: сколько осталось и сколько можно в день
  await press(f, TRANSPORT, { pad: 2 });
  await f.wait(500);
  await show(f, '.lim-card', { pad: 4 }, BEAT * 3);
  await f.eval('history.back()');
  await f.wait(1000);

  // Группа с перерасходом: сверх лимита — штриховкой
  await press(f, KIDS, { pad: 2 });
  await f.wait(500);
  await show(f, '.lim-card', { pad: 4 }, BEAT * 3);

  // Изменить лимит — лист с ползунком (не сохраняем)
  await press(f, '.lim-card [data-lim-edit]', { pad: 4 });
  await f.wait(700);
  await show(f, '.picker-box', { pad: 0 }, BEAT * 3);
  await f.eval('history.back()'); // закрыть лист, как человек — кнопкой «назад»
  await f.wait(700);
  await f.clear();

  // Сводка: перерасход у групп — штриховкой
  await pressTab(f, 'stats', { src: '', sg: '', from: '2026-10-01', to: '2026-12-31' });
  await f.wait(1300);
  await f.spot('[data-ana="pets"]', { pad: 2 });
  await f.eval(`document.querySelector('[data-ana="pets"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), true`);
  await f.wait(2000);

  // Настройки → «Лимиты»: все лимиты разом
  await pressTab(f, 'settings', {});
  await f.wait(500);
  await press(f, '[data-set="limits"]', { pad: 2 });
  await f.wait(900);
  await show(f, '#screen', { pad: 0 }, BEAT * 3);
  await f.clear();
  await f.wait(600);
};
