// Кабинет: слева список с подгрузкой по скроллу, справа карточка выбранной строки.
import { groupIcon, searchIcons, GROUP_ICONS } from '/cabinet/icons.js';
import { hexToHsl, hslToHex, tint, shades, readableText, edge, hexToRgb } from '/cabinet/colors.js';

const DEFAULT_GROUP_COLOR = '#7c9cd6'; // чем красить группу, которой цвет ещё не задали

const $ = (id) => document.getElementById(id);

const rub = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });
const rub0 = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
const int = new Intl.NumberFormat('ru-RU');

const money = (kopecks, compact = false) => (compact ? rub0 : rub).format(Number(kopecks ?? 0) / 100);
const dateRu = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '');
const timeRu = (iso) => (iso ? iso.slice(11, 16) : '');
const qty = (v) => (Number.isInteger(v) ? String(v) : String(v).replace('.', ','));

// коды ставок НДС из ФФД
const NDS_LABELS = { 1: '20%', 2: '10%', 3: '20/120', 4: '10/110', 5: '0%', 6: 'без НДС' };
const ndsLabel = (code) => NDS_LABELS[code] ?? (code == null ? '—' : String(code));

// признак предмета расчёта (тег 1212), нужные значения
const PRODUCT_TYPES = {
  1: 'товар',
  2: 'подакцизный товар',
  4: 'услуга',
  10: 'платёж',
  13: 'иной предмет расчёта',
  31: 'товар с маркировкой',
  32: 'товар с маркировкой',
  33: 'товар с маркировкой',
};

/** Склонение существительного при числе: 1 чек, 2 чека, 5 чеков. */
function plural(n, one, few, many) {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// ── состояние ────────────────────────────────────────────

const PER = 100; // размер порции при подгрузке

const DEFAULTS = {
  view: 'receipts',
  q: '',
  period: '', // '' | day | week | month | year — пресет; пустой = даты ниже
  from: '',
  to: '',
  sum: '', // порог из чипса, рубли
  sum_dir: 'less', // в какую сторону действует порог: less — не больше него, more — не меньше
  // NB: имя не `dir` — так называется направление сортировки ниже
  min_sum: '', // рубли, если диапазон задан полями вручную
  max_sum: '',
  group: '', // группа категорий — первый ряд чипсов
  category: '', // подкатегория — второй ряд, зависит от выбранной группы
  uncategorized: '', // '1' — только неразмеченные позиции
  sort: 'date',
  dir: 'desc',
  card: '', // выбранная карточка: r<id> — чек, i<id> — позиция
  node: '', // выбранное в разделе «Категории»: g:<slug> — группа, c:<slug> — категория
};

const state = { ...DEFAULTS };
let meta = null;
let loadSeq = 0;
let cardSeq = 0;
let loaded = 0; // сколько строк уже в таблице
let total = 0;
let nextPage = 1;
let loading = false;

function readUrl() {
  const params = new URLSearchParams(location.search);
  for (const key of Object.keys(DEFAULTS)) {
    if (params.has(key)) state[key] = params.get(key);
  }
  if (!['items', 'taxonomy'].includes(state.view)) state.view = 'receipts';
  if (!['', 'day', 'week', 'month', 'year'].includes(state.period)) state.period = '';
  if (!/^[ri]\d+$/.test(state.card)) state.card = '';
  if (!/^[gc]:.+$/.test(state.node)) state.node = '';
}

function writeUrl() {
  const params = new URLSearchParams();
  for (const [key, def] of Object.entries(DEFAULTS)) {
    if (String(state[key]) !== String(def)) params.set(key, state[key]);
  }
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Пресет периода → диапазон дат, отсчёт от сегодня. */
function periodRange() {
  if (!state.period) return { from: state.from, to: state.to };
  const days = { day: 0, week: 6, month: 29, year: 364 }[state.period];
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  return { from: isoDate(from), to: isoDate(to) };
}

/**
 * Границы суммы. Чипс задаёт порог, переключатель — в какую сторону он действует:
 * «и меньше» → не больше порога, «и больше» → не меньше. Состояния взаимоисключающие,
 * поэтому это радиокнопки: обе отмеченными означали бы отсутствие ограничения.
 * Поля «от — до» задают диапазон напрямую и отменяют чипс.
 */
function sumBounds() {
  if (!state.sum) return { min: state.min_sum, max: state.max_sum };
  return state.sum_dir === 'more' ? { min: state.sum, max: '' } : { min: '', max: state.sum };
}

/** Стрелки: сдвиг диапазона на его собственную длину назад или вперёд. */
function shiftPeriod(direction) {
  const { from, to } = periodRange();
  if (!from || !to) return;
  const start = new Date(from);
  const end = new Date(to);
  const span = Math.round((end - start) / 86400000) + 1;
  start.setDate(start.getDate() + direction * span);
  end.setDate(end.getDate() + direction * span);
  update({ period: '', from: isoDate(start), to: isoDate(end) });
}

function apiParams(page) {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  const { from, to } = periodRange();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const { min, max } = sumBounds();
  if (min) params.set('min_sum', min);
  if (max) params.set('max_sum', max);
  // Категории есть только у позиций — в разделе «Чеки» эти фильтры не применяются
  if (state.view === 'items') {
    if (state.uncategorized) params.set('uncategorized', '1');
    else if (state.category) params.set('category', state.category);
    else if (state.group) params.set('group', state.group);
    params.set('collapse', '1'); // одна строка на название; раскрытие снимает этот параметр
  }
  params.set('sort', state.sort);
  params.set('dir', state.dir);
  params.set('page', String(page));
  params.set('per', String(PER));
  return params;
}

// ── колонки списка ───────────────────────────────────────
// В списке только то, по чему выбирают строку. Реквизиты — в карточке справа.

/**
 * Пометка строк, которые не идут в сумму. Возврат — не трата; чек, закрытый зачётом
 * аванса, повторяет более раннюю предоплату, по которой деньги уже ушли. Строки остаются
 * на месте: иначе две одинаковые покупки в списке выглядят необъяснимо.
 */
function moneyBadge(r) {
  // Схлопнутая строка: у группы нет одной операции, важно лишь, что внутри есть несчитаемое
  if (isGroup(r)) return r.excluded_count ? ` <span class="badge">вне суммы: ${r.excluded_count}</span>` : '';
  if (r.operation_type === 2) return ' <span class="badge refund">возврат</span>';
  if (r.prepaid_sum > 0) return ' <span class="badge">зачёт аванса</span>';
  return '';
}

const isGroup = (r) => r.positions !== undefined;

/** Ячейка с многоточием: пометка выносится наружу, чтобы её не съело обрезание текста. */
const ellipsisCell = (text, badge) =>
  badge ? `<div class="cell-flex"><span class="ellipsis-text">${text}</span>${badge}</div>` : text;

const COLUMNS = {
  receipts: [
    { key: 'date', title: 'Дата', sort: 'date', render: (r) =>
      `<span class="nowrap">${dateRu(r.purchased_at)}</span> <span class="dim small">${timeRu(r.purchased_at)}</span>` },
    { key: 'seller', title: 'Продавец', sort: 'seller', cls: 'ellipsis', render: (r) =>
      ellipsisCell(esc(r.seller ?? '—'), moneyBadge(r)) },
    { key: 'items', title: 'Поз.', sort: 'items', cls: 'num dim', render: (r) => int.format(r.item_count) },
    { key: 'sum', title: 'Сумма', sort: 'sum', cls: 'num', render: (r) =>
      r.counted ? `<b>${money(r.total_sum)}</b>` : `<span class="dim">${money(r.total_sum)}</span>` },
  ],
  items: [
    { key: 'date', title: 'Дата', sort: 'date', render: (r) =>
      `<span class="nowrap">${dateRu(r.purchased_at)}</span> <span class="dim small">${timeRu(r.purchased_at)}</span>` },
    { key: 'name', title: 'Товар', sort: 'name', cls: 'ellipsis', render: (r) => ellipsisCell(esc(r.name), moneyBadge(r)) },
    { key: 'group', title: 'Группа', cls: 'group-cell dim', render: (r) => esc(r.group_name ?? '—') },
    { key: 'category', title: 'Категория', cls: 'cat-cell', render: (r) =>
      r.category_name
        ? `${esc(r.category_name)}${r.category_source === 'rule-fallback' ? ' <span class="badge">по продавцу</span>' : ''}`
        : '<span class="dim">не определена</span>' },
    { key: 'quantity', title: 'Кол-во', sort: 'quantity', cls: 'num dim', render: (r) => qty(r.quantity) },
    { key: 'sum', title: 'Сумма', sort: 'sum', cls: 'num', render: (r) =>
      isGroup(r) || r.counted ? `<b>${money(r.sum)}</b>` : `<span class="dim">${money(r.sum)}</span>` },
  ],
};

// ── список ───────────────────────────────────────────────

// Список товаров всегда схлопнут по названию: одна строка на товар, а не на каждую покупку
const collapsed = () => state.view === 'items';

function renderHead() {
  const columns = COLUMNS[state.view];
  const expander = collapsed() ? '<th class="expander-cell"></th>' : '';
  $('thead').innerHTML = `<tr><th class="idx">#</th>${expander}${columns
    .map((col) => {
      if (!col.sort) return `<th class="${col.cls ?? ''}">${col.title}</th>`;
      const active = state.sort === col.sort;
      const arrow = active ? (state.dir === 'asc' ? '▲' : '▼') : '↕';
      const sorted = active ? ` aria-sort="${state.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
      return `<th class="sortable ${col.cls ?? ''}" data-sort="${col.sort}"${sorted}>${col.title}<span class="arrow">${arrow}</span></th>`;
    })
    .join('')}</tr>`;
}

/** startIndex — сквозной номер первой строки порции, нумерация не сбивается при подгрузке. */
function rowsHtml(rows, startIndex) {
  const columns = COLUMNS[state.view];
  const prefix = state.view === 'receipts' ? 'r' : 'i';
  return rows
    .map((row, i) => {
      // У схлопнутой строки своей карточки нет — открывается верхняя позиция группы
      const card = prefix + (isGroup(row) ? row.first_id : row.id);
      const cells = columns.map((col) => `<td class="${col.cls ?? ''}">${col.render(row)}</td>`).join('');
      // name_norm — ключ ручной правки категории: по нему строки чинятся на месте, без перезагрузки
      const norm = row.name_norm ? ` data-norm="${esc(row.name_norm)}"` : '';
      return `<tr class="clickable${card === state.card ? ' selected' : ''}" data-card="${card}"${norm}>
        <td class="idx">${int.format(startIndex + i)}</td>${expanderCell(row)}${cells}</tr>`;
    })
    .join('');
}

/** Стрелка раскрытия: только там, где под названием больше одной покупки. */
function expanderCell(row) {
  if (!collapsed()) return '';
  if (!isGroup(row) || row.positions < 2) return '<td class="expander-cell"></td>';
  return (
    `<td class="expander-cell"><button class="expander" type="button" aria-expanded="false"` +
    ` title="Показать ${int.format(row.positions)} ${plural(row.positions, 'покупку', 'покупки', 'покупок')}">` +
    `<span class="expander-sign">+</span><span class="expander-count">${int.format(row.positions)}</span></button></td>`
  );
}

const MAX_CHILDREN = 200; // группа бывает и на 5000 позиций — столько строк в таблице ни к чему

/** Раскрытие: покупки одного названия строками под схлопнутой. */
async function toggleGroup(button) {
  const row = button.closest('tr');
  const open = button.getAttribute('aria-expanded') === 'true';
  const kids = [...document.querySelectorAll(`#tbody tr.child[data-parent="${CSS.escape(row.dataset.norm)}"]`)];

  if (open) {
    kids.forEach((tr) => tr.remove());
    button.setAttribute('aria-expanded', 'false');
    button.querySelector('.expander-sign').textContent = '+';
    return;
  }

  button.setAttribute('aria-expanded', 'true');
  button.querySelector('.expander-sign').textContent = '−';
  if (kids.length) return; // уже загружены, просто были скрыты — но мы их удаляем, так что сюда не попадём

  const params = apiParams(1);
  params.set('per', String(MAX_CHILDREN));
  params.delete('collapse');
  params.set('name_norm', row.dataset.norm);
  try {
    const data = await fetch(`/api/items?${params}`).then((r) => r.json());
    row.insertAdjacentHTML('afterend', childRowsHtml(data.rows, row.dataset.norm, data.totals.count));
  } catch (err) {
    button.setAttribute('aria-expanded', 'false');
    button.querySelector('.expander-sign').textContent = '+';
    showState(`Не удалось раскрыть строку: ${err.message}`, true);
  }
}

