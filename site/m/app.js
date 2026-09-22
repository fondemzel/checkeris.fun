// Мобильный кабинет: сводка за период → группа → категория → позиция, и список чеков.
//
// Это не уменьшенный десктопный кабинет, а другой инструмент на тех же данных.
// Десктоп нужен для разбора: 24 тысячи строк, сортировки, справочник. Телефон
// отвечает на два вопроса — сколько ушло и на что, — даёт поправить категорию
// и добавить трату: отсканировать чек или вбить руками.
//
// Клиент намеренно маленький и самодостаточный: именно его предстоит повторить
// в приложении на Rust, поэтому вся логика здесь про экраны, а всё, что можно
// посчитать в базе, считает сервер (/api/summary).
import { groupIcon } from '/shared/icons.js';
import { shades, edge, readableText } from '/shared/colors.js';
import { TG_ICON, keepLinkReady, markWaiting, pendingLogin, forgetLogin, waitLogin } from '/shared/tglogin.js';
import { showPlace, mappable } from '/shared/ymap.js';

const $ = (id) => document.getElementById(id);
const rub = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
const rubExact = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('ru-RU');

const money = (k, exact = false) => (exact ? rubExact : rub).format(Number(k ?? 0) / 100);
const dateRu = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '');
const timeRu = (iso) => (iso ? iso.slice(11, 16) : '');
const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function plural(n, one, few, many) {
  const m100 = Math.abs(n) % 100;
  const m10 = m100 % 10;
  if (m100 >= 11 && m100 <= 14) return many;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
}

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

