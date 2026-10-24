// Ролик 2 «Скан чека за пару секунд» — действия подряд (текст — 02-scan.md).
// node scripts/film.mjs run docs/video/02-scan.film.mjs --phone --token <токен> \
//   --today 2026-12-18 --theme dark --pace 2 --phone-rec video/02-scan/raw/прогон.mp4
// Скан — без чека и без записи в базу: строка QR чека «Ленты» уходит в сканер программно, ответ
// сервера подменён (FAKE_SCAN, FEED_QR в film-kit.mjs).
import { BEAT, spotSoon, show, FAKE_SCAN, FEED_QR } from './film-kit.mjs';

const FAB = '#fab';

export default async (f) => {
  await f.eval(`localStorage.setItem('checker.mode', 'ring'), true`);
  await f.eval(FAKE_SCAN);
  await f.eval(`film.tab('summary', { mode: 'ring', src: '', sg: '', from: '2026-05-01', to: '2026-05-31' })`);
  await f.wait(1300);

  // «+» тянут вверх — из кнопки растёт полоса со значком сканера — сканер открылся
  await spotSoon(f, FAB, { pad: 4 });
  await f.wait(BEAT * 2);
  const fab = await f.eval(`film.rect('#fab')`);
  await f.down(FAB);
  await f.move({ x: fab.x, y: fab.y - 150 }, 900);
  await f.wait(200);
  await f.up();
  await f.until(`!!document.querySelector('.scanner')`, 3000);
  // Рамка сканера; внизу — ввести строку из QR вручную (если код не читается)
  await spotSoon(f, '.scanner-frame', { pad: 14 });
  await f.wait(BEAT * 2);
  await show(f, '[data-typed]', { pad: 6 });
  await spotSoon(f, '.scanner-frame', { pad: 14 });
  await f.wait(BEAT);
  await f.eval(FEED_QR); // «камера считала код»: QR в рамке, по рамке бегут утолщения
  await f.until(`location.search.includes('screen=added')`, 8000);
  // «Добавлено»: позиции уже разложены по категориям
  await show(f, '#screen .sheet-list', { pad: 2 }, BEAT * 4);
  await show(f, '#screen .sheet-row:nth-child(4)', { pad: 2 }); // корм — «Питомцы»
  await show(f, '#screen .sheet-row:nth-child(5)', { pad: 2 }); // порошок — «Хозтовары»
  await f.clear();
  await f.wait(800);
};