function childRowsHtml(rows, norm, total) {
  const columns = COLUMNS.items;
  const parent = ` data-parent="${esc(norm)}"`;
  const body = rows
    .map((row) => {
      const card = `i${row.id}`;
      const cells = columns.map((col) => `<td class="${col.cls ?? ''}">${col.render(row)}</td>`).join('');
      return `<tr class="clickable child${card === state.card ? ' selected' : ''}" data-card="${card}"` +
        ` data-norm="${esc(row.name_norm)}"${parent}><td class="idx"></td><td class="expander-cell"></td>${cells}</tr>`;
    })
    .join('');
  if (rows.length >= total) return body;
  return (
    body +
    `<tr class="child child-more"${parent}><td class="idx"></td><td class="expander-cell"></td>` +
    `<td colspan="${columns.length}" class="dim">показаны первые ${int.format(rows.length)} из ${int.format(total)}</td></tr>`
  );
}

/**
 * Два ряда чипсов по категориям. Второй ряд появляется только когда выбрана
 * группа, и показывает её подкатегории: 39 подкатегорий одним рядом нечитаемы.
 */
function renderCategoryChips() {
  const groupRow = $('chips-group');
  const categoryRow = $('chips-category');
  const groups = meta?.categories ?? [];
  const visible = state.view === 'items' && groups.length > 0;

  groupRow.hidden = !visible;
  categoryRow.hidden = !visible || !state.group;
  if (categoryRow.hidden) categoryRow.innerHTML = ''; // группа не выбрана — ряд пуст
  if (!visible) return;

  const chip = (attr, value, label, active, count, color) =>
    `<button class="chip" type="button" data-${attr}="${esc(value)}" aria-pressed="${active}"${chipStyle(color, active)}>` +
    `${esc(label)}${count ? ` <span class="chip-count">${int.format(count)}</span>` : ''}</button>`;

  /**
   * Названия групп длинные и в один ряд не помещаются, поэтому в чипсе иконка,
   * а название — в подсказке. У выбранной группы название остаётся на виду:
   * иначе по одним иконкам не понять, какой фильтр сейчас включён.
   */
  const iconChip = (attr, value, iconName, label, active, count, color) => {
    const icon = groupIcon(iconName);
    if (!icon) return chip(attr, value, label, active, count, color); // нет фигуры — обычный чипс
    return (
      `<button class="chip chip-icon-only" type="button" data-${attr}="${esc(value)}"` +
      ` aria-pressed="${active}" title="${esc(label)}" aria-label="${esc(label)}"${chipStyle(color, active)}>` +
      `${icon}${active ? `<span>${esc(label)}</span>` : ''}` +
      `<span class="chip-count">${int.format(count)}</span></button>`
    );
  };

  groupRow.innerHTML =
    chip('group', '', 'Все', !state.group && !state.uncategorized) +
    groups
      .map((g) =>
        iconChip('group', g.slug, g.icon, g.name, state.group === g.slug && !state.uncategorized, g.items, g.color),
      )
      .join('') +
    (meta.uncategorized
      ? iconChip('uncat', '1', 'none', 'Без категории', state.uncategorized === '1', meta.uncategorized)
      : '');

  if (!categoryRow.hidden) {
    const group = groups.find((g) => g.slug === state.group);
    const tones = group ? categoryShades(group) : [];
    categoryRow.innerHTML = group
      ? chip('category', '', 'Все', !state.category) +
        group.subcategories
          .map((s, i) => chip('category', s.slug, s.name, state.category === s.slug, s.items, tones[i]))
          .join('')
      : '';
  }
}