// Значки интерфейса — тот же набор Lucide, что у групп, но это не группы
const svg = (shape) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shape}</svg>`;

const UI = {
  logout: svg('<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>'),
  scan: svg(
    '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/>' +
      '<path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  ),
  pen: svg(
    '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>' +
      '<path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
  ),
  check: svg('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
  ok: svg('<path d="M20 6 9 17l-5-5"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  income: svg('<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>'),
  settings: svg(
    '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/>' +
      '<circle cx="12" cy="12" r="3"/>',
  ),
  stats: svg('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'),
  letters: svg('<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>'),
  ruble: svg('<path d="M6 11h8a4 4 0 0 0 0-8H9v18"/><path d="M6 15h8"/>'),
  tag: svg(
    '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/>' +
      '<circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  ),
  calendar: svg('<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>'),
  wallet: groupIcon('card'),
  receipt: groupIcon('receipt'),
};

// ── доступ ───────────────────────────────────────────────

const TOKEN_KEY = 'checker.token'; // тот же ключ, что в кабинете: один вход на устройство

const token = {
  get: () => localStorage.getItem(TOKEN_KEY) ?? '',
  set: (v) => localStorage.setItem(TOKEN_KEY, v),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (token.get()) headers.authorization = `Bearer ${token.get()}`;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    token.clear();
    showLogin('Сессия закончилась — войдите заново');
    throw new Error('нужен вход');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const post = (path, body) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

// ── период ───────────────────────────────────────────────
// Период — пара дат. Месяц — частный случай, поэтому стрелки листают целыми
// месяцами, если период выровнен по месяцам, и его же длиной, если нет.

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');
const parseDay = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function monthPeriod(y, m, count = 1) {
  return { from: isoDay(new Date(y, m, 1)), to: isoDay(new Date(y, m + count, 0)) };
}

/** Сколько целых месяцев в периоде, если он ровно по их границам; иначе 0. */
function wholeMonths(from, to) {
  const a = parseDay(from);
  const next = addDays(parseDay(to), 1);
  if (a.getDate() !== 1 || next.getDate() !== 1) return 0;
  return (next.getFullYear() - a.getFullYear()) * 12 + next.getMonth() - a.getMonth();
}

function shiftPeriod(from, to, delta) {
  const a = parseDay(from);
  const months = wholeMonths(from, to);
  if (months) return monthPeriod(a.getFullYear(), a.getMonth() + delta * months, months);
  const days = Math.round((parseDay(to) - a) / 86400000) + 1;
  return { from: isoDay(addDays(a, delta * days)), to: isoDay(addDays(parseDay(to), delta * days)) };
}

function periodTitle(from, to) {
  const a = parseDay(from);
  const b = parseDay(to);
  const sameYear = a.getFullYear() === b.getFullYear();
  const months = wholeMonths(from, to);

  if (months === 1) return cap(`${MONTHS[a.getMonth()]} ${a.getFullYear()}`);
  if (months === 12 && a.getMonth() === 0) return `${a.getFullYear()} год`;
  if (months) {
    return sameYear
      ? cap(`${MONTHS[a.getMonth()]} – ${MONTHS[b.getMonth()]} ${a.getFullYear()}`)
      : cap(`${MONTHS[a.getMonth()]} ${a.getFullYear()} – ${MONTHS[b.getMonth()]} ${b.getFullYear()}`);
  }
  if (from === to) return `${a.getDate()} ${MONTHS_GEN[a.getMonth()]} ${a.getFullYear()}`;

  const left = !sameYear
    ? `${a.getDate()} ${MONTHS_SHORT[a.getMonth()]} ${a.getFullYear()}`
    : a.getMonth() === b.getMonth()
      ? `${a.getDate()}`
      : `${a.getDate()} ${MONTHS_SHORT[a.getMonth()]}`;
  return `${left} – ${b.getDate()} ${MONTHS_SHORT[b.getMonth()]} ${b.getFullYear()}`;
}

// ── состояние ────────────────────────────────────────────

let meta = null;
const thisMonth = monthPeriod(new Date().getFullYear(), new Date().getMonth());

const state = {
  from: thisMonth.from,
  to: thisMonth.to,
  screen: 'summary', // summary | group | category | item | receipts | add | manual | added
  group: '',
  category: '',
  item: '',
  filter: 'all', // список чеков: all | failed | pending | manual
  added: '', // чек, только что добавленный сканом или руками
  sort: 'sum', // список товаров: date | name | sum
  dir: 'desc',
};

const SCREEN_NAMES = ['summary', 'group', 'category', 'item', 'receipts', 'add', 'manual', 'added', 'income', 'settings', 'stats'];
const FILTERS = ['all', 'failed', 'pending', 'manual'];

// Сортировки списка товаров и направление, с которого каждая начинается:
// свежие и дорогие — сверху, названия — по алфавиту
const ITEM_SORTS = {
  date: ['По дате', 'desc', 'calendar'],
  name: ['По названию', 'asc', 'letters'],
  sum: ['По цене', 'desc', 'ruble'],
};
const TOP = ['summary', 'receipts', 'income', 'settings', 'stats']; // корневые экраны: у них нет «назад», зато есть «+»

const findGroup = (slug) => (meta?.categories ?? []).find((g) => g.slug === slug) ?? null;
const findCategory = (slug) => {
  for (const g of meta?.categories ?? []) {
    const s = g.subcategories.find((x) => x.slug === slug);
    if (s) return { group: g, category: s };
  }
  return null;
};

/** Цвет категории — оттенок цвета её группы, тот же расчёт, что в кабинете. */
function categoryColor(groupSlug, categorySlug) {
  const g = findGroup(groupSlug);
  if (!g?.color) return null;
  const i = g.subcategories.findIndex((s) => s.slug === categorySlug);
  const tones = shades(g.color, g.subcategories.length, g.shade_from, g.shade_to);
  return i >= 0 ? tones[i] : g.color;
}

// ── навигация ────────────────────────────────────────────
// Экраны складываются в историю браузера, чтобы работала кнопка «назад» телефона.

function go(patch, replace = false) {
  Object.assign(state, patch);
  const params = new URLSearchParams({ screen: state.screen, from: state.from, to: state.to });
  if (state.group) params.set('group', state.group);
  if (state.category) params.set('category', state.category);
  if (state.item) params.set('item', state.item);
  if (state.added) params.set('added', state.added);
  if (state.screen === 'receipts' && state.filter !== 'all') params.set('filter', state.filter);
  if (state.screen === 'category' && (state.sort !== 'sum' || state.dir !== 'desc')) {
    params.set('sort', state.sort);
    params.set('dir', state.dir);
  }
  history[replace ? 'replaceState' : 'pushState']({ ...state }, '', `?${params}`);
  render();
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.screen = SCREEN_NAMES.includes(p.get('screen')) ? p.get('screen') : 'summary';
  if (isDay(p.get('from')) && isDay(p.get('to')) && p.get('from') <= p.get('to')) {
    state.from = p.get('from');
    state.to = p.get('to');
  } else if (/^\d{4}-\d{2}$/.test(p.get('month') ?? '')) {
    // старые ссылки и ярлыки хранили месяц
    const [y, m] = p.get('month').split('-').map(Number);
    Object.assign(state, monthPeriod(y, m - 1));
  }
  state.group = p.get('group') ?? '';
  state.category = p.get('category') ?? '';
  state.item = p.get('item') ?? '';
  state.added = p.get('added') ?? '';
  state.filter = FILTERS.includes(p.get('filter')) ? p.get('filter') : 'all';
  state.sort = Object.hasOwn(ITEM_SORTS, p.get('sort') ?? '') ? p.get('sort') : 'sum';
  state.dir = p.get('dir') === 'asc' ? 'asc' : 'desc';
}

window.addEventListener('popstate', (e) => {
  if (e.state) Object.assign(state, e.state);
  else readUrl();
  document.querySelector('.sheet')?.remove(); // «назад» телефона закрывает и открытый попап
  render();
  // Вернулись из карточки товара, открытой из попапа чека, — показываем чек снова
  if (state.sheet) {
    const id = state.sheet;
    state.sheet = '';
    history.replaceState({ ...state }, '', location.href);
    openReceiptSheet(id);
  }
});

// ── общие куски экранов ──────────────────────────────────

const loading = () => '<div class="empty">Загрузка…</div>';
const failed = (err) => `<div class="empty error">${esc(err.message)}</div>`;

/** Строка периода: стрелки листают, нажатие на даты открывает календарь. */
const periodNav = (compact = false) => `
  <div class="month${compact ? ' compact' : ''}">
    <button class="month-arrow" type="button" data-shift="-1" aria-label="Раньше">‹</button>
    <button class="month-name" type="button" data-period>${UI.calendar}<span>${esc(periodTitle(state.from, state.to))}</span></button>
    <button class="month-arrow" type="button" data-shift="1" aria-label="Позже">›</button>
  </div>`;

/**
 * «Расход» — два взгляда на одни траты: по категориям и списком чеков. Переключатель
 * стоит в шапке обоих экранов, счётчик сканов с ошибкой — на «Чеках»
 */
const expenseSwitch = () => `
  <div class="segments">
    <button class="segment${state.screen === 'summary' ? ' on' : ''}" type="button" data-segment="summary">Категории</button>
    <button class="segment${state.screen === 'receipts' ? ' on' : ''}" type="button" data-segment="receipts">Чеки${
      failedCount ? `<i class="seg-badge">${failedCount > 99 ? '99+' : failedCount}</i>` : ''
    }</button>
  </div>`;

let failedCount = 0; // сканы с ошибкой: значок на вкладке «Расход» и на «Чеках»

/** Строка списка: иконка или кружок цвета, название, сумма и доля от итога. */
function row({ href, color, icon, title, note, sum, share }) {
  const swatch = icon
    ? `<span class="ic" style="background:${color ?? '#eef1f5'};color:${readableText(color ?? '#eef1f5')}">${groupIcon(icon)}</span>`
    : `<span class="dot" style="background:${color ?? '#eef1f5'};border-color:${edge(color ?? '#e1e4e8')}"></span>`;
  return `
    <button class="row" type="button" ${href}>
      ${swatch}
      <span class="row-main">
        <span class="row-title">${esc(title)}</span>
        <span class="row-note">${esc(note)}</span>
        <span class="row-bar"><i style="width:${Math.max(2, Math.round(share * 100))}%;background:${color ?? '#c9ced6'}"></i></span>
      </span>
      <span class="row-sum">${money(sum)}</span>
    </button>`;
}

function toast(text) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ── расходы ──────────────────────────────────────────────

async function screenSummary() {
  const data = await api(`/api/summary?by=group&from=${state.from}&to=${state.to}`);
  const max = Math.max(1, ...data.rows.map((r) => r.sum));

  // Период и итог закреплены: листая группы, видно, за что и сколько
  const head = `
    <div class="stuck-head">
      ${expenseSwitch()}
      <div class="total compact">
        <span class="total-sum">${money(data.totals.sum)}</span>
        <span class="total-note">${int.format(data.totals.receipts)} ${plural(data.totals.receipts, 'чек', 'чека', 'чеков')} ·
          ${int.format(data.totals.count)} ${plural(data.totals.count, 'позиция', 'позиции', 'позиций')}</span>
        ${periodNav(true)}
      </div>
    </div>`;

  if (!data.rows.length) {
    // Совсем новый аккаунт — не «трат нет», а с чего начать. Сводку в meta освежаем:
    // она берётся при входе и не знает о первом добавленном чеке
    if (!meta.stats.receipts) meta = await api('/api/meta');
    if (!meta.stats.receipts) return welcome();
    return `${head}<div class="empty">За этот период трат нет</div>`;
  }

  const rows = data.rows
    .map((r) =>
      row({
        href: `data-group="${esc(r.key ?? '')}"`,
        color: r.color,
        icon: r.icon ?? 'none',
        title: r.name ?? 'Без категории',
        note: `${int.format(r.count)} ${plural(r.count, 'позиция', 'позиции', 'позиций')}`,
        sum: r.sum,
        share: r.sum / max,
      }),
    )
    .join('');

  return `${head}<div class="list">${rows}</div>`;
}

async function screenGroup() {
  const data = await api(
    `/api/summary?by=category&group=${encodeURIComponent(state.group)}&from=${state.from}&to=${state.to}`,
  );
  const g = findGroup(state.group);
  const max = Math.max(1, ...data.rows.map((r) => r.sum));

  // Шапка как в «Расходе»: итог и период закреплены, период меняется прямо здесь
  const head = `
    <div class="stuck-head">
      <div class="total compact">
        <span class="total-sum">${money(data.totals.sum)}</span>
        <span class="total-note">${esc(g?.name ?? '')}</span>
        ${periodNav(true)}
      </div>
    </div>`;

  if (!data.rows.length) return `${head}<div class="empty">В этой группе трат нет</div>`;

  const rows = data.rows
    .map((r) =>
      row({
        href: `data-category="${esc(r.key ?? '')}"`,
        color: categoryColor(state.group, r.key),
        icon: null,
        title: r.name ?? 'Без категории',
        note: `${int.format(r.count)} ${plural(r.count, 'позиция', 'позиции', 'позиций')}`,
        sum: r.sum,
        share: r.sum / max,
      }),
    )
    .join('');

  return `${head}<div class="list">${rows}</div>`;
}

async function screenCategory() {
  const params = new URLSearchParams({
    from: state.from, to: state.to, collapse: '1', sort: state.sort, dir: state.dir, per: '100',
  });
  if (state.category) params.set('category', state.category);
  else params.set('group', state.group);

  const data = await api(`/api/items?${params}`);
  const name = state.category
    ? findGroup(state.group)?.subcategories.find((s) => s.slug === state.category)?.name
    : findGroup(state.group)?.name;

  // Сортировка — значками: подписи не помещаются в закреплённую шапку. Повторное нажатие
  // на выбранную разворачивает порядок, стрелка показывает какой
  const sorts = Object.entries(ITEM_SORTS)
    .map(([key, [label, , icon]]) => {
      const on = state.sort === key;
      const arrow = on ? `<span class="sort-dir">${state.dir === 'asc' ? '↑' : '↓'}</span>` : '';
      return `<button class="sort-chip${on ? ' on' : ''}" type="button" data-sort="${key}" aria-label="${label}" title="${label}">${UI[icon]}${arrow}</button>`;
    })
    .join('');

  // Шапка закреплена: при листании длинного списка итог и порядок остаются на виду
  const head = `
    <div class="stuck-head">
      <div class="total compact">
        <span class="total-sum">${money(data.totals.sum)}</span>
        <span class="total-note">${esc(name ?? '')}</span>
        ${periodNav(true)}
        ${data.rows.length ? `<div class="sorts">${sorts}</div>` : ''}
      </div>
    </div>`;

  if (!data.rows.length) return `${head}<div class="empty">Ничего не найдено</div>`;

  const rows = data.rows
    .map((r) => {
      // Ноль здесь означал бы бесплатную покупку. На деле это возврат или зачёт аванса:
      // сумма есть, но в расходы она не идёт — так и пишем.
      const outside = r.sum === 0 && r.excluded_count;
      return `
      <button class="row item" type="button" data-item="${r.first_id}">
        <span class="row-main">
          <span class="row-title">${esc(r.name)}</span>
          <span class="row-note">${dateRu(r.purchased_at)}${
            r.positions > 1 ? ` · ${int.format(r.positions)} ${plural(r.positions, 'покупка', 'покупки', 'покупок')}` : ''
          }</span>
        </span>
        <span class="row-sum${outside ? ' muted' : ''}">${outside ? 'вне суммы' : money(r.sum)}</span>
      </button>`;
    })
    .join('');

  return `${head}<div class="list">${rows}</div>`;
}

let itemShown = null; // позиция на экране — карте нужны её координаты после отрисовки

async function screenItem() {
  const it = await api(`/api/items/${state.item}`);
  itemShown = it;
  const onMap = mappable(it) && meta?.maps?.key;

  const kv = (rows) =>
    rows
      .filter(([, v]) => v)
      .map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`)
      .join('');

  return `
    <div class="card">
      <div class="card-sum">${money(it.sum, true)}</div>
      <div class="card-name">${esc(it.name)}</div>
      ${kv([
        ['Дата', `${dateRu(it.purchased_at)} ${esc(timeRu(it.purchased_at))}`],
        ['Количество', it.quantity !== 1 ? `${it.quantity}${it.unit ? ` ${esc(it.unit)}` : ''}` : ''],
        ['Продавец', esc(it.seller ?? '')],
        ['Точка', esc(it.retail_place ?? '')],
        // Адрес текстом — когда карты нет. У интернет-покупки это адрес продавца, а не магазина
        ['Адрес', !onMap && !it.internet_sign ? esc(it.retail_address ?? '') : ''],
        ['Покупка', it.internet_sign ? 'в интернете' : ''],
      ])}
    </div>

    <div class="card">
      <div class="card-label">Категория</div>
      <button class="cat-pick" id="item-cat" type="button" data-item-cat="${it.id}">${categoryButton(it.category_slug)}</button>
      <p class="note" id="pick-note">${
        it.same_name_count > 1
          ? `Изменение категории затронет ${int.format(it.same_name_count)} ${plural(it.same_name_count, 'позицию', 'позиции', 'позиций')} с таким же названием`
          : ''
      }</p>
    </div>

    ${it.receipt_drive !== 'manual' ? `
    <div class="card">
      <div class="card-label">Чек</div>
      <button class="cat-pick" type="button" data-item-receipt="${it.receipt_id}">
        <span class="pick-ic" style="background:#eef1f5;color:#4b5563">${UI.receipt}</span>
        <span class="cat-name">${money(it.receipt_total, true)}<small>${int.format(it.receipt_items)} ${plural(it.receipt_items, 'позиция', 'позиции', 'позиций')} · ${dateRu(it.purchased_at)}</small></span>
      </button>
    </div>` : ''}

    ${onMap ? `
    <div class="card place-card">
      <div class="card-label">Где куплено</div>
      <div class="map" id="item-map"><span class="map-wait">Загружаем карту…</span></div>
      <p class="note">${esc(it.place_address ?? it.retail_address ?? '')}${it.place_qc > 1 ? ' · место примерное' : ''}</p>
    </div>` : ''}`;
}

/** Карта рисуется в уже вставленный блок — после того, как экран оказался на странице. */
function mountItemMap() {
  const box = $('item-map');
  if (!box || !itemShown) return;
  showPlace(box, {
    key: meta.maps.key,
    lat: itemShown.place_lat,
    lon: itemShown.place_lon,
    qc: itemShown.place_qc,
    title: itemShown.retail_place ?? itemShown.seller ?? '',
  }).catch((err) => {
    box.outerHTML = `<p class="note error">${esc(err.message)}</p>`;
  });
}

// ── календарь ────────────────────────────────────────────
// Нативный input[type=date] диапазон не выбирает, поэтому сетка своя:
// первое нажатие — начало, второе — конец. Готовые периоды применяются сразу.

