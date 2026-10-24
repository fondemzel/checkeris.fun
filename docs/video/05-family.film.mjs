// Ролик 5 «Общий бюджет с семьёй» — действия подряд (текст — 05-family.md).
// В демо двое — Артём и Катя; чеки подписаны тем, кто добавил. Приглашение и сообщения бота в
// Telegram снимаются отдельно (в демо их нет).
import { BEAT, show, press, pressTab } from './film-kit.mjs';

export default async (f) => {
  // Настройки → «Бюджет»: участники
  await f.eval(`film.tab('settings', {})`);
  await f.wait(900);
  await press(f, '[data-set="budget"]', { pad: 2 });
  await f.wait(900);
  await show(f, 'text:Артём', { up: '.srow, .row, button', pad: 2 });
  await show(f, 'text:Катя', { up: '.srow, .row, button', pad: 2 });
  await f.clear();

  // Чеки за декабрь: у каждого — кто добавил
  await pressTab(f, 'summary', { mode: 'ring', src: '', sg: '', from: '2026-12-01', to: '2026-12-31' });
  await f.wait(900);
  await f.eval(`film.tab('receipts', { from: '2026-12-01', to: '2026-12-31' })`);
  await f.wait(1300);
  await show(f, '#screen .list', { pad: 0 }, BEAT * 3);
  await show(f, '#screen .list [data-receipt]', { pad: 2 });
  await f.clear();
  await f.wait(600);
};