/** Оттенки категорий группы в порядке их следования. */
const categoryShades = (group) =>
  shades(group.color ?? '', (group.subcategories ?? group.categories ?? []).length, group.shade_from, group.shade_to);

/**
 * Раскраска чипса. Невыбранный показан бледнее выбранного, но тем же цветом:
 * так видно и принадлежность к группе, и текущий фильтр.
 */
function chipStyle(color, active) {
  if (!color || !hexToRgb(color)) return '';
  const background = active ? color : tint(color, 45);
  return (
    ` style="background:${background};border-color:${edge(background)};color:${readableText(background)}"`
  );
}

// ── раздел «Категории» ───────────────────────────────────
// Справочник живёт в базе и правится здесь. slug не показываем и не даём менять:
// на него ссылаются словарь и разметка, поэтому он идентификатор, а не подпись.

let taxonomy = { groups: [] };

const findGroup = (slug) => taxonomy.groups.find((g) => g.slug === slug) ?? null;
const findCategory = (slug) =>
  taxonomy.groups.flatMap((g) => g.categories).find((c) => c.slug === slug) ?? null;

async function loadTaxonomy() {
  try {
    taxonomy = await fetch('/api/taxonomy').then((r) => r.json());
  } catch (err) {
    $('tree').innerHTML = `<div class="card-empty error">Не удалось загрузить справочник: ${esc(err.message)}</div>`;
    return;
  }
  renderTree();
}

function renderTree() {
  const cats = taxonomy.groups.reduce((n, g) => n + g.categories.length, 0);
  $('tree-info').textContent =
    `${int.format(taxonomy.groups.length)} ${plural(taxonomy.groups.length, 'группа', 'группы', 'групп')} · ` +
    `${int.format(cats)} ${plural(cats, 'категория', 'категории', 'категорий')}`;

  $('tree').innerHTML = taxonomy.groups
    .map((g) => {
      const active = state.node === `g:${g.slug}`;
      const tones = categoryShades(g);
      const swatch = (color) =>
        color ? `<span class="tree-swatch" style="background:${color};border-color:${edge(color)}"></span>` : '';
      const rows = g.categories
        .map((c, i) => {
          const on = state.node === `c:${c.slug}`;
          return (
            `<button class="tree-row tree-cat${on ? ' selected' : ''}" type="button" data-node="c:${esc(c.slug)}">` +
            `${swatch(tones[i])}<span class="ellipsis-text">${esc(c.name)}</span>` +
            `<span class="dim tree-count">${c.items ? int.format(c.items) : ''}</span></button>`
          );
        })
        .join('');
      return (
        `<div class="tree-group">` +
        `<button class="tree-row tree-head-row${active ? ' selected' : ''}" type="button" data-node="g:${esc(g.slug)}"` +
        `${g.color ? ` style="background:${tint(g.color, 30)}"` : ''}>` +
        `${groupIcon(g.icon) || '<span class="chip-icon"></span>'}` +
        `<span class="ellipsis-text">${esc(g.name)}</span>` +
        `<span class="dim tree-count">${g.items ? int.format(g.items) : ''}</span></button>` +
        rows +
        `<button class="tree-row tree-add" type="button" data-add="${esc(g.slug)}">+ категория</button>` +
        `</div>`
      );
    })
    .join('');
}

/**
 * Сетка иконок: набор задаётся icons.js, поэтому выбирать можно только существующее.
 * Иконок больше сотни, глазами их не перебрать — сверху поиск по русским тегам.
 */
const iconGrid = (names, current) =>
  names
    .filter((name) => name !== 'none')
    .map(
      (name) =>
        `<button class="icon-option${name === current ? ' selected' : ''}" type="button"` +
        ` data-icon="${name}" title="${esc(GROUP_ICONS[name].tags)}">${groupIcon(name)}</button>`,
    )
    .join('');

// Выбранная иконка хранится на сетке, а не ищется в DOM: поиск может её отфильтровать,
// и тогда выбор бы потерялся при следующем нажатии клавиши.
const iconPicker = (current) =>
  `<input id="icon-search" type="search" placeholder="Поиск иконки: еда, ремонт, налог…" autocomplete="off" />` +
  `<div class="icon-picker" id="icon-grid" data-current="${esc(current ?? '')}">${iconGrid(searchIcons(''), current)}</div>` +
  `<p class="dim" id="icon-empty" hidden>Ничего не нашлось. Попробуйте другое слово.</p>`;

/**
 * Выбор цвета группы. Квадрат: по горизонтали тон, по вертикали светлота от чистого
 * цвета к белому. Ниже — полоса «белый → выбранный цвет» с двумя ползунками: между ними
 * раскладываются оттенки категорий, поэтому видно сразу, какой будет вся группа.
 */
function colorPicker(g) {
  const color = g.color ?? DEFAULT_GROUP_COLOR;
  return `
    <div class="color-picker" data-color="${esc(color)}" data-from="${g.shade_from}" data-to="${g.shade_to}">
      <div class="color-field" id="color-field"><span class="color-dot" id="color-dot"></span></div>
      <div class="color-row">
        <span class="color-swatch" id="color-swatch"></span>
        <input id="color-hex" type="text" spellcheck="false" maxlength="7" />
      </div>
      <div class="shade-bar" id="shade-bar">
        <span class="shade-handle" data-edge="from"></span>
        <span class="shade-handle" data-edge="to"></span>
      </div>
      <div class="shade-preview" id="shade-preview"></div>
    </div>`;
}