function openPeriodPicker() {
  let start = state.from;
  let end = state.to;
  const first = parseDay(state.to);
  let view = new Date(first.getFullYear(), first.getMonth(), 1);
  const today = isoDay(new Date());

  const now = new Date();
  const presets = [
    ['Этот месяц', () => monthPeriod(now.getFullYear(), now.getMonth())],
    ['Прошлый месяц', () => monthPeriod(now.getFullYear(), now.getMonth() - 1)],
    ['3 месяца', () => monthPeriod(now.getFullYear(), now.getMonth() - 2, 3)],
    ['Этот год', () => monthPeriod(now.getFullYear(), 0, 12)],
    ['Прошлый год', () => monthPeriod(now.getFullYear() - 1, 0, 12)],
  ];
  if (meta?.stats?.date_from) {
    presets.push(['Всё время', () => ({ from: meta.stats.date_from.slice(0, 10), to: meta.stats.date_to.slice(0, 10) })]);
  }

  const el = document.createElement('div');
  el.className = 'picker';
  document.body.appendChild(el);
  const close = () => el.remove();

  const draw = () => {
    const y = view.getFullYear();
    const m = view.getMonth();
    const offset = (new Date(y, m, 1).getDay() + 6) % 7; // неделя с понедельника
    const days = new Date(y, m + 1, 0).getDate();

    let cells = '<span></span>'.repeat(offset);
    for (let d = 1; d <= days; d += 1) {
      const iso = isoDay(new Date(y, m, d));
      const last = end ?? start;
      const cls = [
        'cal-day',
        iso === start || iso === end ? 'edge' : '',
        end && iso > start && iso < end ? 'in' : '',
        iso === start && end && end !== start ? 'from' : '',
        iso === end && end !== start ? 'to' : '',
        iso === today ? 'today' : '',
        iso > today ? 'future' : '',
      ].filter(Boolean).join(' ');
      cells += `<button class="${cls}" type="button" data-day="${iso}"${iso === last ? ' aria-current="date"' : ''}><span>${d}</span></button>`;
    }

    el.innerHTML = `
      <div class="picker-box cal" role="dialog" aria-label="Выбор периода">
        <div class="picker-top"><span>Период</span><button class="btn" data-close type="button">Отмена</button></div>
        <div class="chips">${presets
          .map(([label], i) => `<button class="chip" type="button" data-preset="${i}">${label}</button>`)
          .join('')}</div>
        <div class="cal-head">
          <button class="month-arrow" type="button" data-view="-1" aria-label="Предыдущий месяц">‹</button>
          <span>${cap(MONTHS[m])} ${y}</span>
          <button class="month-arrow" type="button" data-view="1" aria-label="Следующий месяц">›</button>
        </div>
        <div class="cal-grid">
          ${WEEKDAYS.map((w) => `<span class="cal-wd">${w}</span>`).join('')}
          ${cells}
        </div>
        <p class="note cal-note">${end ? 'Нажмите на день, чтобы выбрать заново' : 'Теперь последний день — или сразу «Показать»'}</p>
        <button class="btn primary big" type="button" data-apply>Показать: ${esc(periodTitle(start, end ?? start))}</button>
      </div>`;
  };

  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('[data-close]')) return close();

    const shift = e.target.closest('[data-view]');
    if (shift) {
      view = new Date(view.getFullYear(), view.getMonth() + Number(shift.dataset.view), 1);
      return draw();
    }

    const day = e.target.closest('[data-day]');
    if (day) {
      const iso = day.dataset.day;
      if (end) {
        start = iso;
        end = null;
      } else if (iso < start) {
        end = start;
        start = iso;
      } else {
        end = iso;
      }
      return draw();
    }

    const preset = e.target.closest('[data-preset]');
    if (preset) {
      close();
      return go(presets[Number(preset.dataset.preset)][1](), true);
    }

    if (e.target.closest('[data-apply]')) {
      close();
      go({ from: start, to: end ?? start }, true);
    }
  });

  draw();
}

// ── чеки ─────────────────────────────────────────────────
// Отдельный список: всё, что приехало, и всё, что застряло. Сканы с ошибкой
// чеками ещё не стали, поэтому идут своими строками поверх списка.

const RECEIPTS_PER = 50;

/** «ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ГАЗПРОМНЕФТЬ - ЦЕНТР"» → «ГАЗПРОМНЕФТЬ - ЦЕНТР». */
function sellerName(r) {
  const quoted = /["«]([^"»]+)["»]/.exec(r.seller ?? '');
  return (quoted?.[1] ?? r.seller ?? r.retail_place ?? '').trim() || 'Без продавца';
}

const jobIsSync = (job) => ['455', '544'].includes(String(job.error_code ?? ''));
const RETRIES = 4; // столько отложенных повторов делает сервер (scan.mjs, RETRY_HOURS)

function jobNote(job) {
  if (job.status === 'new') return 'в очереди';
  if (job.status === 'sent') return 'ждём ответа ФНС';
  if (job.next_at) return `ФНС ещё не знает чек · спросим ${whenRu(job.next_at)}`;
  if (jobIsSync(job)) return 'ФНС так и не отдала чек';
  return job.error ?? 'не вышло';
}

/** Когда будет повтор — по-человечески, в часовом поясе телефона. */
function whenRu(iso) {
  const d = new Date(iso);
  if (d <= new Date()) return 'в ближайшие минуты';
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - parseDay(isoDay(new Date()))) / 86400000);
  if (days <= 0) return `в ${time}`;
  if (days === 1) return `завтра в ${time}`;
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} в ${time}`;
}

const jobRow = (job) => `
  <button class="row" type="button" data-job="${job.id}">
    <span class="scan-dot ${esc(job.status)}${job.next_at && job.status === 'failed' ? ' waiting' : ''}"></span>
    <span class="row-main">
      <span class="row-title">Скан от ${dateRu(job.purchased_at)} ${esc(timeRu(job.purchased_at))}</span>
      <span class="row-note">${esc(jobNote(job))}</span>
    </span>
    <span class="row-sum">${money(job.total_sum, true)}</span>
  </button>`;

let lastDay = ''; // последний выведенный день: следующая страница не повторит его заголовок

function receiptRows(rows) {
  return rows
    .map((r) => {
      const heading = r.purchased_date !== lastDay ? `<div class="day">${esc(dayTitle(r.purchased_date))}</div>` : '';
      lastDay = r.purchased_date;
      const marks = [
        timeRu(r.purchased_at),
        `${int.format(r.item_count)} ${plural(r.item_count, 'позиция', 'позиции', 'позиций')}`,
        r.manual ? 'вручную' : '',
        r.operation_type === 2 ? 'возврат' : '',
        shared() && r.author ? r.author : '', // в общем бюджете видно, чья трата
      ].filter(Boolean);
      return `${heading}
        <button class="row" type="button" data-receipt="${r.id}">
          <span class="row-main">
            <span class="row-title">${esc(r.manual ? r.title : sellerName(r))}</span>
            <span class="row-note">${esc(marks.join(' · '))}</span>
          </span>
          <span class="row-sum${r.counted ? '' : ' muted'}">${money(r.total_sum, true)}</span>
        </button>`;
    })
    .join('');
}

function dayTitle(iso) {
  const d = parseDay(iso);
  const today = isoDay(new Date());
  if (iso === today) return 'Сегодня';
  if (iso === isoDay(addDays(new Date(), -1))) return 'Вчера';
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}${year}`;
}

let receiptsPage = 1; // «Показать ещё» дописывает страницы, не перерисовывая экран

async function screenReceipts() {
  const f = state.filter;
  const scanState = f === 'failed' || f === 'pending' ? `?state=${f}` : '';
  const scans = await api(`/api/scan${scanState}`);
  updateBadge(scans.counts.failed);

  const chip = (key, label, count) =>
    `<button class="chip${f === key ? ' on' : ''}${key === 'failed' && count ? ' alert' : ''}" type="button" data-filter="${key}">` +
    `${label}${count ? ` <b>${int.format(count)}</b>` : ''}</button>`;

  const chips = `<div class="chips">
    ${chip('all', 'Все')}
    ${chip('failed', 'С ошибкой', scans.counts.failed)}
    ${scans.counts.pending || f === 'pending' ? chip('pending', 'В очереди', scans.counts.pending) : ''}
    ${chip('manual', 'Вручную')}
  </div>`;

  // Ошибки и очередь живут вне периода: застрявший скан важен, когда бы ни была покупка
  if (f === 'failed' || f === 'pending') {
    const hint = f === 'failed'
      ? '<p class="note list-hint">Обычно это чек, который касса ещё не передала в ФНС. Мы переспрашиваем сами — через час, 6 часов, сутки и трое суток.</p>'
      : '';
    return scans.jobs.length
      ? `${expenseSwitch()}${chips}${hint}<div class="list">${scans.jobs.map(jobRow).join('')}</div>`
      : `${expenseSwitch()}${chips}<div class="empty">${f === 'failed' ? 'Сканов с ошибкой нет' : 'Очередь пуста'}</div>`;
  }

  receiptsPage = 1;
  lastDay = '';
  const data = await api(`/api/receipts?${receiptsQuery(1)}`);
  // В общем списке застрявшие сканы — те, что попадают в период
  const stuck = f === 'all'
    ? scans.jobs.filter((j) => j.purchased_at.slice(0, 10) >= state.from && j.purchased_at.slice(0, 10) <= state.to)
    : [];

  const head = `
    <div class="stuck-head">
      ${expenseSwitch()}
      <div class="total compact">
        <span class="total-sum">${money(data.totals.sum)}</span>
        <span class="total-note">${int.format(data.totals.count)} ${plural(data.totals.count, 'чек', 'чека', 'чеков')}${
          data.totals.excluded_count ? ` · ${int.format(data.totals.excluded_count)} вне суммы` : ''
        }</span>
        ${periodNav(true)}
      </div>
    </div>
    ${chips}`;

  if (!data.rows.length && !stuck.length) {
    return `${head}<div class="empty">${f === 'manual' ? 'Ручных записей за период нет' : 'Чеков за период нет'}</div>`;
  }

  const more = data.totals.count > RECEIPTS_PER
    ? '<button class="btn more" type="button" id="more">Показать ещё</button>'
    : '';

  return `${head}
    ${stuck.length ? `<div class="list stuck">${stuck.map(jobRow).join('')}</div>` : ''}
    <div class="list" id="receipt-list">${receiptRows(data.rows)}</div>
    ${more}`;
}

function receiptsQuery(page) {
  const q = new URLSearchParams({ from: state.from, to: state.to, sort: 'date', dir: 'desc', per: RECEIPTS_PER, page });
  if (state.filter === 'manual') q.set('kind', 'manual');
  return q;
}

