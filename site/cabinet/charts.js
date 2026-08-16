// Графики раздела «Анализ»: инлайновый SVG, без библиотек.
//
// Правила, которых держимся во всех фигурах:
//   • марки тонкие: столбец не шире 24px, скругление 4px только у конца данных;
//   • сетка и оси — сплошные волосяные линии на один шаг от фона, никакого пунктира;
//   • подписи выборочные: значение у последнего и у самого большого, остальное —
//     по наведению, иначе цифры на каждой марке превращаются в шум;
//   • цвет никогда не единственный признак: у каждой полосы есть подпись рядом.
//
// Цвета групп заданы пользователем и служат опознанием сущности, а не величиной:
// «Питание» зелёное и в чипсах, и в дереве, и здесь. Величину несёт длина полосы.

const NS = 'http://www.w3.org/2000/svg';

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

const rub0 = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
const money = (kopecks) => rub0.format(Number(kopecks ?? 0) / 100);

/** Короткая подпись оси: 1,2 млн / 340 тыс / 900 ₽ — на оси важен порядок, а не точность. */
export function shortMoney(kopecks) {
  const rubles = Number(kopecks ?? 0) / 100;
  if (Math.abs(rubles) >= 1e6) return `${(rubles / 1e6).toFixed(1).replace('.', ',')} млн`;
  if (Math.abs(rubles) >= 1e3) return `${Math.round(rubles / 1e3)} тыс`;
  return String(Math.round(rubles));
}

/** Круглый шаг сетки: ось должна читаться как 0 / 50 тыс / 100 тыс, а не как 47 312. */
function niceStep(max, count = 4) {
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (pow * m >= raw) return pow * m;
  }
  return pow * 10;
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export function monthLabel(key) {
  const [y, m] = String(key).split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]} ${String(y).slice(2)}`;
}

/**
 * Столбцы по времени. Один ряд — значит один цвет и никакой легенды:
 * заголовок уже говорит, что отложено.
 */
export function columns(rows, { height = 220, color = '#2563eb', label = monthLabel, width: given = 0 } = {}) {
  if (!rows.length) return '<div class="chart-empty">Нет данных за период</div>';

  const pad = { top: 18, right: 8, bottom: 22, left: 52 };
  const max = Math.max(...rows.map((r) => r.sum), 1);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const plotH = height - pad.top - pad.bottom;

  // Ширину задаёт вызывающий по измеренному контейнеру: график должен занимать
  // всю колонку, а не жить в её левой трети. Ниже минимума включается прокрутка.
  const width = Math.max(given || 0, 320, rows.length * 46);
  const plotW = width - pad.left - pad.right;
  const band = plotW / rows.length;
  const barW = Math.min(24, band * 0.6);

  const y = (v) => pad.top + plotH - (v / top) * plotH;

  const grid = [];
  for (let v = 0; v <= top + 1; v += step) {
    grid.push(
      `<line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}"/>` +
        `<text class="tick" x="${pad.left - 8}" y="${y(v) + 4}" text-anchor="end">${shortMoney(v)}</text>`,
    );
  }

  const peak = rows.reduce((a, b) => (b.sum > a.sum ? b : a), rows[0]);
  const bars = rows
    .map((r, i) => {
      const x = pad.left + band * i + (band - barW) / 2;
      const h = Math.max(1, ((r.sum / top) * plotH));
      const showValue = r === peak || i === rows.length - 1;
      return (
        `<g class="col" data-key="${esc(r.key)}" data-label="${esc(label(r.key))}" data-value="${esc(money(r.sum))}"` +
        ` data-note="${esc(`${r.count} позиций`)}">` +
        `<rect class="hit" x="${pad.left + band * i}" y="${pad.top}" width="${band}" height="${plotH}"/>` +
        // скругление только сверху: низ стоит на базовой линии
        `<path class="bar" fill="${color}" d="M${x} ${pad.top + plotH} v${-(h - Math.min(4, h))} a4 4 0 0 1 4 -4 h${barW - 8} a4 4 0 0 1 4 4 v${h - Math.min(4, h)} z"/>` +
        (showValue
          ? `<text class="value" x="${x + barW / 2}" y="${y(r.sum) - 6}" text-anchor="middle">${shortMoney(r.sum)}</text>`
          : '') +
        `<text class="tick" x="${x + barW / 2}" y="${height - 6}" text-anchor="middle">${esc(label(r.key))}</text>` +
        `</g>`
      );
    })
    .join('');

  return (
    `<div class="chart-scroll"><svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
    `${grid.join('')}<line class="axis" x1="${pad.left}" x2="${width - pad.right}" y1="${y(0)}" y2="${y(0)}"/>${bars}` +
    `</svg></div>`
  );
}

/**
 * Горизонтальные полосы. Названия длинные, поэтому лежат слева отдельной колонкой,
 * а не внутри полосы: подпись, которую обрезает марка, хуже, чем её отсутствие.
 */
export function bars(rows, { color = '#2563eb', max: forced = null, showShare = false } = {}) {
  if (!rows.length) return '<div class="chart-empty">Нет данных за период</div>';

  const max = forced ?? Math.max(...rows.map((r) => r.sum), 1);
  const total = rows.reduce((s, r) => s + r.sum, 0);

  return `<div class="hbars">${rows
    .map((r) => {
      const width = Math.max(0.6, (r.sum / max) * 100);
      const share = total ? Math.round((r.sum / total) * 100) : 0;
      return `
        <div class="hbar" data-label="${esc(r.name)}" data-value="${esc(money(r.sum))}" data-note="${esc(r.note ?? '')}">
          <div class="hbar-name">${r.dot ? `<span class="hbar-dot" style="background:${r.dot}"></span>` : ''}<span>${esc(r.name)}</span></div>
          <div class="hbar-track"><i style="width:${width}%;background:${r.color ?? color}"></i></div>
          <div class="hbar-value">${money(r.sum)}${showShare ? ` <span class="dim">${share}%</span>` : ''}</div>
        </div>`;
    })
    .join('')}</div>`;
}

/**
 * Подсказка по наведению: график в вебе интерактивен по умолчанию, и цифры,
 * которые мы намеренно не подписали, читатель должен получать здесь.
 */
export function bindTooltip(root) {
  let tip = root.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    root.appendChild(tip);
  }

  const show = (target, event) => {
    const { label, value, note } = target.dataset;
    tip.innerHTML = `<b>${esc(label)}</b><span>${esc(value)}</span>${note ? `<span class="dim">${esc(note)}</span>` : ''}`;
    tip.hidden = false;
    const box = root.getBoundingClientRect();
    const left = event.clientX - box.left;
    const top = event.clientY - box.top;
    tip.style.left = `${Math.min(Math.max(left, 8), box.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(top - tip.offsetHeight - 12, 4)}px`;
  };

  root.addEventListener('mousemove', (e) => {
    const target = e.target.closest('[data-value]');
    if (target) show(target, e);
    else tip.hidden = true;
  });

  root.addEventListener('mouseleave', () => {
    tip.hidden = true;
  });
}

export { NS };