/** Перерисовка виджета под текущее состояние: поле, полоса, ползунки, образцы категорий. */
function paintPicker(categories) {
  const box = $('detail').querySelector('.color-picker');
  if (!box) return;
  const { color, from, to } = pickerState(box);

  const hsl = hexToHsl(color) ?? { h: 0, s: 0, l: 50 };
  $('color-field').style.setProperty('--hue', String(Math.round(hsl.h)));
  const dot = $('color-dot');
  dot.style.left = `${(hsl.h / 360) * 100}%`;
  // Вертикаль — светлота от 50% (чистый тон) до 100% (белый)
  dot.style.top = `${clampPct(((hsl.l - 50) / 50) * 100)}%`;
  dot.style.background = color;

  $('color-swatch').style.background = color;
  if (document.activeElement !== $('color-hex')) $('color-hex').value = color;

  $('shade-bar').style.setProperty('--to-color', color);
  for (const handle of $('shade-bar').querySelectorAll('.shade-handle')) {
    const value = handle.dataset.edge === 'from' ? from : to;
    handle.style.left = `${value}%`;
    handle.style.background = tint(color, value);
  }

  const n = Math.max(categories?.length ?? 0, 1);
  $('shade-preview').innerHTML = shades(color, n, from, to)
    .map((shade, i) => {
      const label = categories?.[i]?.name ?? 'категория';
      return `<span class="shade-chip" style="background:${shade};border-color:${edge(shade)};color:${readableText(shade)}">${esc(label)}</span>`;
    })
    .join('');
}

const clampPct = (v) => Math.min(100, Math.max(0, v));

function pickerState(box) {
  return {
    color: box.dataset.color,
    from: Number(box.dataset.from),
    to: Number(box.dataset.to),
  };
}

function groupEditor(g) {
  return `
    <div class="card-head">
      <div><div class="card-title">Группа</div><div class="dim">${esc(g.slug)}</div></div>
      <button class="btn" type="button" data-close>✕</button>
    </div>
    <div class="card-section">Название</div>
    <div class="editor" data-group="${esc(g.slug)}">
      <input id="node-name" type="text" value="${esc(g.name)}" />
    </div>
    <div class="card-section">Иконка</div>
    <div class="editor">${iconPicker(g.icon)}</div>
    <div class="card-section">Цвет</div>
    <div class="editor">
      ${colorPicker(g)}
      <p class="dim">Категории получают этот же цвет разной насыщенности — между ползунками.</p>
    </div>
    <div class="card-section">Что внутри</div>
    <div class="editor">
      <p class="dim">${int.format(g.categories.length)} ${plural(g.categories.length, 'категория', 'категории', 'категорий')},
        ${int.format(g.items)} ${plural(g.items, 'позиция', 'позиции', 'позиций')} размечено.</p>
      <div class="editor-actions">
        <button class="btn" id="node-save" type="button">Сохранить</button>
        <button class="btn danger" id="node-delete" type="button"${g.categories.length ? ' disabled' : ''}>Удалить группу</button>
      </div>
      <p class="dim" id="node-note">${g.categories.length ? 'Удалить можно только пустую группу.' : ''}</p>
    </div>`;
}

function categoryEditor(c) {
  const used = c.items + c.dictionary + c.sellers + c.gtin;
  const others = taxonomy.groups
    .flatMap((g) => g.categories.map((x) => ({ ...x, group: g.name })))
    .filter((x) => x.slug !== c.slug);

  const usage = used
    ? `Завязано: ${int.format(c.items)} ${plural(c.items, 'позиция', 'позиции', 'позиций')}, ` +
      `${int.format(c.dictionary)} в словаре, ${int.format(c.sellers)} ${plural(c.sellers, 'правило', 'правила', 'правил')} по продавцам.`
    : 'На эту категорию пока ничего не ссылается.';

  return `
    <div class="card-head">
      <div><div class="card-title">Категория</div><div class="dim">${esc(c.slug)}</div></div>
      <button class="btn" type="button" data-close>✕</button>
    </div>
    <div class="card-section">Название и группа</div>
    <div class="editor" data-category="${esc(c.slug)}">
      <input id="node-name" type="text" value="${esc(c.name)}" />
      <select id="node-group">${taxonomy.groups
        .map((g) => `<option value="${esc(g.slug)}"${g.slug === c.group_slug ? ' selected' : ''}>${esc(g.name)}</option>`)
        .join('')}</select>
    </div>
    <div class="card-section">Подсказка модели</div>
    <div class="editor">
      <textarea id="node-hint" rows="3" placeholder="что относится к категории, а что нет">${esc(c.hint ?? '')}</textarea>
      <p class="dim">Из подсказок собирается промпт классификации. Уточнили формулировку — следующая разметка станет точнее.</p>
    </div>
    <div class="card-section">Удаление</div>
    <div class="editor">
      <p class="dim">${usage}</p>
      ${used
        ? `<select id="node-move"><option value="">— куда перенести —</option>${others
            .map((x) => `<option value="${esc(x.slug)}">${esc(x.group)} · ${esc(x.name)}</option>`)
            .join('')}</select>`
        : ''}
      <div class="editor-actions">
        <button class="btn" id="node-save" type="button">Сохранить</button>
        <button class="btn danger" id="node-delete" type="button">${used ? 'Перенести и удалить' : 'Удалить'}</button>
      </div>
      <p class="dim" id="node-note"></p>
    </div>`;
}

function renderNode() {
  const pane = $('detail');
  if (!state.node) {
    pane.innerHTML = '<div class="card-empty">Выберите группу или категорию</div>';
    return;
  }
  const [kind, slug] = [state.node.slice(0, 1), state.node.slice(2)];
  const node = kind === 'g' ? findGroup(slug) : findCategory(slug);
  if (!node) {
    state.node = '';
    return renderNode();
  }
  pane.innerHTML = kind === 'g' ? groupEditor(node) : categoryEditor(node);
  if (kind === 'g') paintPicker(node.categories);
}

/** Любая правка справочника → перечитать его, дерево, чипсы и карточку. */
async function afterTaxonomyChange(select) {
  if (select !== undefined) state.node = select;
  await loadTaxonomy();
  await loadMeta();
  writeUrl();
  renderNode();
}