async function loadMoreReceipts(button) {
  button.disabled = true;
  try {
    const data = await api(`/api/receipts?${receiptsQuery(receiptsPage + 1)}`);
    receiptsPage += 1;
    $('receipt-list').insertAdjacentHTML('beforeend', receiptRows(data.rows));
    if (receiptsPage * RECEIPTS_PER >= data.totals.count) button.remove();
    else button.disabled = false;
  } catch (err) {
    button.textContent = `Не загрузилось: ${err.message}`;
    button.disabled = false;
  }
}

function updateBadge(count) {
  failedCount = count ?? 0;
  const badge = $('tab-badge');
  badge.hidden = !count;
  badge.textContent = count > 99 ? '99+' : String(count ?? '');
  // Число пришло после отрисовки шапки — обновляем и переключатель «Категории | Чеки»
  const segment = document.querySelector('[data-segment="receipts"]');
  if (segment) {
    segment.innerHTML = `Чеки${count ? `<i class="seg-badge">${count > 99 ? '99+' : count}</i>` : ''}`;
  }
}

/** Застрявший скан: что случилось, когда повтор, и что можно сделать самому. */
async function openScanSheet(jobId) {
  let job;
  try {
    ({ job } = await api(`/api/scan/${jobId}`));
  } catch (err) {
    return toast(err.message);
  }

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  document.body.appendChild(sheet);
  const close = () => {
    sheet.remove();
    render();
  };

  const explain = () => {
    if (job.status !== 'failed') return jobNote(job);
    if (jobIsSync(job)) {
      if (job.next_at) {
        return `ФНС пока не получила этот чек от кассы — так бывает, данные доходят до суток и дольше. Спросим сами ${whenRu(job.next_at)}.`;
      }
      return job.retries >= RETRIES
        ? 'ФНС так и не получила этот чек, автоповторы закончились. Можно спросить ещё раз или удалить скан.'
        : 'ФНС не отдала этот чек. Данные могли уже дойти — спросите ещё раз или удалите скан.';
    }
    return 'ФНС отказала. Если QR прочитался криво, проще удалить скан и отсканировать чек заново.';
  };

  const draw = (busy = '') => {
    sheet.innerHTML = `
      <div class="sheet-box" role="dialog" aria-label="Скан чека">
        <div class="sheet-top">
          <div>
            <div class="sheet-sum-total">${money(job.total_sum, true)}</div>
            <div class="note">Покупка ${dateRu(job.purchased_at)} в ${esc(timeRu(job.purchased_at))}</div>
          </div>
          <button class="icon-btn primary" data-close type="button" aria-label="Закрыть" title="Закрыть">${UI.ok}</button>
        </div>
        <div class="card sheet-card">
          <p class="scan-explain">${esc(explain())}</p>
          ${job.status === 'failed' && job.error ? `<div class="kv"><span>Ответ ФНС</span><b>${esc(job.error)}${job.error_code ? ` (${esc(job.error_code)})` : ''}</b></div>` : ''}
          <div class="kv"><span>ФН</span><b>${esc(job.fiscal_drive)}</b></div>
          <div class="kv"><span>ФД / ФП</span><b>${esc(job.fiscal_doc)} / ${esc(job.fiscal_sign)}</b></div>
          <div class="kv"><span>Отсканирован</span><b>${dateRu(job.created_at)}</b></div>
          ${job.retries ? `<div class="kv"><span>Повторов</span><b>${int.format(job.retries)}</b></div>` : ''}
        </div>
        ${busy ? `<p class="note sheet-hint">${esc(busy)}</p>` : ''}
        ${job.status === 'failed' ? `
          <div class="sheet-actions">
            <button class="btn primary" type="button" data-retry${busy ? ' disabled' : ''}>Спросить ФНС сейчас</button>
            <button class="btn" type="button" data-manual>Добавить вручную</button>
            <button class="btn danger" type="button" data-delete${busy ? ' disabled' : ''}>Удалить скан</button>
          </div>` : ''}
      </div>`;
  };

  sheet.addEventListener('click', async (e) => {
    if (e.target === sheet || e.target.closest('[data-close]')) return close();

    // ФНС чек так и не отдала — покупки из него можно записать руками:
    // дата, время и сумма чека уже известны из QR
    if (e.target.closest('[data-manual]')) {
      manualPrefill = {
        sum: rublesInput(job.total_sum),
        date: job.purchased_at.slice(0, 10),
        time: job.purchased_at.slice(11, 16) || '12:00',
        total: job.total_sum,
        left: job.total_sum,
      };
      sheet.remove();
      return go({ screen: 'manual' });
    }

    if (e.target.closest('[data-delete]')) {
      if (!confirm('Удалить скан? Чек можно будет отсканировать заново.')) return;
      try {
        await api(`/api/scan/${job.id}`, { method: 'DELETE' });
        toast('Скан удалён');
        close();
      } catch (err) {
        draw(`Не удалилось: ${err.message}`);
      }
      return;
    }

    if (e.target.closest('[data-retry]')) {
      try {
        ({ job } = await post(`/api/scan/${job.id}/retry`));
      } catch (err) {
        return draw(`Не вышло: ${err.message}`);
      }
      job = await followScan(job, (j) => {
        job = j;
        draw(`${jobNote(j)}…`);
      });
      if (job.status === 'done' && job.receipt_id) {
        sheet.remove();
        await openReceiptSheet(job.receipt_id);
      } else {
        draw(job.status === 'failed' ? 'ФНС снова не отдала чек' : 'Ответ задерживается — проверим позже');
      }
    }
  });

  draw();
}

// ── добавление ───────────────────────────────────────────

/** Первый вход: пусто не потому, что период такой, а потому что чеков ещё нет. */
function welcome() {
  return `
    <div class="welcome">
      <div class="welcome-title">Здесь будут ваши расходы</div>
      <p class="note">Отсканируйте QR-код с любого кассового чека — позиции придут из ФНС
        и сами разложатся по категориям. Покупку без чека можно вбить вручную.</p>
    </div>
    ${screenAdd()}`;
}

function screenAdd() {
  return `
    <div class="add">
      <button class="add-btn" type="button" data-scanner>
        <span class="add-ic">${UI.scan}</span>
        <span class="add-text"><b>Сканировать чек</b><span>QR-код внизу чека — позиции придут из ФНС</span></span>
      </button>
      <button class="add-btn" type="button" data-screen="manual">
        <span class="add-ic">${UI.pen}</span>
        <span class="add-text"><b>Вбить вручную</b><span>Трата без чека: рынок, перевод, наличные</span></span>
      </button>
    </div>`;
}

/**
 * Что получилось после добавления: чек с позициями или одна ручная запись.
 * Отдельный экран, а не всплывающий лист: после сканирования это конец дела,
 * и здесь же решается, добавлять ли дальше. Категории правятся прямо тут —
 * строки те же, что в разборе чека, поэтому и правка работает так же.
 */
let addedManual = false; // что добавили последним: от этого зависит, куда ведёт «ещё»

async function screenAdded() {
  const receipt = await api(`/api/receipts/${state.added}`);
  const manual = receipt.fiscal_drive === 'manual';
  addedManual = manual;
  const again = $('actions').querySelector('[data-again]');
  if (again) again.textContent = manual ? 'Вбить ещё' : 'Сканировать ещё';
  const unknown = receipt.items.filter((i) => !i.category_slug).length;

  return `
    <div class="done">
      <span class="done-ic">${UI.check}</span>
      <div class="done-title">${manual ? 'Трата записана' : 'Чек добавлен'}</div>
      <div class="done-sum">${money(receipt.total_sum, true)}</div>
      <div class="note">${esc(manual ? 'Вручную' : sellerName(receipt))} · ${dateRu(receipt.purchased_at)} ${esc(timeRu(receipt.purchased_at))}</div>
    </div>

    <p class="note list-hint">${
      unknown
        ? `${int.format(unknown)} ${plural(unknown, 'позиция', 'позиции', 'позиций')} без категории — нажмите и выберите`
        : 'Нажмите на строку, чтобы поменять категорию'
    }</p>
    <div class="list sheet-list">${receipt.items.map(sheetRow).join('')}</div>`;
}

// ── сканирование ─────────────────────────────────────────
// Камера открывается сразу поверх экрана — отдельной страницы с кнопкой «навести»
// нет: нажатие «Сканировать» уже и есть это намерение.
//
// QR чека содержит только реквизиты, позиции запрашиваются у ФНС, а обмен там
// асинхронный. Скан уходит в очередь на сервере, а камера показывает, как он
// продвигается, и уступает место разбору чека, когда тот готов.

let scanner = null; // { el, stream, stop } — открытая камера, чтобы погасить её при уходе

const scanSupported = () => 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);

function closeScanner() {
  if (!scanner) return;
  scanner.stop = true;
  scanner.stream?.getTracks().forEach((t) => t.stop());
  scanner.el.remove();
  scanner = null;
}

function openScanner() {
  closeScanner();
  const el = document.createElement('div');
  el.className = 'scanner';
  el.innerHTML = `
    <video playsinline muted autoplay></video>
    <div class="scanner-frame"><p class="scanner-frame-status" id="scanner-frame-status"></p></div>
    <button class="scanner-close" type="button" data-close aria-label="Закрыть">×</button>
    <div class="scanner-bottom">
      <p class="scanner-status" id="scanner-status">Включаем камеру…</p>
      <div class="scanner-actions" id="scanner-actions"></div>
      <button class="scanner-link" type="button" data-typed>Ввести строку из QR вручную</button>
      <form class="scanner-typed" id="scanner-typed" hidden>
        <textarea rows="3" placeholder="t=20250514T1830&amp;s=1234.00&amp;fn=…&amp;i=…&amp;fp=…&amp;n=1"></textarea>
        <button class="btn primary" type="submit">Отправить</button>
      </form>
    </div>`;
  document.body.appendChild(el);
  const current = { el, stream: null, stop: false };
  scanner = current;

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return closeScanner();
    if (e.target.closest('[data-typed]')) {
      el.querySelector('#scanner-typed').hidden = false;
      el.querySelector('[data-typed]').hidden = true;
      return el.querySelector('textarea').focus();
    }
    if (e.target.closest('[data-again]')) return openScanner();
    if (e.target.closest('[data-to-failed]')) {
      closeScanner();
      go({ screen: 'receipts', filter: 'failed' });
    }
  });

  el.querySelector('#scanner-typed').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = el.querySelector('textarea').value.trim();
    if (value) submitScan(current, value);
  });

  startCamera(current);
}

