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

  // Ширину задаёт вызывающий по измеренному контейнеру: график занимает всю колонку
  // и никогда не прокручивается вбок — при частой сетке сужаются сами столбцы.
  const width = Math.max(given || 0, 320);
  const plotW = width - pad.left - pad.right;
  const band = plotW / rows.length;
  const barW = Math.max(3, Math.min(24, band * 0.6));

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
    `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">` +
    `${grid.join('')}<line class="axis" x1="${pad.left}" x2="${width - pad.right}" y1="${y(0)}" y2="${y(0)}"/>${bars}` +
    `</svg>`
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

      // Полоса делится на категории: видно не только сколько ушло в группу,
      // но и чем она набралась. Разделяет не обводка, а зазор цвета фона.
      const parts = (r.parts ?? []).length
        ? r.parts
            .map(
              (p) =>
                `<i style="width:${(p.sum / r.sum) * 100}%;background:${p.color}"` +
                ` data-label="${esc(p.name)}" data-value="${esc(money(p.sum))}" data-note="${esc(r.name)}"></i>`,
            )
            .join('')
        : `<i style="width:100%;background:${r.color ?? color}"></i>`;

      return `
        <div class="hbar" data-label="${esc(r.name)}" data-value="${esc(money(r.sum))}" data-note="${esc(r.note ?? '')}">
          <div class="hbar-name">${r.dot ? `<span class="hbar-dot" style="background:${r.dot}"></span>` : ''}<span>${esc(r.name)}</span></div>
          <div class="hbar-track"><span class="hbar-fill" style="width:${width}%">${parts}</span></div>
          <div class="hbar-value">${money(r.sum)}${showShare ? ` <span class="dim">${share}%</span>` : ''}</div>
        </div>`;
    })
    .join('')}</div>`;
}

/** Точка на окружности: угол отсчитываем от 12 часов по часовой стрелке. */
function polar(cx, cy, r, angle) {
  const a = (angle - 90) * (Math.PI / 180);
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** Сектор кольца: внешняя дуга по часовой, внутренняя обратно. */
function ring(cx, cy, rIn, rOut, from, to) {
  const large = to - from > 180 ? 1 : 0;
  const [x1, y1] = polar(cx, cy, rOut, from);
  const [x2, y2] = polar(cx, cy, rOut, to);
  const [x3, y3] = polar(cx, cy, rIn, to);
  const [x4, y4] = polar(cx, cy, rIn, from);
  return `M${x1} ${y1}A${rOut} ${rOut} 0 ${large} 1 ${x2} ${y2}L${x3} ${y3}A${rIn} ${rIn} 0 ${large} 0 ${x4} ${y4}Z`;
}

/**
 * Двухуровневая круговая: внутреннее кольцо — группы, внешнее — их категории.
 * Своя реализация вместо библиотеки: это полсотни строк тригонометрии, а d3 или
 * иной пакет весит сотни килобайт и тянет сборку — в проекте нет ни одной зависимости.
 *
 * Секторов много, поэтому подписаны только крупные: подпись, не влезающая в сектор,
 * хуже её отсутствия. Остальное читается наведением.
 */
export function sunburst(groups, { size = 420, minLabel = 4 } = {}) {
  const total = groups.reduce((s, g) => s + g.sum, 0);
  if (!total) return '<div class="chart-empty">Нет данных за период</div>';

  const cx = size / 2;
  const cy = size / 2;
  const rHole = size * 0.17;
  const rMid = size * 0.3;
  const rOut = size * 0.46;
  const gap = 0.6; // градусы: зазор вместо обводки, как между полосами

  let angle = 0;
  const inner = [];
  const outer = [];
  const labels = [];

  for (const g of groups) {
    const span = (g.sum / total) * 360;
    const share = (g.sum / total) * 100;
    const color = g.color ?? '#c9ced6';

    inner.push(
      `<path d="${ring(cx, cy, rHole, rMid, angle + gap / 2, angle + span - gap / 2)}" fill="${color}"` +
        ` data-label="${esc(g.name)}" data-value="${esc(money(g.sum))}" data-note="${esc(`${share.toFixed(1)}% расходов`)}"/>`,
    );

    // Подпись группы вдоль радиуса — только если сектор достаточно широкий
    if (share >= minLabel) {
      const [lx, ly] = polar(cx, cy, (rHole + rMid) / 2, angle + span / 2);
      labels.push(
        `<text class="pie-label" x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle"` +
          ` fill="${readableOn(color)}">${esc(shortName(g.name))}</text>`,
      );
    }

    let sub = angle;
    for (const c of g.parts ?? []) {
      const cSpan = (c.sum / total) * 360;
      outer.push(
        `<path d="${ring(cx, cy, rMid + 2, rOut, sub + gap / 2, sub + cSpan - gap / 2)}" fill="${c.color}"` +
          ` data-label="${esc(c.name)}" data-value="${esc(money(c.sum))}" data-note="${esc(g.name)}"/>`,
      );
      sub += cSpan;
    }
    angle += span;
  }

  return (
    `<svg class="pie" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">` +
    `${inner.join('')}${outer.join('')}${labels.join('')}` +
    `<text class="pie-total" x="${cx}" y="${cy - 6}" text-anchor="middle">${money(total)}</text>` +
    `<text class="pie-total-note" x="${cx}" y="${cy + 12}" text-anchor="middle">за период</text>` +
    `</svg>`
  );
}

/** Тёмный текст на светлом секторе и наоборот: подпись не должна тонуть. */
function readableOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return '#1f2328';
  const n = Number.parseInt(m[1], 16);
  const luma = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luma > 0.55 ? '#1f2328' : '#ffffff';
}

const shortName = (name) => (name.length > 12 ? `${name.slice(0, 11)}…` : name);

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