async function taxonomyCall(method, path, body, params = '') {
  const res = await fetch(`/api/taxonomy${path}${params}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const noteError = (message) => {
  const note = $('node-note');
  if (note) {
    note.textContent = message;
    note.classList.add('error');
  }
};

/** Сообщение над деревом: #state живёт в панели списка, а она в этом разделе скрыта. */
function treeNote(message, isError = false) {
  const info = $('tree-info');
  info.textContent = message;
  info.classList.toggle('error', isError);
}

/** Захват указателя: на синтетических событиях id может быть неизвестен, это не повод падать. */
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* не критично */ } };

/**
 * Перетаскивание в пикере. Обработчики висят на карточке, а не на самих элементах:
 * редактор перерисовывается целиком после каждого сохранения, и подписки бы терялись.
 */
function bindColorPicker() {
  const pane = $('detail');
  let drag = null; // { kind: 'field' | 'shade', edge }

  const categoriesOfOpenGroup = () => {
    const box = pane.querySelector('[data-group]');
    return box ? findGroup(box.dataset.group)?.categories ?? [] : [];
  };

  const applyField = (event) => {
    const box = pane.querySelector('.color-picker');
    const rect = $('color-field').getBoundingClientRect();
    const x = clampPct(((event.clientX - rect.left) / rect.width) * 100);
    const y = clampPct(((event.clientY - rect.top) / rect.height) * 100);
    // низ квадрата — белый, верх — чистый тон: светлота идёт от 50% к 100%
    box.dataset.color = hslToHex((x / 100) * 360, 85, 50 + (y / 100) * 50);
    paintPicker(categoriesOfOpenGroup());
  };

  const applyShade = (event, which) => {
    const box = pane.querySelector('.color-picker');
    const rect = $('shade-bar').getBoundingClientRect();
    const value = Math.round(clampPct(((event.clientX - rect.left) / rect.width) * 100));
    box.dataset[which] = String(Math.max(5, value));
    // Ползунки не должны меняться местами — тянем ближний край за собой
    if (Number(box.dataset.from) > Number(box.dataset.to)) {
      box.dataset[which === 'from' ? 'to' : 'from'] = box.dataset[which];
    }
    paintPicker(categoriesOfOpenGroup());
  };

  pane.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.shade-handle');
    if (handle) {
      drag = { kind: 'shade', edge: handle.dataset.edge };
      capture(pane, e);
      return;
    }
    if (e.target.closest('#shade-bar')) {
      // клик по полосе двигает ближний ползунок
      const box = pane.querySelector('.color-picker');
      const rect = $('shade-bar').getBoundingClientRect();
      const value = clampPct(((e.clientX - rect.left) / rect.width) * 100);
      const near = Math.abs(value - Number(box.dataset.from)) < Math.abs(value - Number(box.dataset.to)) ? 'from' : 'to';
      drag = { kind: 'shade', edge: near };
      applyShade(e, near);
      capture(pane, e);
      return;
    }
    if (e.target.closest('#color-field')) {
      drag = { kind: 'field' };
      applyField(e);
      capture(pane, e);
    }
  });

  pane.addEventListener('pointermove', (e) => {
    if (!drag) return;
    e.preventDefault();
    if (drag.kind === 'field') applyField(e);
    else applyShade(e, drag.edge);
  });

  const stop = () => { drag = null; };
  pane.addEventListener('pointerup', stop);
  pane.addEventListener('pointercancel', stop);

  // Цвет можно и вписать: удобно, когда он известен точно
  pane.addEventListener('input', (e) => {
    if (e.target.id !== 'color-hex') return;
    const value = e.target.value.trim();
    if (!hexToRgb(value)) return;
    pane.querySelector('.color-picker').dataset.color = value.toLowerCase();
    paintPicker(categoriesOfOpenGroup());
  });
}

/** Новая запись создаётся сразу и открывается на правку: пустая форма-заготовка тут лишняя. */
async function addGroup() {
  try {
    const { group } = await taxonomyCall('POST', '/groups', { name: 'Новая группа', icon: 'dots' });
    await afterTaxonomyChange(`g:${group.slug}`);
    renderTree();
    $('node-name').select();
  } catch (err) {
    treeNote(`Не удалось создать группу: ${err.message}`, true);
  }
}

async function addCategory(groupSlug) {
  try {
    const { category } = await taxonomyCall('POST', '/categories', {
      group_slug: groupSlug,
      name: 'Новая категория',
    });
    await afterTaxonomyChange(`c:${category.slug}`);
    renderTree();
    $('node-name').select();
  } catch (err) {
    treeNote(`Не удалось создать категорию: ${err.message}`, true);
  }
}

async function saveNode() {
  const box = $('detail').querySelector('[data-group], [data-category]');
  const isGroup = Boolean(box.dataset.group);
  const slug = box.dataset.group ?? box.dataset.category;
  const body = isGroup
    ? (() => {
        const { color, from, to } = pickerState($('detail').querySelector('.color-picker'));
        return { name: $('node-name').value, icon: $('icon-grid').dataset.current, color, shade_from: from, shade_to: to };
      })()
    : { name: $('node-name').value, group_slug: $('node-group').value, hint: $('node-hint').value };

  try {
    await taxonomyCall('PATCH', `/${isGroup ? 'groups' : 'categories'}/${encodeURIComponent(slug)}`, body);
    await afterTaxonomyChange();
    $('node-note').textContent = 'Сохранено.';
  } catch (err) {
    noteError(`Не удалось сохранить: ${err.message}`);
  }
}

async function deleteNode() {
  const box = $('detail').querySelector('[data-group], [data-category]');
  const isGroup = Boolean(box.dataset.group);
  const slug = box.dataset.group ?? box.dataset.category;
  const moveTo = $('node-move')?.value ?? '';

  if (!isGroup && $('node-move') && !moveTo) {
    return noteError('Выберите категорию, куда перенести товары и словарные записи.');
  }

  try {
    const data = await taxonomyCall(
      'DELETE',
      `/${isGroup ? 'groups' : 'categories'}/${encodeURIComponent(slug)}`,
      null,
      moveTo ? `?move_to=${encodeURIComponent(moveTo)}` : '',
    );
    await afterTaxonomyChange('');
    if (data.moved) treeNote(`Перенесено записей: ${int.format(data.moved)}`);
  } catch (err) {
    noteError(`Не удалось удалить: ${err.message}`);
  }
}

function renderSummary(totals) {
  const isItems = state.view === 'items';
  const count = totals.count ?? 0;
  const receipts = isItems ? totals.receipts ?? 0 : count;
  // В схлопнутом списке count — это названия, позиций за ними больше
  const items = isItems ? totals.positions ?? count : totals.items ?? 0;
  // Средний считаем по тому же множеству, что и сумму: без возвратов и зачётов аванса.
  // Знаменатель — всегда позиции (или чеки), а не схлопнутые названия.
  const counted = (isItems ? items : count) - (totals.excluded_count ?? 0);
  const avg = counted ? money((totals.sum ?? 0) / counted, true) : '—';
  const names =
    isItems && totals.names !== undefined
      ? `${int.format(totals.names)} ${plural(totals.names, 'название', 'названия', 'названий')} · `
      : '';
  $('totals-left').textContent =
    `${int.format(receipts)} ${plural(receipts, 'чек', 'чека', 'чеков')} · ` +
    `${int.format(items)} ${plural(items, 'позиция', 'позиции', 'позиций')} · ` +
    names +
    `${isItems ? 'средняя позиция' : 'средний чек'} ${avg}`;

  const skipped = totals.excluded_sum
    ? ` <span class="dim" title="Возвраты и чеки, закрытые зачётом аванса: деньги по ним уже посчитаны">` +
      `вне суммы ${money(totals.excluded_sum, true)}</span> · `
    : '';
  $('totals-right').innerHTML = `${skipped}Итого: <b>${money(totals.sum)}</b>`;
}

function renderFooter() {
  // В схлопнутом списке строки — это названия, а не отдельные покупки
  const noun = collapsed()
    ? plural(total, 'названия', 'названий', 'названий')
    : state.view === 'items'
      ? plural(total, 'позиции', 'позиций', 'позиций')
      : plural(total, 'чека', 'чеков', 'чеков');
  $('range-info').textContent = total
    ? `показано ${int.format(loaded)} из ${int.format(total)} ${noun}`
    : 'ничего не найдено';
  $('load-info').textContent = loading ? 'загрузка…' : loaded < total ? 'прокрутите вниз' : '';
}

function showState(message, isError = false) {
  const el = $('state');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
}

const hideState = () => { $('state').hidden = true; };

// ── карточка справа ──────────────────────────────────────

const kv = (rows) =>
  `<dl class="kv">${rows
    .filter(([, value]) => value !== '' && value != null)
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join('')}</dl>`;

function receiptCard(r) {
  const payment = [
    r.ecash_sum ? `картой ${money(r.ecash_sum)}` : '',
    r.cash_sum ? `наличными ${money(r.cash_sum)}` : '',
    r.prepaid_sum ? `предоплата ${money(r.prepaid_sum)}` : '',
    r.credit_sum ? `в кредит ${money(r.credit_sum)}` : '',
  ]
    .filter(Boolean)
    .join(', ');

  const nds = [
    r.nds_18 ? `20% — ${money(r.nds_18)}` : '',
    r.nds_10 ? `10% — ${money(r.nds_10)}` : '',
    r.nds_0 ? `0% — ${money(r.nds_0)}` : '',
    r.nds_no ? `без НДС — ${money(r.nds_no)}` : '',
  ]
    .filter(Boolean)
    .join(', ');

  const items = r.items
    .map(
      (it) => `<tr data-item="${it.id}" class="clickable">
        <td class="num dim">${it.pos}</td>
        <td>${esc(it.name)}</td>
        <td class="num dim">${qty(it.quantity)}</td>
        <td class="num">${money(it.sum)}</td>
      </tr>`,
    )
    .join('');

  const mismatch =
    r.items_sum !== r.total_sum
      ? `<p class="dim small">Сумма позиций ${money(r.items_sum)} не совпадает с итогом чека.</p>`
      : '';

  return `
    <div class="card-head">
      <div>
        <div class="card-title">${money(r.total_sum)}</div>
        <div class="dim">${dateRu(r.purchased_at)} ${timeRu(r.purchased_at)}${moneyBadge(r) ? ' ·' + moneyBadge(r) : ''}</div>
      </div>
      <button class="btn" type="button" data-close>✕</button>
    </div>
    <div class="card-top">
    ${kv([
      ['Продавец', esc(r.seller ?? '—')],
      ['ИНН', esc(r.seller_inn ?? '—')],
      ['Точка', esc(r.retail_place ?? '—')],
      ['Адрес', esc(r.retail_address ?? '')],
      ['Оплата', payment || '—'],
      ['НДС', nds || '—'],
      ['Кассир', esc(r.operator ?? '')],
      ['Покупатель', esc(r.buyer ?? '')],
      ['ФН / ФД / ФП', `${esc(r.fiscal_drive)} / ${r.fiscal_doc} / ${r.fiscal_sign}`],
      ['Смена', r.shift_number],
      ['ККТ', esc(r.kkt_reg_id ?? '')],
    ])}
    </div>
    <div class="card-section">Позиции · ${int.format(r.item_count)}</div>
    <div class="card-items">
      <table class="card-table">
        <thead><tr><th class="num">№</th><th>Название</th><th class="num">Кол-во</th><th class="num">Сумма</th></tr></thead>
        <tbody>${items}</tbody>
      </table>
      ${mismatch}
    </div>`;
}

// Откуда взялась текущая метка — чтобы было видно, чему пользователь возражает
const CATEGORY_SOURCES = {
  manual: 'проставлена вручную',
  gtin: 'определена по штрихкоду',
  rule: 'определена по правилу продавца',
  'rule-fallback': 'определена по правилу продавца',
  dictionary: 'взята из словаря',
  ngram: 'подобрана по похожему названию',
  llm: 'предложена моделью',
};

const catOption = (slug, name, selected) =>
  `<option value="${esc(slug)}"${slug === selected ? ' selected' : ''}>${esc(name)}</option>`;

/**
 * Второй список: подкатегории выбранной группы либо, если группа не выбрана,
 * все категории сразу — с заголовками групп, иначе 39 пунктов подряд не читаются.
 */
function categoryOptions(groups, groupSlug, selected) {
  const empty = catOption('', '— не выбрана —', selected);
  const items = (list) => list.map((s) => catOption(s.slug, s.name, selected)).join('');

  if (groupSlug) return empty + items(groups.find((g) => g.slug === groupSlug)?.subcategories ?? []);

  return (
    empty +
    groups.map((g) => `<optgroup label="${esc(g.name)}">${items(g.subcategories)}</optgroup>`).join('')
  );
}

/**
 * Выбор категории в карточке: группа, затем подкатегория внутри неё.
 * Пользователь решает не про строку чека, а про товар, поэтому выбор уходит на все
 * позиции с таким же названием — сколько их, написано под списками до сохранения.
 */
function categorySection(it) {
  const groups = meta?.categories ?? [];
  const groupSlug = it.group_slug ?? '';
  const n = it.same_name_count ?? 1;

  const label = it.category_slug
    ? `«${esc(it.category_name)}» ${CATEGORY_SOURCES[it.category_source] ?? esc(it.category_source ?? '')}.`
    : 'Категория не определена.';
  const scope =
    n > 1
      ? ` Выбор применится к ${int.format(n)} ${plural(n, 'позиции', 'позициям', 'позициям')} с таким же названием.`
      : ' Это название встречается только здесь.';

  return `
    <div class="card-section">Категория</div>
    <div class="cat-edit" data-item="${it.id}">
      <select id="cat-group" aria-label="Группа">
        ${catOption('', '— не выбрана —', groupSlug)}${groups.map((g) => catOption(g.slug, g.name, groupSlug)).join('')}</select>
      <select id="cat-slug" aria-label="Категория">
        ${categoryOptions(groups, groupSlug, it.category_slug ?? '')}</select>
      <div class="cat-note dim" id="cat-note">${label}${scope}</div>
    </div>`;
}

/**
 * Правка категории в уже показанных строках. Перезагружать список нельзя: он тянется
 * порциями по скроллу, и перезагрузка вернула бы пользователя в начало таблицы, тогда как
 * правка обычно случается далеко от неё. Строки с этим названием чиним на месте.
 */
function patchRows(nameNorm, category) {
  const rows = document.querySelectorAll(`#tbody tr[data-norm="${CSS.escape(nameNorm)}"]`);
  for (const row of rows) {
    row.querySelector('.group-cell').textContent = category ? category.group_name : '—';
    const cell = row.querySelector('.cat-cell');
    cell.innerHTML = category ? esc(category.name) : '<span class="dim">не определена</span>';
  }
  return rows.length;
}

/** Сохранение выбора: словарь + метки всех одноимённых позиций, затем правка строк на месте. */
async function applyCategory(itemId, slug, box) {
  const note = $('cat-note');
  const selects = [...box.querySelectorAll('select')];
  note.classList.remove('error');
  note.textContent = 'Сохранение…';
  selects.forEach((s) => (s.disabled = true));

  try {
    const res = await fetch(`/api/items/${itemId}/category`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: slug }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const shown = patchRows(data.name_norm, data.category);
    const n = data.affected;
    const positions = `${int.format(n)} ${plural(n, 'позиция', 'позиции', 'позиций')}`;
    const inList = shown > 0 && shown < n ? `, из них в списке ${int.format(shown)}` : '';
    note.textContent = data.category
      ? `«${data.category.name}» — обновлено ${positions}${inList}.`
      : `Категория снята, затронуто ${positions}${inList}.`;

    await loadMeta(); // счётчики в чипсах категорий изменились, чипсы перерисует она сама
  } catch (err) {
    note.textContent = `Не удалось сохранить: ${err.message}`;
    note.classList.add('error');
  } finally {
    selects.forEach((s) => (s.disabled = false));
  }
}

function itemCard(it) {
  return `
    <div class="card-head">
      <div>
        <div class="card-title">${money(it.sum)}</div>
        <div class="dim">${dateRu(it.purchased_at)} ${timeRu(it.purchased_at)}${moneyBadge(it) ? ' ·' + moneyBadge(it) : ''}</div>
      </div>
      <button class="btn" type="button" data-close>✕</button>
    </div>
    <div class="card-section">Товар</div>
    <div class="card-top">
    <p class="card-name">${esc(it.name)}</p>
    ${kv([
      ['Количество', `${qty(it.quantity)}${it.unit ? ` ${esc(it.unit)}` : ''}`],
      ['Цена', money(it.price)],
      ['Сумма', `<b>${money(it.sum)}</b>`],
      ['НДС', `${ndsLabel(it.nds)}${it.nds_sum ? ` · ${money(it.nds_sum)}` : ''}`],
      ['Тип', PRODUCT_TYPES[it.product_type] ?? (it.product_type == null ? '' : String(it.product_type))],
      ['GTIN', esc(it.gtin ?? '')],
      ['Поставщик', esc(it.provider_inn ?? '')],
      ['Продавец', esc(it.seller ?? '—')],
      ['ИНН', esc(it.seller_inn ?? '—')],
      ['Точка', esc(it.retail_place ?? '—')],
      ['Адрес', esc(it.retail_address ?? '')],
    ])}
    </div>
    ${categorySection(it)}
    <div class="card-section">Чек</div>
    <div class="card-actions">
      <button class="btn" type="button" data-receipt="${it.receipt_id}">Открыть чек на ${money(it.receipt_total)}</button>
    </div>`;
}

async function renderCard() {
  const pane = $('detail');
  const seq = ++cardSeq;

  if (!state.card) {
    pane.innerHTML = `<div class="card-empty">${state.view === 'items' ? 'Выберите товар' : 'Выберите чек'}</div>`;
    return;
  }

  const kind = state.card[0];
  const id = state.card.slice(1);
  pane.innerHTML = '<div class="card-empty">Загрузка…</div>';

  try {
    const res = await fetch(kind === 'r' ? `/api/receipts/${id}` : `/api/items/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== cardSeq) return;
    pane.innerHTML = kind === 'r' ? receiptCard(data) : itemCard(data);
  } catch (err) {
    if (seq !== cardSeq) return;
    pane.innerHTML = `<div class="card-empty error">Не удалось загрузить карточку: ${esc(err.message)}</div>`;
  }
}

function selectCard(card) {
  state.card = state.card === card ? '' : card;
  document.querySelectorAll('#tbody tr.selected').forEach((tr) => tr.classList.remove('selected'));
  if (state.card) {
    const row = document.querySelector(`#tbody tr[data-card="${state.card}"]`);
    if (row) row.classList.add('selected');
  }
  writeUrl();
  renderCard();
}

// ── загрузка списка ──────────────────────────────────────

/** Первая страница: фильтры или сортировка изменились. */
async function reload() {
  const seq = ++loadSeq;
  loaded = 0;
  total = 0;
  nextPage = 1;
  loading = false;
  $('tbody').innerHTML = '';
  renderHead();
  writeUrl();
  await fetchPage(seq);
}

/** Следующая порция строк, дописывается к таблице. */
async function fetchPage(seq = loadSeq) {
  if (loading || seq !== loadSeq) return;
  if (nextPage > 1 && loaded >= total) return;

  loading = true;
  renderFooter();
  const pane = document.querySelector('.list-pane');
  if (nextPage === 1) pane.classList.add('is-loading');

  try {
    const res = await fetch(`/api/${state.view}?${apiParams(nextPage)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== loadSeq) return; // фильтры успели смениться

    total = data.totals.count ?? 0;
    const startIndex = loaded + 1;
    loaded += data.rows.length;
    nextPage += 1;

    if (data.rows.length) {
      $('tbody').insertAdjacentHTML('beforeend', rowsHtml(data.rows, startIndex));
      hideState();
    } else if (loaded === 0) {
      showState('Ничего не найдено. Смягчите фильтры или очистите поиск.');
    } else {
      total = loaded; // страница пустая, дальше тянуть нечего — страховка от зацикливания
    }

    renderSummary(data.totals);
    renderFooter();
  } catch (err) {
    if (seq !== loadSeq) return;
    showState(`Ошибка загрузки данных: ${err.message}. Проверьте, что запущен api/src/server.mjs.`, true);
  } finally {
    if (seq === loadSeq) {
      loading = false;
      document.querySelector('.list-pane').classList.remove('is-loading');
      renderFooter();
      fillViewport(seq);
    }
  }
}

/** Если первая порция не заполнила панель, скролла не будет — дотягиваем сами. */
function fillViewport(seq) {
  const box = document.querySelector('.table-scroll');
  if (seq !== loadSeq || loading || loaded >= total) return;
  if (box.scrollHeight <= box.clientHeight + 40) fetchPage(seq);
}

function onScroll() {
  const box = document.querySelector('.table-scroll');
  if (box.scrollTop + box.clientHeight >= box.scrollHeight - 300) fetchPage();
}

async function loadMeta() {
  try {
    meta = await fetch('/api/meta').then((r) => r.json());
  } catch {
    $('data-period').textContent = 'нет связи с API';
    return;
  }

  const { stats, lastImport } = meta;
  $('data-period').textContent = stats.receipts
    ? `${int.format(stats.receipts)} чеков · ${dateRu(stats.date_from)} — ${dateRu(stats.date_to)}`
    : 'база пуста — запустите импорт';

  $('last-import').textContent = [
    lastImport ? `импорт: ${dateRu(lastImport.imported_at)}` : '',
    meta.version ? `v${meta.version}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  renderCategoryChips(); // справочник приезжает позже разметки — перерисовываем
}

// ── события ──────────────────────────────────────────────

function syncControls() {
  $('f-q').value = state.q;
  const { from, to } = periodRange();
  // У пустого date-поля свой «mm/dd/yyyy» вместо placeholder'а, и :placeholder-shown на него
  // не действует — приглушаем его классом, чтобы цвет совпал с полями «от — до»
  for (const [id, value] of [['f-from', from], ['f-to', to]]) {
    $(id).value = value;
    $(id).classList.toggle('filled', Boolean(value));
  }
  const bounds = sumBounds();
  $('f-min').value = bounds.min;
  $('f-max').value = bounds.max;
  $('f-less').checked = state.sum_dir !== 'more';
  $('f-more').checked = state.sum_dir === 'more';

  // сдвигать нечего, пока диапазон не задан
  $('period-prev').disabled = !from || !to;
  $('period-next').disabled = !from || !to;

  document.querySelectorAll('#chips-period .chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.period === state.period));
  });
  document.querySelectorAll('#chips-sum .chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.sum === state.sum));
  });

  $('page-title').textContent = { items: 'Товары', taxonomy: 'Категории' }[state.view] ?? 'Чеки';
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.setAttribute('aria-current', String(item.dataset.view === state.view));
  });

  // Справочник — не список чеков: ни фильтров, ни поиска, ни выгрузки к нему не относится
  const isTaxonomy = state.view === 'taxonomy';
  document.querySelector('.list-pane').hidden = isTaxonomy;
  $('tree-pane').hidden = !isTaxonomy;
  $('f-q').hidden = isTaxonomy;
  $('export-btn').hidden = isTaxonomy;

  renderCategoryChips();
}