/**
 * Статус и кнопки камеры. Пока ищем код, подсказка внизу — рамка должна быть прозрачной.
 * Когда код пойман, всё, что дальше говорит ФНС, пишется прямо в рамке: взгляд
 * и так там. Кнопки остаются внизу, под большим пальцем.
 * Сканер могли закрыть, пока шёл запрос, — тогда молчим.
 */
function scannerSay(current, text, { error = false, actions = '' } = {}) {
  if (scanner !== current) return;
  const caught = current.el.classList.contains('caught');
  const target = current.el.querySelector(caught ? '#scanner-frame-status' : '#scanner-status');
  current.el.querySelector(caught ? '#scanner-status' : '#scanner-frame-status').textContent = '';
  target.innerHTML = text;
  target.classList.toggle('error', error);
  current.el.querySelector('#scanner-actions').innerHTML = actions;
}

/** Камера и поиск QR в кадре. */
async function startCamera(current) {
  if (!scanSupported()) {
    scannerSay(current, 'Этот браузер не умеет читать QR — введите строку из чека вручную', { error: true });
    current.el.querySelector('[data-typed]').click();
    return;
  }

  const video = current.el.querySelector('video');
  try {
    current.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    // Закрыли, пока телефон спрашивал разрешение, — поток сразу гасим
    if (scanner !== current) return current.stream.getTracks().forEach((t) => t.stop());
    video.srcObject = current.stream;
    await video.play();
    scannerSay(current, 'Наведите на QR-код внизу чека');
  } catch (err) {
    scannerSay(current, `Камера недоступна: ${esc(err.message)}`, { error: true });
    return;
  }

  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  while (scanner === current && !current.stop) {
    try {
      const found = await detector.detect(video);
      const qr = found.find((c) => /(^|[?&])fn=/.test(c.rawValue ?? ''));
      if (qr) {
        navigator.vibrate?.(60);
        current.stream.getTracks().forEach((t) => t.stop()); // кадр держим, камеру гасим
        current.el.classList.add('caught');
        await submitScan(current, qr.rawValue);
        return;
      }
    } catch {
      /* кадр не разобрался — просто пробуем следующий */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Опрос задания до готовности или отказа. Ответ ФНС приходит за секунды, но бывает и дольше. */
async function followScan(job, onUpdate) {
  for (let i = 0; i < 30; i += 1) {
    onUpdate(job);
    if (job.status === 'done' || job.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 2000));
    try {
      ({ job } = await api(`/api/scan/${job.id}`));
    } catch {
      break;
    }
  }
  return job;
}

/** Отправка распознанной строки и слежение за заданием до готовности. */
async function submitScan(current, qr) {
  current.el.classList.add('caught');
  const again = '<button class="btn" type="button" data-again>Сканировать ещё</button>';
  scannerSay(current, 'Код прочитан, отправляем…');

  let job;
  try {
    const data = await post('/api/scan', { qr });
    job = data.job;
    if (data.known && job.receipt_id) {
      closeScanner();
      toast('Этот чек уже был в базе');
      return openReceiptSheet(job.receipt_id);
    }
  } catch (err) {
    return scannerSay(current, esc(cap(err.message)), { error: true, actions: again });
  }

  job = await followScan(job, (j) => scannerSay(current, `${esc(cap(jobNote(j)))}…`));
  if (scanner !== current) return; // закрыли, не дождавшись: чек и так появится в списке

  if (job.status === 'done' && job.receipt_id) {
    closeScanner();
    go({ screen: 'added', added: String(job.receipt_id) });
  } else if (job.status === 'failed') {
    api('/api/scan?state=failed').then((d) => updateBadge(d.counts.failed)).catch(() => {});
    scannerSay(
      current,
      `${esc(jobIsSync(job) ? 'ФНС пока не получила этот чек от кассы.' : `Не вышло: ${job.error ?? ''}`)}
       ${job.next_at ? `Спросим сами ${esc(whenRu(job.next_at))}.` : ''}`,
      {
        error: true,
        actions: `${again}<button class="btn" type="button" data-to-failed>Сканы с ошибкой</button>`,
      },
    );
  } else {
    scannerSay(current, 'Ответ задерживается — чек появится в списке, когда ФНС ответит', { actions: again });
  }
}

// ── ручная трата ─────────────────────────────────────────
// Покупка без чека. Категория здесь обязательна: угадывать её не из чего,
// а трата без категории потерялась бы в сводке.

let manualCategory = ''; // переживает перерисовку: несколько трат подряд обычно из одной категории

// Заготовка из скана, который ФНС не отдала: { sum, date, time, total, left }. Живёт, пока
// открыт экран ручной траты, — «+» в следующий раз откроет чистую форму. После записи
// остаток переезжает в manualCarry: «Вбить ещё» продолжит тот же чек
let manualPrefill = null;
let manualCarry = null;

/** Копейки → строка для поля суммы: «3300» или «479,94». */
const rublesInput = (kopecks) =>
  kopecks % 100 ? (kopecks / 100).toFixed(2).replace('.', ',') : String(kopecks / 100);

function categoryButton(slug) {
  const found = findCategory(slug);
  if (!found) {
    return `<span class="pick-ic" style="background:#eef1f5;color:#6b7280">${groupIcon('none')}</span>
      <span class="cat-name muted">Выбрать категорию</span>`;
  }
  const color = found.group.color ?? '#eef1f5';
  return `<span class="pick-ic" style="background:${color};color:${readableText(color)}">${groupIcon(found.group.icon ?? 'none')}</span>
    <span class="cat-name">${esc(found.category.name)}<small>${esc(found.group.name)}</small></span>`;
}

function screenManual() {
  const today = isoDay(new Date());
  const pre = manualPrefill;
  return `
    ${pre ? `<p class="note list-hint">Чек от ${dateRu(pre.date)} на ${money(pre.total, true)}: ФНС его не отдала. ${
      pre.left < pre.total
        ? `Осталось записать ${money(pre.left, true)}.`
        : 'Запишите покупки из него — одной суммой или по одной.'
    }</p>` : ''}
    <form class="card form" id="manual-form" novalidate>
      <label class="field">
        <span>Сумма, ₽</span>
        <input id="m-sum" class="sum-input" inputmode="decimal" autocomplete="off" placeholder="0" required value="${pre ? esc(pre.sum) : ''}" />
      </label>
      <label class="field">
        <span>Что купили</span>
        <input id="m-name" type="text" maxlength="200" autocomplete="off" placeholder="Необязательно" />
      </label>
      <label class="field">
        <span>Дата</span>
        <input id="m-date" type="date" value="${pre?.date ?? today}" max="${today}" required />
      </label>
      <div class="field">
        <span>Категория</span>
        <button class="cat-pick" id="m-cat" type="button">${categoryButton(manualCategory)}</button>
      </div>
      <p class="note" id="m-note"></p>
      <button class="btn primary big" id="m-save" type="submit">Записать</button>
    </form>`;
}

async function saveManual() {
  const note = $('m-note');
  const sum = $('m-sum').value.trim();
  const date = $('m-date').value;
  note.classList.add('error');

  if (!(Number(sum.replace(/\s/g, '').replace(',', '.')) > 0)) {
    note.textContent = 'Укажите сумму';
    return $('m-sum').focus();
  }
  if (!date) {
    note.textContent = 'Укажите дату';
    return;
  }
  if (!manualCategory) {
    note.textContent = 'Выберите категорию';
    return;
  }

  // Сегодняшней трате — текущее время, прошлой — полдень: точного времени никто не помнит
  const now = new Date();
  const time = manualPrefill?.date === date
    ? manualPrefill.time // время покупки из чека
    : date === isoDay(now) ? `${pad(now.getHours())}:${pad(now.getMinutes())}` : '12:00';

  $('m-save').disabled = true;
  note.classList.remove('error');
  note.textContent = 'Записываем…';
  try {
    const saved = await post('/api/manual', { sum, date, time, name: $('m-name').value, category: manualCategory });
    // Записали часть битого чека — остаток ждёт «Вбить ещё»
    const left = manualPrefill ? manualPrefill.left - Math.round(Number(sum.replace(/\s/g, '').replace(',', '.')) * 100) : 0;
    manualCarry = left > 0 ? { ...manualPrefill, left, sum: rublesInput(left) } : null;
    go({ screen: 'added', added: String(saved.id) });
  } catch (err) {
    note.classList.add('error');
    note.textContent = `Не записалось: ${err.message}`;
  } finally {
    $('m-save').disabled = false;
  }
}

// ── разбор чека ──────────────────────────────────────────
// Модель угадывает категорию, но угадывает не всегда. Показываем разобранный чек
// сразу после распознавания: согласиться — ничего не делать, поправить — один выбор.
// Правка уходит в словарь и распространяется на все позиции с таким же названием,
// поэтому следующий такой чек разберётся уже правильно.

/**
 * Строка разбора: значок группы, название в одну строку и категория подстрочником.
 * Названия в чеках длинные («ЧЕРКИЗОВО Колбас По-домаш с чесн рубл катБ0,4»), поэтому
 * обрезаются: важнее видеть весь чек целиком, чем каждое слово в позиции.
 * На экране «Добавлено» нажатие на строку открывает выбор — цель шире, чем один значок.
 * В попапе чека ({ open: true }) строка ведёт в карточку товара, а категорию
 * меняет отдельная кнопка-значок справа.
 */
function sheetRow(item, { open = false } = {}) {
  const group = findGroup(item.group_slug);
  const color = group?.color ?? '#eef1f5';
  // Значок в кольце — категорию предложила модель, сплошной — выбрал человек
  const human = item.category_source === 'manual' || item.category_source === 'pinned';
  const guess = item.category_slug && !human ? ' guess' : '';

  const body = `
      <span class="pick-ic" style="background:${color};color:${readableText(color)}">${groupIcon(group?.icon ?? 'none')}</span>
      <span class="sheet-main">
        <span class="sheet-name">${esc(item.name)}</span>
        <span class="sheet-cat">${esc(item.category_name ?? 'выбрать категорию')}</span>
      </span>
      <span class="sheet-sum">${money(item.sum, true)}</span>`;

  if (!open) {
    return `<button class="sheet-row${guess}" type="button" data-row="${item.id}" data-pick="${item.id}">${body}</button>`;
  }
  return `
    <div class="sheet-row${guess}" data-row="${item.id}">
      <button class="sheet-open" type="button" data-open-item="${item.id}">${body}</button>
      <button class="sheet-edit" type="button" data-pick="${item.id}" aria-label="Поменять категорию" title="Поменять категорию">${UI.tag}</button>
    </div>`;
}

/**
 * Выбор категории в два шага: сначала группа иконками, потом её категории.
 * Так вместо одного списка на сорок строк — две коротких страницы,
 * а цвета и значки те же, что во всём остальном приложении.
 */
function openCategoryPicker(itemId, onPick) {
  const groups = meta?.categories ?? [];
  const picker = document.createElement('div');
  picker.className = 'picker';
  document.body.appendChild(picker);

  const close = () => picker.remove();

  // Для чего выбираем: строка чека, карточка товара или новая ручная трата
  const name =
    (itemId && document.querySelector(`.sheet-row[data-row="${itemId}"] .sheet-name`)?.textContent) ||
    (itemId && itemShown?.id === itemId ? itemShown.name : '') ||
    (!itemId ? document.getElementById('m-name')?.value.trim() : '') ||
    '';
  const subtitle = name ? `<small class="picker-for">Выберите категорию для расхода «${esc(name)}»</small>` : '';
  const closeBtn = `<button class="icon-btn soft" data-close type="button" aria-label="Отмена" title="Отмена">${UI.close}</button>`;

  const showGroups = () => {
    picker.innerHTML = `
      <div class="picker-box" role="dialog" aria-label="Выбор группы">
        <div class="picker-top"><div class="picker-title">Группа${subtitle}</div>${closeBtn}</div>
        <div class="picker-grid">
          ${groups
            .map(
              (g) => `
              <button class="picker-tile" type="button" data-group="${esc(g.slug)}">
                <span class="pick-ic big" style="background:${g.color ?? '#eef1f5'};color:${readableText(g.color ?? '#eef1f5')}">${groupIcon(g.icon ?? 'none')}</span>
                <span class="picker-tile-name">${esc(g.name)}</span>
              </button>`,
            )
            .join('')}
        </div>
      </div>`;
  };

  const showCategories = (group) => {
    const tones = shades(group.color ?? '', group.subcategories.length, group.shade_from, group.shade_to);
    picker.innerHTML = `
      <div class="picker-box" role="dialog" aria-label="Выбор категории">
        <div class="picker-top">
          <button class="picker-back" data-back type="button" aria-label="Назад">‹</button>
          <div class="picker-title">${esc(group.name)}${subtitle}</div>
          ${closeBtn}
        </div>
        <div class="picker-list">
          ${group.subcategories
            .map(
              (s, i) => `
              <button class="picker-item" type="button" data-category="${esc(s.slug)}">
                <span class="dot" style="background:${tones[i] ?? group.color ?? '#eef1f5'}"></span>
                <span>${esc(s.name)}</span>
              </button>`,
            )
            .join('')}
        </div>
      </div>`;
  };

  picker.addEventListener('click', (e) => {
    if (e.target === picker || e.target.closest('[data-close]')) return close();
    if (e.target.closest('[data-back]')) return showGroups();

    const group = e.target.closest('[data-group]');
    if (group) return showCategories(findGroup(group.dataset.group));

    const category = e.target.closest('[data-category]');
    if (category) {
      close(); // возвращаемся к списку товаров сразу, не дожидаясь сохранения
      onPick(itemId, category.dataset.category);
    }
  });

  showGroups();
}

async function openReceiptSheet(receiptId, { current = null } = {}) {
  let receipt;
  try {
    receipt = await api(`/api/receipts/${receiptId}`);
  } catch (err) {
    return toast(`Чек не открылся: ${err.message}`);
  }

  const manual = receipt.fiscal_drive === 'manual';
  const unknown = receipt.items.filter((i) => !i.category_slug).length;
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `
    <div class="sheet-box" role="dialog" aria-label="Разбор чека">
      <div class="sheet-top">
        <div>
          <div class="sheet-sum-total">${money(receipt.total_sum, true)}</div>
          <div class="note">${esc(manual ? 'Записано вручную' : sellerName(receipt))} · ${dateRu(receipt.purchased_at)} ${esc(timeRu(receipt.purchased_at))}${
            shared() && receipt.author ? ` · ${esc(receipt.author)}` : ''
          }</div>
        </div>
        <button class="icon-btn primary" data-close type="button" aria-label="Готово" title="Готово">${UI.ok}</button>
      </div>
      ${unknown ? `<p class="note sheet-hint">${int.format(unknown)} ${plural(unknown, 'позиция', 'позиции', 'позиций')} без категории — выберите значком справа</p>` : ''}
      <div class="sheet-list">${receipt.items.map((i) => sheetRow(i, { open: true })).join('')}</div>
      ${manual ? '<div class="sheet-actions"><button class="btn danger" type="button" data-remove>Удалить запись</button></div>' : ''}
    </div>`;

  document.body.appendChild(sheet);

  // Открыли из карточки товара — эту позицию подсвечиваем и показываем
  const row = current && sheet.querySelector(`.sheet-row[data-row="${current}"]`);
  if (row) {
    row.classList.add('current');
    row.scrollIntoView({ block: 'nearest' });
  }

  const close = () => {
    sheet.remove();
    render(); // сводка могла измениться
  };

  sheet.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]') || e.target === sheet) return close();

    if (e.target.closest('[data-remove]')) {
      if (!confirm('Удалить эту запись?')) return;
      try {
        await api(`/api/receipts/${receipt.id}`, { method: 'DELETE' });
        toast('Запись удалена');
        close();
      } catch (err) {
        toast(`Не удалилось: ${err.message}`);
      }
      return;
    }

    // Значок справа открывает выбор категории; сохранение — уже по возврату
    const pick = e.target.closest('[data-pick]');
    if (pick) return openCategoryPicker(Number(pick.dataset.pick), saveCategory);

    // Строка — в карточку товара. Чек запоминаем в текущей записи истории:
    // «назад» из карточки откроет его снова
    const open = e.target.closest('[data-open-item]');
    if (open) {
      history.replaceState({ ...state, sheet: receipt.id }, '', location.href);
      sheet.remove();
      go({ screen: 'item', item: open.dataset.openItem, sheet: '' });
    }
  });
}

