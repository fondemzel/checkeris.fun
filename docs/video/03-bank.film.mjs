// Ролик 3 «Банк сам подтягивает траты» — действия подряд (текст — 03-bank.md).
// Экраны входа в банк есть только в приложении; здесь — результат: операции банка в ленте
// демо-семьи, карточка операции, «Банки» в настройках (страница на время сцены — как приложение).
import { BEAT, spotSoon, show, press, pressTab, sheetSettled, AS_APP } from './film-kit.mjs';

const FILTER = '[data-drop][aria-label="Фильтр"]';

export default async (f) => {
  await f.eval(`localStorage.setItem('checker.mode', 'list'), true`);
  // Декабрь списком, по дате: чеки и операции банка вперемешку
  await f.eval(`film.tab('summary', { mode: 'list', src: '', sg: '', sort: 'date', dir: 'desc', from: '2026-12-01', to: '2026-12-31' })`);
  await f.wait(1300);
  await show(f, '#screen .list', { pad: 0 });

  // Фильтр: только банк
  await press(f, FILTER);
  await sheetSettled(f);
  await spotSoon(f, '.picker-box', { pad: 0 });
  await f.wait(BEAT);
  await press(f, '[data-fsrc="bank"]', { pad: 2 });
  await press(f, '[data-filt-apply]');
  await f.wait(600);
  await show(f, '.stuck-head .total-note', { pad: 6 });
  await show(f, '#screen .list', { pad: 0 });

  // Операция банка: категория проставлена сама, видно банк и счёт
  // Поездка из банка — категория проставлена сама (первая в списке — плата банку, для показа скучная)
  await press(f, 'text:Яндекс Go', { up: '[data-op]', pad: 2 });
  await f.wait(700);
  await show(f, '#screen .card', { pad: 2 }, BEAT * 3);
  await show(f, '#item-cat', { up: '.card', pad: 2 });
  await f.eval('history.back()');
  await f.wait(900);

  // Настройки: «Банки» — подключённые банки (как в приложении)
  await f.eval(AS_APP);
  await pressTab(f, 'settings', {});
  await f.wait(500);
  await show(f, '[data-set="banks"]', { pad: 2 }, BEAT * 3);
  await f.eval(`(delete window.Checker, true)`);
  await f.clear();
  await f.wait(600);
};