function update(patch) {
  Object.assign(state, patch);
  syncControls();
  reload();
}

function bind() {
  let searchTimer;
  $('f-q').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const value = e.target.value;
    searchTimer = setTimeout(() => update({ q: value }), 300);
  });

  // Правка дат вручную выключает пресет периода
  $('f-from').addEventListener('change', (e) => update({ period: '', from: e.target.value, to: $('f-to').value }));
  $('f-to').addEventListener('change', (e) => update({ period: '', from: $('f-from').value, to: e.target.value }));

  $('chips-period').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) update({ period: chip.dataset.period, from: '', to: '' });
  });

  $('period-prev').addEventListener('click', () => shiftPeriod(-1));
  $('period-next').addEventListener('click', () => shiftPeriod(1));

  $('chips-group').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.uncat !== undefined) return update({ uncategorized: '1', group: '', category: '' });
    update({ group: chip.dataset.group, category: '', uncategorized: '' });
  });

  $('chips-category').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) update({ category: chip.dataset.category });
  });

  $('chips-sum').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) update({ sum: chip.dataset.sum ?? '', min_sum: '', max_sum: '' });
  });

  // Переключатель направления: выбор одного снимает другой, состояние всегда однозначно
  document.querySelectorAll('input[name="sum-dir"]').forEach((radio) => {
    radio.addEventListener('change', (e) => update({ sum_dir: e.target.value }));
  });

  // Правка полей вручную отменяет чипс: границы дальше живут сами по себе
  $('f-min').addEventListener('change', (e) =>
    update({ sum: '', min_sum: e.target.value, max_sum: $('f-max').value }));
  $('f-max').addEventListener('change', (e) =>
    update({ sum: '', min_sum: $('f-min').value, max_sum: e.target.value }));

  $('reset-btn').addEventListener('click', () => {
    const view = state.view;
    Object.assign(state, DEFAULTS, { view });
    renderCard();
    update({});
  });

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', async () => {
      const view = item.dataset.view;
      if (state.view === view) return;
      state.view = view;

      if (view === 'taxonomy') {
        syncControls();
        writeUrl();
        await loadTaxonomy();
        return renderNode();
      }

      // сортировка «по дате» есть в обоих списках, остальные ключи не пересекаются
      const sort = COLUMNS[view].some((c) => c.sort === state.sort) ? state.sort : 'date';
      renderCard();
      update({ sort });
    });
  });

  // ── правка справочника ──
  $('tree').addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) return addCategory(add.dataset.add);
    const row = e.target.closest('[data-node]');
    if (!row) return;
    state.node = state.node === row.dataset.node ? '' : row.dataset.node;
    renderTree();
    writeUrl();
    renderNode();
  });

  $('add-group').addEventListener('click', addGroup);

  $('detail').addEventListener('click', (e) => {
    const icon = e.target.closest('.icon-option');
    if (icon) {
      $('detail').querySelectorAll('.icon-option').forEach((b) => b.classList.remove('selected'));
      icon.classList.add('selected');
      $('icon-grid').dataset.current = icon.dataset.icon;
      return;
    }
    if (e.target.closest('#node-save')) return saveNode();
    if (e.target.closest('#node-delete')) return deleteNode();
  });

  $('detail').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'node-name') saveNode();
  });

  bindColorPicker();

  // Поиск иконки перерисовывает сетку, сохраняя уже выбранную
  $('detail').addEventListener('input', (e) => {
    if (e.target.id !== 'icon-search') return;
    const current = $('icon-grid').dataset.current;
    const found = searchIcons(e.target.value);
    $('icon-grid').innerHTML = iconGrid(found, current);
    $('icon-empty').hidden = found.length > 0;
  });

  $('thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const sort = th.dataset.sort;
    update({ sort, dir: state.sort === sort && state.dir === 'desc' ? 'asc' : 'desc' });
  });

  $('tbody').addEventListener('click', (e) => {
    // стрелка раскрывает группу и не должна попутно открывать карточку
    const expander = e.target.closest('.expander');
    if (expander) {
      e.stopPropagation();
      return toggleGroup(expander);
    }
    const tr = e.target.closest('tr.clickable');
    if (tr) selectCard(tr.dataset.card);
  });

  // карточка чека: клик по позиции открывает карточку товара, кнопка — карточку чека
  $('detail').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return selectCard(state.card);
    const receiptBtn = e.target.closest('[data-receipt]');
    if (receiptBtn) return selectCard(`r${receiptBtn.dataset.receipt}`);
    const itemRow = e.target.closest('tr[data-item]');
    if (itemRow) return selectCard(`i${itemRow.dataset.item}`);
  });

  // выбор категории: смена группы только перезаполняет второй список, сохраняет — второй
  $('detail').addEventListener('change', (e) => {
    const box = e.target.closest('.cat-edit');
    if (!box) return;

    const groups = meta?.categories ?? [];

    if (e.target.id === 'cat-group') {
      $('cat-slug').innerHTML = categoryOptions(groups, e.target.value, '');
      $('cat-note').classList.remove('error');
      $('cat-note').textContent = e.target.value
        ? 'Выберите категорию в группе.'
        : 'Выберите категорию — в списке все, с разбивкой по группам.';
      return;
    }

    if (e.target.id === 'cat-slug') {
      // выбор из полного списка подставляет свою группу в первый список
      const group = groups.find((g) => g.subcategories.some((s) => s.slug === e.target.value));
      $('cat-group').value = group?.slug ?? '';
      applyCategory(box.dataset.item, e.target.value, box);
    }
  });

  document.querySelector('.table-scroll').addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => fillViewport(loadSeq));

  $('export-btn').addEventListener('click', () => {
    const params = apiParams(1);
    params.delete('page');
    params.delete('per');
    params.set('type', state.view);
    location.href = `/api/export.csv?${params}`;
  });
}

readUrl();
syncControls();
bind();
await loadMeta(); // справочник категорий нужен карточке для выпадающих списков

if (state.view === 'taxonomy') {
  await loadTaxonomy();
  renderNode();
} else {
  renderCard();
  reload();
}