/** Сохранение выбранной категории и обновление строки на месте. */
async function saveCategory(itemId, slug) {
  const row = document.querySelector(`.sheet-row[data-row="${itemId}"]`);
  if (!row) return;
  row.classList.add('saving');

  try {
    const data = await post(`/api/items/${itemId}/category`, { category: slug });

    const group = findCategory(slug)?.group;
    const color = group?.color ?? '#eef1f5';
    const ic = row.querySelector('.pick-ic');
    ic.style.background = color;
    ic.style.color = readableText(color);
    ic.innerHTML = groupIcon(group?.icon ?? 'none');
    row.classList.remove('guess'); // выбор человека, кольцо снимаем
    row.querySelector('.sheet-cat').textContent =
      (data.category?.name ?? 'выбрать категорию') +
      (data.affected > 1 ? ` · и ещё ${int.format(data.affected - 1)}` : '');

    row.classList.add('picked');
    meta = await api('/api/meta'); // счётчики категорий изменились
  } catch (err) {
    row.insertAdjacentHTML('beforeend', `<p class="note error">${esc(err.message)}</p>`);
  } finally {
    row.classList.remove('saving');
  }
}

// ── экраны ───────────────────────────────────────────────

const SCREENS = {
  summary: { title: 'Расходы', render: screenSummary },
  receipts: { title: 'Чеки', render: screenReceipts },
  add: { title: 'Добавить', render: screenAdd },
  manual: { title: 'Вручную', render: screenManual, after: () => $('m-sum')?.focus() },
  added: {
    title: 'Добавлено',
    render: screenAdded,
    // Главные кнопки живут в каркасе, а не в содержимом: длинный чек не должен
    // уводить их за край экрана
    // Одна главная кнопка и под ней неприметная ссылка «ещё»: чаще всего человек
    // закончил, а следующий чек — сразу сканер, без промежуточного экрана
    actions: () => `
      <button class="btn primary big" type="button" data-back-home>ОК</button>
      <button class="link more-link" type="button" data-again>Сканировать ещё</button>`,
  },
  group: { title: () => findGroup(state.group)?.name ?? 'Группа', render: screenGroup },
  category: { title: 'Позиции', render: screenCategory },
  item: { title: 'Товар', render: screenItem, after: mountItemMap },
  income: {
    title: 'Доход',
    render: () => soon(UI.income, 'Доходы', 'Здесь будут зарплата, переводы и другие поступления — чтобы видеть, сколько остаётся.'),
  },
  stats: {
    title: 'Статистика',
    render: () => soon(UI.stats, 'Статистика', 'Здесь будут графики: как меняются траты по месяцам и категориям.'),
  },
  settings: { title: 'Настройки', render: screenSettings },
};

/** Раздела ещё нет, а вкладка уже на месте: навигация не будет меняться потом. */
const soon = (icon, title, text) => `
  <div class="soon">
    <span class="soon-ic">${icon}</span>
    <div class="soon-title">${title} — скоро</div>
    <p class="note">${text}</p>
  </div>`;

// Какая вкладка горит: вглубь расходов — «Расходы», добавление — ни одна
const TAB_OF = {
  summary: 'summary', group: 'summary', category: 'summary', item: 'summary', receipts: 'summary',
  income: 'income', settings: 'settings', stats: 'stats',
};

/**
 * Сколько места внизу занимают закреплённые панели — вкладки и полоса кнопок. Столько
 * же отступа нужно ленте, иначе последние строки уйдут под панели. Высота разная:
 * полоса кнопок есть не на всех экранах, а у телефонов разная безопасная зона снизу.
 */
function updateDock() {
  const tabs = document.querySelector('.tabs').offsetHeight;
  const actions = $('actions').hidden ? 0 : $('actions').offsetHeight;
  const root = document.documentElement.style;
  root.setProperty('--tabs', `${tabs}px`);
  root.setProperty('--dock', `${tabs + actions}px`);
}

if ('ResizeObserver' in window) {
  const watch = new ResizeObserver(updateDock);
  watch.observe(document.querySelector('.tabs'));
  watch.observe($('actions'));
} else {
  window.addEventListener('resize', updateDock);
}

let renderSeq = 0;

