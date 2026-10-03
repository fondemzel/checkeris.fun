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
import { groupIcon, searchIcons } from '/shared/icons.js';
import { shades, edge, readableText, hslToHex, hexToHsl, tint } from '/shared/colors.js';
import { TG_ICON, keepLinkReady, markWaiting, pendingLogin, forgetLogin, waitLogin } from '/shared/tglogin.js';
import { showPlace, mappable } from '/shared/ymap.js';
import { T, f, pl } from '/m/i18n/index.js';

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
  sort: svg('<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>'),
  filter: svg('<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>'),
  layers: svg('<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/>'
    + '<path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>'),
  mail: svg('<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/>'),
  card: svg('<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>'),
  grid: svg('<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
  bank: svg(
    '<path d="M10 18v-7"/><path d="M11.12 2.198a2 2 0 0 1 1.76.006l7.866 3.847c.476.233.31.949-.22.949H3.474c-.53 0-.695-.716-.22-.949z"/>' +
      '<path d="M14 18v-7"/><path d="M18 18v-7"/><path d="M3 22h18"/><path d="M6 18v-7"/>',
  ),
  bag: svg(
    '<path d="M16 10a4 4 0 0 1-8 0"/><path d="M3.103 6.034h17.794"/>' +
      '<path d="M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z"/>',
  ),
  keyboard: svg(
    '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/>' +
      '<path d="M18 8h.01"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/><path d="M7 16h10"/>',
  ),
  arrow: svg('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
  refresh: svg('<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>'),
  plus: svg('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  // Действия на странице банка
  login: svg('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>'),
  history: svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'),
  unlink: svg(
    '<path d="m18.84 12.25 1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
      '<path d="m5.17 11.75-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' +
      '<path d="M8 2v3"/><path d="M2 8h3"/><path d="M16 19v3"/><path d="M19 16h3"/>',
  ),
  trash: svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  shield: svg('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'),
  copy: svg('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  user: svg('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  phone: svg('<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>'),
  lock: svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>'),
  eyeOff: svg(
    '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/>' +
      '<path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/>' +
      '<path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/>' +
      '<path d="m2 2 20 20"/>',
  ),
  piggy: svg(
    '<path d="M11 17h3v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3a3.16 3.16 0 0 0 2-2h1a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1h-1a5 5 0 0 0-2-4V3a4 4 0 0 0-3.2 1.6l-.3.4H11a6 6 0 0 0-6 6v1a5 5 0 0 0 2 4v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1z"/>' +
      '<path d="M16 10h.01"/><path d="M2 8v1a2 2 0 0 0 2 2h1"/>',
  ),
  userPlus: svg(
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>' +
      '<path d="M19 8v6"/><path d="M22 11h-6"/>',
  ),
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

/**
 * Период цифрами — для шапки, где рядом стоит сортировка и словам тесно:
 * месяц — «09.26», несколько месяцев — «01.26–09.26», год — «2026», дни — «01.09.26».
 * Полное название («Сентябрь 2026») видно в подсказке и в календаре.
 */
function periodShort(from, to) {
  const a = parseDay(from);
  const b = parseDay(to);
  const two = (n) => String(n).padStart(2, '0');
  const month = (d) => `${two(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
  const day = (d) => `${two(d.getDate())}.${month(d)}`;
  const months = wholeMonths(from, to);

  if (months === 12 && a.getMonth() === 0) return String(a.getFullYear());
  if (months === 1) return month(a);
  if (months) return `${month(a)}–${month(b)}`;
  if (from === to) return day(a);
  return `${day(a)}–${day(b)}`;
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
  bank: '', // банк, чья страница открыта
  tk: '', // настройка категорий: чей справочник — '' расходов, 'in' доходов
  tg: '', // настройка категорий: открытая группа
  tc: '', // настройка категорий: открытая категория
  op: '', // операция банка, чья карточка открыта
  src: '', // фильтр ленты по источнику: '' | receipt | market | bank | manual
  inf: '', // фильтр доходов: '' | '-' (без категории) | код группы доходов
  added: '', // чек, только что добавленный сканом или руками
  sort: 'date', // списки: date | name | sum
  dir: 'desc',
};

const SCREEN_NAMES = ['summary', 'group', 'category', 'item', 'receipts', 'add', 'manual', 'added', 'income',
  'settings', 'set_profile', 'set_budget', 'set_banks', 'set_cats', 'set_group', 'set_cat', 'privacy', 'stats', 'bank', 'bank_card', 'bank_add', 'bank_safety', 'bank_wizard', 'op'];
const FILTERS = ['all', 'failed', 'pending', 'manual'];

// Сортировки списков — одни и те же везде, где есть что сортировать: товары, чеки,
// операции банка. Направление, с которого начинается каждая: свежие и дорогие сверху,
// названия по алфавиту. Каждый экран сам переводит ключ в параметры своего запроса
const SORTS = {
  date: ['По дате', 'desc', 'calendar'],
  category: ['По категориям', 'asc', 'grid'],
  name: ['По названию', 'asc', 'letters'],
  sum: ['По сумме', 'desc', 'ruble'],
};

/**
  * Шапка списка: сумма и подпись слева, справа две кнопки — сортировка и фильтр; ниже период.
  * Кнопка открывает список прямо под собой: строка — значок и название. Так в шапке две
  * кнопки вместо восьми, а что выбрано, видно в подписи под суммой.
  */
const listHead = ({ sum, note, sorts = ['date', 'name', 'sum'], filters = '' }) => `
  <div class="total compact">
    <div class="head-top">
      <div class="head-sum">
        <span class="total-sum">${sum}</span>
        <span class="total-note">${note}</span>
      </div>
      <div class="head-btns">
        ${sorts ? sortDrop(sorts === true ? undefined : sorts) : ''}
        ${filters}
      </div>
    </div>
    <div class="head-line">
      ${periodNav(true)}
    </div>
  </div>`;

/** Кнопка с выпадающим списком. on — выбрано не то, что по умолчанию: кнопка подсвечена. */
const drop = (icon, label, rows, on = false) => `
  <div class="drop">
    <button class="drop-btn${on ? ' on' : ''}" type="button" data-drop aria-label="${label}" title="${label}">${icon}</button>
    <div class="drop-menu" role="menu" hidden>${rows}</div>
  </div>`;

/** Строка списка: значок, название и отметка справа у выбранной. */
const dropRow = (attrs, icon, text, on, mark = UI.ok) => `
  <button class="drop-row${on ? ' on' : ''}" type="button" role="menuitem" ${attrs}>
    <span class="drop-ic">${icon}</span><span class="drop-text">${esc(text)}</span>${on ? `<span class="drop-mark">${mark}</span>` : ''}
  </button>`;

/**
 * Фильтр расходов по источнику: только из банка, только чеки или только ручные записи.
 * Значки те же, что у сумм в ленте, — их уже узнают.
 */
const SOURCE_FILTERS = [
  ['receipt', 'Только чеки'],
  ['market', 'Только маркетплейсы'],
  ['bank', 'Только банк'],
  ['manual', 'Только вручную'],
];

const sourceChips = () => drop(UI.filter, 'Фильтр',
  dropRow('data-src=""', UI.layers, 'Все источники', !state.src)
  + SOURCE_FILTERS.map(([key, label]) => dropRow(`data-src="${key}"`, SOURCES[key].icon, label, state.src === key)).join(''),
  Boolean(state.src));

/** Сортировка. Выбранная строка показывает направление; повторное нажатие его разворачивает. */
const sortDrop = (keys = ['date', 'name', 'sum']) => drop(UI.sort, 'Сортировка', keys
  .map((key) => {
    const [label, , icon] = SORTS[key];
    // Стрелка — значком, а не символом: символ ↓ телефон может нарисовать цветным эмодзи
    const arrow = `<span class="sort-dir${state.dir === 'asc' ? ' asc' : ''}">${UI.arrow}</span>`;
    return dropRow(`data-sort="${key}"`, UI[icon], label, state.sort === key, arrow);
  })
  .join(''));

// Список открывается под своей кнопкой; нажатие мимо или на другую кнопку закрывает его.
// Выбор строки перерисовывает шапку — список закрывается сам
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-drop]');
  const own = btn?.nextElementSibling;
  for (const menu of document.querySelectorAll('.drop-menu')) if (menu !== own) menu.hidden = true;
  if (own) own.hidden = !own.hidden;
});

// Корневые экраны: у них нет «назад». «Банк» — такой же вид «Расхода», как чеки,
// в него приходят переключателем, а не вглубь
const TOP = ['summary', 'receipts', 'bank', 'income', 'settings', 'stats'];

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
  // Уходим вглубь — запоминаем, где был список: «назад» вернёт ровно туда
  if (!replace) history.replaceState({ ...history.state, scroll: window.scrollY }, '', location.href);
  Object.assign(state, patch);
  const params = new URLSearchParams({ screen: state.screen, from: state.from, to: state.to });
  if (state.group) params.set('group', state.group);
  if (state.category) params.set('category', state.category);
  if (state.item) params.set('item', state.item);
  if (state.bank) params.set('bank', state.bank);
  if (state.screen === 'set_group' && state.tg) params.set('tg', state.tg);
  if (state.screen === 'set_cat' && state.tc) params.set('tc', state.tc);
  if (['set_cats', 'set_group', 'set_cat'].includes(state.screen) && state.tk) params.set('tk', state.tk);
  if (state.op) params.set('op', state.op);
  if (state.screen === 'summary' && state.src) params.set('src', state.src);
  if (state.screen === 'income' && state.inf) params.set('inf', state.inf);
  if (state.added) params.set('added', state.added);
  if (state.screen === 'receipts' && state.filter !== 'all') params.set('filter', state.filter);
  if (['summary', 'category', 'receipts', 'bank'].includes(state.screen) && (state.sort !== 'date' || state.dir !== 'desc')) {
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
  state.bank = p.get('bank') ?? '';
  state.tk = p.get('tk') === 'in' ? 'in' : '';
  state.tg = p.get('tg') ?? '';
  state.tc = p.get('tc') ?? '';
  state.op = p.get('op') ?? '';
  state.src = ['receipt', 'market', 'bank', 'manual'].includes(p.get('src')) ? p.get('src') : '';
  state.inf = p.get('inf') ?? '';
  state.added = p.get('added') ?? '';
  state.filter = FILTERS.includes(p.get('filter')) ? p.get('filter') : 'all';
  state.sort = Object.hasOwn(SORTS, p.get('sort') ?? '') ? p.get('sort') : 'date';
  state.dir = p.get('dir') === 'asc' ? 'asc' : 'desc';
}

/**
 * Попап живёт одной записью в истории: «назад» закрывает его и остаётся на том же экране.
 * Повторно запись не добавляем — иначе после возврата из карточки товара их станет две.
 */
function openPopup(el) {
  document.body.appendChild(el);
  if (!history.state?.popup) history.pushState({ ...state, popup: true }, '', location.href);
}

/**
 * Закрыть попап. Его запись из истории снимаем, только если это последний открытый попап:
 * выбор категории поверх чека закрывается сам по себе, а чек должен остаться.
 */
function closePopup(el) {
  el.remove();
  if (document.querySelector('.sheet, .picker')) return; // под ним ещё один — историю не трогаем
  if (history.state?.popup) {
    closingPopup = true; // попап уже убран — обработчик «назад» узнает о нём по этой пометке
    history.back(); // экран перерисует обработчик «назад»
  } else if (!keepsForm()) render();
}
let closingPopup = false;

/**
 * На экране форма, и он уже показан: перерисовка стёрла бы введённое. Попап (выбор
 * категории, календарь) закрылся — поля остаются как есть, своё значение попап вписал сам.
 */
const keepsForm = () => Boolean(SCREENS[state.screen]?.form) && shownScreen === state.screen;

/**
 * Попап уступает место переходу: запись истории не снимаем — её заменит сам переход
 * (go с replace). Иначе «назад» успевает вернуть прежнее состояние и отменяет выбор.
 */
const dropPopup = (el) => el.remove();

// Прокрутку возвращаем сами: браузер делает это раньше, чем список успевает отрисоваться
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

window.addEventListener('popstate', (e) => {
  // popup, sheet и scroll — пометки самой записи истории, в состоянии экрана им делать нечего
  const { popup, sheet, scroll, ...screenState } = e.state ?? {};
  if (e.state) Object.assign(state, screenState);
  else readUrl();
  // «Назад» закрывает открытый попап — и лист, и выбор категории, и календарь
  const hadPopup = closingPopup || Boolean(document.querySelector('.sheet, .picker'));
  closingPopup = false;
  for (const el of document.querySelectorAll('.sheet, .picker')) el.remove();
  // Закрыли попап над формой — форму не трогаем: иначе сумма и название сотрутся
  if (hadPopup && keepsForm()) return;
  // Вернулись к списку — туда же, где его оставили. Закрытие попапа экран не двигает
  const back = render();
  if (scroll && !hadPopup) back.then(() => window.scrollTo(0, scroll));
  // Вернулись из карточки товара, открытой из попапа чека, — показываем чек снова
  if (sheet) {
    history.replaceState({ ...state, popup: true }, '', location.href);
    openReceiptSheet(sheet);
  }
});

// ── общие куски экранов ──────────────────────────────────

const loading = () => '<div class="empty">Загрузка…</div>';
const failed = (err) => `<div class="empty error">${esc(err.message)}</div>`;

/** Строка периода: стрелки листают, нажатие на даты открывает календарь. */
const periodNav = (compact = false) => `
  <div class="month${compact ? ' compact' : ''}">
    <button class="month-arrow" type="button" data-shift="-1" aria-label="Раньше">‹</button>
    <button class="month-name" type="button" data-period title="${esc(periodTitle(state.from, state.to))}">${UI.calendar}<span>${esc(
      compact ? periodShort(state.from, state.to) : periodTitle(state.from, state.to),
    )}</span></button>
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
    ${bankLinked ? `<button class="segment${state.screen === 'bank' ? ' on' : ''}" type="button" data-segment="bank">Банк</button>` : ''}
  </div>`;

// Есть ли в бюджете операции банка (подключал кто угодно из участников): без них третья
// вкладка «Расхода» и вкладка «Доход» не нужны
let bankLinked = false;

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
  // Все траты периода: товары из чеков и ручные записи — по названиям, траты из банка —
  // по операциям. Покупки, у которых нашёлся чек, приходят один раз — чеком
  const params = new URLSearchParams({
    from: state.from, to: state.to, collapse: collapseMode(), per: '20000',
    sort: ['date', 'name', 'sum'].includes(state.sort) ? state.sort : 'date', dir: state.dir,
  });
  const opsQuery = new URLSearchParams({
    from: state.from, to: state.to, direction: 'debit', kind: 'expense', per: '20000',
  });
  const [data, ops, failed] = await Promise.all([
    api(`/api/items?${params}`),
    api(`/api/bank/ops?${opsQuery}`).catch(() => null),
    api('/api/scan?state=failed').catch(() => null),
  ]);
  const bankRows = ops?.rows ?? [];
  if (failed) updateBadge(failed.counts.failed);

  if (!data.rows.length && !bankRows.length) {
    // Совсем новый аккаунт — не «трат нет», а с чего начать. Сводку в meta освежаем:
    // она берётся при входе и не знает о первом добавленном чеке
    if (!meta.stats.receipts) meta = await api('/api/meta');
    if (!meta.stats.receipts && !bankLinked) return welcome();
  }

  // Фильтр по источнику: итог и число покупок считаем по тому, что осталось
  const shownItems = state.src === 'bank' ? [] : data.rows.filter((r) => !state.src || itemSource(r) === state.src);
  const shownOps = !state.src || state.src === 'bank' ? bankRows : [];
  const total = shownItems.reduce((s, r) => s + r.sum, 0) + shownOps.reduce((s, op) => s + op.amount, 0);
  const count = shownItems.reduce((s, r) => s + (r.positions ?? 1), 0) + shownOps.length;

  // Подпись: сколько покупок, как отсортировано и что отобрано
  // Каждая часть помечена: после нажатия на значок изменившаяся часть подсвечивается
  const part = (name, text) => `<span class="note-part" data-note-part="${name}">${esc(text)}</span>`;
  const note = [
    part('count', `${int.format(count)} ${plural(count, 'покупка', 'покупки', 'покупок')}`),
    SORTS[state.sort] ? part('sort', SORTS[state.sort][0].toLowerCase()) : '',
    state.src ? part('src', SOURCE_FILTERS.find(([key]) => key === state.src)[1].toLowerCase()) : '',
  ].filter(Boolean).join(' · ');

  const head = `
    <div class="stuck-head">
      ${listHead({
        sum: money(total),
        note,
        sorts: ['date', 'category', 'name', 'sum'],
        filters: sourceChips(),
      })}
    </div>`;

  // Сканы с ошибкой не должны теряться: переключателя с «Чеками» больше нет — ведём ссылкой
  const failedCount = failed?.counts.failed ?? 0;
  const failedLink = failedCount
    ? `<p class="note list-hint"><button class="link" type="button" data-to-failed>Сканы с ошибкой: ${int.format(failedCount)}</button></p>`
    : '';

  return `${head}${failedLink}${await spendingFeed(shownItems, shownOps)}`;
}

async function screenGroup() {
  const data = await api(
    `/api/summary?by=category&group=${encodeURIComponent(state.group)}&from=${state.from}&to=${state.to}`,
  );
  const g = state.group === NONE ? { name: 'Без категории' } : findGroup(state.group);
  const max = Math.max(1, ...data.rows.map((r) => r.sum));

  // Шапка как в «Расходе»: итог и период закреплены, период меняется прямо здесь
  const head = `
    <div class="stuck-head">
      ${listHead({ sum: money(data.totals.sum), note: esc(g?.name ?? ''), sorts: false })}
    </div>`;

  if (!data.rows.length) return `${head}<div class="empty">В этой группе трат нет</div>`;

  const rows = data.rows
    .map((r) =>
      row({
        href: `data-category="${esc(r.key ?? NONE)}"`,
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

/**
 * Лента трат — одна на «Расходе» и внутри категории. Неважно, чем трата попала в Чекер:
 * товар из чека, ручная запись или операция банка — это просто покупка. Откуда она,
 * говорит неприметный значок у суммы; слева — значок группы, под названием — категория.
 *
 * При сортировке по дате лента делится на дни, по категориям — на категории; у каждого
 * заголовка — подытог.
 */
/**
 * Как склеивать одинаковые товары: в ленте по дням — внутри дня (иначе покупки за месяц
 * встают под последний день одной строкой, и итог дня врёт), в остальных — за весь период.
 */
const collapseMode = () => (state.sort === 'date' ? 'day' : '1');

async function spendingFeed(itemRows, bankRows) {
  const spendings = [
    ...itemRows.map((r) => ({
      name: r.name,
      at: r.purchased_at,
      sum: r.sum,
      source: itemSource(r),
      category: r.category_slug,
      positions: r.positions,
      outside: r.sum === 0 && r.excluded_count, // возврат или зачёт аванса: деньги уже считали
      action: `data-item="${r.first_id}"`,
      // Несколько покупок одного товара — можно развернуть. В ленте по дням группа живёт
      // внутри дня: у пива за сегодня и пива за вчера разные ключи и разное раскрытие
      group: r.positions > 1 ? (r.day ? `${r.day}|${r.name_norm}` : r.name_norm) : null,
      norm: r.name_norm,
      day: r.day ?? null,
      noted: Boolean(r.has_note),
    })),
    ...bankRows.map((op) => ({
      name: op.merchant ?? op.description ?? 'Без названия',
      at: op.at,
      sum: op.amount,
      source: 'bank',
      category: op.category_slug,
      positions: 1,
      outside: false,
      action: `data-op="${op.id}"`,
      group: null,
      noted: Boolean(op.has_note),
    })),
  ];
  if (!spendings.length) return '<div class="empty">За этот период трат нет</div>';

  // Порядок категорий — как в справочнике: так группы идут всегда в одном порядке
  const catOrder = new Map();
  (meta?.categories ?? []).forEach((g, gi) =>
    g.subcategories.forEach((c, ci) => catOrder.set(c.slug, gi * 1000 + ci)),
  );
  const back = state.dir === 'asc' ? -1 : 1;
  const byDate = (a, b) => (Date.parse(b.at) - Date.parse(a.at)) * back;
  spendings.sort((a, b) => {
    if (state.sort === 'name') return a.name.localeCompare(b.name, 'ru') * -back;
    if (state.sort === 'sum') return (b.sum - a.sum) * back;
    if (state.sort === 'category') {
      const diff = (catOrder.get(a.category) ?? 1e9) - (catOrder.get(b.category) ?? 1e9);
      return (diff ? diff * -back : Date.parse(b.at) - Date.parse(a.at));
    }
    return byDate(a, b);
  });

  // Развёрнутые группы подгружаем здесь же, до отрисовки: тогда «назад» из карточки
  // возвращает список уже раскрытым, и прокрутка попадает на то же место
  const open = spendings.filter((r) => r.group && expanded.has(expandKey(r.group)));
  const parts = new Map(
    await Promise.all(
      open.map(async (r) => {
        const q = new URLSearchParams({
          // Группа дня раскрывается покупками только этого дня
          from: r.day ?? state.from, to: r.day ?? state.to, name_norm: r.norm, sort: 'date', dir: 'desc', per: '100',
          ...(state.category ? { category: state.category } : state.group ? { group: state.group } : {}),
        });
        const res = await api(`/api/items?${q}`).catch(() => ({ rows: [], totals: { count: 0 } }));
        return [r.group, res];
      }),
    ),
  );

  // Заголовки разделов: день или категория, справа — подытог
  const sectionOf = (r) =>
    state.sort === 'date' ? r.at.slice(0, 10) : state.sort === 'category' ? r.category ?? NONE : null;
  const sums = new Map();
  const counts = new Map(); // сколько покупок в разделе — для заголовка категории
  for (const r of spendings) {
    const key = sectionOf(r);
    if (key == null) continue;
    counts.set(key, (counts.get(key) ?? 0) + (r.positions ?? 1));
    if (!r.outside) sums.set(key, (sums.get(key) ?? 0) + r.sum);
  }
  // Разделы свёрнуты: по умолчанию открыт только верхний. Если строк много, открытым
  // держим один раздел — иначе лента разрастается до тысяч строк
  const order = [...new Set(spendings.map(sectionOf))].filter((k) => k != null);
  const opened = openSections(order[0]);
  const single = spendings.length > 500;
  if (single && opened.size > 1) {
    const keep = [...opened].pop();
    opened.clear();
    opened.add(keep);
  }
  feedSections = { order, single };

  const sectionHead = (key) => {
    const isOpen = opened.has(key);
    const title = state.sort === 'date'
      ? esc(dayTitle(key))
      : (() => {
          const found = key === NONE ? null : findCategory(key);
          const color = found ? categoryColor(found.group.slug, key) ?? found.group.color : '#c9ced6';
          return `<span class="op-cat" style="background:${color}"></span>${esc(found?.category.name ?? 'Без категории')} (${int.format(counts.get(key) ?? 0)})`;
        })();
    return `
      <button class="day section${isOpen ? ' open' : ''}" type="button" data-section="${esc(key)}">
        <span><span class="section-arrow">${UI.chevron}</span>${title}</span>
        <b>${money(sums.get(key) ?? 0)}</b>
      </button>`;
  };

  let section;
  const rows = spendings
    .map((r) => {
      const key = sectionOf(r);
      const head = key != null && key !== section ? sectionHead(key) : '';
      section = key;
      if (key != null && !opened.has(key)) return head; // раздел свёрнут — строк не рисуем

      const found = r.category ? findCategory(r.category) : null;
      const color = found?.group.color ?? '#eef1f5';
      const dot = found ? categoryColor(found.group.slug, r.category) ?? color : '#d7dbe2';
      const isOpen = r.group && parts.has(r.group);
      // Стрелка — внутри подписи, в размер текста: как бы ни рисовался значок, строка не поплывёт
      const toggle = r.group
        ? ` <span class="expand${isOpen ? ' open' : ''}" data-expand="${esc(r.group)}" role="button" aria-label="${isOpen ? 'Свернуть' : 'Показать покупки'}">${UI.chevron}</span>`
        : '';
      const note = [
        `<span class="op-cat" style="background:${dot}"></span>${esc(found?.category.name ?? 'Без категории')}`,
        // При сортировке по дате день уже в заголовке раздела, в остальных — нужен в строке
        state.sort === 'date' ? '' : dateRu(r.at.slice(0, 10)),
        r.positions > 1 ? `${int.format(r.positions)} ${plural(r.positions, 'покупка', 'покупки', 'покупок')}` : '',
      ].filter(Boolean).join(' · ');

      const row = `${head}
      <button class="row item" type="button" ${r.action}${r.group ? ` data-long="${esc(r.group)}"` : ''}>
        <span class="ic" style="background:${color};color:${readableText(color)}">${groupIcon(found?.group.icon ?? 'none')}</span>
        <span class="row-main">
          <span class="row-title">${esc(r.name)}</span>
          <span class="row-note">${note}${toggle}</span>
        </span>
        ${r.noted ? '<span class="noted" title="Есть комментарий"></span>' : ''}
        <span class="row-sum${r.outside ? ' muted' : ''}">${r.outside ? 'вне суммы' : money(r.sum)}</span>
        <span class="src" title="${SOURCES[r.source].title}">${SOURCES[r.source].icon}</span>
      </button>`;
      if (!isOpen) return row;

      // Покупки группы — со сдвигом вправо: видно, что это части строки выше
      const part = parts.get(r.group);
      const subs = part.rows
        .map((it) => `
          <button class="row item sub-row" type="button" data-item="${it.id}">
            <span class="row-main">
              <span class="row-title">${dateRu(it.purchased_date ?? it.purchased_at.slice(0, 10))} · ${esc(timeRu(it.purchased_at))}</span>
              <span class="row-note">${esc(it.seller ?? '')}${it.quantity !== 1 ? ` · ${it.quantity}${it.unit ? ` ${esc(it.unit)}` : ''}` : ''}</span>
            </span>
            ${it.has_note ? '<span class="noted" title="Есть комментарий"></span>' : ''}
            <span class="row-sum">${money(it.sum)}</span>
          </button>`)
        .join('');
      // Показываем последние сто: дальше листать группу неудобно, а сумма в строке и так полная
      const more = part.totals.count > part.rows.length
        ? `<div class="sub-more note">Показаны последние ${int.format(part.rows.length)} из ${int.format(part.totals.count)}</div>`
        : '';
      return row + subs + more;
    })
    .join('');

  return `<div class="list">${rows}</div>`;
}

async function screenCategory() {
  const params = new URLSearchParams({
    from: state.from, to: state.to, collapse: collapseMode(), sort: state.sort, dir: state.dir, per: '100',
  });
  if (state.category) params.set('category', state.category);
  else params.set('group', state.group);

  // Расход — это движение денег, а чек лишь один из его источников: рядом с товарами
  // показываем и траты без чека из той же категории
  const opsQuery = new URLSearchParams({
    from: state.from, to: state.to, direction: 'debit', kind: 'expense', per: '100',
    sort: state.sort, dir: state.dir,
    ...(state.category ? { category: state.category } : { group: state.group }),
  });
  const [data, ops] = await Promise.all([
    api(`/api/items?${params}`),
    api(`/api/bank/ops?${opsQuery}`).catch(() => null),
  ]);
  const bankRows = ops?.rows ?? [];
  const name = state.category === NONE || state.group === NONE
    ? 'Без категории'
    : state.category
      ? findGroup(state.group)?.subcategories.find((s) => s.slug === state.category)?.name
      : findGroup(state.group)?.name;

  // Шапка закреплена: при листании длинного списка итог и порядок остаются на виду
  const bankSum = bankRows.reduce((sum, op) => sum + op.amount, 0);
  const head = `
    <div class="stuck-head">
      ${listHead({
        sum: money(data.totals.sum + bankSum),
        note: esc(name ?? ''),
        sorts: data.rows.length > 0,
      })}
    </div>`;

  if (!data.rows.length && !bankRows.length) return `${head}<div class="empty">Ничего не найдено</div>`;

  return `${head}${await spendingFeed(data.rows, bankRows)}`;
}

/**
 * Операции из банка. Пока отдельный список, а не часть расходов: покупка картой — это и чек
 * из ФНС, и операция в банке, и считать её дважды нельзя. Сопоставление чеков с операциями —
 * следующий шаг; до него суммы расходов считаются по чекам, как раньше.
 */
async function screenBank() {
  const q = new URLSearchParams({
    from: state.from, to: state.to, direction: 'debit', kind: 'covered,expense',
    per: '300', sort: state.sort, dir: state.dir,
  });
  const [data, state_] = await Promise.all([
    api(`/api/bank/ops?${q}`),
    api(`/api/bank?from=${state.from}&to=${state.to}`).catch(() => null),
  ]);
  const byKind = Object.fromEntries((state_?.totals ?? []).map((t) => [t.kind, t]));

  const head = `
    <div class="stuck-head">
      ${listHead({
        sum: money(data.totals.sum),
        note: `${int.format(byKind.covered?.count ?? 0)} с чеком · ${int.format(byKind.expense?.count ?? 0)} без чека${
          byKind.transfer ? ` · ${int.format(byKind.transfer.count)} переводов между своими` : ''}`,
        sorts: data.rows.length > 0,
      })}
    </div>`;

  if (!data.rows.length) {
    return `${head}<div class="empty">Операций за период нет</div>`;
  }

  // Покупка с чеком уже посчитана чеком: сумма в шапке — это оплата картой, а не «ещё расходы»
  const hint = `<p class="note list-hint">Оплата картами Т-Банка. Покупки с чеком в расходах считаются
    по чеку — дважды они не попадают. Переводы между своими счетами в список не входят.</p>`;

  const byDate = state.sort === 'date';
  let day = '';
  const rows = data.rows
    .map((op) => {
      const opDay = op.at.slice(0, 10);
      const header = !byDate || opDay === day
        ? ''
        : dayHead(opDay, daySum(data.rows, opDay, (x) => x.at, (x) => x.amount));
      day = opDay;
      const note = [
        timeRu(op.at),
        op.bank_category,
        op.card ? `карта ·${op.card}` : '',
        op.status === 'WAIT' ? 'в обработке' : '',
      ].filter(Boolean).join(' · ');
      // Операция с чеком ведёт в чек: там видно, что куплено. Трата без чека — в выбор
      // категории: иначе она нигде не учтётся
      const found = op.category_slug ? findCategory(op.category_slug) : null;
      const cat = op.receipt_id
        ? ''
        : found
          ? `<span class="op-cat" style="background:${found.group.color ?? '#eef1f5'}"></span>${esc(found.category.name)}`
          : '<span class="op-cat none"></span><span class="pick-hint">выбрать категорию</span>';
      const action = op.receipt_id ? `data-receipt="${op.receipt_id}"` : `data-op="${op.id}"`;
      return `${header}
        <button class="row bank-op" type="button" ${action}>
          <span class="row-main">
            <span class="row-title">${esc(op.merchant ?? op.description ?? 'Без названия')}</span>
            <span class="row-note">${cat}${cat ? ' · ' : ''}${esc(note)}</span>
          </span>
          ${op.receipt_id ? `<span class="op-mark" title="Есть чек">${UI.receipt}</span>` : ''}
          <span class="row-sum">${money(op.amount)}</span>
        </button>`;
    })
    .join('');

  return `${head}${hint}<div class="list">${rows}</div>`;
}

/**
 * Доход — поступления из банка. Переводы между своими счетами сюда не попадают: деньги
 * не появились, а переложены. Без подключённого банка показывать нечего.
 */
async function screenIncome() {
  if (!bankLinked) {
    return soon(UI.income, 'Доходы', inApp()
      ? 'Подключите банк в настройках — поступления появятся здесь сами.'
      : 'Поступления берутся из банка. Подключить его можно в приложении для Android.');
  }

  const q = new URLSearchParams({
    from: state.from, to: state.to, direction: 'credit', kind: 'income',
    per: '5000', sort: state.sort, dir: state.dir,
  });
  const [data, bank] = await Promise.all([
    api(`/api/bank/ops?${q}`),
    api(`/api/bank?from=${state.from}&to=${state.to}`).catch(() => null),
  ]);
  const transfers = (bank?.totals ?? []).find((t) => t.kind === 'transfer');

  // Фильтр: группа доходов или «без категории». Итог и число считаем по тому, что осталось
  const groups = meta?.income ?? [];
  const picked = groups.find((g) => g.slug === state.inf);
  const filter = state.inf === '-' ? '-' : picked ? picked.slug : '';
  const all = data.rows;
  data.rows = !filter ? all : all.filter((op) => {
    const found = incomeCat(op.category_slug);
    return filter === '-' ? !found : found?.group.slug === filter;
  });
  const sum = filter ? data.rows.reduce((n, op) => n + op.amount, 0) : data.totals.sum;
  const count = filter ? data.rows.length : data.totals.count;
  const filters = drop(UI.filter, 'Фильтр',
    dropRow('data-inf=""', UI.layers, T.income.all, !filter)
    + groups.map((g) => dropRow(`data-inf="${esc(g.slug)}"`, groupIcon(g.icon ?? 'none'), g.name, filter === g.slug)).join('')
    + dropRow('data-inf="-"', groupIcon('none'), T.income.noCategory, filter === '-'),
    Boolean(filter));

  const head = `
    <div class="stuck-head">
      ${listHead({
        sum: money(sum),
        note: [
          `${int.format(count)} ${pl(count, T.income.many)}`,
          SORTS[state.sort] ? SORTS[state.sort][0].toLowerCase() : '',
          filter ? (picked?.name ?? T.income.noCategory).toLowerCase() : '',
          !filter && transfers ? `${int.format(transfers.count)} переводов между своими` : '',
        ].filter(Boolean).map(esc).join(' · '),
        sorts: all.length > 0,
        filters: all.length > 0 ? filters : '',
      })}
    </div>`;

  if (!data.rows.length) return `${head}<div class="empty">${filter ? T.income.emptyFilter : 'Поступлений за период нет'}</div>`;

  const byDate = state.sort === 'date';
  let day = '';
  const rows = data.rows
    .map((op) => {
      const opDay = op.at.slice(0, 10);
      const header = !byDate || opDay === day
        ? ''
        : dayHead(opDay, daySum(data.rows, opDay, (x) => x.at, (x) => x.amount));
      day = opDay;
      const cat = incomeCat(op.category_slug);
      const note = [
        `<span class="op-cat" style="background:${cat?.color ?? '#d7dbe2'}"></span>${esc(cat?.name ?? T.income.noCategory)}`,
        esc(timeRu(op.at)),
        esc(op.account_name ?? ''),
      ].filter(Boolean).join(' · ');
      return `${header}
        <button class="row item bank-op" type="button" data-op="${op.id}">
          <span class="row-main">
            <span class="row-title">${esc(op.description ?? op.merchant ?? T.income.one)}</span>
            <span class="row-note">${note}</span>
          </span>
          <span class="row-sum income">+${money(op.amount)}</span>
        </button>`;
    })
    .join('');

  return `${head}<div class="list">${rows}</div>`;
}

/** Откуда трата попала в Чекер: значок в строке отвечает на этот вопрос без слов. */
const SOURCES = {
  receipt: { title: 'Из чека', icon: UI.receipt },
  market: { title: 'С маркетплейса', icon: UI.bag },
  manual: { title: 'Вручную', icon: UI.keyboard }, // карандаш путали с кнопкой «редактировать»
  bank: { title: 'Из банка', icon: UI.bank },
};

// Какие разделы ленты (дни, категории) открыты. Ключ — всё, что меняет состав ленты:
// в другом периоде или сортировке снова открыт только верхний раздел
const sectionState = new Map();
let feedSections = { order: [], single: false };
const sectionsKey = () => `${state.sort}|${state.group}|${state.category}|${state.from}|${state.to}`;
function openSections(first) {
  const key = sectionsKey();
  if (!sectionState.has(key)) sectionState.set(key, new Set(first != null ? [first] : []));
  return sectionState.get(key);
}

// Какие группы одинаковых товаров развёрнуты. Ключ включает категорию и период: в другом
// списке та же группа начинается свёрнутой
const expanded = new Set();
const expandKey = (norm) => `${state.group}|${state.category}|${state.from}|${state.to}|${norm}`;

let itemShown = null; // позиция на экране — карте нужны её координаты после отрисовки

async function screenItem() {
  const it = await api(`/api/items/${state.item}`);
  return itemCard({ ...it, source: itemSource({ manual: it.receipt_drive === 'manual', market: it.market }) });
}

/**
 * Трата из банка — тот же товар, только без чека. Приводим её к полям позиции и рисуем
 * той же карточкой: человеку важно, что трата учтена, а не каким путём она пришла.
 */
async function screenOp() {
  const op = await api(`/api/bank/ops/${state.op}`);
  const income = op.direction === 'credit';
  $('title').textContent = income ? T.income.one : 'Товар'; // вид операции известен только теперь
  for (const tab of document.querySelectorAll('[data-tab]')) tab.classList.toggle('on', tab.dataset.tab === (income ? 'income' : 'summary'));
  return itemCard({
    id: op.id,
    source: 'bank',
    income,
    sum: op.amount,
    // У поступления главное — описание («Проценты на остаток», имя отправителя), а «продавец»
    // — лишь канал, которым оно пришло («Бонусы», «Входящий перевод»)
    name: income ? op.description || op.sender || op.merchant || T.income.one : op.merchant ?? op.description ?? 'Без названия',
    purchased_at: op.at,
    quantity: 1,
    seller: op.merchant && op.description && op.description !== op.merchant ? (income ? op.merchant : op.description) : null,
    category_slug: op.category_slug,
    same_name_count: op.same_count,
    note: op.note,
    card: op.card,
    account_name: op.account_name,
    account: op.account,
    bank: op.bank,
  });
}

/** Чем трата попала в Чекер: чек, ручная запись или конкретный банк. */
/** Источник позиции чека: вбита руками, чек маркетплейса (по ИНН площадки) или обычный чек. */
const itemSource = (r) => (r.manual ? 'manual' : r.market ? 'market' : 'receipt');

const sourceName = (it) => (it.source === 'bank' ? bankById(it.bank)?.name ?? T.sources.bank : T.sources[it.source]);

/**
 * С какого счёта прошла операция: название и цифры — «Black •••• 9315», как в списке
 * счетов на странице банка. Названия нет — остаются одни цифры. Цифры берём у карты,
 * а если её нет (накопительный счёт, копилка) — у номера счёта.
 */
function accountName(it) {
  const digits = tail({ card: it.card, id: it.account }).trim();
  return [it.account_name, digits].filter(Boolean).join(' ');
}

/** Карточка траты — одна для всех источников. Отличается только строка «Источник». */
function itemCard(it) {
  itemShown = it;
  const bank = it.source === 'bank';
  const onMap = !bank && mappable(it) && meta?.maps?.key;

  const kv = (rows) =>
    rows
      .filter(([, v]) => v)
      .map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`)
      .join('');

  return `
    <div class="card">
      <div class="card-sum${it.income ? ' income' : ''}">${it.income ? '+' : ''}${money(it.sum, true)}</div>
      <div class="card-name">${esc(it.name)}</div>
      ${kv([
        ['Дата', `${dateRu(it.purchased_at)} ${esc(timeRu(it.purchased_at))}`],
        ['Количество', it.quantity !== 1 ? `${it.quantity}${it.unit ? ` ${esc(it.unit)}` : ''}` : ''],
        // У ручной записи продавца нет — «Ручная запись» уже сказано строкой «Источник»
        [it.income ? T.income.channel : 'Продавец', it.source === 'manual' ? '' : esc(it.seller ?? '')],
        ['Точка', esc(it.retail_place ?? '')],
        // Адрес текстом — когда карты нет. У интернет-покупки это адрес продавца, а не магазина
        ['Адрес', !onMap && !it.internet_sign ? esc(it.retail_address ?? '') : ''],
        ['Покупка', it.internet_sign ? 'в интернете' : ''],
        // У траты из банка цифры карты стоят в строке «Счёт», отдельная строка не нужна
        ['Карта', !bank && it.card ? `·${esc(it.card)}` : ''],
        ['Счёт', esc(bank ? accountName(it) : it.account_name ?? '')],
        ['Источник', `${SOURCES[it.source].icon} ${esc(sourceName(it))}`],
      ])}
    </div>

    <div class="card">
      <div class="card-label">Категория</div>
      <button class="cat-pick" id="item-cat" type="button" ${it.income ? `data-op-incat="${it.id}"` : bank ? `data-op-cat="${it.id}"` : `data-item-cat="${it.id}"`}>${it.income ? incomeButton(it.category_slug) : categoryButton(it.category_slug)}</button>
      ${!bank && !it.income && it.same_name_count > 1 ? `
      <div class="same-row">
        <span class="same-text">Для всех с таким названием<small class="note">${int.format(it.same_name_count)} ${plural(it.same_name_count, 'позиция', 'позиции', 'позиций')} · и для новых покупок</small></span>
        ${toggle('id="item-same"', true, 'Менять категорию у всех позиций с таким названием')}
      </div>` : ''}
      <p class="note" id="pick-note">${
        !bank && !it.income
          ? ''
          : it.same_name_count > 1
          ? it.income
            ? f(T.income.affects, { n: int.format(it.same_name_count), word: pl(it.same_name_count, T.income.many) })
            : bank
            ? `Изменение категории затронет ${int.format(it.same_name_count)} ${plural(it.same_name_count, 'трату', 'траты', 'трат')} этого продавца`
            : `Изменение категории затронет ${int.format(it.same_name_count)} ${plural(it.same_name_count, 'позицию', 'позиции', 'позиций')} с таким же названием`
          : ''
      }</p>
    </div>

    <div class="card">
      <div class="card-label">Комментарий</div>
      <div class="note-row">
        <textarea class="note-input" id="item-note" rows="1" maxlength="1000" placeholder="Добавить комментарий"
          data-note="${bank ? `/api/bank/ops/${it.id}/note` : `/api/items/${it.id}/note`}">${esc(it.note ?? '')}</textarea>
        <button class="note-save" type="button" data-note-save aria-label="Сохранить" title="Сохранить">${UI.ok}</button>
      </div>
    </div>

    <div class="settings-actions item-actions">
      ${bank
        ? `<button class="btn" type="button" data-op-kind="transfer" data-id="${it.id}">Это перевод себе</button>
           <button class="btn danger" type="button" data-op-kind="excluded" data-id="${it.id}">Не учитывать</button>
           <p class="note">${it.income ? T.income.transferHint : 'Перевод себе — например, на карту Озона: расходом станут покупки, сделанные на эти деньги.'}</p>`
        : `<button class="btn danger" type="button" data-item-hide="${it.id}">${it.source === 'manual' ? 'Удалить запись' : 'Убрать из расходов'}</button>`}
    </div>

    ${it.source === 'receipt' || it.source === 'market' ? `
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
  openPopup(el);
  const close = () => closePopup(el);

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
        <div class="picker-top"><div class="picker-title">Период</div><button class="icon-btn soft" data-close type="button" aria-label="Закрыть" title="Закрыть">${UI.close}</button></div>
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
      dropPopup(el);
      return go(presets[Number(preset.dataset.preset)][1](), true);
    }

    if (e.target.closest('[data-apply]')) {
      dropPopup(el);
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

/**
 * Заголовок дня с подытогом. Группировка по дням имеет смысл только при сортировке по дате:
 * в списке по сумме или по названию соседние строки из разных дней, и делить их нечем.
 */
const dayHead = (day, sum) => `
  <div class="day">
    <span>${esc(dayTitle(day))}</span>
    <b>${money(sum)}</b>
  </div>`;

/** Сколько потрачено в этот день среди показанных строк. */
const daySum = (rows, day, at, amount) =>
  rows.filter((r) => at(r).slice(0, 10) === day).reduce((sum, r) => sum + amount(r), 0);

function receiptRows(rows) {
  const byDate = state.sort === 'date';
  return rows
    .map((r) => {
      const heading = byDate && r.purchased_date !== lastDay
        ? dayHead(r.purchased_date, daySum(rows, r.purchased_date, (x) => x.purchased_date, (x) => (x.counted ? x.total_sum : 0)))
        : '';
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

  // Ошибки и очередь живут вне периода: застрявший скан важен, когда бы ни была покупка
  if (f === 'failed' || f === 'pending') {
    const back = '<button class="link" type="button" data-filter="all">Ко всем чекам</button>';
    const hint = f === 'failed'
      ? `<p class="note list-hint">Обычно это чек, который касса ещё не передала в ФНС. Мы переспрашиваем сами — через час, 6 часов, сутки и трое суток. ${back}</p>`
      : `<p class="note list-hint">${back}</p>`;
    return scans.jobs.length
      ? `${hint}<div class="list">${scans.jobs.map(jobRow).join('')}</div>`
      : `${hint}<div class="empty">${f === 'failed' ? 'Сканов с ошибкой нет' : 'Очередь пуста'}</div>`;
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
      ${listHead({
        sum: money(data.totals.sum),
        note: `${int.format(data.totals.count)} ${plural(data.totals.count, 'чек', 'чека', 'чеков')}${
          data.totals.excluded_count ? ` · ${int.format(data.totals.excluded_count)} вне суммы` : ''}`,
      })}
    </div>`;

  if (!data.rows.length && !stuck.length) {
    return `${head}<div class="empty">${f === 'manual' ? 'Ручных записей за период нет' : 'Чеков за период нет'}</div>`;
  }

  const more = data.totals.count > RECEIPTS_PER
    ? '<button class="btn more" type="button" id="more">Показать ещё</button>'
    : '';

  return `${head}
    ${scans.counts.failed
      ? `<p class="note list-hint"><button class="link" type="button" data-filter="failed">Сканы с ошибкой: ${int.format(scans.counts.failed)}</button></p>`
      : ''}
    ${stuck.length ? `<div class="list stuck">${stuck.map(jobRow).join('')}</div>` : ''}
    <div class="list" id="receipt-list">${receiptRows(data.rows)}</div>
    ${more}`;
}

function receiptsQuery(page) {
  // У чека «название» — это продавец
  const sort = { date: 'date', name: 'seller', sum: 'sum' }[state.sort] ?? 'date';
  const q = new URLSearchParams({ from: state.from, to: state.to, sort, dir: state.dir, per: RECEIPTS_PER, page });
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
  openPopup(sheet);
  const close = () => closePopup(sheet);

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
      return go({ screen: 'manual' }, true); // попап уступает место форме, в истории — одна запись
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

// Прозрачная картинка вместо заставки видео. Без неё Android WebView, пока камера не дала
// первый кадр, рисует свою серую кнопку «play», растянутую на весь экран сканера
const NO_POSTER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

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
    <video playsinline muted autoplay poster="${NO_POSTER}"></video>
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

// ── категории доходов ────────────────────────────────────
// Свой справочник — группы и категории, как у расходов. Приходит вместе с meta (meta.income).

/** Категория дохода по коду: она сама, её группа и её оттенок. */
function incomeCat(slug) {
  for (const g of meta?.income ?? []) {
    const i = g.subcategories.findIndex((c) => c.slug === slug);
    if (i < 0) continue;
    const tones = shades(g.color ?? '', g.subcategories.length, g.shade_from, g.shade_to);
    return { category: g.subcategories[i], group: g, name: g.subcategories[i].name, color: tones[i] ?? g.color };
  }
  return null;
}

function incomeButton(slug) {
  const found = incomeCat(slug);
  if (!found) {
    return `<span class="pick-ic" style="background:#eef1f5;color:#6b7280">${groupIcon('none')}</span>
      <span class="cat-name muted">${T.income.pick}</span>`;
  }
  const color = found.group.color ?? '#eef1f5';
  return `<span class="pick-ic" style="background:${color};color:${readableText(color)}">${groupIcon(found.group.icon ?? 'none')}</span>
    <span class="cat-name">${esc(found.name)}<small>${esc(found.group.name)}</small></span>`;
}

async function saveIncomeCategory(id, slug) {
  try {
    const res = await post(`/api/bank/ops/${id}/category`, { category: slug });
    screenCache.clear();
    toast(res.affected > 1 ? f(T.income.savedMore, { n: int.format(res.affected - 1) }) : T.income.saved);
    render();
  } catch (err) {
    toast(`Не сохранилось: ${err.message}`);
  }
}

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
      <label class="field">
        <span>Комментарий</span>
        <textarea id="m-note" class="m-note" rows="2" maxlength="1000" placeholder="Необязательно"></textarea>
      </label>
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
    const saved = await post('/api/manual', {
      sum, date, time, name: $('m-name').value, category: manualCategory, note: $('m-note').value,
    });
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
function openCategoryPicker(itemId, onPick, groups = meta?.categories ?? []) {
  const income = groups === meta?.income;
  const picker = document.createElement('div');
  picker.className = 'picker';
  openPopup(picker);

  const close = () => closePopup(picker);

  // Для чего выбираем: строка чека, карточка товара или новая ручная трата
  const name =
    (itemId && document.querySelector(`.sheet-row[data-row="${itemId}"] .sheet-name`)?.textContent) ||
    (itemId && itemShown?.id === itemId ? itemShown.name : '') ||
    (state.screen === 'op' ? document.querySelector('.card-name')?.textContent : '') ||
    (!itemId ? document.getElementById('m-name')?.value.trim() : '') ||
    '';
  const subtitle = name ? `<small class="picker-for">${f(income ? T.income.pickFor : 'Выберите категорию для расхода «{name}»', { name: esc(name) })}</small>` : '';
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
    if (group) return showCategories(groups.find((g) => g.slug === group.dataset.group));

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
    </div>`;

  openPopup(sheet);

  // Открыли из карточки товара — эту позицию подсвечиваем и показываем
  const row = current && sheet.querySelector(`.sheet-row[data-row="${current}"]`);
  if (row) {
    row.classList.add('current');
    row.scrollIntoView({ block: 'nearest' });
  }

  const close = () => closePopup(sheet); // сводка могла измениться — перерисует обработчик «назад»

  sheet.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]') || e.target === sheet) return close();

    // Значок справа открывает выбор категории; сохранение — уже по возврату
    const pick = e.target.closest('[data-pick]');
    if (pick) return openCategoryPicker(Number(pick.dataset.pick), saveCategory);

    // Строка — в карточку товара. Чек запоминаем в текущей записи истории:
    // «назад» из карточки откроет его снова
    const open = e.target.closest('[data-open-item]');
    if (open) {
      history.replaceState({ ...state, sheet: receipt.id, popup: true }, '', location.href);
      sheet.remove();
      go({ screen: 'item', item: open.dataset.openItem, sheet: '' });
    }
  });
}

/** Категория траты без чека: запоминается для этого продавца и красит его прошлые операции. */
async function saveOpCategory(id, slug) {
  try {
    const res = await post(`/api/bank/ops/${id}/category`, { category: slug });
    toast(res.affected > 1 ? `Категория выбрана · ещё ${int.format(res.affected - 1)} у этого продавца` : 'Категория выбрана');
    render();
  } catch (err) {
    toast(`Не сохранилось: ${err.message}`);
  }
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

// ── мастер подключения банка ─────────────────────────────
// Подключение банка и загрузка всей истории — по шагам, чтобы человек видел, что
// происходит: вступление → счета → выбор → загрузка → итог.
//
// Про конкретный банк мастер ничего не знает: команды уходят в приложение
// (window.Checker: bankAccounts, historyStart, historyStop, historyStatus), ход приходит
// событиями «checker-history». Шаг хранится на сервере, а ход загрузки — в приложении,
// поэтому мастер можно закрыть и вернуться туда же.

const WIZ_STEPS = ['intro', 'analyze', 'found', 'load', 'result'];
const WIZ_DOT = { intro: 0, analyze: 1, found: 2, load: 3, marking: 3, result: 4 };
const WIZ_PART_SEC = 13; // одна часть (счёт × год): пауза, запрос, отправка — так вышло на настоящей загрузке

let wiz = null; // { bank, step, accounts, selected, result, progress, error, awaitLogin }
let wizTimer = null;

// Мастер один для всех банков, но грузит каждый банк по-своему: Т-Банк — по счёт×год,
// Сбер — страницами единой истории. Различие спрятано в родных методах приложения
function histNative(bank) {
  const c = window.Checker ?? {};
  if (bank === 'ozon') {
    return { accounts: () => c.ozonAccounts(), start: (t, s) => c.ozonHistoryStart(t, s), stop: () => c.ozonHistoryStop(), status: () => c.ozonHistoryStatus?.() };
  }
  if (bank === 'wb') {
    return { accounts: () => c.wbAccounts(), start: (t, s) => c.wbHistoryStart(t, s), stop: () => c.wbHistoryStop(), status: () => c.wbHistoryStatus?.() };
  }
  return bank === 'sber'
    ? { accounts: () => c.sberAccounts(), start: (t, s) => c.sberHistoryStart(t, s), stop: () => c.sberHistoryStop(), status: () => c.sberHistoryStatus?.() }
    : { accounts: () => c.bankAccounts(), start: (t, s) => c.historyStart(t, s), stop: () => c.historyStop(), status: () => c.historyStatus?.() };
}

/** Магазин (Озон, WB): вместо счетов — годы, вместо операций — чеки. */
const isShop = (bank) => Boolean(bankById(bank)?.shop);

/** Тексты магазина: общие (T.wizard.ozon) и свои у WB поверх. */
const shopText = (bank) => ({ ...T.wizard.ozon, ...(bank === 'ozon' ? {} : T.wizard[bank] ?? {}) });

/** Текст мастера: у магазина свой, если есть, иначе банковский. */
const wizText = (bank, part, key) => (isShop(bank) && shopText(bank)[key]) || T.wizard[part]?.[key];

// Сколько секунд на единицу плана: заказ Озона — две-три страницы и PDF; чек WB — одна страница
const WIZ_UNIT_SEC = { ozon: 1.5, wb: 1 };

const histStatus = (bank) => {
  try {
    return JSON.parse(histNative(bank).status() || '{}');
  } catch {
    return {};
  }
};

// Умеет ли приложение мастер для этого банка. У Озона он идёт по заказам: «Электронные чеки»
// хранят только последние недели, а обычное обновление берёт именно их
const HIST_START = { tbank: 'historyStart', sber: 'sberHistoryStart', ozon: 'ozonHistoryStart', wb: 'wbHistoryStart' };
const canWizard = (id) => Boolean(HIST_START[id] && window.Checker?.[HIST_START[id]]);

/** Мастер для банка: с сервера — шаг, из приложения — идёт ли загрузка. */
/** Банк не подключён, а от прошлого подключения осталась загрузка: её состояние устарело. */
const wizStale = (bank) => inApp() && bankState(bank) === 'off' && !histStatus(bank).running;

async function wizLoad(bank) {
  if (wiz?.bank === bank && !(wizStale(bank) && wiz.step === 'load')) return wiz;
  const saved = await api(`/api/bank/history?bank=${encodeURIComponent(bank)}`).catch(() => ({}));
  wiz = { bank, step: 'intro', accounts: null, selected: [], result: null, ...(saved.state ?? {}) };
  if (wiz.step === 'analyze' || wiz.step === 'marking') wiz.step = wiz.step === 'marking' ? 'load' : 'intro';
  const s = histStatus(bank);
  if (wizStale(bank)) {
    // Банк отключили: прежняя недогруженная история уже ни к чему, продолжать её нечем —
    // сессии нет. Мастер начинается сначала, со входа
    wiz = { bank, step: 'intro', accounts: null, selected: [], result: null };
    wizSave();
  } else if (s.running || (s.total && s.done < s.total)) {
    wiz.step = 'load';
    wiz.progress = { ...s, stage: s.running ? 'load' : 'paused' };
  } else if (wiz.step === 'load') {
    wiz.progress = { ...s, stage: 'paused' };
  }
  return wiz;
}

/** Шаг — на сервер: закрыли приложение, открыли — мастер там же. Ход загрузки не нужен. */
function wizSave() {
  const { bank, step, accounts, selected, result } = wiz;
  api('/api/bank/history', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bank, state: { step, accounts, selected, result } }),
  }).catch(() => {});
}

function wizGo(step) {
  wiz.step = step;
  wiz.error = null;
  wizSave();
  if (state.screen === 'bank_wizard') render();
}

/** Открыть мастер. fresh — начать сначала; идущую или прерванную загрузку это не сбрасывает. */
function openWizard(bank, fresh = false) {
  const s = histStatus(bank);
  const busy = !wizStale(bank) && (s.running || (s.total && s.done < s.total));
  if ((fresh || wizStale(bank)) && !busy) {
    wiz = { bank, step: 'intro', accounts: null, selected: [], result: null };
    wizSave();
  }
  go({ screen: 'bank_wizard', bank });
}

async function screenBankWizard() {
  const w = await wizLoad(state.bank ?? 'tbank');
  const b = bankById(w.bank) ?? BANKS[0];
  const dots = WIZ_STEPS.map((_, i) => `<span class="wiz-dot${i <= WIZ_DOT[w.step] ? ' on' : ''}"></span>`).join('');
  const body = await WIZ_SCREENS[w.step](w, b);
  return `<div class="wiz"><div class="wiz-dots">${dots}</div>${body}</div>`;
}

const wizSpinner = (text) => `<div class="wiz-wait"><span class="wiz-spin"></span><p>${text}</p></div>`;

const WIZ_SCREENS = {
  intro: (w, b) => `
    <div class="card wiz-hello">
      ${bankLogo(b, true)}
      <h2>${f(T.wizard.intro.title, { bank: esc(b.from ?? b.name) })}</h2>
      <p class="note">${wizText(w.bank, 'intro', 'subtitle')}</p>
    </div>
    <div class="card">
      <div class="card-label">${T.wizard.intro.safetyLabel}</div>
      <ul class="bank-facts">${facts(isShop(w.bank) ? { ...T.wizard.intro, ...shopText(w.bank) } : T.wizard.intro, ['safetyLogin', 'safetyRead', 'safetyYours'])}</ul>
    </div>
    <div class="card">
      <div class="card-label">${T.wizard.intro.planLabel}</div>
      <ol class="wiz-plan">${[1, 2, 3, 4, 5].map((i) => `<li>${wizText(w.bank, 'intro', `plan${i}`)}</li>`).join('')}</ol>
    </div>`,

  analyze: (w) =>
    w.error
      ? `<div class="card"><p class="note error">${f(T.wizard.analyze.failed, { why: esc(w.error) })}</p></div>`
      : wizSpinner(wizText(w.bank, 'analyze', 'wait')),

  found: async (w) => {
    const bankData = await api('/api/bank').catch(() => null);
    const have = bankData?.links?.find((l) => l.bank === w.bank)?.ops ?? 0;
    const thisYear = new Date().getFullYear();
    if (isShop(w.bank)) return wizFoundShop(w, have);
    const rows = (w.accounts ?? []).map((a) => {
      const kind = T.accountTypes[a.type] ?? a.type ?? T.bankCard.accounts.kind;
      const currency = a.currency && a.currency !== 'RUB' ? ` · ${a.currency}` : '';
      // У Сбера возраста счёта нет — показываем тип; у Т-Банка добавляем «с года»
      const age = a.created ? f(T.wizard.found.since, { year: new Date(a.created).getFullYear() }) : '';
      return `
        <label class="wiz-acc">
          <input type="checkbox" data-wiz-acc="${esc(a.id)}"${w.selected.includes(a.id) ? ' checked' : ''} />
          <span class="wiz-acc-main">
            <span class="wiz-acc-name">${esc(a.name)}</span>
            <small class="note">${esc(kind)}${currency}${age}</small>
          </span>
        </label>`;
    }).join('');
    return `
      <div class="card">
        <h2 class="wiz-title">${f(T.wizard.found.title, { n: w.accounts?.length ?? 0, word: pl(w.accounts?.length ?? 0, T.common.accounts) })}</h2>
        <p class="note">${T.wizard.found.hint}</p>
        <div class="wiz-accs">${rows}</div>
      </div>
      <div class="card"><p class="note" id="wiz-estimate">${wizEstimate(w)}</p>${
        have ? `<p class="note">${f(T.wizard.found.already, { n: int.format(have), word: pl(have, T.common.ops) })}</p>` : ''
      }</div>`;
  },

  load: (w) => {
    const p = w.progress ?? {};
    const failed = p.stage === 'error';
    const paused = p.stage === 'paused' || p.stage === 'stopped';
    return `
      <div class="card wiz-load">
        <h2 class="wiz-title">${failed ? T.wizard.load.titleFailed : paused ? T.wizard.load.titleStopped : T.wizard.load.title}</h2>
        <div class="wiz-bar${p.total ? '' : ' flow'}"><span id="wiz-bar" style="width:${p.total ? Math.min(100, Math.round(((p.done ?? 0) / p.total) * 100)) : 0}%"></span></div>
        <div class="wiz-nums">
          <div><b id="wiz-ops">0</b><small class="note">${isShop(w.bank) ? shopText(w.bank).receipts : T.wizard.load.ops}</small></div>
          <div><b id="wiz-mid">—</b><small class="note" id="wiz-mid-label">${isShop(w.bank) ? shopText(w.bank).ordersDone : T.wizard.load.parts}</small></div>
          <div><b id="wiz-eta">—</b><small class="note">${T.wizard.load.left}</small></div>
        </div>
        <p class="note" id="wiz-now"></p>
        ${failed ? `<p class="note error">${f(T.wizard.load.savedFailed, { why: esc(w.error ?? '') })}</p>` : ''}
        ${paused ? `<p class="note">${T.wizard.load.savedStopped}</p>` : ''}
      </div>
      <p class="note wiz-hint">${T.wizard.load.keepOpen}</p>`;
  },

  marking: () => wizSpinner(T.wizard.marking),

  result: (w) => {
    const r = w.result ?? {};
    if (r.shop || r.ozon) return wizResultShop({ shop: 'ozon', ...r }); // ozon — итог прежней версии
    const kinds = Object.fromEntries((r.kinds ?? []).map((k) => [k.kind, k]));
    const count = (k) => kinds[k]?.count ?? 0;
    const expenses = count('expense');
    const sorted = kinds.expense?.categorized ?? 0;
    const share = expenses ? Math.round((sorted / expenses) * 100) : 100;
    const first = r.total?.first?.slice(0, 4);
    const last = r.total?.last?.slice(0, 4);
    const years = first && last ? Number(last) - Number(first) + 1 : 0;
    const row = (label, value, note = '') =>
      `<div class="wiz-row"><span>${label}${note ? `<small class="note">${note}</small>` : ''}</span><b>${value}</b></div>`;
    const accounts = (r.accounts ?? [])
      .map((a) => row(esc(a.name ?? a.account), int.format(a.count), f(T.wizard.result.since, { year: a.first?.slice(0, 4) })))
      .join('');
    return `
      <div class="card wiz-hello">
        <h2>${f(T.wizard.result.title, { n: int.format(r.total?.count ?? 0), word: pl(r.total?.count ?? 0, T.common.ops) })}</h2>
        <p class="note">${years ? f(T.wizard.result.span, { years, word: pl(years, T.common.years), from: first, to: last }) : ''}</p>
      </div>
      <div class="card">
        <div class="card-label">${T.wizard.result.foundLabel}</div>
        ${row(T.wizard.result.covered, int.format(count('covered')), T.wizard.result.coveredHint)}
        ${row(T.wizard.result.expense, int.format(expenses), f(T.wizard.result.expenseHint, { percent: share }))}
        ${row(T.wizard.result.income, int.format(count('income')))}
        ${row(T.wizard.result.transfer, int.format(count('transfer')), T.wizard.result.transferHint)}
        ${count('excluded') ? row(T.wizard.result.excluded, int.format(count('excluded'))) : ''}
      </div>
      ${expenses - sorted > 0 ? `
      <div class="card">
        <p class="note">${f(T.wizard.result.rest, { n: int.format(expenses - sorted), word: pl(expenses - sorted, T.wizard.result.restWord) })}</p>
      </div>` : ''}
      <div class="card">
        <div class="card-label">${T.wizard.result.byAccount}</div>
        ${accounts}
      </div>`;
  },
};

/** Итог магазина: чеки, товары, годы. */
function wizResultShop(r) {
  const O = shopText(r.shop);
  const row = (label, value, note = '') =>
    `<div class="wiz-row"><span>${label}${note ? `<small class="note">${note}</small>` : ''}</span><b>${value}</b></div>`;
  const count = r.total?.count ?? 0;
  const first = r.total?.first?.slice(0, 4);
  const last = r.total?.last?.slice(0, 4);
  const years = first && last ? Number(last) - Number(first) + 1 : 0;
  return `
    <div class="card wiz-hello">
      <h2>${f(O.resultTitle, { n: int.format(count), word: pl(count, T.common.receipts) })}</h2>
      <p class="note">${years ? f(T.wizard.result.span, { years, word: pl(years, T.common.years), from: first, to: last }) : ''}</p>
    </div>
    <div class="card">
      <div class="card-label">${O.foundLabel}</div>
      ${r.added != null ? row(O.added, int.format(r.added), O.addedHint) : ''}
      ${row(O.items, int.format(r.items ?? 0))}
    </div>
    ${r.years?.length ? `
    <div class="card">
      <div class="card-label">${O.byYear}</div>
      ${r.years.map((y) => row(esc(y.year), int.format(y.count))).join('')}
    </div>` : ''}`;
}

/** Магазин: годы с числом заказов (Озон) или чеков (WB) вместо счетов. */
function wizFoundShop(w, have) {
  const O = shopText(w.bank);
  const n = w.accounts?.length ?? 0;
  const rows = (w.accounts ?? []).map((a) => `
    <label class="wiz-acc">
      <input type="checkbox" data-wiz-acc="${esc(a.id)}"${w.selected.includes(a.id) ? ' checked' : ''} />
      <span class="wiz-acc-main">
        <span class="wiz-acc-name">${esc(a.name)}</span>
        <small class="note">${int.format(a.count ?? a.orders)} ${pl(a.count ?? a.orders, O.orders)}</small>
      </span>
    </label>`).join('');
  return `
    <div class="card">
      <h2 class="wiz-title">${f(O.title, { n, word: pl(n, T.common.years) })}</h2>
      <p class="note">${O.hint}</p>
      <div class="wiz-accs">${rows}</div>
    </div>
    <div class="card"><p class="note" id="wiz-estimate">${wizEstimate(w)}</p>${
      have ? `<p class="note">${f(O.already, { n: int.format(have), word: pl(have, T.common.receipts) })}</p>` : ''
    }</div>`;
}

/** Сколько частей и времени займёт загрузка выбранных счетов. */
function wizEstimate(w) {
  const chosen = (w.accounts ?? []).filter((a) => w.selected.includes(a.id));
  if (isShop(w.bank)) {
    const O = shopText(w.bank);
    if (!chosen.length) return O.pickOne;
    const units = chosen.reduce((sum, a) => sum + (a.count ?? a.orders ?? 0), 0);
    const min = Math.max(1, Math.ceil((units * (WIZ_UNIT_SEC[w.bank] ?? 1.5)) / 60));
    return f(O.estimate, { n: int.format(units), word: pl(units, O.orders), min });
  }
  if (!chosen.length) return T.wizard.found.pickOne;
  const n = `${chosen.length} ${pl(chosen.length, T.common.accounts)}`;
  // У Сбера возраст счёта неизвестен и грузим единой историей — оценка общая
  if (chosen.some((a) => !a.created)) {
    return f(T.wizard.found.estimateRough, { n });
  }
  const parts = chosen.reduce((count, a) => count + (a.years ?? 1), 0);
  const min = Math.max(1, Math.ceil((parts * WIZ_PART_SEC) / 60));
  const since = Math.min(...chosen.map((a) => new Date(a.created).getFullYear()));
  return f(T.wizard.found.estimate, { n, since, min });
}

/** Кнопки внизу — у каждого шага своя главная. */
function wizActions() {
  if (!wiz) return '';
  const p = wiz.progress ?? {};
  switch (wiz.step) {
    case 'intro':
      return `<button class="btn primary big" type="button" data-wiz="begin">${T.wizard.intro.start}</button>`;
    case 'analyze':
      return wiz.error ? `<button class="btn primary big" type="button" data-wiz="begin">${T.wizard.analyze.retry}</button>` : '';
    case 'found':
      return `<button class="btn primary big" type="button" data-wiz="sync"${wiz.selected.length ? '' : ' disabled'}>${T.wizard.found.go}</button>`;
    case 'load':
      return p.stage === 'load' || p.stage === 'wait'
        ? `<button class="btn big" type="button" data-wiz="stop">${T.wizard.load.stop}</button>`
        : `<button class="btn primary big" type="button" data-wiz="resume">${T.wizard.load.resume}</button>`;
    case 'result':
      return `<button class="btn primary big" type="button" data-wiz="done">${T.wizard.result.done}</button>`;
    default:
      return '';
  }
}

/** Ход загрузки — раз в секунду, без перерисовки экрана. */
function wizTick() {
  if (state.screen !== 'bank_wizard' || wiz?.step !== 'load') return;
  const p = wiz.progress ?? {};
  const bar = $('wiz-bar');
  if (!bar) return;
  const total = p.total || 0;
  const done = p.done || 0;
  $('wiz-ops').textContent = int.format(p.ops ?? 0);
  const waitLeft = p.waitUntil ? Math.ceil((p.waitUntil - Date.now()) / 1000) : 0;

  // Общее число приходит не сразу (у Т-Банка — с первым событием, у Сбера — после подсчёта),
  // поэтому вид полосы переключаем здесь, а не только при отрисовке: иначе «бегущая»
  // анимация останется навсегда и настоящего прогресса не увидеть
  const counting = p.stage === 'count' || !total;
  bar.parentElement.classList.toggle('flow', counting);

  // Средняя плитка: у Т-Банка — куски плана, у Сбера — общее число операций
  const mid = $('wiz-mid');
  if (mid) {
    mid.textContent = !total ? '—' : p.byOps ? int.format(total) : f(T.bankCard.accounts.count, { on: done, all: total });
    $('wiz-mid-label').textContent = isShop(wiz.bank) ? shopText(wiz.bank).ordersDone : p.byOps ? T.wizard.load.total : T.wizard.load.parts;
  }

  if (p.stage === 'count') {
    $('wiz-now').textContent = T.wizard.load.counting;
    return;
  }
  if (!total) {
    $('wiz-now').textContent = T.wizard.load.running;
    return;
  }
  bar.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
  const left = Math.max(0, total - done);
  // Пока не по чему считать скорость: у кусков плана есть средняя длительность,
  // а у операций её нет — ждём первых страниц
  const measured = p.runStart && p.runDone > 0 ? ((Date.now() - p.runStart) / 1000 / p.runDone) * left : null;
  const eta = measured ?? (p.byOps ? null : left * WIZ_PART_SEC);
  $('wiz-eta').textContent =
    !left || eta == null ? '—' : eta < 60 ? `${Math.max(1, Math.round(eta))} с` : `${Math.ceil(eta / 60)} мин`;
  $('wiz-now').textContent =
    waitLeft > 0
      ? f(T.wizard.load.waiting, { sec: waitLeft })
      : p.stage === 'load' && p.account
        ? f(T.wizard.load.now, { account: p.account, year: p.year })
        : '';
}

function wizStartTimer() {
  clearInterval(wizTimer);
  wizTimer = setInterval(() => {
    if (state.screen !== 'bank_wizard') return clearInterval(wizTimer);
    wizTick();
  }, 1000);
}

/** Начать: банк подключён — сразу к счетам, нет — сначала окно входа. */
function wizBegin() {
  if (bankState(wiz.bank) === 'active') {
    wizGo('analyze');
    return histNative(wiz.bank).accounts();
  }
  wiz.awaitLogin = true;
  bankBridge(wiz.bank).login();
}

async function onWizardClick(button) {
  const action = button.dataset.wiz;
  if (action === 'begin') return wizBegin();
  if (action === 'sync') {
    button.disabled = true;
    try {
      // Выбор счетов — не только для истории: обычное обновление тоже берёт только их.
      // У Озона выбраны годы — они нужны только этой загрузке
      if (!isShop(wiz.bank)) {
        await api(`/api/bank/accounts?bank=${encodeURIComponent(wiz.bank)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accounts: wiz.accounts.map((a) => ({ ...a, enabled: wiz.selected.includes(a.id) })) }),
        });
      }
      await post('/api/bank/history/start', { bank: wiz.bank });
    } catch (err) {
      button.disabled = false;
      return toast(`Не вышло: ${err.message}`);
    }
    wiz.progress = { stage: 'load', done: 0, total: 0, ops: 0, runStart: Date.now(), runDone: 0 };
    wizGo('load');
    return histNative(wiz.bank).start(token.get(), JSON.stringify(wiz.selected));
  }
  if (action === 'stop') {
    button.disabled = true;
    button.textContent = 'Останавливаем…';
    return histNative(wiz.bank).stop();
  }
  if (action === 'resume') {
    wiz.progress = { ...wiz.progress, ...histStatus(wiz.bank), stage: 'load', runStart: Date.now(), runDone: 0 };
    wiz.error = null;
    render();
    return histNative(wiz.bank).start(token.get(), '');
  }
  if (action === 'done') {
    wizSave();
    return go({ screen: 'bank_card', bank: wiz.bank });
  }
}

/** Конец загрузки: сервер размечает всё разом и рассказывает, что получилось. */
async function wizFinish() {
  wiz.step = 'marking';
  if (state.screen === 'bank_wizard') render();
  try {
    wiz.result = await post('/api/bank/history/finish', { bank: wiz.bank });
    if (wiz.result.shop) wiz.result.added = wiz.progress?.added ?? null;
    wizGo('result');
  } catch (err) {
    wiz.step = 'load';
    wiz.progress = { ...wiz.progress, stage: 'error' };
    wiz.error = f(T.wizard.result.markFailed, { why: err.message });
    if (state.screen === 'bank_wizard') render();
  }
}

window.addEventListener('checker-history', (e) => {
  const r = e.detail ?? {};
  if (!wiz) return;
  if (r.stage === 'accounts') {
    wiz.accounts = r.accounts ?? [];
    if (isShop(wiz.bank)) {
      wiz.selected = wiz.accounts.map((a) => a.id);
      return wizGo('found');
    }
    // Галочки — по прошлому выбору: выключенный однажды счёт остаётся выключенным
    api(`/api/bank/accounts?bank=${encodeURIComponent(wiz.bank)}`)
      .catch(() => ({ accounts: [] }))
      .then(({ accounts }) => {
        const off = new Set(accounts.filter((a) => !a.enabled).map((a) => a.id));
        wiz.selected = wiz.accounts.map((a) => a.id).filter((id) => !off.has(id));
        wizGo('found');
      });
    return;
  }
  if (r.stage === 'loaded') {
    wiz.progress = { ...(wiz.progress ?? {}), ...r };
    return wizFinish();
  }

  // Сбер не говорит, сколько всего операций — приложение нащупывает это перед загрузкой
  if (r.stage === 'count') {
    wiz.progress = { ...(wiz.progress ?? {}), stage: 'count' };
    if (wiz.step !== 'load') wiz.step = 'load';
    if (state.screen === 'bank_wizard') render();
    return;
  }

  const before = wiz.progress?.stage;
  const p = { ...(wiz.progress ?? {}) };
  if (r.stage === 'error') {
    if (wiz.step === 'analyze') {
      wiz.error = r.error;
      return render();
    }
    wiz.error = r.error;
    p.stage = 'error';
  } else if (r.stage === 'wait') {
    p.stage = 'wait';
    p.waitUntil = Date.now() + r.seconds * 1000;
  } else {
    // load и stopped: счётчики из приложения
    const prevDone = p.done ?? 0;
    Object.assign(p, r, { waitUntil: 0 });
    if (r.stage === 'load' && r.done > prevDone) p.runDone = (p.runDone ?? 0) + (r.done - prevDone);
    p.runStart ??= Date.now();
  }
  wiz.progress = p;
  if (wiz.step !== 'load') wiz.step = 'load';
  // Сменилось состояние — меняются заголовок и кнопка; иначе хватит цифр
  if (state.screen !== 'bank_wizard') return;
  if (before !== p.stage && !(before === 'wait' && p.stage === 'load') && !(before === 'load' && p.stage === 'wait')) render();
  else wizTick();
});

// Счета на странице банка: выбор сохраняется сразу, операции счёта уходят из учёта или возвращаются
$('screen').addEventListener('change', async (e) => {
  const box = e.target.closest('[data-bank-acc]');
  if (!box) return;
  const ops = Number(box.dataset.ops) || 0;
  if (!box.checked && ops && !confirm(f(T.bankCard.accounts.offConfirm, { ops: int.format(ops), opsWord: pl(ops, T.common.ops) }))) {
    box.checked = true;
    return;
  }
  box.disabled = true;
  try {
    await api(`/api/bank/accounts?bank=${encodeURIComponent(state.bank ?? 'tbank')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accounts: [{ id: box.dataset.bankAcc, enabled: box.checked }] }),
    });
    toast(box.checked ? T.bankCard.accounts.on : T.bankCard.accounts.off);
  } catch (err) {
    box.checked = !box.checked;
    toast(`Не сохранилось: ${err.message}`);
  } finally {
    box.disabled = false;
  }
});

// Галочки счетов: оценка времени меняется сразу
$('screen').addEventListener('change', (e) => {
  const box = e.target.closest('[data-wiz-acc]');
  if (!box || !wiz) return;
  const id = box.dataset.wizAcc;
  wiz.selected = box.checked ? [...new Set([...wiz.selected, id])] : wiz.selected.filter((x) => x !== id);
  const estimate = $('wiz-estimate');
  if (estimate) estimate.textContent = wizEstimate(wiz);
  const sync = document.querySelector('[data-wiz="sync"]');
  if (sync) sync.disabled = !wiz.selected.length;
});

// ── экраны ───────────────────────────────────────────────

const SCREENS = {
  summary: { title: 'Расходы', render: screenSummary },
  receipts: { title: 'Чеки', render: screenReceipts },
  add: { title: 'Добавить', render: screenAdd },
  // form — на экране поля, которые человек заполняет: закрытие попапа его не перерисовывает
  manual: { title: 'Вручную', render: screenManual, after: () => $('m-sum')?.focus(), form: true },
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
  group: {
    title: () => (state.group === NONE ? 'Без категории' : findGroup(state.group)?.name ?? 'Группа'),
    render: screenGroup,
  },
  category: { title: 'Позиции', render: screenCategory },
  item: { title: 'Товар', render: screenItem, after: () => { mountItemMap(); fitNote(); } },
  bank: { title: 'Операции банка', render: screenBank },
  income: { title: 'Доход', render: screenIncome },
  stats: {
    title: 'Статистика',
    render: () => soon(UI.stats, 'Статистика', 'Здесь будут графики: как меняются траты по месяцам и категориям.'),
  },
  settings: { title: 'Настройки', render: screenSettings },
  set_profile: { title: T.settings.profile.label, render: screenSetProfile },
  set_budget: { title: T.settings.budget.label, render: screenSetBudget },
  set_banks: { title: T.settings.banks.label, render: screenSetBanks },
  privacy: { title: T.settings.data.label, render: screenPrivacy },
  set_cats: { title: () => (state.tk === 'in' ? T.settings.cats.incomeTitle : T.settings.cats.expenseTitle), render: screenSetCats },
  set_group: { title: T.settings.cats.group, render: screenSetGroup, after: focusNew },
  set_cat: { title: T.settings.cats.category, render: screenSetCat, after: focusNew },
  bank_card: { title: () => bankById(state.bank)?.name ?? 'Банк', render: screenBankCard },
  bank_add: { title: T.bankAdd.title, render: screenBankAdd },
  bank_safety: { title: T.bankCard.safety.label, render: screenBankSafety },
  bank_wizard: {
    title: () => bankById(state.bank)?.name ?? 'Банк',
    render: screenBankWizard,
    // Кнопки зависят от шага, а он известен только после загрузки мастера
    after: () => {
      const actions = wizActions();
      $('actions').innerHTML = actions;
      $('actions').hidden = !actions;
      updateDock();
      wizTick();
      wizStartTimer();
    },
  },
  op: { title: 'Товар', render: screenOp, after: () => fitNote() },
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
  summary: 'summary', group: 'summary', category: 'summary', item: 'summary', receipts: 'summary', bank: 'summary',
  income: 'income', settings: 'settings', stats: 'stats', bank_card: 'settings', bank_add: 'settings',
  bank_safety: 'settings', bank_wizard: 'settings', op: 'summary',
  set_profile: 'settings', set_budget: 'settings', set_banks: 'settings', privacy: 'settings', set_cats: 'settings', set_group: 'settings', set_cat: 'settings',
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

/**
 * Подсветка изменившейся части подписи: круг расходится и тает. Так человек видит, что
 * сделал значок, который он только что нажал, — без слов и подсказок.
 */
let pulseNext = null;
function pulse(name) {
  pulseNext = null;
  const el = document.querySelector(`[data-note-part="${name}"]`);
  if (!el) return;
  el.classList.remove('pulse');
  void el.offsetWidth; // перезапуск анимации, если нажали дважды подряд
  el.classList.add('pulse');
  // Снимаем по таймеру: событие конца анимации приходит не во всех браузерах
  setTimeout(() => el.classList.remove('pulse'), 1100);
}
let shownScreen = null; // что сейчас на экране: по нему решаем, мигать «Загрузкой» или нет

// Готовые экраны — чтобы вернуться на знакомый мгновенно. Ключ — адрес экрана со всеми
// параметрами (месяц, категория, банк). Только списки и настройки: у форм, карточек с
// картой и мастера после отрисовки своя жизнь (поля, таймеры), прошлый вид им не годится.
// Живут до перезагрузки страницы; свежий вид всё равно приходит следом и заменяет прошлый
const CACHED = ['summary', 'group', 'category', 'receipts', 'bank', 'income', 'settings', 'set_profile', 'set_budget', 'set_banks', 'set_cats', 'privacy', 'bank_card', 'bank_add', 'bank_safety'];
const screenCache = new Map();
function remember(key, html) {
  screenCache.delete(key); // свежий — в конец очереди
  screenCache.set(key, html);
  if (screenCache.size > 40) screenCache.delete(screenCache.keys().next().value);
}
const EXPENSE = ['summary', 'receipts', 'bank']; // один раздел: переключатель в шапке, общая шапка
const NONE = '-'; // «Без категории»: у неразмеченного нет кода, но открывать его список нужно

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
  // Пустой экран с «Загрузкой» — только когда уходим в другой раздел. Листание месяцев,
  // смена сортировки и переключатель «Категории | Чеки | Банк» перерисовывают содержимое
  // на месте: иначе экран мигает на каждое нажатие
  const shown = Boolean($('screen').firstChild);
  const sameScreen = shown && state.screen === shownScreen;
  const sameKind = shown && EXPENSE.includes(state.screen) && EXPENSE.includes(shownScreen);
  // Экран уже открывали — сразу показываем, каким он был, а свежий вид подставим, когда
  // придут данные. Иначе «назад» каждый раз упирается в «Загрузку»
  const key = location.search;
  const cached = !sameScreen && CACHED.includes(state.screen) ? screenCache.get(key) : null;
  if (cached) {
    $('screen').innerHTML = cached;
    window.scrollTo(0, history.state?.scroll ?? 0); // «назад» — туда же, где оставили
    shownScreen = state.screen;
  } else if (!sameScreen && !sameKind) {
    $('screen').innerHTML = loading();
    window.scrollTo(0, 0); // прокручивается страница, а не блок экрана
  }
  // Ответ задерживается — показываем это не пустотой, а приглушением списка. Если на экране
  // уже прошлый вид, не гасим: он почти наверняка верный, свежий тихо его заменит
  const dim = setTimeout(() => seq === renderSeq && !cached && $('screen').classList.add('busy'), 250);

  try {
    const html = await screen.render();
    if (seq !== renderSeq) return;
    if (CACHED.includes(state.screen)) remember(key, html);
    // Тот же список — остаёмся там же, где листали; другой — смотрим с начала
    const keepScroll = sameScreen || cached ? window.scrollY : 0;
    // Ничего не изменилось — не трогаем: перерисовка сбросила бы нажатие и фокус
    if (html !== cached) {
      $('screen').innerHTML = html;
      window.scrollTo(0, keepScroll);
    }
    shownScreen = state.screen;
    screen.after?.();
    if (pulseNext) pulse(pulseNext);
  } catch (err) {
    if (seq === renderSeq) $('screen').innerHTML = failed(err);
  } finally {
    clearTimeout(dim);
    if (seq === renderSeq) $('screen').classList.remove('busy');
  }
}

// ── обновление свайпом вниз ──────────────────────────────
// Потянули страницу вниз от самого верха — перечитываем экран с сервера, как в любом
// приложении. Кружок со стрелкой выезжает из-под шапки и поворачивается по мере натяжения;
// отпустили за порогом — крутится, пока не придёт свежий вид. Формы и мастер не трогаем:
// там перерисовка сбросила бы введённое.

const PULLABLE = [...CACHED, 'item', 'op'];
const PULL_AT = 70; // столько протянуть (с учётом тугости), чтобы обновить
const PULL_MAX = 96; // дальше кружок не едет
const puller = document.createElement('div');
puller.className = 'puller';
puller.innerHTML = UI.refresh;
$('app').append(puller);

let pullFrom = null; // где палец коснулся экрана; null — это не натяжение
let pullBy = 0;
let pulling = false;

function pullReset() {
  puller.classList.add('back');
  puller.classList.remove('spin', 'ready');
  puller.style.transform = '';
  puller.style.opacity = '';
  setTimeout(() => puller.classList.remove('back'), 220);
}

addEventListener('touchstart', (e) => {
  const allowed = window.scrollY <= 0 && e.touches.length === 1 && !pulling && !$('app').hidden
    && PULLABLE.includes(state.screen) && !document.querySelector('.sheet, .picker');
  pullFrom = allowed ? e.touches[0].clientY : null;
  pullBy = 0;
}, { passive: true });

addEventListener('touchmove', (e) => {
  if (pullFrom == null) return;
  const dy = e.touches[0].clientY - pullFrom;
  pullBy = dy > 0 && window.scrollY <= 0 ? Math.min(PULL_MAX, dy * 0.5) : 0; // тянется туже пальца
  puller.style.transform = `translateY(${pullBy}px) rotate(${pullBy * 3.5}deg)`;
  puller.style.opacity = String(Math.min(1, pullBy / PULL_AT));
  puller.classList.toggle('ready', pullBy >= PULL_AT);
}, { passive: true });

addEventListener('touchend', async () => {
  if (pullFrom == null) return;
  pullFrom = null;
  if (pullBy < PULL_AT) return pullReset();
  pulling = true;
  puller.classList.add('spin', 'back');
  puller.style.transform = `translateY(${PULL_AT}px)`;
  try {
    // Свежие данные и справочники; кружок крутится хотя бы мгновение — иначе не видно, что было
    screenCache.delete(location.search);
    kept.clear();
    reloadIfUpdated();
    await Promise.all([
      api('/api/meta').then((m) => (meta = m)).catch(() => {}),
      new Promise((r) => setTimeout(r, 450)),
    ]);
    await render();
  } finally {
    pulling = false;
    pullReset();
  }
});

// Жест перехватила система (например, шторка уведомлений) — просто прячем кружок
addEventListener('touchcancel', () => {
  if (pullFrom == null) return;
  pullFrom = null;
  pullReset();
});

// ── события ──────────────────────────────────────────────

async function onScreenClick(e) {
  // Строка позиции с выбором категории — экран «Добавлено»
  const pick = e.target.closest('[data-pick]');
  if (pick) return openCategoryPicker(Number(pick.dataset.pick), saveCategory);

  // Категория в карточке товара
  // Фильтр по источнику: повторное нажатие снимает
  const inf = e.target.closest('[data-inf]');
  if (inf) return go({ inf: inf.dataset.inf }, true);

  const src = e.target.closest('[data-src]');
  if (src) {
    const next = !src.dataset.src || state.src === src.dataset.src ? '' : src.dataset.src;
    pulseNext = next ? 'src' : 'count'; // фильтр сняли — меняется число покупок
    return go({ src: next }, true);
  }

  // Заголовок раздела: свернуть или развернуть. При длинной ленте открыт только один
  const sectionBtn = e.target.closest('[data-section]');
  if (sectionBtn) {
    const opened = openSections();
    const key = sectionBtn.dataset.section;
    if (opened.has(key)) opened.delete(key);
    else {
      if (feedSections.single) opened.clear();
      opened.add(key);
    }
    return render();
  }

  // Сканы с ошибкой — ссылкой с «Расхода»: отдельной вкладки «Чеки» больше нет
  if (e.target.closest('[data-to-failed]')) return go({ screen: 'receipts', filter: 'failed' });

  // Убрать товар из расходов: задвоенный или учтённый где-то ещё
  const hide = e.target.closest('[data-item-hide]');
  if (hide) {
    const manual = hide.textContent.includes('Удалить');
    if (!confirm(manual ? 'Удалить эту запись?' : 'Убрать товар из расходов? Он перестанет учитываться в суммах.')) return;
    try {
      await post(`/api/items/${hide.dataset.itemHide}/hide`, {});
      toast(manual ? 'Запись удалена' : 'Товар убран из расходов');
      return history.back(); // карточки больше нет — возвращаемся к ленте
    } catch (err) {
      return toast(`Не вышло: ${err.message}`);
    }
  }

  // Трата из банка — перевод себе или не учитывать
  const opKind = e.target.closest('[data-op-kind]');
  if (opKind) {
    const transfer = opKind.dataset.opKind === 'transfer';
    const income = itemShown?.income;
    if (!confirm(transfer
      ? income ? T.income.transferConfirm : 'Отметить как перевод себе? Он не будет считаться расходом.'
      : income ? T.income.excludeConfirm : 'Не учитывать эту трату? Она пропадёт из расходов.')) return;
    try {
      await post(`/api/bank/ops/${opKind.dataset.id}/kind`, { kind: opKind.dataset.opKind });
      toast(transfer ? 'Отмечено как перевод себе' : income ? T.income.excluded : 'Трата больше не учитывается');
      return history.back();
    } catch (err) {
      return toast(`Не вышло: ${err.message}`);
    }
  }

  // Стрелка у группы одинаковых покупок: развернуть или свернуть, не открывая карточку
  const toggle = e.target.closest('[data-expand]');
  if (toggle) {
    const key = expandKey(toggle.dataset.expand);
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    return render(); // тот же экран — список перерисуется на месте, прокрутка не сбросится
  }

  // Трата из банка открывается карточкой, как товар; категория меняется уже в ней
  const opOpen = e.target.closest('[data-op]');
  if (opOpen) return go({ screen: 'op', op: opOpen.dataset.op });

  const opIncat = e.target.closest('[data-op-incat]');
  if (opIncat) return openCategoryPicker(Number(opIncat.dataset.opIncat), saveIncomeCategory, meta?.income ?? []);

  const opCat = e.target.closest('[data-op-cat]');
  if (opCat) return openCategoryPicker(Number(opCat.dataset.opCat), saveOpCategory);

  if (e.target.closest('[data-bank-add]')) return go({ screen: 'bank_add' });

  const bankOpen = e.target.closest('[data-bank-open]');
  if (bankOpen) return go({ screen: 'bank_card', bank: bankOpen.dataset.bankOpen });

  const bankSafety = e.target.closest('[data-bank-safety]');
  if (bankSafety) return go({ screen: 'bank_safety', bank: bankSafety.dataset.bankSafety });

  const wizButton = e.target.closest('[data-wiz]');
  if (wizButton) return onWizardClick(wizButton);

  // Мастер: подключение и загрузка всей истории
  const wizOpen = e.target.closest('[data-wizard]');
  if (wizOpen) return openWizard(wizOpen.dataset.wizard, true);

  const bank = e.target.closest('[data-bank]');
  if (bank) {
    const id = bank.dataset.bankId ?? 'tbank';
    // Вход в банк (окно банка открывает приложение). После входа — в общие настройки и
    // сразу обновление: ради него обычно и входят
    if (bank.dataset.bank === 'login' || bank.dataset.bank === 'relogin') {
      syncAfterLogin = id;
      return bankBridge(id).login();
    }
    if (bank.dataset.bank === 'sync') return startBankSync(id);
    if (bank.dataset.bank === 'forget') {
      if (!confirm(T.bankCard.manage.forgetConfirm)) return;
      bankBridge(id).forget();
      await api(`/api/bank?bank=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
      return render();
    }
    if (bank.dataset.bank === 'wipe') {
      if (!confirm(T.bankCard.manage.wipeConfirm)) return;
      bankBridge(id).forget();
      const res = await api(`/api/bank/ops?bank=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
      toast(res ? f(T.bankCard.manage.wiped, { n: int.format(res.ops ?? 0) }) : T.common.failed);
      bankLinked = false;
      return go({ screen: 'set_banks' });
    }
  }

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
    const dir = key === state.sort ? (state.dir === 'asc' ? 'desc' : 'asc') : SORTS[key][1];
    pulseNext = 'sort';
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
    // Переключатель выключен — только эта покупка; его нет — позиция с таким названием одна
    const only = $('item-same') ? !$('item-same').checked : false;
    const data = await post(`/api/items/${itemId}/category`, { category: slug, only });
    button.innerHTML = categoryButton(slug);
    note.textContent = data.only
      ? data.category ? `«${data.category.name}» — только для этой покупки` : 'Категория снята у этой покупки'
      : data.category
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

// Вкладка сбрасывает глубину, но не период: переключение не должно терять выбор дат.
// В историю переходы по вкладкам не пишем: иначе «назад» из карточки товара возвращает
// не к списку, а туда, где человек был до переключения — например, в настройки
document.querySelector('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) go({ screen: tab.dataset.tab, group: '', category: '', item: '', bank: '' }, true);
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
  const B = T.settings.budget;
  const name = srow({
    icon: UI.wallet,
    title: budget.is_owner
      ? inlineEdit('budget', budget.name, { cls: 'srow-input', label: B.nameLabel, max: 60 })
      : esc(budget.name),
    note: B.nameNote,
  });
  const members = budget.members
    .map((m) =>
      srow({
        icon: UI.user,
        title: esc(m.name),
        note: [m.is_me ? B.you : '', m.is_owner ? B.owner : `${int.format(m.receipts)} ${pl(m.receipts, B.receipts)}`]
          .filter(Boolean)
          .join(' · '),
        end: budget.is_owner && !m.is_me ? endBtn(`data-remove-member="${m.id}"`, UI.close, B.remove) : '',
      }),
    )
    .join('');
  const invite = budget.is_owner ? srow({ icon: UI.userPlus, title: B.invite, note: B.inviteNote, attrs: 'data-invite' }) : '';
  const leave = budget.is_home ? '' : srow({ icon: UI.logout, title: B.leave, note: B.leaveNote, attrs: 'data-leave', danger: true });
  return section(B.main, '', name + leave)
    + section(B.members, budget.members.length > 1 ? B.noteShared : B.noteAlone, members + invite);
}

/**
 * Приглашение — своим листом, а не системным «Поделиться»: тот показывает всё, что умеет
 * принимать ссылки (такси, банки, билеты), и настроить его страница не может. Здесь —
 * только мессенджеры и почта: у каждого есть ссылка, открывающая приложение с готовым текстом.
 * Системное окно осталось запасным пунктом «Другое…».
 */
async function shareInvite(button) {
  button.disabled = true;
  let invite;
  try {
    invite = await api('/api/budget/invites', { method: 'POST' });
  } catch (err) {
    button.disabled = false;
    return toast(`Не вышло: ${err.message}`);
  }
  button.disabled = false;

  const text = 'Присоединяйся к нашему бюджету в Чекере';
  const both = `${text}: ${invite.url}`;
  const enc = encodeURIComponent;
  // Логотипы мессенджеров — официальные, файлами: у Макса он градиентный и тяжёлый для кода
  const logo = (name) => `<img class="share-logo" src="/shared/brand/${name}.svg" alt="" />`;
  const targets = [
    // Сайты Telegram и WhatsApp из России открываются не всегда — ссылки сразу в приложения, как у входа
    ['Telegram', logo('telegram'), `tg://msg_url?url=${enc(invite.url)}&text=${enc(text)}`],
    ['WhatsApp', logo('whatsapp'), `whatsapp://send?text=${enc(both)}`],
    ['Макс', logo('max'), `https://max.ru/:share?text=${enc(both)}`],
    ['Почта', `<span class="share-ic">${UI.mail}</span>`, `mailto:?subject=${enc('Приглашение в Чекер')}&body=${enc(`${text}:\n${invite.url}`)}`],
  ];

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `
    <div class="sheet-box" role="dialog" aria-label="Пригласить в бюджет">
      <div class="sheet-top">
        <div>
          <div class="sheet-sum-total">Пригласить</div>
          <div class="note">Выберите, куда отправить ссылку</div>
        </div>
        <button class="icon-btn soft" data-close type="button" aria-label="Закрыть" title="Закрыть">${UI.close}</button>
      </div>
      <div class="picker-list share-list">
        ${targets
          .map(([name, icon, href]) => `
            <a class="picker-item share-item" href="${esc(href)}"${href.startsWith('https:') ? ' target="_blank" rel="noopener"' : ''} data-share>
              ${icon}<span>${name}</span>
            </a>`)
          .join('')}
        <button class="picker-item share-item" type="button" data-copy>
          <span class="share-ic">${UI.copy}</span><span>Скопировать ссылку</span>
        </button>
      </div>
      ${navigator.share ? '<button class="link share-more" type="button" data-more>Другое…</button>' : ''}
    </div>`;
  openPopup(sheet);

  sheet.addEventListener('click', async (e) => {
    if (e.target === sheet || e.target.closest('[data-close]')) return closePopup(sheet);
    if (e.target.closest('[data-share]')) return setTimeout(() => closePopup(sheet), 300); // ссылка уже открывается
    if (e.target.closest('[data-copy]')) {
      await navigator.clipboard?.writeText(invite.url).catch(() => {});
      toast('Ссылка скопирована — отправьте её тому, кого приглашаете');
      return closePopup(sheet);
    }
    if (e.target.closest('[data-more]')) {
      closePopup(sheet);
      await navigator.share({ title: 'Чекер', text, url: invite.url }).catch(() => {});
    }
  });
}

/** Настройки: кто вошёл, бюджет, выход и удаление аккаунта. */
/**
 * Данные настроек — профиль, бюджет, банки — держим в памяти: экраны настроек простые, и
 * ждать сеть при каждом переходе между ними незачем. Экран рисуется сразу из того, что уже
 * знаем, а свежий ответ приходит следом и перерисовывает экран, только если что-то изменилось.
 */
const kept = new Map();
function apiKept(path) {
  const had = kept.get(path);
  const fresh = api(path).then((value) => {
    kept.set(path, value);
    if (had !== undefined && JSON.stringify(had) !== JSON.stringify(value) && state.screen.startsWith('set')) render();
    return value;
  });
  if (had === undefined) return fresh;
  fresh.catch(() => {});
  return Promise.resolve(had);
}

async function screenSettings() {
  const [me, budget, bank] = await Promise.all([
    apiKept('/api/session').catch(() => null),
    apiKept('/api/budget').catch(() => null),
    inApp() ? apiKept('/api/bank').catch(() => null) : null,
  ]);
  const S = T.settings;
  const members = budget?.members.length ?? 0;
  const banks = BANKS.filter((b) => inApp() && bankState(b.id) !== 'off').map((b) => b.name);
  // «12 групп · 40 категорий» — одинаково для расходов и доходов
  const counts = (groups = []) => {
    const cats = groups.reduce((n, g) => n + g.subcategories.length, 0);
    return f(S.cats.expenseNote, {
      groups: int.format(groups.length), gw: pl(groups.length, S.cats.groupsW), cats: int.format(cats), cw: pl(cats, S.cats.catsW),
    });
  };
  const link = (id, icon, title, note) => srow({ icon, title, note: esc(note), attrs: `data-set="${id}"`, end: GO });
  // Разделы — строками: каждая ведёт на свой экран. Так в настройки помещаются новые
  // разделы, а главный экран остаётся коротким
  return section(S.menu.label, '',
    link('profile', UI.user, S.profile.label, me?.name || (me?.telegram ? S.profile.viaTelegram : S.profile.viaPassword))
    + (budget ? link('budget', UI.wallet, S.budget.label, `${budget.name} · ${int.format(members)} ${pl(members, S.menu.members)}`) : '')
    + (inApp() ? link('banks', UI.bank, S.banks.label, banks.length ? banks.join(', ') : S.menu.banksNone) : '')
    // «Данные» — сразу страница о данных, без промежуточного экрана
    + srow({ icon: UI.shield, title: S.data.label, note: S.data.note, attrs: 'data-privacy', end: GO }))
    + section(S.cats.label, S.cats.listNote,
      link('cats', UI.wallet, S.cats.expense, counts(meta?.categories))
      + link('incats', UI.income, S.cats.income, counts(meta?.income)));
}

async function screenSetProfile() {
  const me = await apiKept('/api/session').catch(() => null);
  const P = T.settings.profile;
  return section(P.block, me?.telegram ? P.viaTelegram : P.viaPassword,
    srow({
      icon: UI.user,
      title: inlineEdit('name', me?.name ?? '', { cls: 'srow-input', label: P.nameLabel, placeholder: P.namePlaceholder, max: 60 }),
      note: P.nameNote,
    }) + srow({ icon: UI.logout, title: P.logout, attrs: 'data-logout' })
      + (me?.role === 'admin'
        ? ''
        : srow({ icon: UI.trash, title: T.settings.deleteAccount, note: T.settings.data.deleteNote, attrs: 'data-delete-account', danger: true })));
}

async function screenSetBudget() {
  return budgetSection(await apiKept('/api/budget').catch(() => null));
}

async function screenSetBanks() {
  return bankSection(inApp() ? await apiKept('/api/bank').catch(() => null) : null);
}

/** Стрелка «дальше» в сером кружке: строка ведёт на другой экран. */
const GO = `<span class="srow-go">${UI.chevron}</span>`;

/**
 * «Какие данные хранит Чекер» — экраном приложения, а не отдельной страницей: уход на
 * /privacy.html выгружал приложение, и возврат назад запускал его заново. Текст тот же —
 * site/privacy.md; разбор намеренно простой: заголовки, списки, абзацы и **жирный**.
 */
let privacyText = null;
async function screenPrivacy() {
  privacyText ??= await fetch('/privacy.md').then((r) => (r.ok ? r.text() : Promise.reject(new Error(T.common.failed))));
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const html = [];
  let list = false;
  for (const line of privacyText.split('\n')) {
    const text = line.trim();
    const item = text.startsWith('- ');
    if (list && !item) html.push('</ul>');
    if (item && !list) html.push('<ul>');
    list = item;
    if (item) html.push(`<li>${inline(text.slice(2))}</li>`);
    else if (text.startsWith('## ')) html.push(`<h2>${inline(text.slice(3))}</h2>`);
    else if (text.startsWith('# ')) html.push(`<h1>${inline(text.slice(2))}</h1>`);
    else if (text) html.push(`<p>${inline(text)}</p>`);
  }
  if (list) html.push('</ul>');
  return `<article class="card doc">${html.join('')}</article>`;
}

// ── настройка категорий ──────────────────────────────────
// Справочник у бюджета свой: группы (название, значок, цвет) и категории в них (название,
// группа, подсказка). То же, что в разделе «Категории» кабинета, без перетаскивания.

const taxoBase = () => (state.tk === 'in' ? '/api/income/taxonomy' : '/api/taxonomy');
const taxo = () => apiKept(taxoBase());
// Чем меряем категорию: тратами у расходов, поступлениями у доходов
const usedWord = () => (state.tk === 'in' ? T.income.many : T.settings.cats.spendsW);

/** Правка справочника: после неё свежие и сам справочник, и категории во всём приложении. */
async function taxoCall(method, path, body) {
  const res = await api(`${taxoBase()}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  kept.delete(taxoBase());
  screenCache.clear();
  meta = await api('/api/meta');
  return res;
}

const groupBadge = (g) => {
  const color = g.color ?? '#eef1f5';
  return `<span class="gic" style="background:${color};color:${readableText(color)}">${groupIcon(g.icon ?? 'none')}</span>`;
};
const catDot = (color) => `<span class="cat-dot" style="background:${color ?? '#d7dbe2'}"></span>`;
const catTones = (g) => shades(g.color ?? '', g.categories.length, g.shade_from, g.shade_to);
const catUsed = (c) => c.items + (c.ops ?? 0);

// Значок группы в списке нажимается сам по себе: открывает выбор цвета и значка
const lookBadge = (g) => groupBadge(g).replace('class="gic"', `class="gic" data-tlook="${esc(g.slug)}"`);

/** Группы — одним списком: строка ведёт внутрь группы, значок слева — в выбор цвета и значка. */
async function screenSetCats() {
  const C = T.settings.cats;
  const { groups } = await taxo();
  const rows = groups.map((g) => srow({
    icon: lookBadge(g),
    bare: true,
    title: esc(g.name),
    // Подстрочник — сами категории группы; не поместились — строка обрежется многоточием
    note: g.categories.length ? esc(g.categories.map((c) => c.name).join(', ')) : C.unused,
    attrs: `data-tgroup="${esc(g.slug)}"`,
    end: GO,
  }));
  return section(C.groupsBlock, C.listNote, rows.join('') + srow({ icon: UI.plus, title: C.addGroup, attrs: 'data-tgroup-add' }));
}

/** Внутри группы: её настройки и её категории. */
async function screenSetGroup() {
  const C = T.settings.cats;
  const g = (await taxo()).groups.find((x) => x.slug === state.tg);
  if (!g) return `<div class="empty">${C.gone}</div>`;
  const tones = catTones(g);
  const busy = g.categories.length > 0;
  const color = g.color ?? NEW_GROUP_COLOR;
  const { h, s, l } = pleasant(color);
  const cats = g.categories.map((c, i) => {
    const n = catUsed(c);
    return srow({
      icon: catDot(tones[i] ?? g.color).replace('class="cat-dot"', 'class="cat-dot" data-tone'),
      bare: true,
      title: esc(c.name),
      note: n ? `${int.format(n)} ${pl(n, usedWord())}` : C.unused,
      attrs: `data-tcat="${esc(c.slug)}"`,
      end: GO,
    });
  });
  // Цвет и градиент — полосами прямо здесь: двигаешь ползунок — значок группы и кружки
  // категорий ниже перекрашиваются сразу, сохраняется при отпускании
  const bars = `
    <div class="bar-row" style="--pick:${color}">
      <div class="bar-label">${C.color}</div>
      <input class="hue" type="range" min="0" max="359" value="${Math.round(h)}" data-ghue data-s="${s}" data-l="${l}" aria-label="${esc(C.color)}" />
      <div class="bar-label">${C.shade}</div>
      <div class="dual" style="background:linear-gradient(90deg, ${tint(color, 5)}, ${color})">
        <input type="range" min="5" max="100" value="${g.shade_from}" data-shade="shade_from" aria-label="${esc(C.shadeFrom)}" />
        <input type="range" min="5" max="100" value="${g.shade_to}" data-shade="shade_to" aria-label="${esc(C.shadeTo)}" />
      </div>
    </div>`;
  return section(C.groupSettings, '',
    srow({ icon: groupBadge(g), bare: true, title: inlineEdit('tgroup', g.name, { cls: 'srow-input', label: C.group, max: 40 }), note: C.nameNote })
    + srow({ icon: UI.grid, title: C.icon, attrs: 'data-tgroup-icon', end: GO })
    + bars)
    + section(C.catsBlock, '', cats.join('') + srow({ icon: UI.plus, title: C.addCat, attrs: `data-tcat-add="${esc(g.slug)}"` }))
    + section(C.manage, '', srow({
      icon: UI.trash, title: C.deleteGroup, note: busy ? C.deleteGroupBusy : '', attrs: 'data-tgroup-delete', danger: !busy, off: busy,
    }));
}

async function screenSetCat() {
  const C = T.settings.cats;
  const { groups } = await taxo();
  const g = groups.find((x) => x.categories.some((c) => c.slug === state.tc));
  const c = g?.categories.find((x) => x.slug === state.tc);
  if (!c) return `<div class="empty">${C.gone}</div>`;
  const tone = catTones(g)[g.categories.indexOf(c)] ?? g.color;
  return section(C.category, '',
    srow({ icon: catDot(tone), bare: true, title: inlineEdit('tcat', c.name, { cls: 'srow-input', label: C.category, max: 40 }), note: C.nameNote })
    + srow({ icon: groupBadge(g), bare: true, title: C.inGroup, note: esc(g.name), attrs: 'data-tcat-move', end: GO })
    // Подсказка нужна разметке чеков — у доходов её нет
    + (state.tk === 'in' ? '' : srow({ icon: UI.pen, title: inlineEdit('thint', c.hint ?? '', { cls: 'srow-input', label: C.hintPlaceholder, placeholder: C.hintPlaceholder, max: 200 }), note: C.hintNote })))
    + section(C.manage, '', srow({
      icon: UI.trash, title: C.deleteCat, note: catUsed(c) + c.dictionary + c.links ? (state.tk === 'in' ? C.deleteIncomeNote : C.deleteCatNote) : '', attrs: 'data-tcat-delete', danger: true,
    }));
}

// Только что созданная группа или категория открывается с названием в правке
let focusNewNext = false;
function focusNew() {
  if (!focusNewNext) return;
  focusNewNext = false;
  const input = document.querySelector('#screen [data-inline]');
  if (!input) return;
  input.readOnly = false;
  input.focus();
  input.select();
}

/** Лист выбора поверх экрана: заголовок, содержимое, закрытие крестиком и нажатием мимо. */
function openChoice(title, body, onClick) {
  const el = document.createElement('div');
  el.className = 'picker';
  el.innerHTML = `
    <div class="picker-box" role="dialog" aria-label="${esc(title)}">
      <div class="picker-top"><div class="picker-title">${esc(title)}</div>
        <button class="icon-btn soft" data-close type="button" aria-label="Закрыть" title="Закрыть">${UI.close}</button></div>
      ${body}
    </div>`;
  openPopup(el);
  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('[data-close]')) return closePopup(el);
    onClick(e, () => closePopup(el));
  });
  return el;
}

const NEW_GROUP_COLOR = '#3b7bce';

/** Тон, насыщенность и светлота цвета группы — в коридоре, где любой тон смотрится ровно. */
function pleasant(color) {
  const hsl = hexToHsl(color) ?? { h: 212, s: 60, l: 52 };
  return { h: hsl.h, s: Math.min(Math.max(hsl.s, 50), 80), l: Math.min(Math.max(hsl.l, 42), 58) };
}

// Полосы на экране группы: что сейчас выставлено и как это выглядит
function groupBars() {
  const hue = document.querySelector('#screen [data-ghue]');
  if (!hue) return null;
  const [a, b] = [...document.querySelectorAll('#screen [data-shade]')].map((i) => Number(i.value));
  return {
    color: hslToHex(Number(hue.value), Number(hue.dataset.s), Number(hue.dataset.l)),
    shade_from: Math.min(a, b),
    shade_to: Math.max(a, b),
  };
}

$('screen').addEventListener('input', (e) => {
  if (!e.target.matches('[data-ghue], [data-shade]')) return;
  const { color, shade_from, shade_to } = groupBars();
  const row = e.target.closest('.bar-row');
  row.style.setProperty('--pick', color);
  row.querySelector('.dual').style.background = `linear-gradient(90deg, ${tint(color, 5)}, ${color})`;
  const badge = document.querySelector('#screen .gic');
  badge.style.background = color;
  badge.style.color = readableText(color);
  const dots = [...document.querySelectorAll('#screen [data-tone]')];
  shades(color, dots.length, shade_from, shade_to).forEach((tone, i) => (dots[i].style.background = tone));
});

$('screen').addEventListener('change', (e) => {
  if (!e.target.matches('[data-ghue], [data-shade]')) return;
  const bars = groupBars();
  // Сохраняем то, что двигали: цвет или границы градиента. Экран уже выглядит как надо
  const body = e.target.matches('[data-ghue]') ? { color: bars.color } : { shade_from: bars.shade_from, shade_to: bars.shade_to };
  taxoCall('PATCH', `/groups/${encodeURIComponent(state.tg)}`, body).catch((err) => toast(`${T.common.failed}: ${err.message}`));
});

/**
 * Цвет и значок группы. Цвет — радужная полоса: двигаем тон, насыщенность и светлота
 * остаются в приятном коридоре, чтобы любой выбор хорошо смотрелся рядом с остальными.
 * what: both — из списка групп (и полоса, и значки), icon — из настроек группы (только значки).
 */
async function openGroupLook(slug, what) {
  const g = (await taxo()).groups.find((x) => x.slug === slug);
  if (g) openLook({ ...g, save: (body) => taxoCall('PATCH', `/groups/${encodeURIComponent(slug)}`, body) }, what);
}

/** g — у чего меняем вид: название, цвет, значок и save(изменения) — куда сохранять. */
function openLook(g, what) {
  const C = T.settings.cats;
  let color = g.color ?? NEW_GROUP_COLOR;
  let icon = g.icon ?? 'dots';
  const { h: hue0, s: sat, l: lig } = pleasant(color);
  const save = (body) => g.save(body).catch((err) => toast(`${T.common.failed}: ${err.message}`));
  const grid = (names) => names
    .map((n) => `<button class="icon-cell${n === icon ? ' on' : ''}" type="button" data-icon="${esc(n)}">${groupIcon(n)}</button>`)
    .join('');

  const el = openChoice(what === 'icon' ? C.icon : C.look, `
    <div class="look-head"><span class="gic big" id="look-badge"></span><b>${esc(g.name)}</b></div>
    ${what === 'icon' ? '' : `<input class="hue" type="range" min="0" max="359" value="${Math.round(hue0)}" aria-label="${esc(C.color)}" />`}
    <input class="icon-search" type="search" placeholder="${esc(C.iconSearch)}" />
    <div class="icon-cells">${grid(searchIcons(''))}</div>`,
  async (ev, close) => {
    const picked = ev.target.closest('[data-icon]')?.dataset.icon;
    if (!picked) return;
    icon = picked;
    paint();
    for (const cell of el.querySelectorAll('.icon-cell')) cell.classList.toggle('on', cell.dataset.icon === icon);
    await save({ icon });
    if (what === 'icon') close();
  });

  // Значок в шапке попапа показывает выбор сразу, ещё до сохранения
  function paint() {
    const badge = el.querySelector('#look-badge');
    badge.style.background = color;
    badge.style.color = readableText(color);
    badge.innerHTML = groupIcon(icon);
    el.style.setProperty('--pick', color);
  }
  paint();

  const hue = el.querySelector('.hue');
  hue?.addEventListener('input', () => {
    color = hslToHex(Number(hue.value), sat, lig);
    paint();
  });
  hue?.addEventListener('change', () => save({ color })); // отпустили ползунок — сохраняем
  el.querySelector('.icon-search')?.addEventListener('input', (ev) => {
    el.querySelector('.icon-cells').innerHTML = grid(searchIcons(ev.target.value));
  });
}

async function onCatsClick(e) {
  const C = T.settings.cats;
  const hit = (sel) => e.target.closest(sel);
  const failed = (err) => toast(`${T.common.failed}: ${err.message}`);

  if (hit('[data-tlook]')) return openGroupLook(hit('[data-tlook]').dataset.tlook, 'both');
  if (hit('[data-tcat]')) return go({ screen: 'set_cat', tc: hit('[data-tcat]').dataset.tcat });
  if (hit('[data-tgroup]')) return go({ screen: 'set_group', tg: hit('[data-tgroup]').dataset.tgroup });

  if (hit('[data-tcat-add]')) {
    try {
      const { category } = await taxoCall('POST', '/categories', { name: C.newCat, group_slug: hit('[data-tcat-add]').dataset.tcatAdd });
      focusNewNext = true;
      go({ screen: 'set_cat', tc: category.slug });
    } catch (err) { failed(err); }
    return;
  }
  if (hit('[data-tgroup-add]')) {
    try {
      const { group } = await taxoCall('POST', '/groups', { name: C.newGroup, icon: 'dots', color: NEW_GROUP_COLOR });
      focusNewNext = true;
      go({ screen: 'set_group', tg: group.slug });
    } catch (err) { failed(err); }
    return;
  }

  if (hit('[data-tgroup-icon]')) return openGroupLook(state.tg, 'icon');
  if (hit('[data-tgroup-delete]')) {
    const g = (await taxo()).groups.find((x) => x.slug === state.tg);
    if (!g || !confirm(f(C.deleteGroupConfirm, { name: g.name }))) return;
    try {
      await taxoCall('DELETE', `/groups/${encodeURIComponent(g.slug)}`);
      history.back();
    } catch (err) { failed(err); }
    return;
  }

  if (hit('[data-tcat-move]')) {
    const { groups } = await taxo();
    const body = `<div class="picker-list">${groups.map((g) => `
      <button class="picker-item" type="button" data-to="${esc(g.slug)}">${groupBadge(g)}<span>${esc(g.name)}</span></button>`).join('')}</div>`;
    openChoice(C.inGroup, body, async (ev, close) => {
      const to = ev.target.closest('[data-to]')?.dataset.to;
      if (!to) return;
      await taxoCall('PATCH', `/categories/${encodeURIComponent(state.tc)}`, { group_slug: to }).catch(failed);
      close();
    });
    return;
  }
  if (hit('[data-tcat-delete]')) {
    const cats = (await taxo()).groups.flatMap((g) => g.categories);
    const c = cats.find((x) => x.slug === state.tc);
    if (!c) return;
    const remove = async (moveTo) => {
      try {
        await taxoCall('DELETE', `/categories/${encodeURIComponent(c.slug)}${moveTo ? `?move_to=${encodeURIComponent(moveTo)}` : ''}`);
        history.back(); // карточки удалённой категории больше нет — возвращаемся к списку
      } catch (err) { failed(err); }
    };
    // Категорией пользуются — сначала выбираем, куда перенести её траты и правила
    if (catUsed(c) + c.dictionary + c.links) {
      const income = state.tk === 'in';
      openCategoryPicker(null, (_, slug) => {
        const to = cats.find((x) => x.slug === slug);
        if (slug === c.slug || !to) return;
        // Лист выбора закрывается шагом «назад» — ждём его, прежде чем идти дальше
        setTimeout(() => { if (confirm(f(income ? C.moveIncomeConfirm : C.moveConfirm, { name: c.name, to: to.name }))) remove(slug); }, 150);
      }, income ? meta?.income ?? [] : undefined);
    } else if (confirm(f(C.deleteCatConfirm, { name: c.name }))) remove('');
  }
}

// ── разделы и строки настроек ────────────────────────────
// Настройки — это разделы, в разделе — строки. Раздел: название и подстрочник. Строка:
// значок слева (необязательно), название, подстрочник (необязательно) и действие справа
// (необязательно). Один вид на весь экран и на экраны банка — читается одним списком.

/**
 * Раздел — как в Telegram: название мелким цветным шрифтом внутри карточки, пояснение —
 * серым текстом под ней, между блоками. Оба необязательны.
 */
const section = (title, note, rows) => `
  <section class="card sec">
    ${title ? `<div class="sec-title">${title}</div>` : ''}
    ${rows}
  </section>
  ${note ? `<p class="sec-foot">${note}</p>` : ''}`;

/**
 * Строка раздела.
 *   icon  — значок или логотип банка (bare — без подложки: у логотипа она своя);
 *   title — текст или поле правки на месте, note — подстрочник (wrap — в несколько строк,
 *           для пояснений; обычно подстрочник в одну строку и обрезается);
 *   attrs — строка становится кнопкой с этими data-атрибутами, href — ссылкой;
 *   end   — действие справа: отдельная кнопка, её нажатие не открывает строку.
 */
function srow({ icon = '', bare = false, title, note = '', wrap = false, attrs = '', href = '', end = '', danger = false, off = false }) {
  let body =
    (icon ? `<span class="srow-ic${bare ? ' bare' : ''}">${icon}</span>` : '') +
    `<span class="srow-text"><span class="srow-title">${title}</span>${note ? `<small class="note srow-note">${note}</small>` : ''}</span>` +
    (end === GO ? GO : ''); // стрелка «дальше» — часть строки: нажимается вместе с ней
  if (end === GO) end = '';
  const main = href
    ? `<a class="srow-main" href="${href}">${body}</a>`
    : attrs
      ? `<button class="srow-main" type="button" ${attrs}${off ? ' disabled' : ''}>${body}</button>`
      : `<div class="srow-main">${body}</div>`;
  return `<div class="srow${danger ? ' danger' : ''}${off ? ' off' : ''}${wrap ? ' wrap' : ''}">${main}${end}</div>`;
}

/** Круглая кнопка справа: обновить, исключить. Крутится — значит, занята. */
const endBtn = (attrs, icon, label, spin = false) =>
  `<button class="row-icon${spin ? ' spin' : ''}" type="button" ${attrs} aria-label="${esc(label)}" title="${esc(label)}"${spin ? ' disabled' : ''}>${icon}</button>`;



/**
 * Приложение для Android: страница живёт внутри него и через мост window.Checker умеет то,
 * чего браузер не может, — войти в банк на устройстве и забрать оттуда операции. В обычном
 * браузере моста нет, и раздел «Банк» не показывается.
 */
const inApp = () => Boolean(window.Checker);
const appInfo = () => {
  try {
    return JSON.parse(window.Checker.info());
  } catch {
    return {};
  }
};

/**
 * Банк в настройках. Вход в интернет-банк человек проходит сам, в окне банка внутри
 * приложения; сессия остаётся на телефоне, в Чекер приезжают только операции.
 */
/**
 * Банки. Т-Банк уже работает, остальные — на будущее: строка есть, подключение появится.
 * Логотип лежит файлом в /shared/brand; нет файла — рисуем букву банка.
 */
const BANKS = [
  // from — название после «из»: «загрузим историю из Т-Банка»
  { id: 'tbank', name: 'Т-Банк', from: 'Т-Банка', logo: '/shared/brand/tbank.png', ready: true },
  { id: 'vtb', name: 'ВТБ', from: 'ВТБ', logo: '/shared/brand/vtb.svg' },
  { id: 'alfa', name: 'Альфа-Банк', from: 'Альфа-Банка', logo: '/shared/brand/alfa.svg' },
  { id: 'sber', name: 'Сбербанк', from: 'Сбербанка', logo: '/shared/brand/sber.svg', ready: true },
  // Не банк, а магазин: вместо выписки — чеки заказов с товарами. Подключается так же
  { id: 'ozon', name: 'Озон', from: 'Озона', logo: '/shared/brand/ozon.svg', ready: true, shop: true },
  { id: 'wb', name: 'Wildberries', from: 'Wildberries', logo: '/shared/brand/wb.svg', ready: Boolean(window.Checker?.wbSync), shop: true },
];

// Состояние банка на этом устройстве: active | expired | off. У каждого банка своё —
// приложение отдаёт карту banks; поле bank/bankState осталось для старых версий
const bankState = (id) => {
  const info = appInfo();
  return info.banks?.[id] ?? (info.bank === id ? info.bankState : 'off') ?? 'off';
};

const bankById = (id) => BANKS.find((b) => b.id === id);

/** В чём меряется источник: у банка — операции, у магазина — чеки. */
const unitOf = (b) => (b?.shop ? T.common.receipts : T.common.ops);

/** Значок банка: официальный логотип, а если файла нет — буква названия. */
const bankLogo = (b, connected) => `
  <span class="bank-logo${connected ? '' : ' off'}" data-letter="${esc(b.name[0])}">
    <img src="${b.logo}" alt="" onerror="this.remove()" onload="this.parentNode.classList.add('has-logo')" />
  </span>`;

/**
 * Банки в настройках: по строке на банк, как участники бюджета. Слева логотип, внутри
 * название и когда обновлялись операции, справа кнопка обновления. Вход в интернет-банк
 * человек проходит сам, в окне банка внутри приложения; сессия остаётся на телефоне.
 */
function bankSection(bank) {
  if (!inApp()) return '';
  const S = T.settings.banks;
  // В списке только подключённые: остальные — за строкой «Подключить банк», чтобы
  // настройки не заполнялись банками, которыми человек не пользуется
  const rows = BANKS.filter((b) => bankState(b.id) !== 'off')
    .map((b) => {
      const link = bank?.links?.find((l) => l.bank === b.id);
      const expired = bankState(b.id) === 'expired';
      // В подстрочнике — операции за сегодня: общее число за годы ничего не говорит, а
      // сегодняшние видно сразу после обновления
      const today = link?.today ?? 0;
      // Сессия банка истекла — не беда: держать её открытой постоянно незачем. Строка та же,
      // что у подключённого, только значок серый; обновление само начнёт с входа
      const note = `${link?.synced_at ? ago(link.synced_at) : S.neverSynced} · ${
        today ? f(S.today, { n: int.format(today), word: pl(today, unitOf(b)) }) : b.shop ? S.todayNoneShop : S.todayNone
      }`;
      return srow({
        icon: bankLogo(b, !expired),
        bare: true,
        title: b.name,
        note: esc(note),
        attrs: `data-bank-open="${b.id}"`,
        end: endBtn(`data-bank="${expired ? 'relogin' : 'sync'}" data-bank-id="${b.id}"`, UI.refresh, S.refresh, bankSyncing === b.id),
      });
    })
    .join('');
  // Подстрочник — какие банки можно подключить, а если все готовые уже есть — какие скоро
  const off = BANKS.filter((b) => bankState(b.id) === 'off');
  const free = off.filter((b) => b.ready).map((b) => b.name);
  const soon = off.filter((b) => !b.ready).map((b) => b.name);
  const add = srow({
    icon: UI.plus,
    title: S.add,
    note: free.length
      ? f(S.addNote, { names: free.join(', ') })
      : soon.length ? f(S.addNoteSoon, { names: soon.join(', ') }) : S.addNoteNone,
    attrs: 'data-bank-add',
    end: GO,
  });
  return section(S.block, '', rows + add)
    + `<p class="note sec-link"><button class="link" type="button" data-privacy>${T.common.privacy}</button></p>`;
}

/** Экран выбора банка: те, что ещё не подключены. Готовые сверху, «скоро» — ниже. */
function screenBankAdd() {
  const rows = BANKS.filter((b) => !inApp() || bankState(b.id) === 'off')
    .sort((x, y) => Number(Boolean(y.ready)) - Number(Boolean(x.ready)))
    .map((b) =>
      srow({
        icon: bankLogo(b, false),
        bare: true,
        title: b.name,
        note: b.ready ? T.bankAdd.ready : T.bankAdd.soon,
        attrs: b.ready ? `data-bank-open="${b.id}"` : 'data-bank-soon',
        off: !b.ready,
        end: b.ready ? GO : '',
      }),
    )
    .join('');
  return section(T.bankAdd.label, T.bankAdd.hint, rows || `<p class="note">${T.bankAdd.allConnected}</p>`);
}

/**
 * Список фактов: у каждого жирное начало и пояснение. В текстах они лежат парами
 * `<имя>Bold` и `<имя>Text` — так их проще переводить по одной строке.
 */
const facts = (node, names) =>
  names.map((name) => `<li><b>${node[`${name}Bold`]}</b> ${node[`${name}Text`]}</li>`).join('');

/** Хвост счёта: последние цифры карты, а если их нет — самого счёта. */
function tail(a) {
  const digits = String(a.card || a.id || '').replace(/\D/g, '');
  return digits.length >= 4 ? ` •••• ${digits.slice(-4)}` : '';
}

/**
 * Строка действия на странице банка — та же строка, что в настройках: значок слева.
 * «Загрузить всю историю» открывает мастер (data-wizard), остальное — data-bank.
 */
const act = (what, bank, title, icon, danger = false) =>
  srow({
    icon,
    title,
    danger,
    attrs: what === 'wizard' ? `data-wizard="${bank}"` : `data-bank="${what}" data-bank-id="${bank}"`,
  });

// Названия платёжных систем — для подсказки у значка карты
const NETWORKS = { mastercard: 'Mastercard', visa: 'Visa', mir: 'Мир' };

/**
 * Значок счёта: у карты — знак платёжной системы, у остального — значок вида счёта.
 * Систему и вид определяет сервер: по первым цифрам карты или по названию счёта.
 */
function accountIcon(a) {
  if (a.network) {
    return { icon: `<img class="pay-logo" src="/shared/brand/${a.network}.svg" alt="${NETWORKS[a.network]}" />`, bare: true };
  }
  return { icon: a.kind === 'saving' ? UI.piggy : a.kind === 'loan' ? UI.calendar : UI.bank };
}

/** Переключатель справа в строке: включает и выключает счёт. */
const toggle = (attrs, on, label) => `
  <label class="switch" title="${esc(label)}">
    <input type="checkbox" ${attrs}${on ? ' checked' : ''} aria-label="${esc(label)}" />
    <span class="switch-track"></span>
  </label>`;

/**
 * Страница банка: что происходит с данными, и все действия по нему. Вход в интернет-банк
 * проходит на телефоне, поэтому здесь же и объяснение — человек видит его до того,
 * как вводить что-то в окне банка.
 */
async function screenBankCard() {
  const b = bankById(state.bank) ?? BANKS[0];
  const [data, accs] = inApp()
    ? await Promise.all([
        api('/api/bank').catch(() => null),
        api(`/api/bank/accounts?bank=${encodeURIComponent(b.id)}`).catch(() => null),
      ])
    : [null, null];
  const link = data?.links?.find((l) => l.bank === b.id);
  const accounts = accs?.accounts ?? [];
  const conn = inApp() ? bankState(b.id) : 'off';
  const connected = conn !== 'off';
  const expired = conn === 'expired';
  const ops = link?.ops ?? 0;

  return `
    <section class="card sec bank-card">
      <div class="bank-head">
        ${bankLogo(b, connected)}
        <div>
          <div class="budget-name">${b.name}</div>
          <p class="note${expired ? ' error' : ''}">${
            expired
              ? T.bankCard.expired
              : connected
                ? f(T.bankCard.connected, { ops: int.format(ops), opsWord: pl(ops, unitOf(b)) })
                  + (link?.synced_at ? f(T.bankCard.connectedAt, { when: ago(link.synced_at) }) : '')
                : b.ready ? T.bankCard.notConnected : T.bankCard.soon
          }</p>
        </div>
      </div>
      ${srow({ icon: UI.shield, title: T.bankCard.safety.label, note: T.bankCard.safety.rowNote, attrs: `data-bank-safety="${b.id}"`, end: GO })}
    </section>

    ${accounts.length ? section(T.bankCard.accounts.label, T.bankCard.accounts.hint, accounts.map((a) => srow({
      ...accountIcon(a),
      // Цифры счёта не обрезаются: у Сбера три «Сберегательных счёта» различаются только ими
      title: `<span class="acc-title"><span class="acc-name">${esc(a.name || a.id)}</span><span class="acc-tail">${esc(tail(a))}</span></span>`,
      // Вид счёта: у Т-Банка — тип от банка, у Сбера типа нет — по тому, что узнал сервер
      note: `${esc(T.accountTypes[a.type] ?? T.bankCard.accounts.kinds[a.kind] ?? a.type ?? T.bankCard.accounts.kind)}${a.currency && a.currency !== 'RUB' ? ` · ${esc(a.currency)}` : ''} · ${int.format(a.ops)} ${pl(a.ops, T.common.ops)}`,
      end: toggle(`data-bank-acc="${esc(a.id)}" data-ops="${a.ops}"`, a.enabled, T.bankCard.accounts.toggle),
    })).join('')) : ''}

    ${!b.ready
      ? `<div class="settings-actions"><button class="btn big" type="button" disabled>${T.bankCard.soon}</button></div>`
      : !connected
        ? `<div class="settings-actions">${
            canWizard(b.id)
              ? `<button class="btn primary big with-ic" type="button" data-wizard="${b.id}">${UI.login} ${T.settings.banks.connect}</button>`
              : `<button class="btn primary big with-ic" type="button" data-bank="login" data-bank-id="${b.id}">${UI.login} ${T.settings.banks.connect}</button>`
          }</div>`
        : section(T.bankCard.manage.label, '',
            (!expired && canWizard(b.id) ? act('wizard', b.id, T.bankCard.manage.history, UI.history) : '')
            + (!expired ? act('sync', b.id, T.bankCard.manage.sync, UI.refresh) : '')
            + act('login', b.id, T.bankCard.manage.relogin, UI.login)
            + act('forget', b.id, T.bankCard.manage.forget, UI.unlink)
            + (ops && !b.shop ? act('wipe', b.id, T.bankCard.manage.wipe, UI.trash, true) : ''))}`;
}

/**
 * «Безопасность данных» — своим экраном, из строки в шапке страницы банка: как проходит
 * вход и что попадает на сервер. Одинаково для всех банков.
 */
function screenBankSafety() {
  const S = T.bankCard.safety;
  const rows = [
    [UI.phone, 'login'],
    [UI.lock, 'password'],
    [UI.upload, 'server'],
    [UI.eyeOff, 'private'],
  ].map(([icon, name]) => srow({ icon, title: S[`${name}Bold`], note: S[`${name}Text`], wrap: true }));
  // Название раздела уже в шапке экрана — здесь только подстрочник
  return section(S.block, S.note, rows.join('') + srow({ icon: UI.shield, title: T.common.privacy, attrs: 'data-privacy', end: GO }));
}

/** «10 мин назад», «3 ч назад», иначе дата. */
function ago(iso) {
  if (!iso) return '';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return T.common.agoNow;
  if (min < 60) return f(T.common.agoMin, { n: min });
  if (min < 24 * 60) return f(T.common.agoHour, { n: Math.round(min / 60) });
  return dateRu(iso.slice(0, 10));
}

async function onSettingsClick(e) {
    const invite = e.target.closest('[data-invite]');
    if (invite) return shareInvite(invite);

    if (e.target.closest('[data-leave]')) {
      if (!confirm(T.settings.budget.leaveConfirm)) return;
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
      if (!confirm(T.settings.budget.removeConfirm)) return;
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
      if (!confirm(T.settings.profile.logoutConfirm)) return;
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      token.clear();
      location.reload();
    }

    if (e.target.closest('[data-delete-account]')) {
      if (!confirm(T.settings.deleteConfirm)) return;
      if (!confirm(T.settings.deleteConfirm2)) return;
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
  if (e.target.closest('[data-privacy]')) return go({ screen: 'privacy' });
  const set = e.target.closest('[data-set]');
  // Категории расходов и доходов — одни и те же экраны, разный справочник
  if (set && ['cats', 'incats'].includes(set.dataset.set)) return go({ screen: 'set_cats', tk: set.dataset.set === 'incats' ? 'in' : '' });
  if (set) return go({ screen: `set_${set.dataset.set}` });
  if (!state.screen.startsWith('set')) return;
  if (e.target.closest('[data-tlook], [data-tcat], [data-tgroup], [data-tcat-add], [data-tgroup-add], [data-tgroup-icon], [data-tgroup-delete], [data-tcat-move], [data-tcat-delete]')) return onCatsClick(e);
  onSettingsClick(e);
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
    toast(T.settings.budget.nameSaved);
    return data.name;
  },
  // Справочник категорий: название группы, название и подсказка категории
  tgroup: async (name) => (await taxoCall('PATCH', `/groups/${encodeURIComponent(state.tg)}`, { name })).group.name,
  tcat: async (name) => (await taxoCall('PATCH', `/categories/${encodeURIComponent(state.tc)}`, { name })).category.name,
  thint: async (hint) => (await taxoCall('PATCH', `/categories/${encodeURIComponent(state.tc)}`, { hint })).category.hint ?? '',
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

// Приложению нужен токен: фоновая загрузка операций идёт без открытой страницы
if (inApp() && token.get()) window.Checker.saveToken?.(token.get());

/**
 * Новая выкладка сайта. Телефон держит открытую страницу в памяти днями — и в браузере,
 * и в приложении, — поэтому, возвращаясь, сверяем версию с сервером: вышла новая —
 * тихо перезагружаемся на том же месте. Иначе обновление доходит, только когда
 * приложение закроют совсем.
 */
let loadedVersion = null;
fetch('/api/version').then((r) => r.json()).then((v) => (loadedVersion = v.version)).catch(() => {});

async function reloadIfUpdated() {
  if (!loadedVersion || document.querySelector('.sheet, .picker, .scanner')) return; // не рвём начатое
  if (state.screen === 'bank_wizard') return; // мастер ждёт событий от приложения
  try {
    const { version } = await (await fetch('/api/version', { cache: 'no-store' })).json();
    if (version && version !== loadedVersion) location.reload();
  } catch {
    // нет сети — проверим в следующий раз
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  reloadIfUpdated();
  rollMonth();
});

// Приложение открыто со вчера, а месяц за ночь сменился: на экране так и остаётся прошлый,
// и сегодняшних трат не видно. Если человек смотрел «текущий месяц», переводим на новый;
// выбранный руками период не трогаем
let shownMonth = monthPeriod(new Date().getFullYear(), new Date().getMonth());
function rollMonth() {
  const now = monthPeriod(new Date().getFullYear(), new Date().getMonth());
  const was = shownMonth;
  shownMonth = now;
  if (now.from === was.from) return;
  if (state.from !== was.from || state.to !== was.to) return;
  screenCache.clear(); // «Сегодня» и подытоги дней посчитаны вчерашним днём
  go(now, true);
}

/**
 * Длинный тап по строке «6 покупок» разворачивает их: стрелка была слишком мелкой, чтобы
 * в неё попадать. Обычный тап, как и раньше, открывает товар.
 */
let longPress = null;
let longPressFired = false;

$('screen').addEventListener('pointerdown', (e) => {
  const row = e.target.closest('[data-long]');
  if (!row) return;
  longPressFired = false;
  const { clientX: x, clientY: y } = e;
  longPress = {
    x,
    y,
    timer: setTimeout(() => {
      longPressFired = true;
      navigator.vibrate?.(15); // короткий отклик: человек понимает, что сработало
      const key = expandKey(row.dataset.long);
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      render();
    }, 450),
  };
});

const cancelLongPress = (e) => {
  if (!longPress) return;
  // Палец поехал — это прокрутка, а не нажатие
  if (e?.type === 'pointermove' && Math.hypot(e.clientX - longPress.x, e.clientY - longPress.y) < 10) return;
  clearTimeout(longPress.timer);
  longPress = null;
};
for (const type of ['pointerup', 'pointercancel', 'pointermove', 'pointerleave']) {
  $('screen').addEventListener(type, cancelLongPress);
}

// Тап, которым закончилось долгое нажатие, не должен ещё и открывать товар
$('screen').addEventListener('click', (e) => {
  if (!longPressFired) return;
  longPressFired = false;
  e.stopPropagation();
  e.preventDefault();
}, true);

// Долгое нажатие на телефоне вызывает меню выделения — у строк оно ни к чему
$('screen').addEventListener('contextmenu', (e) => {
  if (e.target.closest('[data-long]')) e.preventDefault();
});

/**
 * Комментарий к товару: поле, которое растёт вместе с текстом и сохраняется само, когда
 * человек закончил писать — ушёл из поля. Отдельной кнопки нет: это заметка, а не форма.
 */
const growNote = (el) => {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
};
const fitNote = () => $('item-note') && growNote($('item-note'));

$('screen').addEventListener('input', (e) => {
  if (e.target.matches?.('[data-note]')) growNote(e.target);
});

// Галочка сохранения видна, пока пишут. Нажатие не должно уводить фокус раньше клика —
// тогда поле само потеряет фокус по нашей команде и сохранится как обычно
$('screen').addEventListener('pointerdown', (e) => {
  if (e.target.closest('[data-note-save]')) e.preventDefault();
});
$('screen').addEventListener('click', (e) => {
  if (e.target.closest('[data-note-save]')) $('item-note')?.blur();
});

$('screen').addEventListener('focusout', async (e) => {
  const el = e.target;
  if (!el.matches?.('[data-note]') || el.value === el.defaultValue) return;
  try {
    const res = await post(el.dataset.note, { note: el.value });
    el.value = el.defaultValue = res.note ?? '';
    toast(res.note ? 'Комментарий сохранён' : 'Комментарий удалён');
  } catch (err) {
    toast(`Не сохранилось: ${err.message}`);
  }
});

// Вернулись в приложение (например, из окна банка) — состояние могло измениться
window.addEventListener('checker-resume', () => {
  reloadIfUpdated();
  rollMonth();
  if (state.screen === 'bank_wizard' && wiz?.awaitLogin) {
    if (bankState(wiz.bank) === 'active') {
      wiz.awaitLogin = false;
      wizGo('analyze');
      histNative(wiz.bank).accounts();
    }
    return;
  }
  // Вернулись из окна банка — в настройки. Сессия уже рабочая — обновляем сразу; ещё нет
  // (банк дозавершает вход в фоне) — крутим стрелку и ждём события checker-bank-ready
  if (syncAfterLogin) {
    const id = syncAfterLogin;
    if (state.screen !== 'set_banks') go({ screen: 'set_banks' });
    if (bankState(id) === 'active') {
      syncAfterLogin = null;
      return startBankSync(id);
    }
    bankSyncing = id;
    if (state.screen === 'set_banks') render();
    return;
  }
  if (state.screen === 'set_banks' || state.screen === 'bank_card') render();
});

// Какой банк сейчас обновляется: значок крутится и после перерисовки экрана
let bankSyncing = null;
// Вход начат ради обновления: после него сразу обновить
let syncAfterLogin = null;

// Мост к приложению для конкретного банка: у Сбера свои методы, у Т-Банка свои
function bankBridge(id) {
  const c = window.Checker;
  if (id === 'ozon') return { login: () => c.ozonLogin(), sync: () => c.ozonSync(token.get()), forget: () => c.ozonForget() };
  if (id === 'wb') return { login: () => c.wbLogin(), sync: () => c.wbSync(token.get()), forget: () => c.wbForget() };
  return id === 'sber'
    ? { login: () => c.sberLogin(), sync: () => c.sberSync(token.get()), forget: () => c.sberForget() }
    : { login: () => c.bankLogin(), sync: () => c.bankSync(token.get()), forget: () => c.bankForget() };
}

function startBankSync(id) {
  bankSyncing = id;
  bankBridge(id).sync();
  if (state.screen === 'set_banks') render();
}

// Банк дозавершил вход уже после того, как окно ушло с экрана
window.addEventListener('checker-bank-ready', (e) => {
  const id = e.detail?.bank ?? 'tbank';
  syncAfterLogin = null;
  if (!e.detail?.ok) {
    bankSyncing = null;
    if (state.screen === 'set_banks' || state.screen === 'bank_card') render();
    return;
  }
  if (state.screen !== 'set_banks') go({ screen: 'set_banks' });
  startBankSync(id);
});

// Итог выгрузки приходит от приложения событием: показываем и обновляем экран
window.addEventListener('checker-bank', (e) => {
  bankSyncing = null;
  const r = e.detail ?? {};
  // Показываем новое, а не всё проверенное: банк каждый раз отдаёт и последние дни
  toast(
    r.ok && r.error
      ? f(T.bankCard.sync.failed, { why: r.error }) // что-то загрузилось, но не всё
      : r.ok
      ? r.ops
        ? f(bankById(r.bank)?.shop ? T.bankCard.sync.addedShop : T.bankCard.sync.added, { n: int.format(r.ops) })
        : bankById(r.bank)?.shop ? T.bankCard.sync.noneShop : T.bankCard.sync.none
      : f(T.bankCard.sync.failed, { why: r.error ?? T.bankCard.sync.failedUnknown }),
  );
  if (state.screen === 'set_banks' || state.screen === 'bank_card') render();
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
  // Есть ли банк: от этого зависит третья вкладка в «Расходе»
  api('/api/bank')
    .then((d) => {
      const had = bankLinked;
      // Банк в бюджете — у себя или у другого участника: операции из него видны всем
      bankLinked = (d.links ?? []).some((l) => l.ops > 0) || d.budget_ops > 0;
      if (bankLinked !== had) render();
    })
    .catch(() => {});
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
      return closePopup(sheet);
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