async function render() {
  const seq = ++renderSeq;
  closeScanner(); // уходим с экрана (в том числе кнопкой «назад») — камера гаснет
  const screen = SCREENS[state.screen] ?? SCREENS.summary;
  const top = TOP.includes(state.screen);
  if (state.screen !== 'manual') manualPrefill = null; // заготовка из скана — только для этого захода
  if (state.screen !== 'added') manualCarry = null;

  $('title').textContent = typeof screen.title === 'function' ? screen.title() : screen.title;
  $('back').hidden = top;

  const actions = screen.actions?.() ?? '';
  $('actions').innerHTML = actions;
  $('actions').hidden = !actions;
  updateDock();
  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.classList.toggle('on', tab.dataset.tab === TAB_OF[state.screen]);
  }
  $('screen').innerHTML = loading();
  window.scrollTo(0, 0); // прокручивается страница, а не блок экрана

  try {
    const html = await screen.render();
    if (seq !== renderSeq) return;
    $('screen').innerHTML = html;
    screen.after?.();
  } catch (err) {
    if (seq === renderSeq) $('screen').innerHTML = failed(err);
  }
}

// ── события ──────────────────────────────────────────────

function onScreenClick(e) {
  // Строка позиции с выбором категории — экран «Добавлено»
  const pick = e.target.closest('[data-pick]');
  if (pick) return openCategoryPicker(Number(pick.dataset.pick), saveCategory);

  // Категория в карточке товара
  const itemReceipt = e.target.closest('[data-item-receipt]');
  if (itemReceipt) return openReceiptSheet(Number(itemReceipt.dataset.itemReceipt), { current: state.item });

  const itemCat = e.target.closest('[data-item-cat]');
  if (itemCat) return openCategoryPicker(Number(itemCat.dataset.itemCat), saveItemCategory);

  const shift = e.target.closest('[data-shift]');
  if (shift) return go(shiftPeriod(state.from, state.to, Number(shift.dataset.shift)), true);

  if (e.target.closest('[data-period]')) return openPeriodPicker();

  const filter = e.target.closest('[data-filter]');
  if (filter) return go({ filter: filter.dataset.filter }, true);

  // «Категории | Чеки» — замена экрана на месте: «назад» по переключателю не ходит
  const segment = e.target.closest('[data-segment]');
  if (segment) return go({ screen: segment.dataset.segment }, true);

  const sort = e.target.closest('[data-sort]');
  if (sort) {
    const key = sort.dataset.sort;
    const dir = key === state.sort ? (state.dir === 'asc' ? 'desc' : 'asc') : ITEM_SORTS[key][1];
    return go({ sort: key, dir }, true);
  }

  const group = e.target.closest('[data-group]');
  if (group) return go({ screen: 'group', group: group.dataset.group, category: '' });

  const category = e.target.closest('[data-category]');
  if (category) return go({ screen: 'category', category: category.dataset.category });

  const item = e.target.closest('[data-item]');
  if (item) return go({ screen: 'item', item: item.dataset.item });

  if (e.target.closest('[data-scanner]')) return openScanner();

  // «Сканировать ещё» — сразу камера; после ручной траты — снова форма
  if (e.target.closest('[data-again]')) {
    if (!addedManual) return openScanner();
    manualPrefill = manualCarry; // продолжаем битый чек, если он не дописан
    manualCarry = null;
    return go({ screen: 'manual' });
  }

  // «Вернуться» ведёт к расходам, а не на шаг назад: позади форма или камера
  if (e.target.closest('[data-back-home]')) return go({ screen: 'summary', added: '' });

  const screen = e.target.closest('[data-screen]');
  if (screen) return go({ screen: screen.dataset.screen });

  const job = e.target.closest('[data-job]');
  if (job) return openScanSheet(Number(job.dataset.job));

  const receipt = e.target.closest('[data-receipt]');
  if (receipt) return openReceiptSheet(Number(receipt.dataset.receipt));

  const more = e.target.closest('#more');
  if (more) return loadMoreReceipts(more);

  if (e.target.closest('#m-cat')) {
    return openCategoryPicker(null, (_, slug) => {
      manualCategory = slug;
      $('m-cat').innerHTML = categoryButton(slug);
      $('m-note').textContent = '';
    });
  }
}

// Полоса действий лежит вне #screen, но кнопки на ней — те же data-атрибуты
$('screen').addEventListener('click', onScreenClick);
$('actions').addEventListener('click', onScreenClick);

$('screen').addEventListener('submit', (e) => {
  if (e.target.id !== 'manual-form') return;
  e.preventDefault();
  saveManual();
});

/** Категория из карточки товара: выбор тот же, что в разборе чека, итог — под кнопкой. */
async function saveItemCategory(itemId, slug) {
  const note = $('pick-note');
  const button = $('item-cat');
  note.classList.remove('error');
  note.textContent = 'Сохранение…';
  button.disabled = true;
  try {
    const data = await post(`/api/items/${itemId}/category`, { category: slug });
    button.innerHTML = categoryButton(slug);
    note.textContent = data.category
      ? `«${data.category.name}» — обновлено ${int.format(data.affected)} ${plural(data.affected, 'позиция', 'позиции', 'позиций')}`
      : `Категория снята, затронуто ${int.format(data.affected)}`;
    meta = await api('/api/meta'); // счётчики и цвета могли измениться
  } catch (err) {
    note.textContent = `Не удалось сохранить: ${err.message}`;
    note.classList.add('error');
  } finally {
    button.disabled = false;
  }
}

$('back').addEventListener('click', () => history.back());
$('fab').addEventListener('click', () => go({ screen: 'add' }));

// Вкладка сбрасывает глубину, но не период: переключение не должно терять выбор дат
document.querySelector('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) go({ screen: tab.dataset.tab, group: '', category: '', item: '' });
});

/**
 * Аккаунт: кто вошёл, выход и удаление. Удаление — насовсем и со всеми данными,
 * поэтому спрашиваем дважды и говорим, что именно пропадёт.
 */
const DEFAULT_BUDGET = 'Мой бюджет';

/** Общий ли бюджет: тогда у чеков показывается автор. */
const shared = () => (meta?.budget?.members ?? 1) > 1;

/** Раздел «Бюджет» в листе аккаунта: состав, приглашение, выход. */
function budgetSection(budget) {
  if (!budget) return '';
  const members = budget.members
    .map(
      (m) => `
      <div class="member">
        <span class="member-name">${esc(m.name)}${m.is_me ? ' <span class="note">(вы)</span>' : ''}</span>
        <span class="note">${m.is_owner ? 'владелец' : `${int.format(m.receipts)} ${plural(m.receipts, 'чек', 'чека', 'чеков')}`}</span>
        ${budget.is_owner && !m.is_me ? `<button class="link" type="button" data-remove-member="${m.id}">Исключить</button>` : ''}
      </div>`,
    )
    .join('');

  return `
    <div class="card budget">
      <div class="card-label">Бюджет</div>
      ${budget.is_owner
        ? inlineEdit('budget', budget.name, { cls: 'budget-name', label: 'Название бюджета', max: 60 })
        : `<div class="budget-name">${esc(budget.name)}</div>`}
      ${members}
      ${budget.is_owner ? '<button class="member member-add" type="button" data-invite>Добавить пользователя</button>' : ''}
      <p class="note budget-hint">${
        budget.members.length > 1
          ? 'Все участники видят и добавляют траты в этот бюджет.'
          : 'Пригласите семью — будете вести один бюджет на всех.'
      }</p>
      ${!budget.is_home ? '<button class="btn" type="button" data-leave>Выйти из общего бюджета</button>' : ''}
    </div>`;
}

/** Ссылка-приглашение: через системное «Поделиться», а если его нет — в буфер обмена. */
async function shareInvite(button) {
  button.disabled = true;
  try {
    const invite = await api('/api/budget/invites', { method: 'POST' });
    const text = 'Присоединяйся к нашему бюджету в Чекере';
    if (navigator.share) {
      await navigator.share({ title: 'Чекер', text, url: invite.url }).catch(() => {});
    } else {
      await navigator.clipboard?.writeText(invite.url);
      toast('Ссылка скопирована — отправьте её тому, кого приглашаете');
    }
    button.insertAdjacentHTML('afterend', `<p class="note invite-url">Ссылка на неделю, одна на человека:<br>${esc(invite.url)}</p>`);
  } catch (err) {
    toast(`Не вышло: ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

/** Настройки: кто вошёл, бюджет, выход и удаление аккаунта. */
async function screenSettings() {
  const [me, budget] = await Promise.all([
    api('/api/session').catch(() => null),
    api('/api/budget').catch(() => null),
  ]);
  return `
    <div class="card profile">
      <div class="card-label">Вход</div>
      ${inlineEdit('name', me?.name ?? '', { cls: 'profile-name', label: 'Имя', placeholder: 'Ваше имя', max: 60 })}
      <button class="row-action note" type="button" data-logout>${
        me?.telegram ? 'Вход через Телеграм' : 'Вход по паролю'
      }. Нажмите для выхода</button>
    </div>
    ${budgetSection(budget)}
    <div class="settings-actions">
      ${me?.role === 'admin' ? '' : '<button class="btn danger" type="button" data-delete-account>Удалить аккаунт и все данные</button>'}
      <p class="note"><a href="/privacy.html">Какие данные хранит Чекер</a></p>
    </div>`;
}

async function onSettingsClick(e) {
    const invite = e.target.closest('[data-invite]');
    if (invite) return shareInvite(invite);

    if (e.target.closest('[data-leave]')) {
      if (!confirm('Выйти из общего бюджета? Вы вернётесь в свой. Ваши траты останутся в общем.')) return;
      try {
        await api('/api/budget/leave', { method: 'POST' });
        location.reload();
      } catch (err) {
        toast(`Не вышло: ${err.message}`);
      }
      return;
    }

    const remove = e.target.closest('[data-remove-member]');
    if (remove) {
      if (!confirm('Исключить из бюджета? Человек вернётся в свой бюджет, его траты останутся здесь.')) return;
      try {
        await api(`/api/budget/members/${remove.dataset.removeMember}`, { method: 'DELETE' });
        meta = await api('/api/meta');
        render();
      } catch (err) {
        toast(`Не вышло: ${err.message}`);
      }
      return;
    }

    if (e.target.closest('[data-logout]')) {
      // Строка — большая цель, задеть её легко: переспрашиваем
      if (!confirm('Выйти на этом устройстве?')) return;
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      token.clear();
      location.reload();
    }

    if (e.target.closest('[data-delete-account]')) {
      if (!confirm('Удалить аккаунт? Пропадут все чеки, ручные траты, категории и правки.')) return;
      if (!confirm('Точно? Восстановить аккаунт будет нельзя.')) return;
      try {
        await api('/api/account', { method: 'DELETE' });
        token.clear();
        location.reload();
      } catch (err) {
        toast(`Не удалилось: ${err.message}`);
      }
    }
}

$('screen').addEventListener('click', (e) => {
  if (state.screen === 'settings') onSettingsClick(e);
});

/**
 * Правка на месте: имя в настройках, название бюджета. В настройках нажимается почти каждая
 * строка, поэтому значков у действий нет: нажатие на текст открывает поле и клавиатуру.
 * Сохраняется, когда человек закончил: «Готово» на клавиатуре или уход из поля.
 */
function inlineEdit(field, value, { cls = '', label = '', placeholder = '', max = 60 } = {}) {
  return `
    <input class="inline-input ${cls}" data-inline="${field}" type="text" maxlength="${max}" enterkeyhint="done"
      readonly value="${esc(value)}" placeholder="${esc(placeholder)}" aria-label="${esc(label)} — нажмите, чтобы изменить" />`;
}

// Куда сохранять каждое поле. Возвращают сохранённое значение — сервер его чистит
const INLINE_SAVE = {
  name: async (name) => {
    const data = await api('/api/session', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    toast('Имя сохранено');
    meta = await api('/api/meta'); // у чеков общего бюджета автор — это имя
    return data.name;
  },
  budget: async (name) => {
    const data = await api('/api/budget', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    toast('Название сохранено');
    return data.name;
  },
};

$('screen').addEventListener('click', (e) => {
  const input = e.target.closest('[data-inline]');
  if (!input?.readOnly) return;
  input.readOnly = false;
  input.focus(); // в обработчике нажатия, иначе iOS не покажет клавиатуру
  input.select();
});

$('screen').addEventListener('keydown', (e) => {
  if (e.target.matches?.('[data-inline]') && e.key === 'Enter') e.target.blur();
});

$('screen').addEventListener('focusout', async (e) => {
  const input = e.target;
  if (!input.matches?.('[data-inline]') || input.readOnly) return;
  input.readOnly = true;
  input.setSelectionRange(0, 0); // снимаем выделение, оставшееся от начала правки
  window.getSelection()?.removeAllRanges();
  const value = input.value.replace(/\s+/g, ' ').trim();
  if (!value || value === input.defaultValue) {
    input.value = input.defaultValue; // пустое не сохраняем — возвращаем прежнее
    return;
  }
  try {
    input.value = input.defaultValue = await INLINE_SAVE[input.dataset.inline](value);
  } catch (err) {
    input.value = input.defaultValue;
    toast(`Не сохранилось: ${err.message}`);
  }
});

// ── запуск ───────────────────────────────────────────────

// ── вход ─────────────────────────────────────────────────
// Главный способ — Telegram, пароль спрятан ниже: он остался для тех, кто завёл
// аккаунт до Telegram.

let stopLinkRefresh = null;
let stopWaiting = null;

function showLogin(note) {
  $('login').hidden = false;
  $('app').hidden = true;
  $('login-note').textContent =
    note ?? (pendingInvite.get() ? 'Войдите, чтобы принять приглашение в общий бюджет' : 'Учёт расходов по чекам');
  $('login-note').classList.toggle('error', Boolean(note));
  $('tg-ic').innerHTML = TG_ICON;
  setWaiting(null);

  stopLinkRefresh?.();
  stopLinkRefresh = keepLinkReady($('tg-login'), {
    client: 'm',
    onError: (err) => {
      // Вход через Telegram не настроен или сервер недоступен — остаётся пароль
      $('tg-login').hidden = err.status === 503;
      if (err.status === 503) $('login-pass-block').open = true;
    },
  });

  // Вернулись из Telegram, а страница перезагрузилась — продолжаем ждать тот же вход
  const pending = pendingLogin();
  if (pending) awaitTelegram(pending);
}

function setWaiting(login) {
  $('tg-wait').hidden = !login;
  $('tg-login').hidden = Boolean(login);
  if (login) {
    $('tg-again').href = login.url;
    $('tg-web').href = login.web ?? login.url;
  }
}

function awaitTelegram(login) {
  setWaiting(login);
  stopWaiting?.();
  stopWaiting = waitLogin(login.nonce, {
    onDone: async (data) => {
      token.set(data.token);
      stopLinkRefresh?.();
      await start();
      if (data.created) toast(`Добро пожаловать, ${data.login}!`);
    },
    // Токен забрала страница подтверждения в соседней вкладке — он уже у нас
    onFail: (message, status) => (status === 'used' && token.get() ? start() : showLogin(message)),
  });
}

$('tg-login').addEventListener('click', (e) => {
  if ($('tg-login').classList.contains('disabled')) return e.preventDefault();
  // Ссылка открывает Telegram сама; здесь только начинаем ждать подтверждения
  awaitTelegram(markWaiting($('tg-login')));
});

$('tg-cancel').addEventListener('click', () => {
  stopWaiting?.();
  forgetLogin();
  showLogin();
});

async function start() {
  stopLinkRefresh?.();
  $('login').hidden = true;
  $('app').hidden = false;
  $('tab-summary-ic').innerHTML = UI.wallet;
  $('tab-income-ic').innerHTML = UI.income;
  $('tab-settings-ic').innerHTML = UI.settings;
  $('tab-stats-ic').innerHTML = UI.stats;
  meta = await api('/api/meta');

  // Пустой месяц на старте — не повод показывать ноль: открываем последний с данными
  const p = new URLSearchParams(location.search);
  if (!p.get('from') && !p.get('month') && meta.stats.date_to) {
    const last = parseDay(meta.stats.date_to.slice(0, 10));
    Object.assign(state, monthPeriod(last.getFullYear(), last.getMonth()));
  }
  go({}, true);
  offerInvite();

  // Бейдж ошибок виден с любого экрана — застрявший скан не должен теряться
  api('/api/scan?state=failed').then((d) => updateBadge(d.counts.failed)).catch(() => {});
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-submit').disabled = true;
  try {
    const res = await fetch('/api/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: $('login-name').value, password: $('login-pass').value, label: 'телефон' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    token.set(data.token);
    $('login-pass').value = '';
    await start();
  } catch (err) {
    showLogin(err.message);
  } finally {
    $('login-submit').disabled = false;
  }
});

// ── приглашение в бюджет ─────────────────────────────────
// Ссылка /m/?invite=<код>. Код запоминается до входа: новый человек сначала входит
// через Telegram, и только потом ему показывают, куда его зовут.

const INVITE_KEY = 'checker.invite';
const pendingInvite = {
  get: () => {
    try {
      return localStorage.getItem(INVITE_KEY);
    } catch {
      return null;
    }
  },
  set: (v) => {
    try {
      if (v) localStorage.setItem(INVITE_KEY, v);
      else localStorage.removeItem(INVITE_KEY);
    } catch {
      /* без хранилища приглашение переживёт только эту страницу */
    }
  },
};

function takeInviteFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get('invite');
  if (!code) return;
  pendingInvite.set(code);
  params.delete('invite');
  const rest = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}`);
}

/** Показать приглашение и дать решить: перенести свои чеки или начать с общего. */
async function offerInvite() {
  const code = pendingInvite.get();
  if (!code) return;

  let info;
  try {
    info = await api(`/api/invites/${encodeURIComponent(code)}`);
  } catch (err) {
    pendingInvite.set(null);
    return toast(`Приглашение не сработало: ${err.message}`);
  }
  if (info.already) {
    pendingInvite.set(null);
    return toast(`Вы уже в бюджете «${info.budget}»`);
  }

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  const who = info.owner ? `${esc(info.owner)} приглашает вас` : 'Вас приглашают';
  // «Мой бюджет» — имя по умолчанию, со стороны приглашённого оно звучит странно
  const where = info.budget === DEFAULT_BUDGET ? 'в общий бюджет' : `в бюджет «${esc(info.budget)}»`;
  sheet.innerHTML = `
    <div class="sheet-box" role="dialog" aria-label="Приглашение в бюджет">
      <div class="sheet-top">
        <div>
          <div class="sheet-sum-total">Общий бюджет</div>
          <div class="note">${who} ${where} · ${int.format(info.members)} ${plural(info.members, 'участник', 'участника', 'участников')}</div>
        </div>
      </div>
      <p class="note sheet-hint">Вы будете видеть и добавлять траты вместе. Выйти можно в любой момент — вы вернётесь в свой бюджет.</p>
      ${info.blocked ? `<p class="note error">${esc(info.blocked)}</p>` : ''}
      <div class="sheet-actions">
        ${info.blocked ? '' : info.own_receipts
          ? `<button class="btn primary" type="button" data-join="move">Перенести мои чеки (${int.format(info.own_receipts)})</button>
             <button class="btn" type="button" data-join="fresh">Начать с общего — мои останутся у меня</button>`
          : '<button class="btn primary" type="button" data-join="fresh">Присоединиться</button>'}
        <button class="btn" type="button" data-decline>Отказаться</button>
      </div>
    </div>`;
  document.body.appendChild(sheet);

  sheet.addEventListener('click', async (e) => {
    if (e.target.closest('[data-decline]')) {
      pendingInvite.set(null);
      return sheet.remove();
    }
    const join = e.target.closest('[data-join]');
    if (!join) return;
    sheet.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const res = await api(`/api/invites/${encodeURIComponent(code)}/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ move: join.dataset.join === 'move' }),
      });
      pendingInvite.set(null);
      sheet.remove();
      meta = await api('/api/meta');
      // Новый бюджет — новые данные: показываем его последний месяц с тратами
      const last = meta.stats.date_to ? parseDay(meta.stats.date_to.slice(0, 10)) : new Date();
      go({ screen: 'summary', ...monthPeriod(last.getFullYear(), last.getMonth()) }, true);
      toast(res.moved ? `Вы в общем бюджете, перенесено чеков: ${res.moved}` : 'Вы в общем бюджете');
    } catch (err) {
      sheet.querySelectorAll('button').forEach((b) => (b.disabled = false));
      toast(`Не вышло: ${err.message}`);
    }
  });
}

takeInviteFromUrl();
readUrl();
if (token.get()) {
  try {
    await api('/api/session');
    await start();
  } catch {
    showLogin();
  }
} else {
  showLogin();
}
