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
import { shades as lightShades, edge, readableText, hslToHex, hexToHsl, hexToRgb } from '/shared/colors.js';

/**
 * Оттенки категорий группы (см. shared/colors.js). В светлой теме цвет группы разбавляется
 * белым; в тёмной так бледные категории превращались в белёсые точки, поэтому там он
 * разбавляется фоном карточки — порядок и различимость те же, но в тон теме.
 */
function shades(hex, n, from = 25, to = 85) {
  if (document.documentElement.dataset.theme !== 'dark') return lightShades(hex, n, from, to);
  const rgb = hexToRgb(hex);
  if (!rgb || n <= 0) return Array.from({ length: Math.max(0, n) }, () => null);
  const base = { r: 0x18, g: 0x20, b: 0x29 }; // --surface тёмной темы
  const mix = (pct) => {
    const k = 0.08 + 0.92 * (pct / 100); // 1% — почти фон, как в светлой теме почти белый
    const ch = (c, b) => Math.round(b + (c - b) * k).toString(16).padStart(2, '0');
    return `#${ch(rgb.r, base.r)}${ch(rgb.g, base.g)}${ch(rgb.b, base.b)}`;
  };
  if (n === 1) return [mix((from + to) / 2)];
  return Array.from({ length: n }, (_, i) => mix(from + ((to - from) * i) / (n - 1)));
}
import { TG_ICON, keepLinkReady, markWaiting, pendingLogin, forgetLogin, waitLogin } from '/shared/tglogin.js';
import { showPlace, mappable } from '/shared/ymap.js';
import { T, f, pl } from '/m/i18n/index.js';
import qrcode from '/shared/qrcode.js';

const $ = (id) => document.getElementById(id);
const rub = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
const rubExact = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('ru-RU');
const share = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }); // доли: 30 или 30,3

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
  telegram: svg('<path d="M15 10l-4 4l6 6l4-16l-18 7l4 2l2 6l3-4"/>'),
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
  // Лимит: стрелка упирается в черту — «до предела» (Lucide arrow-right-to-line)
  limit: svg('<path d="M17 12H3"/><path d="m11 18 6-6-6-6"/><path d="M21 5v14"/>'),
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
  ring: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 3v5"/><path d="m19.8 16.5-4.3-2.5"/>'),
  chartLine: svg('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 16c.5-2 1.5-7 4-7 2 0 2 3 4 3 2.5 0 4.5-5 5-7"/>'),
  chartBars: svg('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'),
  list: svg('<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>'),
  moon: svg('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
  sparkle: svg('<path d="M9.94 14.06 4 20"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.93 4.93 2.83 2.83"/><path d="m16.24 16.24 2.83 2.83"/><path d="m16.24 7.76 2.83-2.83"/>'),
  search: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  swap: svg('<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>'),
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
  if (options.method && options.method !== 'GET') feedData.clear(); // правка — ленты устарели
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

/**
 * Данные длинных лент (траты, операции банка) — в памяти. Раскрыть день, вернуться из карточки,
 * сменить сортировку — это перерисовка из уже скачанного, а не новые мегабайты за всё время.
 * Свежие данные — после любой правки, обновления банка, «потянуть вниз» или через пару минут.
 */
const feedData = new Map(); // путь → { at, promise }
const FEED_TTL = 2 * 60 * 1000;
// За всё время — десятки мегабайт в памяти; старые выбрасываем. Одному виду аналитики нужно ~11
// ответов (этот и три прошлых периода, доходы, лимиты), и соседи для свайпа — ещё столько же
const FEED_KEEP = 36;

function apiFeed(path) {
  const hit = feedData.get(path);
  if (hit && Date.now() - hit.at < FEED_TTL) return hit.promise;
  const promise = api(path).catch((err) => {
    feedData.delete(path);
    throw err;
  });
  feedData.delete(path);
  feedData.set(path, { at: Date.now(), promise });
  while (feedData.size > FEED_KEEP) feedData.delete(feedData.keys().next().value);
  return promise;
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
 * Период человеческим языком — для заголовка экрана: «Сентябрь 2026», «2026 год»; отрезок до
 * сегодняшнего дня — «За три недели», «За 30 дней»; «Сегодня», «Вчера», «Эта неделя».
 */
function humanPeriod(from, to) {
  if (wholeMonths(from, to)) return periodTitle(from, to);
  const now = new Date();
  const today = isoDay(now);
  const days = Math.round((parseDay(to) - parseDay(from)) / 86400000) + 1;
  const monday = addDays(now, -((now.getDay() + 6) % 7));
  if (from === isoDay(monday) && to === isoDay(addDays(monday, 6))) return 'Эта неделя';
  if (from === isoDay(addDays(monday, -7)) && to === isoDay(addDays(monday, -1))) return 'Прошлая неделя';
  if (from === isoDay(addDays(monday, -7)) && to === isoDay(addDays(monday, 6))) return 'Две недели';
  if (to === today) {
    if (days === 1) return 'Сегодня';
    if (days === 7) return 'За неделю';
    if (days % 7 === 0 && days <= 28) return `За ${['', '', 'две', 'три', 'четыре'][days / 7]} недели`;
    return `За ${days} ${plural(days, 'день', 'дня', 'дней')}`;
  }
  if (from === to && from === isoDay(addDays(now, -1))) return 'Вчера';
  return periodTitle(from, to);
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
  q: '', // поиск в расходах и доходах: слова через пробел, все должны найтись
  ringGroup: '', // кольцо: раскрытая группа — тогда кольцо по её категориям
  ringRest: '', // кольцо: раскрытое «Остальное» — ключи слитых в него секторов через запятую
  sg: '', // расходы: отбор — группа или несколько групп/категорий через запятую (как «Остальное» кольца); NONE — без категории
  mode: (() => {
    try {
      return localStorage.getItem('checker.mode') === 'ring' ? 'ring' : 'list'; // расходы и доходы: список или кольцо
    } catch {
      return 'list';
    }
  })(),
  same: '', // точный отбор «все такие же» из карточки: 'item|название' | 'op|продавец' | 'in|описание'
  inf: '', // фильтр доходов: '' | '-' (без категории) | коды групп доходов через запятую
  isrc: '', // источники доходов: '' — все | bank,manual
  step: '', // деление графика аналитики: '' — по длине периода | d | w | m | q | y
  added: '', // чек, только что добавленный сканом или руками
  sort: 'category', // списки: date | category | name | sum; по умолчанию — defaultSort(экран)
  dir: 'desc',
};

const SCREEN_NAMES = ['summary', 'group', 'category', 'item', 'receipts', 'add', 'manual', 'income_add', 'added', 'income',
  'settings', 'set_profile', 'set_budget', 'set_banks', 'set_cats', 'set_group', 'set_cat', 'privacy', 'stats', 'bank', 'bank_card', 'bank_add', 'bank_safety', 'bank_wizard', 'op', 'autolabel', 'set_motion', 'set_limits', 'set_backup'];
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

/** Сортировка по умолчанию: расходы, доходы и аналитика — по категориям, остальные списки — по дате. */
const defaultSort = (screen) => (['summary', 'income', 'stats'].includes(screen) ? 'category' : 'date');

/**
  * Шапка списка: сумма и подпись слева, справа две кнопки — сортировка и фильтр; ниже период.
  * Кнопка открывает список прямо под собой: строка — значок и название. Так в шапке две
  * кнопки вместо восьми, а что выбрано, видно в подписи под суммой.
  */
/**
 * Поиск в строке периода: на всё оставшееся место, как кнопка даты. Ищет по уже загруженному —
 * выборка обновляется на каждый символ без запросов к серверу.
 */
const searchBox = () => `
  <label class="search">
    <span class="search-ic">${UI.search}</span>
    <input id="q" type="search" value="${esc(state.q)}" placeholder="Поиск" enterkeyhint="search" autocomplete="off" />
    <button class="search-x" type="button" data-q-clear aria-label="Очистить"${state.q ? '' : ' hidden'}>${UI.close}</button>
  </label>`;

const searchNorm = (v) => String(v ?? '').toLowerCase().replace(/ё/g, 'е');

/** Ключ «такой же» — как у правил на сервере (ruleKey, incomeKey): без регистра, знаков и лишних пробелов. */
const sameKey = (v) => {
  const k = searchNorm(v).replace(/[^a-zа-я0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return k.length >= 2 ? k : null;
};

/**
 * Точный отбор «все такие же» (state.same): тот же товар по названию, та же трата по продавцу,
 * тот же доход по описанию — ровно те, что посчитаны в карточке как «затронет N».
 */
function sameAs(kind, row) {
  const [want, ...rest] = state.same.split('|');
  const key = rest.join('|');
  if (kind !== want) return false;
  if (kind === 'item') return row.name_norm === key;
  if (kind === 'op') return sameKey(opWho(row)) === key;
  return sameKey(row.description || row.sender || row.merchant) === key;
}

/**
 * Подходит ли запись под поиск: каждое слово запроса — в одном из полей. Число — ещё и сумма:
 * «244» — траты от 244,00 до 244,99 ₽, «244,50» — ровно 244,50 (amounts — в копейках, у валютной
 * траты и сумма в валюте). Сумма — точно, а не вхождением цифр: иначе «70» нашло бы и 170, и 7000.
 */
function matchesQ(fields, amounts = []) {
  const words = searchNorm(state.q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = searchNorm(fields.filter(Boolean).join(' '));
  const sums = amounts.filter((a) => a != null).map((a) => Math.abs(a));
  return words.every((w) => {
    if (hay.includes(w)) return true;
    const num = w.match(/^(\d+)(?:[.,](\d{1,2}))?$/);
    if (!num) return false;
    const rub = Number(num[1]) * 100;
    if (num[2] == null) return sums.some((a) => a >= rub && a < rub + 100);
    return sums.includes(rub + Number(num[2].padEnd(2, '0')));
  });
}

const listHead = ({ sum, note, sorts = ['date', 'name', 'sum'], filters = '', search = false, mode = false, extra = '' }) => `
  <div class="total compact">
    <div class="head-top">
      <div class="head-sum">
        <span class="total-sum">${sum}</span>
        <span class="total-note">${note}</span>
      </div>
      <div class="head-btns">
        ${sorts && !(mode && state.mode === 'ring') ? sortDrop(sorts === true ? undefined : sorts) : ''}
        ${filters}
        ${extra}
        ${mode ? `<button class="drop-btn" type="button" data-mode-toggle
          aria-label="${state.mode === 'ring' ? 'Показать списком' : 'Показать кольцом'}" title="${state.mode === 'ring' ? 'Списком' : 'Кольцом'}">${state.mode === 'ring' ? UI.list : UI.ring}</button>` : ''}
      </div>
    </div>
    <div class="head-line">
      ${periodNav(true)}
      ${search ? searchBox() : ''}
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
  ['failed', 'Чеки с ошибкой'], // в фильтре — только когда такие есть (sourceChips)
];

/** Короткие подписи источников — плитки листа фильтров и подпись под суммой при нескольких. */
const SOURCE_SHORT = { receipt: 'Чеки', market: 'Маркетплейсы', bank: 'Банк', manual: 'Вручную', failed: 'С ошибкой' };
/** Источник проходит отбор: ничего не выбрано — проходят все. */
const srcOn = (kind) => !state.src || state.src.split(',').includes(kind);
/** Подпись отбора по источникам: один — «только чеки», несколько — «чеки, банк». */
const srcNote = () => {
  const keys = state.src.split(',');
  return keys.length === 1 ? SOURCE_FILTERS.find(([k]) => k === keys[0])?.[1].toLowerCase() ?? ''
    : keys.map((k) => SOURCE_SHORT[k]?.toLowerCase()).filter(Boolean).join(', ');
};

const sourceChips = () => drop(UI.filter, 'Фильтр',
  // Что-то отобрано — первой строкой «Сбросить фильтры»: источник и группы разом
  (state.src || state.sg ? dropRow('data-reset-filters', UI.close, 'Сбросить фильтры', false) + '<div class="drop-sep"></div>' : '')
  + dropRow('data-src=""', UI.layers, 'Все источники', !state.src)
  + SOURCE_FILTERS.filter(([key]) => key !== 'failed' || failedCount > 0 || state.src === 'failed')
    .map(([key, label]) => dropRow(`data-src="${key}"`, SOURCES[key].icon, label, state.src === key)).join('')
  // Группа: все покупки только её категорий. Повторное нажатие снимает. Внутри кольца группы
  // (и раскрытого «Остального») групп не предлагаем: другая группа дала бы пустое кольцо
  + (state.screen !== 'stats' && state.mode === 'ring' && (state.ringGroup || state.ringRest) ? '' : '<div class="drop-sep"></div>'
    + (meta?.categories ?? []).map((g) => dropRow(`data-sg="${esc(g.slug)}"`, groupIcon(g.icon ?? 'none'), g.name, state.sg === g.slug)).join('')
    + dropRow(`data-sg="${NONE}"`, groupIcon('none'), 'Без категории', state.sg === NONE)),
  Boolean(state.src || state.sg));

/** Сортировка. Выбранная строка показывает направление; повторное нажатие его разворачивает. */
const sortDrop = (keys = ['date', 'name', 'sum']) => drop(UI.sort, 'Сортировка', keys
  .map((key) => {
    const [label, , icon] = SORTS[key];
    // Стрелка — значком, а не символом: символ ↓ телефон может нарисовать цветным эмодзи
    const arrow = `<span class="sort-dir${state.dir === 'asc' ? ' asc' : ''}">${UI.arrow}</span>`;
    return dropRow(`data-sort="${key}"`, UI[icon], label, state.sort === key, arrow);
  })
  .join(''));

// Меню (фильтр, сортировка) на телефоне — листом снизу, как принято в мобильных приложениях:
// выпадающий список не помещался и не листался пальцем. Строки листа — копия скрытого меню
// у кнопки; нажатая строка нажимает свою копию в меню, и дальше работают обычные обработчики.
// Сначала лист закрывается (снимает свою запись истории), выбор — уже после: иначе «назад»
// от закрытия вернул бы прежнее состояние поверх выбора
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-drop]');
  if (!btn) return;
  const menu = btn.nextElementSibling;
  // Сортировка — коротким попапом прямо из кнопки, как выбор периода на острове: пунктов
  // мало, лист снизу для них — лишнее движение через весь экран
  if (btn.title === 'Сортировка' || 'pop' in btn.dataset) return dropPopOpen(btn, menu);
  if (menu.querySelector('[data-sg], [data-inf]')) return openFilterSheet(Boolean(menu.querySelector('[data-inf]'))); // источники и группы — плитками
  const sheet = openChoice(btn.title, `<div class="choice-list">${menu.innerHTML}</div>`, (ev, close) => {
    const row = ev.target.closest('.drop-row');
    if (!row) return;
    const i = [...sheet.querySelectorAll('.drop-row')].indexOf(row);
    // Строку ищем в меню, которое на экране сейчас: экран мог уже перерисоваться (данные из
    // памяти — мгновенно), и прежнее меню отцеплено — нажатие на него никуда не доходило
    const title = btn.title;
    const pick = () => {
      const now = [...document.querySelectorAll('[data-drop]')].find((b) => b.title === title)?.nextElementSibling ?? menu;
      now.querySelectorAll('.drop-row')[i]?.click();
    };
    if (history.state?.popup) addEventListener('popstate', () => setTimeout(pick, 0), { once: true });
    else setTimeout(pick, 0);
    close();
  });
});

/**
 * Плитка выбора: значок, мелкая подпись под ним; выбранная — с кружком-галочкой на углу значка.
 * Одна и та же в листе фильтров и в выборе группы везде в приложении
 */
const pickTile = (attr, ic, name, on = false) => `<button class="picker-tile filt-tile${on ? ' on' : ''}" type="button" ${attr}>
  <span class="filt-ic">${ic}<b class="filt-check">${UI.ok}</b></span><span class="picker-tile-name">${esc(name)}</span></button>`;
/** Значок группы для плитки — её цветом. */
const groupTileIc = (g) => {
  const color = g.color ?? 'var(--fill)';
  return `<span class="pick-ic big" style="background:${color};color:${readableText(color)}">${groupIcon(g.icon ?? 'none')}</span>`;
};

/**
 * Лист фильтров «Расхода» и «Аналитики»: верхний ряд — источники, под чертой — группы, плитками
 * со значками. Выбрать можно несколько; выбранная плитка — с кружком-галочкой. Отбор применяется,
 * когда лист закрывают (галочка, мимо, «назад»; крестик — сбросив всё): применять на ходу нельзя — перерисовка
 * экрана под листом спорила бы с его записью в истории
 */
function openFilterSheet(income = false) {
  // Расходы: источники и группы расходов (src, sg). Доходы: банк или вручную и группы доходов (isrc, inf)
  const cfg = income
    ? { srcKey: 'isrc', groupKey: 'inf', sources: ['bank', 'manual'], none: '-', groups: meta?.income ?? [], noneName: T.income.noCategory }
    : { srcKey: 'src', groupKey: 'sg', sources: Object.keys(SOURCE_SHORT), none: NONE, groups: meta?.categories ?? [], noneName: 'Без категории' };
  const src = new Set(state[cfg.srcKey] ? state[cfg.srcKey].split(',') : []);
  const sg = new Set(state[cfg.groupKey] ? state[cfg.groupKey].split(',') : []);
  const sources = cfg.sources.filter((k) => k !== 'failed' || failedCount > 0 || src.has(k))
    .map((k) => pickTile(`data-fsrc="${k}"`, `<span class="pick-ic big filt-src-ic">${SOURCES[k].icon}</span>`, SOURCE_SHORT[k], src.has(k))).join('');
  const groups = [...cfg.groups, { slug: cfg.none, name: cfg.noneName, icon: 'none' }]
    .map((g) => pickTile(`data-fsg="${esc(g.slug)}"`, groupTileIc(g), g.name, sg.has(g.slug))).join('');
  const body = `<div class="filt-row">${sources}</div><div class="filt-sep"></div><div class="filt-grid">${groups}</div>`;
  // Вверху справа: крестик — сбросить всё и закрыть, галочка — показать выбранное
  const action = `<span class="picker-acts">
    <button class="icon-btn soft" type="button" data-filt-reset aria-label="Сбросить фильтры" title="Сбросить">${UI.close}</button>
    <button class="icon-btn primary" type="button" data-filt-apply aria-label="Показать" title="Показать">${UI.ok}</button></span>`;
  const sheet = openChoice('Фильтр', body, (e, close) => {
    const t = e.target.closest('[data-fsrc], [data-fsg]');
    if (t) {
      const [set, key] = t.dataset.fsrc ? [src, t.dataset.fsrc] : [sg, t.dataset.fsg];
      if (!set.delete(key)) set.add(key);
      t.classList.toggle('on', set.has(key));
      navigator.vibrate?.(8);
      return;
    }
    if (e.target.closest('[data-filt-reset]')) {
      src.clear();
      sg.clear();
      return close();
    }
    if (e.target.closest('[data-filt-apply]')) close();
  }, { action });
  // Лист закрыли — применяем, когда отработает «назад» (его запись в истории)
  const apply = () => {
    const next = { [cfg.srcKey]: [...src].join(','), [cfg.groupKey]: [...sg].join(',') };
    if (next[cfg.srcKey] === state[cfg.srcKey] && next[cfg.groupKey] === state[cfg.groupKey]) return;
    pulseNext = 'count';
    go({ ...next, ringGroup: '', ringRest: '' }, true);
  };
  new MutationObserver((_, mo) => {
    if (sheet.isConnected) return;
    mo.disconnect();
    if (history.state?.popup) addEventListener('popstate', () => setTimeout(apply, 0), { once: true });
    else setTimeout(apply, 0);
  }).observe(sheet.parentNode, { childList: true });
}


// ── попап меню у кнопки (сортировка) ──
// Вырастает из кнопки вниз, как попап периода на острове (.quick). Строки — копия скрытого
// меню у кнопки; нажатая строка нажимает свою копию в меню, которое на экране сейчас
let dropPop = null; // { el, title }

function dropPopOpen(btn, menu) {
  dropPopClose(true);
  const el = document.createElement('div');
  el.className = 'quick quick-menu';
  el.innerHTML = menu.innerHTML;
  document.body.appendChild(el);
  // Под кнопкой, правым краем к её правому краю, не вылезая за экран
  const r = btn.getBoundingClientRect();
  const w = el.offsetWidth;
  const left = Math.min(Math.max(10, r.right - w), innerWidth - 10 - w);
  el.style.left = `${left}px`;
  el.style.top = `${r.bottom + 8}px`;
  el.style.transformOrigin = `${r.left + r.width / 2 - left}px 0`;
  if (motion('sheets')) {
    el.animate([{ opacity: 0, transform: 'scale(0.5)' }, { opacity: 1, transform: 'none' }],
      { duration: 200, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.15)' });
  }
  dropPop = { el, title: btn.title };
}

function dropPopClose(now = false) {
  const el = dropPop?.el;
  if (!el) return;
  dropPop = null;
  if (now || !motion('sheets')) return el.remove();
  el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.8)' }], { duration: 120, easing: 'ease-in' })
    .finished.then(() => el.remove(), () => el.remove());
}

/** Выбрать строку попапа: нажать её копию в меню у кнопки, которое на экране сейчас. */
function dropPopPick(row) {
  const { el, title } = dropPop;
  const i = [...el.querySelectorAll('.drop-row')].indexOf(row);
  dropPopClose();
  const now = [...document.querySelectorAll('[data-drop]')].find((b) => b.title === title)?.nextElementSibling;
  now?.querySelectorAll('.drop-row')[i]?.click();
}

// Попап открыт: строка — выбор, мимо — закрыть (нажатие на ту же кнопку не открывает его снова)
document.addEventListener('click', (e) => {
  // Нажатие, которым кончилось долгое, — не переключение попапа: он уже открыт
  if (dropHold?.ate && e.target.closest('[data-drop]')) {
    dropHold.ate = false;
    e.stopPropagation();
    return;
  }
  if (!dropPop) return;
  const { el, title } = dropPop;
  const row = e.target.closest('.drop-row');
  if (row && el.contains(row)) {
    dropPopPick(row);
    e.stopPropagation();
    return;
  }
  if (el.contains(e.target)) return;
  const again = e.target.closest('[data-drop]')?.title === title;
  dropPopClose();
  if (again) e.stopPropagation();
}, true);
addEventListener('scroll', () => dropPopClose(), { passive: true });
window.addEventListener('popstate', () => dropPopClose(true));

// Долгое нажатие на сортировку — как на «Расходе» острова: попап открывается, пока палец
// держат; можно, не отпуская, провести до пункта и отпустить, а можно отпустить и нажать.
// Пока палец держит попап, лента не листается и не тянется, вкладки не переключаются
let dropHold = null; // { x, y, timer, held, moved, ate }
const holdsDrop = () => Boolean(dropHold?.held);

document.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('[data-drop]');
  if (dropHold && !dropHold.held) clearTimeout(dropHold.timer);
  if (!btn || btn.title !== 'Сортировка') {
    if (dropHold) dropHold.ate = false;
    return;
  }
  const hold = { x: e.clientX, y: e.clientY, held: false, moved: false, ate: false };
  hold.timer = setTimeout(() => {
    dropPopOpen(btn, btn.nextElementSibling);
    hold.held = true;
    hold.ate = true; // click за отпусканием — не повторное открытие
    navigator.vibrate?.(15);
  }, QUICK_HOLD);
  dropHold = hold;
});
document.addEventListener('pointermove', (e) => {
  if (!dropHold) return;
  if (!dropHold.held) {
    // Палец поехал до срока — это не долгое нажатие
    if (Math.hypot(e.clientX - dropHold.x, e.clientY - dropHold.y) > 10) clearTimeout(dropHold.timer);
    return;
  }
  if (!dropPop) return;
  dropHold.moved = true;
  const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('.drop-row');
  for (const r of dropPop.el.querySelectorAll('.drop-row')) r.classList.toggle('hot', r === row);
});
const dropRelease = (e) => {
  if (!dropHold) return;
  clearTimeout(dropHold.timer);
  if (!dropHold.held) return;
  dropHold.held = false;
  if (!dropPop) return;
  const row = e.type === 'pointerup' && document.elementFromPoint(e.clientX, e.clientY)?.closest('.drop-row');
  if (row && dropPop.el.contains(row)) return dropPopPick(row);
  // Отпустили, не уводя палец, — попап остаётся: пункт можно нажать
  if (dropHold.moved) dropPopClose();
};
document.addEventListener('pointerup', dropRelease);
document.addEventListener('pointercancel', dropRelease);
// Пока палец держит попап, страница не прокручивается
document.addEventListener('touchmove', (e) => {
  if (holdsDrop()) e.preventDefault();
}, { passive: false });
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('[data-drop]')) e.preventDefault();
});

// Корневые экраны: у них нет «назад». «Банк» — такой же вид «Расхода», как чеки,
// в него приходят переключателем, а не вглубь
const TOP = ['summary', 'receipts', 'bank', 'income', 'settings', 'stats'];

// Экраны с периодом: в заголовке под названием — период человеческим языком
const PERIOD_SCREENS = ['summary', 'income', 'group', 'category', 'receipts', 'bank'];
const demoPill = $('demo-pill');

/**
 * Заголовок экрана: название и в той же строке — период человеческим языком. Не помещается —
 * сокращается название, период виден целиком. Метка демо-режима — под заголовком.
 */
function setTitle(main, sub = '') {
  const el = $('title');
  el.innerHTML = `<span class="bar-main">${esc(main)}</span>${sub ? `<span class="bar-period">&nbsp;· ${esc(sub)}</span>` : ''}`;
  el.classList.toggle('long', Boolean(sub)); // с периодом — на пиксель мельче: длинное реже сокращается
  // Всё равно не помещается — ещё на пиксель мельче; дальше уже сокращается название
  el.classList.remove('tight');
  const name = el.querySelector('.bar-main');
  if (name.scrollWidth > name.clientWidth) el.classList.add('tight');
  demoPill.hidden = !meta?.demo;
  demoPill.textContent = T.settings.help.pill;
  document.querySelector('.bar').classList.toggle('demo', Boolean(meta?.demo));
}

const findGroup = (slug) => (meta?.categories ?? []).find((g) => g.slug === slug) ?? null;
/** Значок категории: свой, а не выбран — её группы. found — из findCategory или incomeCat. */
const catIcon = (found) => found?.category?.icon || found?.group?.icon || 'none';

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
  // Поиск набирают уже на экране, после того как его запись в истории сделана, — поэтому
  // запоминаем его здесь же: «назад» из карточки вернёт к той же выборке
  if (!replace) history.replaceState({ ...history.state, scroll: window.scrollY, q: state.q, same: state.same, mode: state.mode, ringGroup: state.ringGroup, ringRest: state.ringRest }, '', location.href);
  Object.assign(state, patch);
  const params = new URLSearchParams({ screen: state.screen, from: state.from, to: state.to });
  if (state.group) params.set('group', state.group);
  if (state.category) params.set('category', state.category);
  if (state.item) params.set('item', state.item);
  if (state.bank) params.set('bank', state.bank);
  if (['set_group', 'set_limits'].includes(state.screen) && state.tg) params.set('tg', state.tg);
  if (state.screen === 'set_cat' && state.tc) params.set('tc', state.tc);
  if (['set_cats', 'set_group', 'set_cat'].includes(state.screen) && state.tk) params.set('tk', state.tk);
  if (state.op) params.set('op', state.op);
  // Отборы «Расхода» действуют и в «Аналитике»: в адресе — чтобы экран из памяти был с ними
  if (['summary', 'stats'].includes(state.screen) && state.src) params.set('src', state.src);
  if (['summary', 'stats'].includes(state.screen) && state.sg) params.set('sg', state.sg);
  if (state.screen === 'income' && state.inf) params.set('inf', state.inf);
  if (state.screen === 'income' && state.isrc) params.set('isrc', state.isrc);
  if (state.screen === 'stats' && state.step) params.set('step', state.step);
  if (state.added) params.set('added', state.added);
  if (state.screen === 'receipts' && state.filter !== 'all') params.set('filter', state.filter);
  const usual = defaultSort(state.screen);
  if (['summary', 'income', 'category', 'receipts', 'bank', 'stats'].includes(state.screen)
    && (state.sort !== usual || state.dir !== SORTS[usual][1])) {
    params.set('sort', state.sort);
    params.set('dir', state.dir);
  }
  history[replace ? 'replaceState' : 'pushState']({ ...state }, '', `?${params}`);
  navDir = replace ? '' : 'fwd';
  return render();
}

// Ссылка на чек (сообщение бота о новом чеке участника): ?receipt=ID — после первой
// отрисовки поверх экрана открывается этот чек
let pendingReceipt = 0;

function readUrl() {
  const p = new URLSearchParams(location.search);
  pendingReceipt = Number(p.get('receipt')) || 0;
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
  state.src = (p.get('src') ?? '').split(',').filter((k) => ['receipt', 'market', 'bank', 'manual', 'failed'].includes(k)).join(',');
  state.inf = p.get('inf') ?? '';
  state.isrc = (p.get('isrc') ?? '').split(',').filter((k) => ['bank', 'manual'].includes(k)).join(',');
  state.step = ['d', 'w', 'm', 'q', 'y'].includes(p.get('step')) ? p.get('step') : '';
  state.sg = p.get('sg') ?? '';
  state.added = p.get('added') ?? '';
  state.filter = FILTERS.includes(p.get('filter')) ? p.get('filter') : 'all';
  state.sort = Object.hasOwn(SORTS, p.get('sort') ?? '') ? p.get('sort') : defaultSort(state.screen);
  state.dir = ['asc', 'desc'].includes(p.get('dir')) ? p.get('dir') : SORTS[state.sort][1];
}

/**
 * Попап живёт одной записью в истории: «назад» закрывает его и остаётся на том же экране.
 * Повторно запись не добавляем — иначе после возврата из карточки товара их станет две.
 */
// Листы снизу выезжают, а затемнение под ними проявляется; закрываются так же, обратно.
// opening — только на первые мгновения: лист, который перерисовывает своё содержимое
// (выбор категории: группы → категории), не должен выезжать заново на каждом шаге
const POPUP_OUT = 180; // мс: столько уезжает закрытый лист
const OPEN_POPUPS = '.sheet:not(.closing), .picker:not(.closing)';

function removePopup(el) {
  if (el.classList.contains('closing')) return;
  if (!motion('sheets')) return el.remove(); // без анимации — сразу
  el.classList.add('closing');
  setTimeout(() => el.remove(), POPUP_OUT);
}

/**
 * Подтверждение — своим окном вместо системного confirm (тот в приложении выглядит как
 * «Подтвердите действие на сайте …»). Окно по центру: текст и две кнопки — «Отмена» и
 * само действие глаголом; опасное — красным. Возвращает промис: true — согласились.
 * «Назад» и нажатие мимо — отказ. Ответ приходит, когда окно уже закрыто и запись истории
 * снята: следующий шаг (переход, «назад» из карточки) не столкнётся с её снятием.
 */
function ask(text, { ok = T.common.yes, danger = false } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'picker ask';
    el.innerHTML = `
      <div class="ask-box" role="alertdialog" aria-label="${esc(text)}">
        <p class="ask-text">${esc(text)}</p>
        <div class="ask-btns">
          <button class="ask-btn" type="button" data-ask="0">${esc(T.common.cancel)}</button>
          <button class="ask-btn${danger ? ' danger' : ''}" type="button" data-ask="1">${esc(ok)}</button>
        </div>
      </div>`;
    let done = false;
    const finish = (yes) => {
      if (done) return;
      done = true;
      // Закрытие снимет запись истории, только если под окном нет другого попапа
      const waits = history.state?.popup && ![...document.querySelectorAll(OPEN_POPUPS)].some((x) => x !== el);
      if (waits) addEventListener('popstate', () => setTimeout(() => resolve(yes), 0), { once: true });
      else setTimeout(() => resolve(yes), 0);
      closePopup(el);
    };
    el.addEventListener('click', (e) => {
      if (e.target === el) return finish(false);
      const btn = e.target.closest('[data-ask]');
      if (btn) finish(btn.dataset.ask === '1');
    });
    // «Назад» закрыл окно (обработчик истории убрал его сам) — это отказ
    addEventListener('popstate', () => {
      if (done) return;
      done = true;
      resolve(false);
    }, { once: true });
    openPopup(el);
  });
}

function openPopup(el) {
  el.classList.add('opening');
  setTimeout(() => el.classList.remove('opening'), 320);
  document.body.appendChild(el);
  if (!history.state?.popup) history.pushState({ ...state, popup: true }, '', location.href);
}

/**
 * Закрыть попап. Его запись из истории снимаем, только если это последний открытый попап:
 * выбор категории поверх чека закрывается сам по себе, а чек должен остаться.
 */
function closePopup(el) {
  removePopup(el);
  if (document.querySelector(OPEN_POPUPS)) return; // под ним ещё один — историю не трогаем
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
const dropPopup = (el) => removePopup(el);

// Прокрутку возвращаем сами: браузер делает это раньше, чем список успевает отрисоваться
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

window.addEventListener('popstate', (e) => {
  // «Назад» над листом с несохранённым: лист остаётся (запись истории — обратно), а вопрос —
  // как при нажатии мимо. Окна поверх листа (тот же вопрос) «назад» закрывает
  const open = [...document.querySelectorAll(OPEN_POPUPS)];
  const guarded = !closingPopup && open.find((p) => p.guard?.());
  if (guarded) {
    history.pushState({ ...state, popup: true }, '', location.href);
    for (const p of open.slice(open.indexOf(guarded) + 1)) removePopup(p);
    closeGuarded(guarded);
    return;
  }
  // popup, sheet и scroll — пометки самой записи истории, в состоянии экрана им делать нечего
  const { popup, sheet, scroll, ...screenState } = e.state ?? {};
  if (e.state) Object.assign(state, screenState);
  else readUrl();
  // «Назад» закрывает открытый попап — и лист, и выбор категории, и календарь
  const hadPopup = closingPopup || Boolean(document.querySelector(OPEN_POPUPS));
  closingPopup = false;
  for (const el of document.querySelectorAll(OPEN_POPUPS)) removePopup(el);
  // Закрыли попап над формой — форму не трогаем: иначе сумма и название сотрутся
  if (hadPopup && keepsForm()) return;
  // Вернулись к списку — туда же, где его оставили. Закрытие попапа экран не двигает
  navDir = 'back';
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
let incomeManual = false; // в бюджете есть доходы, вписанные вручную
/** Есть ли что показать в «Доходе»: банк подключён или доходы вписаны вручную. */
const incomeOn = () => bankLinked || incomeManual;

let failedCount = 0; // сканы с ошибкой: показывать ли «Чеки с ошибкой» в фильтре источников

/** Строка списка: иконка или кружок цвета, название, сумма и доля от итога. */
function row({ href, color, icon, title, note, sum, share }) {
  const swatch = icon
    ? `<span class="ic" style="background:${color ?? 'var(--fill)'};color:${readableText(color ?? 'var(--fill)')}">${groupIcon(icon)}</span>`
    : `<span class="dot" style="background:${color ?? 'var(--fill)'};border-color:${edge(color ?? '#e1e4e8')}"></span>`;
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

/**
 * Запросы «Расхода» за период from…to — те же, что делает экран (screenSummary). Ими же
 * данные соседнего периода загружаются заранее, пока его тянут свайпом (prefetchPeriod).
 */
function summaryFeeds(from, to) {
  // Все траты периода: товары из чеков и ручные записи — по названиям, траты из банка —
  // по операциям. Покупки, у которых нашёлся чек, приходят один раз — чеком
  const params = new URLSearchParams({
    from, to, collapse: collapseMode(), per: '20000',
    sort: ['date', 'name', 'sum'].includes(state.sort) ? state.sort : 'date', dir: state.dir,
  });
  const opsQuery = new URLSearchParams({ from, to, direction: 'debit', kind: 'expense', per: '20000' });
  // Переводы себе — отдельным разделом в конце (только по категориям): видно, что туда ушло
  const withSelf = state.sort === 'category' && srcOn('bank');
  const selfQuery = new URLSearchParams({ from, to, direction: 'debit', kind: 'transfer', per: '20000' });
  // Карточка лимита под кольцом — без отборов: иначе потрачено не сравнить с лимитом
  const withLimit = meta?.limits_on !== false && state.mode === 'ring' && !state.src && !state.sg && !state.q.trim() && !state.ringRest;
  return {
    items: `/api/items?${params}`,
    ops: `/api/bank/ops?${opsQuery}`,
    self: withSelf ? `/api/bank/ops?${selfQuery}` : null,
    limits: withLimit ? `/api/limits/state?from=${from}&to=${to}` : null,
  };
}

async function screenSummary() {
  const feeds = summaryFeeds(state.from, state.to);
  const [data, ops, failed, self, limits] = await Promise.all([
    apiFeed(feeds.items),
    apiFeed(feeds.ops).catch(() => null),
    // Сканы с ошибкой — из памяти лент: свежим запросом на каждую смену периода экран ждал
    // сервер, и свайп периода запинался пустотой. Правка и новый скан память сбрасывают
    apiFeed('/api/scan?state=failed').catch(() => null),
    feeds.self ? apiFeed(feeds.self).catch(() => null) : null,
    feeds.limits ? apiFeed(feeds.limits).catch(() => null) : null,
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
  let shownItems = data.rows.filter((r) => srcOn(itemSource(r)))
    .filter((r) => (state.same ? sameAs('item', r) : matchesQ([r.name, r.seller, r.retail_place, SOURCES[itemSource(r)].title, T.sources[itemSource(r)],
      findCategory(r.category_slug)?.category.name], [r.sum, ...String(r.sums ?? '').split(','), ...String(r.prices ?? '').split(',')]
      .filter((v) => v !== '').map(Number))));
  let shownOps = (srcOn('bank') ? bankRows : [])
    .filter((op) => (state.same ? sameAs('op', op) : matchesQ([op.merchant, op.description, op.account_name, SOURCES.bank.title, T.sources.bank,
      bankById(op.bank)?.name, findCategory(op.category_slug)?.category.name], [op.amount, op.orig_amount])));
  // Отбор по группе — после источника и поиска: строки только её категорий
  // Ключи отбора — группы или категории (из «Остального» кольца категорий)
  const picked = new Set(state.sg ? state.sg.split(',') : []);
  const inGroup = (slug) => !state.sg || picked.has(slug ?? '') || picked.has(findCategory(slug)?.group.slug ?? NONE);
  if (state.sg) {
    shownItems = shownItems.filter((r) => inGroup(r.category_slug));
    shownOps = shownOps.filter((op) => inGroup(op.category_slug));
  }
  // Сканы с ошибкой — строками в «Без категории», «вне суммы»: за ту же покупку может быть
  // операция из банка, и трата посчиталась бы дважды. Сумма и дата — из QR-кода
  const scanRows = srcOn('failed') && (!state.sg || picked.has(NONE) || picked.has(''))
    ? (failed?.jobs ?? []).filter((j) => j.purchased_at.slice(0, 10) >= state.from && j.purchased_at.slice(0, 10) <= state.to)
      .filter((j) => matchesQ([SOURCES.failed.title, 'без категории'], [j.total_sum]))
    : [];
  const total = shownItems.reduce((s, r) => s + r.sum, 0) + shownOps.reduce((s, op) => s + op.amount, 0);
  const count = shownItems.reduce((s, r) => s + (r.positions ?? 1), 0) + shownOps.length;

  // Подпись: сколько покупок, как отсортировано и что отобрано
  // Каждая часть помечена: после нажатия на значок изменившаяся часть подсвечивается
  const part = (name, text) => `<span class="note-part" data-note-part="${name}">${esc(text)}</span>`;
  const note = [
    part('count', `${int.format(count)} ${plural(count, 'покупка', 'покупки', 'покупок')}`),
    SORTS[state.sort] ? part('sort', SORTS[state.sort][0].toLowerCase()) : '',
    state.src ? part('src', srcNote()) : '',
    state.sg ? part('src', [...picked].map((k) => (k === NONE ? 'без категории' : findGroup(k)?.name ?? findCategory(k)?.category.name ?? '')).join(', ')) : '',
    state.q ? part('q', state.same ? `только «${state.q.trim()}»` : `поиск «${state.q.trim()}»`) : '',
    perDayNote(shownItems, shownOps, part),
  ].filter(Boolean).join(' · ');

  const head = `
    <div class="stuck-head">
      ${listHead({
        sum: money(total),
        note,
        sorts: ['date', 'category', 'name', 'sum'],
        filters: sourceChips(),
        search: true,
        mode: true,
      })}
    </div>`;


  const selfRows = (state.sg ? [] : self?.rows ?? []).filter((op) => state.same ? sameAs('op', op) : matchesQ([op.merchant, op.description, op.account_name, SOURCES.bank.title,
    T.sources.bank, bankById(op.bank)?.name, 'перевод себе'], [op.amount, op.orig_amount]));
  if (state.mode === 'ring') {
    // Кольцо: доли групп. Сумма группы — по категории каждой строки; без категории — серым
    const byGroup = new Map();
    const add = (slug, sum) => {
      const g = slug ? findCategory(slug)?.group : null;
      const key = g?.slug ?? NONE;
      byGroup.set(key, (byGroup.get(key) ?? 0) + sum);
    };
    shownItems.forEach((r) => add(r.category_slug, r.sum));
    shownOps.forEach((op) => add(op.category_slug, op.amount));
    const opened = state.ringGroup && findGroup(state.ringGroup);
    if (opened) {
      // Кольцо категорий группы: суммы — по категориям её строк, цвета — оттенки группы
      const byCat = new Map();
      const addCat = (slug, sum) => byCat.set(slug, (byCat.get(slug) ?? 0) + sum);
      shownItems.forEach((r) => addCat(r.category_slug, r.sum));
      shownOps.forEach((op) => addCat(op.category_slug, op.amount));
      const cats = opened.subcategories.map((c) => ({
        key: c.slug, name: c.name, color: categoryColor(opened.slug, c.slug) ?? opened.color, icon: c.icon || opened.icon, sum: byCat.get(c.slug) ?? 0,
      }));
      const groupSum = cats.reduce((n, c) => n + c.sum, 0);
      return `${head}${ringView(cats, groupSum, opened.name, 'summary-cat', total, limitCard(limits, opened.slug))}`;
    }
    // Сколько непустых категорий в группе: одна — нажатие ведёт сразу в список, кольцо из
    // одного сектора ничего не добавляет. Кроме группы с лимитом: под её кольцом — карточка лимита
    const catsOf = new Map();
    const note = (slug, sum) => {
      const g = slug && sum > 0 ? findCategory(slug)?.group.slug : null;
      if (g) catsOf.set(g, (catsOf.get(g) ?? new Set()).add(slug));
    };
    shownItems.forEach((r) => note(r.category_slug, r.sum));
    shownOps.forEach((op) => note(op.category_slug, op.amount));
    const parts = (meta?.categories ?? []).map((g) => ({
      key: g.slug, name: g.name, color: g.color, icon: g.icon, sum: byGroup.get(g.slug) ?? 0,
      single: catsOf.get(g.slug)?.size === 1 && !(meta?.limits?.[g.slug] > 0),
    }));
    parts.push({ key: NONE, name: 'Без категории', color: '#c9ced6', icon: 'none', sum: byGroup.get(NONE) ?? 0 });
    return `${head}${ringView(parts, total, `${int.format(count)} ${plural(count, 'покупка', 'покупки', 'покупок')}`, 'summary', null, limitCard(limits))}`;
  }
  return `${head}${await spendingFeed(shownItems, shownOps, selfRows, scanRows)}`;
}

/**
 * Кольцо долей: сегмент на группу (её цвет, тонкий зазор между соседями), в центре — итог.
 * Значки групп — напротив своих секторов, с суммой и долей под каждым; ниже — расшифровка таблицей:
 * доля и сумма читаются и без цвета. Нажатие на значок, сегмент или строку открывает группу.
 */
/**
 * Заглавие расходов и доходов: раздел или что раскрыто — группа (кольцо группы или список,
 * отобранный по ней), категория или «Остальное». nameOf — название группы или категории по ключу.
 */
function ringTitle(base, nameOf) {
  const names = [];
  if (state.mode === 'ring') {
    if (state.ringGroup) names.push(nameOf(state.ringGroup));
    if (state.ringRest) names.push('Остальное');
  } else {
    const filter = state.screen === 'summary' ? state.sg : state.screen === 'income' ? state.inf : '';
    const keys = filter ? filter.split(',') : [];
    // Отобрано несколько (фильтр с выбором или «Остальное» кольца) — названиями, а не «Остальное»:
    // две — обе, больше — две и сколько ещё
    const list = keys.map(nameOf).filter(Boolean);
    if (list.length) names.push(list.length <= 2 ? list.join(', ') : `${list.slice(0, 2).join(', ')} и ещё ${list.length - 2}`);
  }
  // Раскрытое — вместо названия раздела: рядом ещё период, а раздел видно по вкладке
  const shown = names.filter(Boolean);
  return shown.length ? shown.join(' · ') : base;
}

// Какое кольцо анимировали последним и когда (at — первый нарисованный кадр). Разметка кольца
// одна и та же при любом показе, а анимацию включает playRing уже на экране.
//
// Анимация не должна совпасть с разбором свежих данных: телефон на это время замирает, и
// заливка запинается. При переходе на вкладку сначала мгновенно показывается сохранённый вид —
// заливка идёт сразу по нему, а свежие данные render запрашивает уже после неё (ringNow).
// При смене периода кольцо и так появляется уже с данными. playRing(false) — только показать
// пустое кольцо, не пуская заливку
let ringPlayed = { key: '', at: null };

// Сектор кольца — фигура со слегка скруглёнными углами (у линии с dasharray углы только
// острые или круглые на всю толщину). Углы — от вершины по часовой, в радианах; кольцо —
// между радиусами 22 и 30 в квадрате 100×100. У узкого сектора радиус скругления меньше:
// иначе углы съели бы его целиком
const RING_IN = 22;
const RING_OUT = 30;
const RING_ROUND = 1.6;

function ringSector(a0, a1) {
  const w = a1 - a0;
  if (w <= 1e-4) return '';
  const at = (a, r) => `${(50 + Math.sin(a) * r).toFixed(3)} ${(50 - Math.cos(a) * r).toFixed(3)}`;
  if (w >= 2 * Math.PI - 1e-4) {
    // Целый круг (одна группа) — кольцо без углов
    return `M${at(0, RING_OUT)}A${RING_OUT} ${RING_OUT} 0 1 1 ${at(Math.PI, RING_OUT)}A${RING_OUT} ${RING_OUT} 0 1 1 ${at(0, RING_OUT)}Z`
      + `M${at(0, RING_IN)}A${RING_IN} ${RING_IN} 0 1 0 ${at(Math.PI, RING_IN)}A${RING_IN} ${RING_IN} 0 1 0 ${at(0, RING_IN)}Z`;
  }
  const half = Math.sin(Math.min(w, Math.PI) / 2);
  const rc = Number(Math.max(0, Math.min(RING_ROUND, (RING_OUT - RING_IN) / 2, (RING_IN * half) / (1 - half) * 0.9)).toFixed(3));
  const to = Math.asin(rc / (RING_OUT - rc)); // на столько угол скругления заходит на внешнюю дугу
  const ti = Math.asin(rc / (RING_IN + rc)); // …и на внутреннюю
  const eo = (RING_OUT - rc) * Math.cos(to); // где скругление сходит с боковой стороны
  const ei = (RING_IN + rc) * Math.cos(ti);
  const big = (r) => (w - 2 * (r === RING_OUT ? to : ti) > Math.PI ? 1 : 0);
  return `M${at(a0, eo)}A${rc} ${rc} 0 0 1 ${at(a0 + to, RING_OUT)}`
    + `A${RING_OUT} ${RING_OUT} 0 ${big(RING_OUT)} 1 ${at(a1 - to, RING_OUT)}A${rc} ${rc} 0 0 1 ${at(a1, eo)}`
    + `L${at(a1, ei)}A${rc} ${rc} 0 0 1 ${at(a1 - ti, RING_IN)}`
    + `A${RING_IN} ${RING_IN} 0 ${big(RING_IN)} 0 ${at(a0 + ti, RING_IN)}A${rc} ${rc} 0 0 1 ${at(a0, ei)}Z`;
}
const RING_SWEEP = 900; // заливка круга
const RING_POP = 300; // проявление значка
const RING_ANIM = 1300; // заливка и проявление последнего значка

/**
 * Появление ленты расходов и доходов: заголовки разделов и строки — по одной сверху вниз («Раскрытие
 * разделов»); так же — строки групп и категорий в аналитике. Только новый список — другой период,
 * отбор, вход на экран; набор в поиске и перерисовка теми же данными его заново не проявляют.
 */
let listPlayed = '';
function playList() {
  const stats = state.screen === 'stats';
  if (!stats) anaBarsKey = ''; // ушли из аналитики — вернёмся, и полосы зальются заново
  const fresh = stats ? document.querySelector('#screen .ana-row')
    : ['summary', 'income'].includes(state.screen) && state.mode !== 'ring' && document.querySelector('#screen .list');
  if (!fresh) {
    listPlayed = '';
    return;
  }
  const key = stats ? anaKey() : sectionsKey();
  if (key === listPlayed) return;
  listPlayed = key;
  if (!motion('sections')) return; // и при въезде экрана — одновременно с ним
  if (stats && motion('ring')) {
    // Полосы строки заливаются, как только она проявилась; до того — спрятаны (шторка закрыта):
    // экран мог прийти без въезда (листание периодов), и тогда их ещё никто не прятал
    anaBarsKey = key;
    document.querySelectorAll('#screen .ana-clip').forEach((b) => (b.style.clipPath = 'inset(0 100% 0 0)'));
  }
  [...document.querySelectorAll(stats ? '#screen .ana-row' : '#screen .list > *')].forEach((el, i) => {
    if (i >= 25) return stats && anaBarsKey === key && anaFillRow(el, 0);
    el.style.setProperty('--i', i);
    el.classList.add('row-in');
    el.addEventListener('animationend', () => {
      el.classList.remove('row-in');
      if (stats && anaBarsKey === key) anaFillRow(el, 0);
    }, { once: true });
  });
}

function playRing(start = true) {
  if (holdFills) start = false; // содержимое ещё въезжает — заливка после остановки
  const box = document.querySelector('#screen .ring-box');
  // На экране нет кольца (список, карточка, пустой период) — забываем показанное: кольцо,
  // появившись снова (в том числе по «назад»), заливается заново. Пока кольцо на экране
  // (набор в поиске, свежие данные), анимация не повторяется
  if (!box) ringPlayed = { key: '', at: null };
  if (!box || !motion('ring')) return;
  if (box.dataset.ringKey !== ringPlayed.key) ringPlayed = { key: box.dataset.ringKey, at: null };
  if (ringPlayed.at != null && performance.now() - ringPlayed.at >= RING_ANIM) return; // уже показано
  if (box.dataset.playing) return; // это кольцо уже анимируется

  // Заливка и значки — одним циклом по кадрам. Заливка: дуга дошла до места sweep, каждому
  // сектору видна его часть до этого места — одна кривая на весь круг, сколько бы ни было
  // секторов. Значок проявляется, когда заливка дошла до середины его сектора.
  // (Маска с анимацией не годится: браузер не перерисовывает её по ходу анимации.)
  // Границы секторов — из разметки: фигура на экране уже могла быть урезана прошлым вызовом
  const from = Number(box.dataset.from); // откуда начинается заливка
  const arcs = [...box.querySelectorAll('.ring-arc')].map((el) => ({ el, a0: Number(el.dataset.a0), a1: Number(el.dataset.a1) }));
  const icons = [...box.querySelectorAll('.ring-ic')].map((el) => ({ el, show: Number(el.dataset.show) }));
  const paint = (elapsed) => {
    const t = Math.min(1, elapsed / RING_SWEEP);
    const sweep = from + (1 - (1 - t) ** 3) * 2 * Math.PI; // ease-out по кубу
    // Каждому сектору — его часть до места заливки, тоже со скруглёнными углами
    for (const a of arcs) a.el.setAttribute('d', ringSector(a.a0, t >= 1 ? a.a1 : Math.min(a.a1, sweep)));
    for (const i of icons) {
      const k = Math.min(1, Math.max(0, (elapsed - i.show) / RING_POP));
      const e = 1 - (1 - k) ** 2;
      i.el.style.opacity = k >= 1 ? '' : e.toFixed(3);
      i.el.style.scale = k >= 1 ? '' : (0.6 + 0.4 * e).toFixed(3);
    }
  };
  // Пока не пустили — пустое кольцо (или то место, где анимацию прервала перерисовка)
  paint(ringPlayed.at == null ? 0 : performance.now() - ringPlayed.at);
  // Таблица под кольцом проявляется по строке вместе с заливкой. Пока заливка ждёт старта
  // (сохранённый вид, свежие данные ещё в пути) — строки скрыты: иначе мелькнули бы и пропали
  // Приехал лентой страниц — расшифровка приехала с ним и не проявляется заново
  // Экран въезжает — расшифровка проявляется по строке сразу, вместе с въездом (не ждёт заливки)
  if (arrived && !box.dataset.came) {
    box.dataset.came = '1';
    if (motion('sections')) {
      document.querySelectorAll('#screen .ring-list > .ring-row').forEach((el, i) => {
        el.style.setProperty('--i', i);
        el.classList.add('row-in');
        el.addEventListener('animationend', () => el.classList.remove('row-in'), { once: true });
      });
    }
  }
  const legend = ringPlayed.at == null && motion('sections') && !box.dataset.came ? [...document.querySelectorAll('#screen .ring-list > .ring-row')] : [];
  legend.forEach((el) => el.classList.add('row-wait'));
  const fresh = ringPlayed.at == null;
  if (fresh) fillLimitBars(true); // полоса лимита под кольцом — с нуля, вместе с заливкой
  if (!start) return;
  box.dataset.playing = '1';
  if (fresh) fillLimitBars();
  legend.forEach((el, i) => {
    el.style.setProperty('--i', i);
    el.classList.remove('row-wait');
    el.classList.add('row-in');
    el.addEventListener('animationend', () => el.classList.remove('row-in'), { once: true });
  });
  // Кольцо заливается с нуля — и сумма в шапке вместе с ним прокручивается от нуля. Если она
  // уже крутится (свайп периода — от прежней суммы), не перезапускаем
  const sumEl = document.querySelector('#screen .total-sum');
  if (ringPlayed.at == null && sumEl && !sumEl.dataset.sum) rollNumber(sumEl, '0');
  // Время — performance.now(), а не метка кадра из requestAnimationFrame: та — когда кадр
  // запланировали. Если перед этим телефон разбирал данные, метка отстаёт на сотни мс, и
  // первый же кадр перескакивал далеко вперёд — это и был рывок в начале заливки
  // Кадр задержался (телефон занят: убирал прежний экран, разбирал данные) — простой в счёт
  // анимации не идёт: иначе следующий кадр показывал бы сразу полкольца
  let last = null;
  // Цикл — только своего кольца: экран, уезжающий лентой страниц, ещё на странице, и его
  // цикл переставлял бы часы нового кольца (ringPlayed общий) — новое заливалось бы во время
  // сдвига и к остановке было уже наполовину залито
  const key = box.dataset.ringKey;
  const frame = () => {
    // Экран перерисовали или кольцо уже не текущее — продолжит (или начнёт) новая отрисовка
    if (!box.isConnected || ringPlayed.key !== key || !$('screen').contains(box)) return;
    const now = performance.now();
    ringPlayed.at ??= now;
    if (last != null && now - last > 50) ringPlayed.at += now - last - 16;
    last = now;
    const elapsed = now - ringPlayed.at;
    paint(elapsed);
    if (elapsed < RING_ANIM) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return true;
}

/**
 * overall — итог всего периода, когда кольцо вложенное (категории группы, «Остальное»): тогда
 * над значком — доля от всех расходов (доходов), а под ним рядом с суммой — доля в этом кольце.
 */
function ringView(parts, total, countText, kind, overall = null, extra = '') {
  // Вложенное кольцо: категории группы или «Остальное». whole — итог, от которого доля над значком
  const nested = overall != null || Boolean(state.ringRest);
  const whole = overall ?? total;
  // Раскрытое «Остальное» — кольцо только из слитых в него секторов, итог — их сумма
  if (state.ringRest) {
    const keys = new Set(state.ringRest.split(','));
    parts = parts.filter((p) => keys.has(p.key));
    total = parts.reduce((n, p) => n + p.sum, 0);
    countText = 'Остальное';
  }
  const all = parts.filter((p) => p.sum > 0).sort((a, b) => b.sum - a.sum);
  if (!all.length) return `<div class="empty">${state.q ? 'Ничего не нашлось' : 'За этот период ничего нет'}</div>`;
  // «Остальное» раскрывается всегда — его ключ: «~» и ключи слитых секторов
  const tap = (p) => {
    if (p.other) return ` data-ring="${esc(kind)}|~${esc(p.parts.map((x) => x.key).join(','))}"`;
    return ` data-ring="${esc(kind)}|${esc(p.key)}${p.single ? '|list' : ''}"`;
  };
  const sum = all.reduce((n, p) => n + p.sum, 0);
  const pct = (p) => share.format(Math.round((p.sum / sum) * 1000) / 10);
  const pctAll = (p) => share.format(Math.round((p.sum / whole) * 1000) / 10);
  // Доля: во вложенном кольце — своя (в группе) и в скобках общая (от всех расходов/доходов).
  // Над значком и в таблице под кольцом (там скобки мельче); под значком — только сумма
  const shares = (p) => (nested ? `${pct(p)}% (${pctAll(p)}%)` : `${pct(p)}%`);
  const TURN = 2 * Math.PI;

  // Значок стоит строго напротив середины своего сектора — без указателей. Чтобы соседние
  // не налезали, подбираем порядок секторов: прямоугольники значков с подписью (в процентах
  // стороны кольца) не должны пересекаться. Наверху и внизу мешает ширина, по бокам — высота
  const side = Math.min(380, (window.innerWidth || 400) - 48);
  const R = 41;
  const point = (angle, radius) => [50 + Math.sin(angle) * radius, 50 - Math.cos(angle) * radius];
  const measure = (p) => {
    p.ang = (p.sum / sum) * TURN;
    p.w = (Math.max(32, Math.max(money(p.sum).length, shares(p).length) * 5.8 + 2) / side) * 100;
    p.h = (60 / side) * 100; // доля над значком 32px, сумма под ним
    return p;
  };
  // Место значка считается один раз, когда его ставят (place), а не при каждой сверке: перебор
  // сверяет пары десятки тысяч раз, и синусы с косинусами на каждой занимали полсекунды —
  // столько стоял пустым новый период при свайпе
  const place = (p, mid) => {
    p.mid = mid;
    p.x = 50 + Math.sin(mid) * R;
    p.y = 50 - Math.cos(mid) * R;
  };
  const apart = (a, b) => Math.abs(a.x - b.x) >= (a.w + b.w) / 2 + 0.3 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2;
  // Перебор с отсечением: самый крупный — первым, дальше крупные и мелкие вперемежку
  // (этот порядок пробуется первым). Каждый новый значок сверяется со всеми поставленными
  const arrange = (items) => {
    const [first, ...rest] = items;
    for (const k of [0.5, 0, 1, 0.25, 0.75]) {
      let budget = 500; // удачный порядок находится быстро; дольше — почти всегда впустую (тогда слияние)
      const order = [first];
      const left = new Set(rest);
      place(first, -k * first.ang + first.ang / 2);
      const dfs = (at) => {
        if (!left.size) return true;
        if ((budget -= 1) < 0) return false;
        const cand = [...left];
        if (order.length % 2) cand.reverse(); // после крупного — мелкий, после мелкого — крупный
        for (const c of cand) {
          place(c, at + c.ang / 2);
          if (!order.every((o) => apart(o, c))) continue;
          order.push(c);
          left.delete(c);
          if (dfs(at + c.ang)) return true;
          order.pop();
          left.add(c);
        }
        return false;
      };
      if (dfs(-k * first.ang + first.ang)) return { order, start: -k * first.ang };
    }
    return null;
  };
  // Не помещаются — самые мелкие уходят в «Остальное» (серый сектор; по отдельности — в расшифровке)
  let items = all.map(measure);
  let other = null;
  let placed = arrange(items);
  while (!placed && items.length > 2) {
    const rest = items.filter((p) => !p.other);
    const take = other ? [rest.pop()] : [rest.pop(), rest.pop()];
    other ??= { key: '', name: 'Остальное', color: '#dfe3e8', icon: 'blocks', sum: 0, other: true, parts: [] };
    for (const p of take) {
      other.parts.push(p);
      other.sum += p.sum;
    }
    items = [...rest, measure(other)].sort((a, b) => b.sum - a.sum);
    placed = arrange(items);
  }
  if (!placed) placed = { order: items, start: 0 };
  const merged = new Set(other?.parts ?? []);

  // Сегменты: кольцо по средней окружности r=26 в квадрате 100×100 (снаружи — место под значки);
  // зазор ≈ 2px. Рисует их ringSector — со скруглёнными углами
  const r = 26;
  const len = 2 * Math.PI * r;
  const gap = placed.order.length > 1 ? 0.9 : 0;
  let at = (placed.start / TURN) * len;
  const at0 = at;

  // Появление: заливка проходит круг одним движением, быстро в начале и мягко к концу.
  // Скорость не зависит от того, сколько секторов и какого они размера. Значок проявляется,
  // когда заливка доходит до середины
  // его сектора (та же кривая, что у маски: ease-out по кубу). Только когда кольцо
  // показывают заново (другой период, группа, режим, возврат с экрана без кольца) — не при наборе в поиске;
  // включает её playRing
  const ringKey = [kind, state.from, state.to, state.ringGroup, state.ringRest, state.src, state.sg, state.inf].join('|');
  const when = (f) => RING_SWEEP * (1 - Math.cbrt(1 - Math.min(1, Math.max(0, f)))); // обратная к ease-out
  const arcs = placed.order.map((p) => {
    const part = (p.sum / sum) * len;
    const f0 = (at - at0) / len;
    const f1 = (at - at0 + part) / len;
    p.show = when((f0 + f1) / 2);
    // Сектор — от угла до угла, зазор поровну с обеих сторон (на средней линии ≈ 0,9)
    const a0 = ((at + gap / 2) / len) * TURN;
    const a1 = ((at + part - gap / 2) / len) * TURN;
    const arc = `<path class="ring-arc" fill="${p.color ?? '#c9ced6'}" d="${ringSector(a0, a1)}"
      data-a0="${a0.toFixed(4)}" data-a1="${a1.toFixed(4)}"${tap(p)}><title>${esc(p.name)}: ${money(p.sum)}</title></path>`;
    at += part;
    return arc;
  }).join('');
  const icons = placed.order.map((p) => {
    const [x, y] = point(p.mid, R);
    const color = p.color ?? '#c9ced6';
    return `
      <button class="ring-ic" type="button" style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%" data-show="${p.show.toFixed(0)}"${tap(p)} aria-label="${esc(p.name)}: ${money(p.sum)}">
        <span class="ring-sum">${shares(p)}</span>
        <span class="ic${p.other ? ' round' : ''}" style="background:${color};color:${readableText(color)}">${groupIcon(p.icon ?? 'none')}</span>
        <span class="ring-sum">${money(p.sum)}</span>
      </button>`;
  }).join('');
  // Расшифровка — все по отдельности, со значками; ушедшие в «Остальное» — его цветом
  const rows = all.map((p) => `
    <button class="ring-row" type="button"${tap(p)}>
      ${(() => {
        // Значок группы или категории — в цвете её сектора (ушедшие в «Остальное» — его цветом)
        const c = merged.has(p) ? other.color : p.color ?? '#c9ced6';
        return `<span class="ic" style="background:${c};color:${readableText(c)}">${groupIcon(p.icon ?? 'none')}</span>`;
      })()}
      <span class="ring-name">${esc(p.name)}</span>
      <span class="ring-share">${pct(p)}%${nested ? ` <small>(${pctAll(p)}%)</small>` : ''}</span>
      <b>${money(p.sum)}</b>
    </button>`).join('');
  return `
    <div class="card ring-card">
      <div class="ring-box" data-ring-key="${esc(ringKey)}" data-from="${((at0 / len) * TURN).toFixed(4)}">
        <svg class="ring-svg" viewBox="0 0 100 100" aria-hidden="true">${arcs}</svg>
        <div class="ring-center"><b>${money(total)}</b><small class="note">${esc(countText)}</small></div>
        ${icons}
      </div>
    </div>
    ${extra}
    <div class="list ring-list">${rows}</div>`;
}

// ── лимит под кольцом ────────────────────────────────────
// Карточка под кольцом расходов (всех групп или одной): полоса, лимит на выбранный период,
// потрачено и сколько осталось, а ниже — сколько можно в день и прогноз (идущий период) или
// итог (прошедший). Поля одни и те же при любом периоде — карточка не прыгает по высоте.
// Лимит на период считает сервер (limits.mjs: по дням, так что «две недели» — доля месяца).
//
// Полоса: пока не превышен — вся полоса и есть лимит, заливка зелёная. Превышен — шкала
// растягивается до 125% потраченного (заливка кончается на 80%), отсечка лимита смещается
// влево: до неё зелёное, после — красное.
const LIMIT_STEP = { quarter: 100000, month: 50000, week: 10000, day: 1000 };
const LIMIT_PERIODS = ['month', 'quarter', 'week', 'day'];

/** Лимит периода amount → на отрезок from…to (как limitForRange в limits.mjs). */
function limitForRange(amount, period, from, to) {
  if (!amount) return 0;
  let sum = 0;
  for (let d = parseDay(from), end = parseDay(to); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const q = Math.floor(d.getMonth() / 3) * 3;
    sum += period === 'day' ? amount
      : period === 'week' ? amount / 7
        : period === 'quarter' ? amount / Math.round((new Date(d.getFullYear(), q + 3, 1) - new Date(d.getFullYear(), q, 1)) / 86400000)
          : amount / new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  }
  return Math.round(sum);
}

function limitCard(st, slug = '') {
  if (!st) return '';
  const P = T.settings.limits;
  const today = isoDay(new Date());
  const keys = slug ? [slug] : (meta?.categories ?? []).map((g) => g.slug).filter((k) => st.range[k] > 0);
  const of = (map) => keys.reduce((n, k) => n + (map[k] ?? 0), 0);
  const limit = keys.length ? of(st.range) : 0;
  const spent = of(st.spent);
  const left = limit - spent;
  const over = limit > 0 && spent > limit;
  // Полоса: w — докуда заливка, a — отсечка лимита (при перерасходе)
  const w = !limit ? 0 : over ? 80 : Math.min(100, (spent / limit) * 100);
  const a = over ? (80 * limit) / spent : 100;
  const num = (label, value, cls = '') => `<span class="lim-num${cls}"><small>${label}</small><b>${value}</b></span>`;

  let note;
  if (!limit) {
    const usual = slug ? st.usual[slug] ?? 0 : 0;
    note = slug ? `${P.notSet}${usual ? ` · ${P.usually} ≈ ${money(Math.ceil(usual / 10000) * 10000)}` : ''}` : P.noneNote;
  } else if (st.to < today) {
    note = over ? `${P.result}: ${P.overBy} ${money(-left)}` : `${P.result}: ${P.fit}${left > 0 ? `, ${P.saved} ${money(left)}` : ''}`;
  } else {
    const from = st.from > today ? st.from : today;
    const days = Math.round((parseDay(st.to) - parseDay(from)) / 86400000) + 1;
    const forecast = spent + of(st.rest);
    const perDay = left > 0 ? `≈ ${money(left / days)} ${P.perDay}` : P.exceeded;
    note = st.from > today
      ? `${P.notStarted} · ${perDay}`
      : `${perDay}${forecast > spent ? ` · ${P.forecast} ${money(forecast)}` : ''}`;
  }

  const title = slug ? P.cardTitle : P.cardTitleAll;
  // Подстрочник: у группы — её лимит на период лимитов («60 000 ₽ в месяц»; карточка — на
  // выбранный отрезок), у общей — сколько групп с лимитом
  const per = P.per[st.period] ?? P.per.month;
  const base = slug ? st.limits[slug] ?? 0 : 0;
  const sub = slug
    ? (base ? `${money(base)} ${per}` : P.notSetShort)
    : keys.length ? f(P.groupsWith, { n: int.format(keys.length), w: pl(keys.length, T.settings.cats.groupsW) }) : P.none;
  return `
    <div class="card lim-card${limit ? '' : ' empty'}">
      <div class="lim-top">
        <span class="lim-head"><span class="lim-title">${title}</span><small class="note lim-sub">${sub}</small></span>
        <button class="drop-btn lim-edit" type="button" data-lim-edit="${esc(slug)}" aria-label="${esc(slug ? (limit ? P.edit : P.set) : P.setup)}" title="${esc(slug ? (limit ? P.edit : P.set) : P.setup)}">${slug ? UI.pen : UI.settings}</button>
      </div>
      <div class="lim-bar">
        <span class="lim-run" data-w="${w.toFixed(2)}" style="--w:${w.toFixed(2)}%">
          <i class="ok" style="width:${a.toFixed(2)}%"></i>${over ? `<i class="over" style="left:${a.toFixed(2)}%"></i>` : ''}
        </span>
      </div>
      <div class="lim-nums">
        ${num(P.spent, money(spent))}
        ${num(P.limit, limit ? money(limit) : '—')}
        ${over ? num(P.overBy[0].toUpperCase() + P.overBy.slice(1), money(-left), ' over') : num(P.left, limit ? money(left) : '—')}
      </div>
      <p class="note lim-note">${note}</p>
    </div>`;
}

/**
 * Заливка полос лимита от нуля. hold — только обнулить (кольцо ждёт старта заливки), иначе —
 * пустить. Без анимации колец полосы сразу на месте.
 */
function fillLimitBars(hold = false) {
  const bars = [...document.querySelectorAll('#screen .lim-run')];
  if (!bars.length || !motion('ring')) return;
  bars.forEach((b) => {
    b.classList.remove('lim-fill');
    b.style.setProperty('--w', '0%');
  });
  if (hold) return;
  void document.body.offsetWidth; // зафиксировать ноль, иначе заливки не будет видно
  bars.forEach((b) => {
    b.classList.add('lim-fill');
    b.style.setProperty('--w', `${b.dataset.w}%`);
  });
}

/** После правки лимитов: свежие meta и данные, экран заново, полосы заливаются. */
async function limitsChanged() {
  for (const k of [...feedData.keys()]) if (k.startsWith('/api/limits') || k.startsWith('/api/analytics')) feedData.delete(k);
  screenCache.clear();
  meta = await api('/api/meta');
  await render();
  fillLimitBars();
}

/**
 * Лист «Лимит» группы: переключатель, сумма на период лимитов (поле и ползунок до 2,5 обычных
 * трат группы) и «Зафиксировать» — такой лимит не меняют, когда двигают другие.
 */
async function openLimitSheet(slug) {
  const g = findGroup(slug);
  if (!g) return;
  const P = T.settings.limits;
  let full;
  try {
    full = await api('/api/limits');
  } catch (err) {
    toast(`${T.common.failed}: ${err.message}`);
    return;
  }
  const step = LIMIT_STEP[full.period] ?? LIMIT_STEP.month;
  const cur = full.limits[slug] ?? 0;
  const usual = full.suggest[slug] ?? 0;
  const max = Math.max(step * 10, Math.ceil(Math.max(usual * 2.5, cur * 1.5) / step) * step);
  const start = cur || usual || step * 4;
  const per = P.per[full.period];
  const rub = (k) => int.format(Math.round(k / 100));
  const el = openChoice(g.name, `
    <div class="lim-sheet">
      <div class="lim-rows">${srow({
        icon: UI.limit, title: P.turnOn, end: toggle('data-lim-on', cur > 0, P.turnOn),
      })}${srow({
        // Фиксация — сразу под включением; без лимита фиксировать нечего — гаснет вместе с полями
        icon: UI.lock, title: P.fixShort, off: !cur, end: toggle(`data-lim-fix${cur ? '' : ' disabled'}`, Boolean(full.fixed[slug]), P.fixShort),
      })}</div>
      <div class="lim-set${cur > 0 ? '' : ' off'}">
        <label class="limit-field"><input id="lim-input" type="text" inputmode="numeric" autocomplete="off" value="${rub(start)}" /><span>₽ ${per}</span></label>
        <input class="lim-range" type="range" min="0" max="${max}" step="${step}" value="${Math.min(max, start)}" aria-label="${esc(P.toggle)}" />
        <div class="lim-scale"><span>0</span>${usual ? `<button class="link" type="button" data-lim-usual>${P.usually} ≈ ${money(usual)}</button>` : ''}<span>${money(max)}</span></div>
      </div>
    </div>`, async (ev, close) => {
    const input = el.querySelector('#lim-input');
    if (ev.target.closest('[data-lim-usual]')) {
      input.value = rub(usual);
      el.querySelector('.lim-range').value = usual;
      mark();
      return;
    }
    if (!ev.target.closest('[data-lim-save]')) return;
    const { on, amount, fix } = chosen();
    const btn = ev.target.closest('[data-lim-save]');
    btn.disabled = true;
    try {
      await api('/api/limits', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limits: { [slug]: amount }, fixed: { [slug]: on && fix } }),
      });
    } catch (err) {
      btn.disabled = false;
      toast(err.message);
      return;
    }
    el.guard = null;
    close();
    limitsChanged();
  }, {
    // «Сохранить» (галочка) — на месте крестика: закрывают лист «назад» и нажатием мимо. Доступна, только
    // когда есть что сохранять; с несохранённым закрытие спрашивает
    action: `<button class="icon-btn primary picker-save" type="button" data-lim-save disabled aria-label="${esc(P.save)}" title="${esc(P.save)}">${UI.ok}</button>`,
    dirty: () => changed(),
    note: P.sheetNote,
  });
  // Что выбрано сейчас — и отличается ли от того, что было
  const chosen = () => {
    const on = el.querySelector('[data-lim-on]').checked;
    return {
      on,
      amount: on ? Number(el.querySelector('#lim-input').value.replace(/[^\d]/g, '')) * 100 : 0,
      fix: el.querySelector('[data-lim-fix]').checked,
    };
  };
  const was = { amount: cur, fix: Boolean(full.fixed[slug]) };
  const changed = () => {
    const now = chosen();
    return now.amount !== was.amount || (now.on && now.fix !== was.fix);
  };
  const mark = () => {
    el.querySelector('[data-lim-save]').disabled = !changed();
  };
  el.addEventListener('change', mark);
  el.addEventListener('input', () => setTimeout(mark, 0));
  el.addEventListener('change', (e) => {
    if (!e.target.matches('[data-lim-on]')) return;
    // Выключили — поля гаснут, но остаются на месте (и не правятся)
    const set = el.querySelector('.lim-set');
    set.classList.toggle('off', !e.target.checked);
    for (const input of set.querySelectorAll('input, button')) input.disabled = !e.target.checked;
    const fix = el.querySelector('[data-lim-fix]');
    fix.disabled = !e.target.checked;
    fix.closest('.srow').classList.toggle('off', !e.target.checked);
  });
  if (!cur) for (const input of el.querySelectorAll('.lim-set input, .lim-set button')) input.disabled = true;
  el.addEventListener('input', (e) => {
    const input = el.querySelector('#lim-input');
    if (e.target.matches('.lim-range')) input.value = rub(Number(e.target.value));
    if (e.target === input) {
      input.value = input.value.replace(/[^\d]/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
      el.querySelector('.lim-range').value = Number(input.value.replace(/[^\d]/g, '')) * 100;
    }
  });
}

$('screen').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-lim-edit]');
  if (!edit) return;
  if (edit.dataset.limEdit) openLimitSheet(edit.dataset.limEdit);
  else go({ screen: 'set_limits', tg: '' });
});

// ── настройки → лимиты ───────────────────────────────────
// «Основные»: включить лимиты целиком (выключенные нигде не показываются, суммы остаются) и
// период лимитов — попапом; смена периода пересчитывает заданные лимиты. Ниже — лимиты всех
// групп расходов. С экрана группы («Управлять лимитами») — сюда же, её строка подсвечена.
async function screenSetLimits() {
  const P = T.settings.limits;
  const full = await api('/api/limits');
  const per = P.per[full.period];
  const main = section(T.settings.menu.label, `<span data-lim-foot>${full.on ? P.periodNote : P.offFoot}</span>`,
    srow({ icon: UI.limit, title: P.on, end: toggle('data-limits-toggle', full.on, P.on) })
    + srow({ icon: UI.calendar, title: P.period, note: P.periods[full.period], attrs: `data-lim-period-pick="${full.period}"`, end: GO, off: !full.on }));
  const groups = (meta?.categories ?? []).map((g) => {
    const amount = full.limits[g.slug] ?? 0;
    const usual = full.suggest[g.slug] ?? 0;
    return srow({
      icon: groupBadge(g),
      bare: true,
      title: esc(g.name),
      note: amount
        ? `${money(amount)} ${per}${full.fixed[g.slug] ? ` · ${P.fixed}` : ''}`
        : `${P.notSet}${usual ? ` · ${P.usually} ≈ ${money(usual)}` : ''}`,
      attrs: `data-lim-group="${esc(g.slug)}"`,
      end: GO,
      off: !full.on, // выключены — видно, что задано, но не правится
    });
  }).join('');
  const total = Object.values(full.limits).reduce((n, v) => n + v, 0);
  // «Основные» закреплены сверху: при прокрутке видно, почему группы серые (лимиты выключены)
  return `<div class="stuck-head lim-stuck">${main}</div>` + section(P.groups, total ? f(P.totalNote, { sum: money(total), per }) : P.groupsNote, groups);
}

/** Строка группы, с которой пришли («Управлять лимитами»), — на виду и подсвечена. */
function limitsFocus() {
  if (!state.tg) return;
  const row = document.querySelector(`#screen [data-lim-group="${CSS.escape(state.tg)}"]`)?.closest('.srow');
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('lim-flash');
}

$('screen').addEventListener('click', async (e) => {
  if (state.screen !== 'set_limits') return;
  const group = e.target.closest('[data-lim-group]');
  if (group) return openLimitSheet(group.dataset.limGroup);
  const pick = e.target.closest('[data-lim-period-pick]');
  if (!pick) return null;
  const P = T.settings.limits;
  const current = pick.dataset.limPeriodPick;
  const rows = LIMIT_PERIODS.map((p) => dropRow(`data-lim-period="${p}"`, '', P.periods[p], p === current)).join('');
  return openChoice(P.period, `<div class="choice-list">${rows}</div><p class="note lim-choice-note">${P.periodNote}</p>`, async (ev, close) => {
    const row = ev.target.closest('[data-lim-period]');
    if (!row) return;
    close();
    if (row.dataset.limPeriod === current) return;
    try {
      await api('/api/limits/period', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ period: row.dataset.limPeriod }) });
      await limitsChanged();
    } catch (err) {
      toast(`${T.common.failed}: ${err.message}`);
    }
  });
});

/** Строки экрана «Лимиты», которые без включённых лимитов неактивны. */
function limitsDim(off) {
  for (const el of document.querySelectorAll('#screen [data-lim-period-pick], #screen [data-lim-group]')) {
    el.disabled = off;
    el.closest('.srow').classList.toggle('off', off);
  }
  const foot = document.querySelector('#screen [data-lim-foot]');
  if (foot) foot.textContent = off ? T.settings.limits.offFoot : T.settings.limits.periodNote;
}

/** Включить или выключить лимиты целиком — на экране «Лимиты» и в поиске по настройкам. */
$('screen').addEventListener('change', async (e) => {
  if (!e.target.matches('[data-limits-toggle]')) return;
  const box = e.target;
  box.disabled = true;
  try {
    // На экране «Лимиты» строки гаснут и загораются на месте, плавно — без перерисовки
    if (state.screen === 'set_limits') limitsDim(!box.checked);
    await api('/api/limits/on', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: box.checked }) });
    for (const k of [...feedData.keys()]) if (k.startsWith('/api/limits') || k.startsWith('/api/analytics')) feedData.delete(k);
    screenCache.clear();
    meta = await api('/api/meta');
  } catch (err) {
    box.checked = !box.checked;
    if (state.screen === 'set_limits') limitsDim(!box.checked);
    toast(`${T.common.failed}: ${err.message}`);
  }
  box.disabled = false;
});

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
        icon: r.key ? catIcon(findCategory(r.key)) : null,
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

const FEED_STEP = 300; // строк ленты за раз
let feedLimit = { key: '', n: FEED_STEP };

/** Раздел «Перевод себе» в расходах: не категория, а вид операции — в итог не входит. */
const SELF = '#transfer';

async function spendingFeed(itemRows, bankRows, selfRows = [], scanRows = []) {
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
      name: opWho(op) ?? 'Без названия',
      at: op.at,
      sum: op.amount,
      source: 'bank',
      category: op.category_slug,
      positions: 1,
      outside: false,
      action: `data-op="${op.id}"`,
      orig: foreign(op),
      group: null,
      noted: Boolean(op.has_note),
    })),
    ...scanRows.map((j) => ({
      name: SOURCES.failed.title,
      at: j.purchased_at,
      sum: j.total_sum,
      source: 'failed',
      category: null, // «Без категории»
      scan: true, // вне суммы, но сумма видна (серая); нажатие — к скану
      positions: 1,
      outside: true,
      action: 'data-to-failed',
      group: null,
      noted: false,
    })),
    ...selfRows.map((op) => ({
      name: opWho(op) ?? 'Перевод',
      at: op.at,
      sum: op.amount,
      source: 'bank',
      category: SELF,
      self: true, // перевод себе: виден, но в суммы разделов расходов и итог не входит
      positions: 1,
      outside: false,
      action: `data-op="${op.id}"`,
      orig: foreign(op),
      group: null,
      noted: Boolean(op.has_note),
    })),
  ];
  if (!spendings.length) return `<div class="empty">${state.q ? 'Ничего не нашлось' : 'За этот период трат нет'}</div>`;

  // Порядок категорий — как в справочнике: так группы идут всегда в одном порядке
  const catOrder = new Map();
  (meta?.categories ?? []).forEach((g, gi) =>
    g.subcategories.forEach((c, ci) => catOrder.set(c.slug, gi * 1000 + ci)),
  );
  catOrder.set(SELF, 2e9); // переводы себе — после всего, даже после «Без категории»
  const back = state.dir === 'asc' ? -1 : 1;
  // Даты — ISO-строки одного вида: сравниваем как строки, без разбора (строк — десятки тысяч)
  const later = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
  const byDate = (a, b) => later(a, b) * back;
  spendings.sort((a, b) => {
    if (state.sort === 'name') return a.name.localeCompare(b.name, 'ru') * -back;
    if (state.sort === 'sum') return (b.sum - a.sum) * back;
    if (state.sort === 'category') {
      const diff = (catOrder.get(a.category) ?? 1e9) - (catOrder.get(b.category) ?? 1e9);
      return (diff ? diff * -back : later(a, b));
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
  // По дням верхний (сегодняшний) день открыт; по категориям всё свёрнуто — видно разом, сколько где
  // Во время поиска раскрыто всё — иначе найденное пряталось бы в свёрнутых разделах
  const opened = openSections(state.sort === 'category' ? null : order[0], fewRows(spendings.length) ? order : null);
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
          if (key === SELF) return `<span class="op-cat" style="background:#c9ced6"></span>Перевод себе · вне суммы (${int.format(counts.get(key) ?? 0)})`;
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

  // Длинный список рисуем порциями: тысячи строк разом телефон тянет с трудом. Дальше —
  // по мере прокрутки (кнопка внизу нажимается сама, когда до неё долистали)
  const limit = feedLimit.key === sectionsKey() ? feedLimit.n : FEED_STEP;
  feedLimit = { key: sectionsKey(), n: limit };
  const visible = spendings.filter((r) => {
    const key = sectionOf(r);
    return key == null || opened.has(key);
  }).length;
  let drawn = 0;
  let section;
  // В разделе «Без категории» первой строкой — авторазметка: товары по названию, траты банка
  // по продавцу
  const autoBtn = `<button class="feed-auto" type="button" data-autolabel>${UI.sparkle} Разметить автоматически</button>`;
  const rows = spendings
    .map((r) => {
      const key = sectionOf(r);
      const head = key != null && key !== section
        ? sectionHead(key) + (key === NONE && opened.has(key) ? autoBtn : '')
        : '';
      section = key;
      if (key != null && !opened.has(key)) return head; // раздел свёрнут — строк не рисуем
      drawn += 1;
      if (drawn > limit) {
        return drawn === limit + 1
          ? `${head}<button class="feed-more" type="button" data-feed-more>${f('Показать ещё · осталось {n}', { n: int.format(visible - limit) })}</button>`
          : head;
      }

      const found = r.category && !r.self ? findCategory(r.category) : null;
      const color = found?.group.color ?? 'var(--fill)';
      const dot = found ? categoryColor(found.group.slug, r.category) ?? color : '#d7dbe2';
      const isOpen = r.group && parts.has(r.group);
      // Стрелка — внутри подписи, в размер текста: как бы ни рисовался значок, строка не поплывёт
      const toggle = r.group
        ? ` <span class="expand${isOpen ? ' open' : ''}" data-expand="${esc(r.group)}" role="button" aria-label="${isOpen ? 'Свернуть' : 'Показать покупки'}">${UI.chevron}</span>`
        : '';
      const note = [
        `<span class="op-cat" style="background:${dot}"></span>${esc(r.self ? 'Перевод себе' : found?.category.name ?? 'Без категории')}`,
        // При сортировке по дате день уже в заголовке раздела, в остальных — нужен в строке
        state.sort === 'date' ? '' : dateRu(r.at.slice(0, 10)),
        r.positions > 1 ? `${int.format(r.positions)} ${plural(r.positions, 'покупка', 'покупки', 'покупок')}` : '',
        r.orig ? esc(r.orig) : '', // покупка в валюте: в сумме — рубли, здесь — сколько было
      ].filter(Boolean).join(' · ');

      const row = `${head}
      <button class="row item" type="button" ${r.action}${r.group ? ` data-long="${esc(r.group)}"` : ''}>
        <span class="ic" style="background:${color};color:${readableText(color)}">${r.self ? UI.swap : groupIcon(catIcon(found))}</span>
        <span class="row-main">
          <span class="row-title">${esc(r.name)}</span>
          <span class="row-note">${note}${toggle}</span>
        </span>
        ${r.noted ? '<span class="noted" title="Есть комментарий"></span>' : ''}
        <span class="row-sum${r.outside || r.self ? ' muted' : ''}">${r.outside && !r.scan ? 'вне суммы' : money(r.sum)}</span>
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
      // Покупки группы — в общем блоке: он раскрывается и сворачивается «шторкой» по высоте
      return `${row}<div class="sub-wrap">${subs}${more}</div>`;
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
          ? `<span class="op-cat" style="background:${found.group.color ?? 'var(--fill)'}"></span>${esc(found.category.name)}`
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
/** Запросы «Дохода» за период — как summaryFeeds у «Расхода». */
function incomeFeeds(from, to) {
  const q = new URLSearchParams({
    from, to, direction: 'credit', kind: 'income',
    // По категориям раскладываем здесь; внутри категории — свежие сверху
    per: '5000', sort: state.sort === 'category' ? 'date' : state.sort, dir: state.sort === 'category' ? 'desc' : state.dir,
  });
  return { ops: `/api/bank/ops?${q}`, bank: `/api/bank?from=${from}&to=${to}` };
}

async function screenIncome() {
  if (!incomeOn()) {
    return soon(UI.income, 'Доходы', `${inApp()
      ? 'Подключите банк в настройках — поступления появятся здесь сами.'
      : 'Поступления берутся из банка. Подключить его можно в приложении для Android.'} Или впишите доход вручную: «+» → «Доход вручную».`);
  }

  const feeds = incomeFeeds(state.from, state.to);
  const [data, bank] = await Promise.all([
    apiFeed(feeds.ops),
    apiFeed(feeds.bank).catch(() => null),
  ]);
  const transfers = (bank?.totals ?? []).find((t) => t.kind === 'transfer');

  // Фильтр: группа доходов или «без категории». Итог и число считаем по тому, что осталось
  const groups = meta?.income ?? [];
  // Отбор: группа, «без категории» или несколько групп/категорий через запятую («Остальное» кольца)
  const keys = new Set(state.inf ? state.inf.split(',') : []);
  const filter = state.inf ?? '';
  const filterName = [...keys].map((k) => (k === '-' ? T.income.noCategory : groups.find((g) => g.slug === k)?.name ?? incomeCat(k)?.name ?? '')).join(', ');
  // Данные — из памяти (apiFeed): отбираем в свой список, ответ сервера не трогаем
  const all = data.rows;
  const isrcOn = (op) => !state.isrc || state.isrc.split(',').includes(op.bank === 'manual' ? 'manual' : 'bank');
  const narrowed = Boolean(filter || state.isrc || state.q.trim());
  const rows = all
    .filter(isrcOn)
    .filter((op) => {
      if (!filter) return true;
      const found = incomeCat(op.category_slug);
      return keys.has(op.category_slug ?? '') || keys.has(found?.group.slug ?? '-');
    })
    .filter((op) => (state.same ? sameAs('in', op) : matchesQ([op.description, op.merchant, op.account_name, SOURCES.bank.title, T.sources.bank,
      bankById(op.bank)?.name, incomeCat(op.category_slug)?.name], [op.amount, op.orig_amount])));
  const sum = narrowed ? rows.reduce((n, op) => n + op.amount, 0) : data.totals.sum;
  const count = narrowed ? rows.length : data.totals.count;
  const filters = drop(UI.filter, 'Фильтр',
    dropRow('data-inf=""', UI.layers, T.income.all, !filter)
    + groups.map((g) => dropRow(`data-inf="${esc(g.slug)}"`, groupIcon(g.icon ?? 'none'), g.name, filter === g.slug)).join('')
    + dropRow('data-inf="-"', groupIcon('none'), T.income.noCategory, filter === '-'),
    Boolean(filter || state.isrc));

  const head = `
    <div class="stuck-head">
      ${listHead({
        sum: money(sum),
        note: [
          `${int.format(count)} ${pl(count, T.income.many)}`,
          SORTS[state.sort] ? SORTS[state.sort][0].toLowerCase() : '',
          state.isrc ? state.isrc.split(',').map((k) => SOURCE_SHORT[k]?.toLowerCase()).join(', ') : '',
          filter ? filterName.toLowerCase() : '',
          state.q.trim() ? (state.same ? `только «${state.q.trim()}»` : `поиск «${state.q.trim()}»`) : '',
          !filter && transfers ? `${int.format(transfers.count)} переводов между своими` : '',
        ].filter(Boolean).map(esc).join(' · '),
        sorts: all.length > 0 ? ['category', 'date', 'name', 'sum'] : false,
        // Внутри кольца группы отбор по группам дал бы пустое кольцо — фильтра нет
        filters: all.length > 0 && !(state.mode === 'ring' && (state.ringGroup || state.ringRest)) ? filters : '',
        search: all.length > 0,
        mode: all.length > 0,
      })}
    </div>`;

  if (!rows.length) return `${head}<div class="empty">${filter ? T.income.emptyFilter : 'Поступлений за период нет'}</div>`;

  if (state.mode === 'ring') {
    const byGroup = new Map();
    for (const op of rows) {
      const key = incomeCat(op.category_slug)?.group.slug ?? NONE;
      byGroup.set(key, (byGroup.get(key) ?? 0) + op.amount);
    }
    const opened = state.ringGroup && groups.find((g) => g.slug === state.ringGroup);
    if (opened) {
      const byCat = new Map();
      for (const op of rows) byCat.set(op.category_slug, (byCat.get(op.category_slug) ?? 0) + op.amount);
      const cats = opened.subcategories.map((c) => ({
        key: c.slug, name: c.name, color: incomeCat(c.slug)?.color ?? opened.color, icon: c.icon || opened.icon, sum: byCat.get(c.slug) ?? 0,
      }));
      return `${head}${ringView(cats, cats.reduce((n, c) => n + c.sum, 0), opened.name, 'income-cat', sum)}`;
    }
    const catsOf = new Map(); // одна непустая категория в группе — сразу список (как у расходов)
    for (const op of rows) {
      const g = op.amount > 0 ? incomeCat(op.category_slug)?.group.slug : null;
      if (g) catsOf.set(g, (catsOf.get(g) ?? new Set()).add(op.category_slug));
    }
    const parts = groups.map((g) => ({
      key: g.slug, name: g.name, color: g.color, icon: g.icon, sum: byGroup.get(g.slug) ?? 0, single: catsOf.get(g.slug)?.size === 1,
    }));
    parts.push({ key: NONE, name: T.income.noCategory, color: '#c9ced6', icon: 'none', sum: byGroup.get(NONE) ?? 0 });
    return `${head}${ringView(parts, sum, `${int.format(count)} ${pl(count, T.income.many)}`, 'income')}`;
  }

  const byDate = state.sort === 'date';
  const byCat = state.sort === 'category';
  // По категориям: порядок — как в справочнике доходов, без категории — в конце
  const catOrder = new Map();
  (meta?.income ?? []).forEach((g, gi) => g.subcategories.forEach((c, ci) => catOrder.set(c.slug, gi * 1000 + ci)));
  const rank = (op) => catOrder.get(op.category_slug) ?? 1e9;
  const list = byCat ? [...rows].sort((a, b) => (rank(a) - rank(b)) * (state.dir === 'asc' ? 1 : -1)) : rows;
  const catSums = new Map();
  const catCounts = new Map();
  for (const op of list) {
    catSums.set(op.category_slug ?? '', (catSums.get(op.category_slug ?? '') ?? 0) + op.amount);
    catCounts.set(op.category_slug ?? '', (catCounts.get(op.category_slug ?? '') ?? 0) + 1);
  }
  // Одинаковые поступления (то же название) — одной строкой в своём разделе (дне, категории),
  // как одинаковые товары в расходах: общая сумма и число, стрелка раскрывает их по одному
  const norm = (op) => (op.description ?? op.merchant ?? '').trim().toLowerCase();
  const secOf = (op) => (byDate ? op.at.slice(0, 10) : byCat ? op.category_slug ?? '' : '');
  const entries = [];
  const byKey = new Map();
  for (const op of list) {
    const gk = `in|${secOf(op)}|${norm(op)}`;
    const found = byKey.get(gk);
    if (found) {
      found.ops.push(op);
      found.sum += op.amount;
      continue;
    }
    const entry = { gk, ops: [op], sum: op.amount };
    byKey.set(gk, entry);
    entries.push(entry);
  }
  // По сумме — по сумме строки, а не первого поступления в ней
  if (state.sort === 'sum') entries.sort((a, b) => (b.sum - a.sum) * (state.dir === 'asc' ? -1 : 1));

  let day = '';
  let cat = null;
  const opened = openSections(null, byCat && fewRows(list.length) ? [...new Set(list.map((op) => op.category_slug || NONE))] : null);
  feedSections = { order: [], single: false };
  const html = entries
    .map(({ gk, ops, sum: groupSum }) => {
      const op = ops[0]; // последнее: список идёт от свежих
      const opDay = op.at.slice(0, 10);
      let header = '';
      if (byDate && opDay !== day) header = dayHead(opDay, daySum(rows, opDay, (x) => x.at, (x) => x.amount));
      if (byCat && (op.category_slug ?? '') !== cat) {
        const c = incomeCat(op.category_slug);
        const key = op.category_slug ?? '';
        // Раздел-категория сворачивается, как в расходах; по умолчанию все свёрнуты
        header = `
          <button class="day section${opened.has(key || NONE) ? ' open' : ''}" type="button" data-section="${esc(key || NONE)}">
            <span><span class="section-arrow">${UI.chevron}</span><span class="op-cat" style="background:${c?.color ?? '#d7dbe2'}"></span>${esc(c?.name ?? T.income.noCategory)} (${int.format(catCounts.get(key))})</span>
            <b>${money(catSums.get(key))}</b>
          </button>`;
      }
      day = opDay;
      cat = op.category_slug ?? '';
      if (byCat && !opened.has(cat || NONE)) return header; // раздел свёрнут — строк не рисуем
      const opCat = incomeCat(op.category_slug);
      const many = ops.length > 1;
      const isOpen = many && expanded.has(expandKey(gk));
      const note = [
        `<span class="op-cat" style="background:${opCat?.color ?? '#d7dbe2'}"></span>${esc(opCat?.name ?? T.income.noCategory)}`,
        byDate ? esc(timeRu(op.at)) : `${dateRu(opDay)} ${esc(timeRu(op.at))}`,
        many ? `${int.format(ops.length)} ${pl(ops.length, T.income.many)}` : esc(op.account_name ?? ''),
      ].filter(Boolean).join(' · ');
      const toggle = many
        ? ` <span class="expand${isOpen ? ' open' : ''}" data-expand="${esc(gk)}" role="button" aria-label="${isOpen ? 'Свернуть' : 'Показать поступления'}">${UI.chevron}</span>`
        : '';
      const row = `${header}
        <button class="row item bank-op" type="button" data-op="${op.id}"${many ? ` data-long="${esc(gk)}"` : ''}>
          <span class="row-main">
            <span class="row-title">${esc(op.description ?? op.merchant ?? T.income.one)}</span>
            <span class="row-note">${note}${toggle}</span>
          </span>
          <span class="row-sum income">+${money(groupSum)}</span>
        </button>`;
      if (!isOpen) return row;
      // Поступления строки — со сдвигом, «шторкой», как покупки группы в расходах
      const subs = ops.map((x) => `
          <button class="row item sub-row" type="button" data-op="${x.id}">
            <span class="row-main">
              <span class="row-title">${dateRu(x.at.slice(0, 10))} · ${esc(timeRu(x.at))}</span>
              <span class="row-note">${esc(x.account_name ?? '')}</span>
            </span>
            <span class="row-sum income">+${money(x.amount)}</span>
          </button>`).join('');
      return `${row}<div class="sub-wrap">${subs}</div>`;
    })
    .join('');

  return `${head}<div class="list">${html}</div>`;
}

/**
 * С кем операция: обычно продавец, а у перевода человеку — сам человек (в Т-Банке «продавец»
 * перевода — банк получателя). Так же считает сервер (opWho в bankmatch.mjs).
 */
/** Сумма покупки в валюте («70,00 TRY») — у валютной операции; учёт идёт в рублях (fx.mjs). */
const foreign = (op) =>
  op.orig_currency
    ? `${(Math.abs(op.orig_amount) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${op.orig_currency}`
    : null;

const opWho = (op) => (op.op_group === 'TRANSFER' && /банк|bank|^клиенту|^втб$/i.test(op.merchant ?? '')
  ? op.description || op.merchant
  : op.merchant || op.description) || null;

/** Откуда трата попала в Чекер: значок в строке отвечает на этот вопрос без слов. */
const SOURCES = {
  receipt: { title: 'Из чека', icon: UI.receipt },
  market: { title: 'С маркетплейса', icon: UI.bag },
  manual: { title: 'Вручную', icon: UI.keyboard }, // карандаш путали с кнопкой «редактировать»
  bank: { title: 'Из банка', icon: UI.bank },
  failed: { title: 'Чек с ошибкой', icon: UI.receipt }, // скан, который ФНС не отдала: сумма и дата — из QR
};

// Какие разделы ленты (дни, категории) открыты. Ключ — всё, что меняет состав ленты:
// в другом периоде или сортировке снова открыт только верхний раздел
const sectionState = new Map();
let feedSections = { order: [], single: false };
// Поиск в ключ не входит: раскрытое человеком остаётся раскрытым, что бы он ни искал
// Отбор (источник, группа) — тоже часть ключа: отобранный список начинает со своих разделов
const sectionsKey = () => `${state.screen}|${state.sort}|${state.group}|${state.category}|${state.from}|${state.to}|${state.src}|${state.sg}|${state.inf}|${state.isrc}`;
// Строк немного — разделы сразу раскрыты: прятать нечего, а открывать по одному — лишние нажатия.
// Не в поиске: найденное там намеренно свёрнуто, раскрывает человек
const FEW_ROWS = 30;
const fewRows = (n) => n <= FEW_ROWS && !state.q.trim();
/** Раскрытые разделы списка. Впервые — first (один раздел) или all (все, например при поиске). */
function openSections(first, all = null) {
  const key = sectionsKey();
  if (!sectionState.has(key)) sectionState.set(key, new Set(all ?? (first != null ? [first] : [])));
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
  setTitle(income ? T.income.one : 'Товар'); // вид операции известен только теперь
  for (const tab of document.querySelectorAll('[data-tab]')) tab.classList.toggle('on', tab.dataset.tab === (income ? 'income' : 'summary'));
  return itemCard({
    id: op.id,
    source: 'bank',
    income,
    sum: op.amount,
    // У поступления главное — описание («Проценты на остаток», имя отправителя), а «продавец»
    // — лишь канал, которым оно пришло («Бонусы», «Входящий перевод»)
    name: income ? op.description || op.sender || op.merchant || T.income.one : opWho(op) ?? 'Без названия',
    purchased_at: op.at,
    quantity: 1,
    seller: op.merchant && op.description && op.description !== op.merchant ? (income ? op.merchant : op.description) : null,
    category_slug: op.category_slug,
    same_name_count: op.same_count,
    merchant: opWho(op), // у перевода — получатель: по нему и «все траты этого продавца»
    orig: foreign(op),
    note: op.note,
    card: op.card,
    account_name: op.account_name,
    account: op.account,
    bank: op.bank,
    manualIncome: op.bank === 'manual', // вписан вручную: источник «вручную», его можно удалить
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
        // Покупка в валюте: сверху — рубли, которые ушли, здесь — сколько было в валюте
        ['В валюте', esc(it.orig ?? '')],
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
        ['Источник', it.manualIncome ? `${SOURCES.manual.icon} ${esc(T.sources.manual)}` : `${SOURCES[it.source].icon} ${esc(sourceName(it))}`],
      ])}
    </div>

    <div class="card">
      <div class="card-label">Категория</div>
      <button class="cat-pick" id="item-cat" type="button" ${it.income ? `data-op-incat="${it.id}"` : bank ? `data-op-cat="${it.id}"` : `data-item-cat="${it.id}"`}>${it.income ? incomeButton(it.category_slug) : categoryButton(it.category_slug)}</button>
      <div class="pick-same">
      <p class="note" id="pick-note">${
        it.same_name_count > 1
          ? it.income
            ? f(T.income.affects, { n: int.format(it.same_name_count), word: pl(it.same_name_count, T.income.many) })
            : bank
            ? `Изменение категории затронет ${int.format(it.same_name_count)} ${plural(it.same_name_count, 'трату', 'траты', 'трат')} этого продавца`
            : `Изменение категории затронет ${int.format(it.same_name_count)} ${plural(it.same_name_count, 'позицию', 'позиции', 'позиций')} с таким же названием`
          : ''
      }</p>
      ${it.same_name_count > 1 ? `
      <button class="pick-same-go" type="button" data-same-go="${esc(it.income ? it.name : bank ? it.merchant ?? it.name : it.name)}"
        data-same="${esc(it.income ? `in|${sameKey(it.name)}` : bank ? `op|${sameKey(it.merchant ?? it.name)}` : `item|${it.name_norm}`)}"
        data-same-screen="${it.income ? 'income' : 'summary'}" aria-label="Показать все такие же" title="Показать все такие же">${GO}</button>` : ''}
      </div>
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
      ${it.manualIncome
        ? `<button class="btn danger" type="button" data-op-del="${it.id}">Удалить запись</button>`
        : bank
        ? `<button class="btn danger" type="button" data-op-kind="excluded" data-id="${it.id}">Не учитывать</button>
           <p class="note">${it.income ? T.income.transferHint : 'Перевод себе — например, на карту Озона — отмечается в выборе категории: расходом станут покупки, сделанные на эти деньги.'}</p>`
        : `<button class="btn danger" type="button" data-item-hide="${it.id}">${it.source === 'manual' ? 'Удалить запись' : 'Убрать из расходов'}</button>`}
    </div>

    ${it.source === 'receipt' || it.source === 'market' ? `
    <div class="card">
      <div class="card-label">Чек</div>
      <button class="cat-pick" type="button" data-item-receipt="${it.receipt_id}">
        <span class="pick-ic" style="background:var(--fill);color:var(--muted)">${UI.receipt}</span>
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

  // Готовые периоды — четырьмя строками: дни, недели, месяцы, годы. Неделя — с понедельника
  const now = new Date();
  const span = (from, to) => ({ from: isoDay(from), to: isoDay(to) });
  const monday = addDays(now, -((now.getDay() + 6) % 7));
  const presets = [
    ['days', 'Сегодня', () => span(now, now)],
    ['days', 'Вчера', () => span(addDays(now, -1), addDays(now, -1))],
    ['days', '7 дней', () => span(addDays(now, -6), now)],
    ['days', '30 дней', () => span(addDays(now, -29), now)],
    ['weeks', 'Эта неделя', () => span(monday, addDays(monday, 6))],
    ['weeks', 'Прошлая неделя', () => span(addDays(monday, -7), addDays(monday, -1))],
    ['weeks', '2 недели', () => span(addDays(monday, -7), addDays(monday, 6))],
    ['months', 'Этот месяц', () => monthPeriod(now.getFullYear(), now.getMonth())],
    ['months', 'Прошлый месяц', () => monthPeriod(now.getFullYear(), now.getMonth() - 1)],
    ['months', '3 месяца', () => monthPeriod(now.getFullYear(), now.getMonth() - 2, 3)],
    ['years', 'Этот год', () => monthPeriod(now.getFullYear(), 0, 12)],
    ['years', 'Прошлый год', () => monthPeriod(now.getFullYear() - 1, 0, 12)],
  ];
  if (meta?.stats?.date_from) {
    presets.push(['years', 'Всё время', () => ({ from: meta.stats.date_from.slice(0, 10), to: meta.stats.date_to.slice(0, 10) })]);
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
        <div class="cal-presets">${['days', 'weeks', 'months', 'years'].map((row) => `
          <div class="cal-preset-row">${presets
            .map(([r, label, period], i) => {
              if (r !== row) return '';
              // Выбранный сейчас период — подсвечен
              const p = period();
              const on = p.from === start && p.to === (end ?? start);
              return `<button class="chip${on ? ' on' : ''}" type="button" data-preset="${i}">${label}</button>`;
            })
            .join('')}</div>`).join('')}</div>
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
      return go(presets[Number(preset.dataset.preset)][2](), true);
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
  // Сканы с ошибкой — строками в ленте и пунктом фильтра, а не счётчиком на вкладке
  failedCount = count ?? 0;
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
      if (!(await ask('Удалить скан? Чек можно будет отсканировать заново.', { ok: T.common.delete, danger: true }))) return;
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
      <button class="add-btn" type="button" data-screen="income_add">
        <span class="add-ic">${UI.income}</span>
        <span class="add-text"><b>Доход вручную</b><span>Зарплата наличными, возврат долга, подработка</span></span>
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

/**
 * Считанный код — картинкой в рамке, пока ФНС отвечает: камера к этому времени погашена, и
 * рамка была бы просто тёмной. Модули — скруглёнными точками, глазки — кольцами; часть точек
 * изредка мигает, по рамке бегут утолщения (scannerRun): видно, что работа идёт.
 */
function scannerQr(text) {
  let q;
  try {
    q = qrcode(0, 'M');
    q.addData(text);
    q.make();
  } catch {
    return ''; // не уложилось в код — оставляем рамку как была
  }
  const n = q.getModuleCount();
  const eye = (x, y) => x < 7 && y < 7 ? [0, 0] : x >= n - 7 && y < 7 ? [n - 7, 0] : x < 7 && y >= n - 7 ? [0, n - 7] : null;
  let dots = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!q.isDark(y, x) || eye(x, y)) continue;
      // Каждая девятая точка мигает — в своё время, чтобы мерцание шло вразнобой
      const blink = Math.random() < 0.11 ? ` class="qr-blink" style="animation-delay:${(Math.random() * 3).toFixed(2)}s"` : '';
      dots += `<rect x="${x + 0.08}" y="${y + 0.08}" width="0.84" height="0.84" rx="0.3"${blink}/>`;
    }
  }
  const eyes = [[0, 0], [n - 7, 0], [0, n - 7]].map(([x, y]) => `
    <rect x="${x + 0.5}" y="${y + 0.5}" width="6" height="6" rx="1.7" fill="none" stroke="currentColor" stroke-width="1"/>
    <rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="0.9"/>`).join('');
  return `<div class="scanner-qr"><svg viewBox="-1 -1 ${n + 2} ${n + 2}" aria-hidden="true">${eyes}${dots}</svg></div>
    <canvas class="scanner-run" aria-hidden="true"></canvas>`;
}

/**
 * Утолщения, бегущие по рамке сканера: голова — втрое толще рамки, хвост плавно сужается до её
 * толщины. Их 2–4, у каждого своя скорость; одни вырастают в случайном месте, другие сходят на
 * нет — сужаются до толщины рамки. Рисуются по кадрам на холсте поверх рамки, пока сканер ждёт
 * ответа; отказ (scan-failed) или закрытие — останавливают.
 */
function scannerRun(current) {
  const canvas = current.el.querySelector('canvas.scanner-run');
  if (!canvas) return;
  const PAD = 6; // холст шире рамки: голова выходит за её линию
  const LINE = 2; // толщина рамки — как border у .scanner-frame
  const R = 16 - LINE / 2; // радиус по середине линии рамки
  const box = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * dpr);
  canvas.height = Math.round(box.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  // Середина линии рамки — скруглённый прямоугольник; точка и нормаль по длине s
  const x0 = PAD + LINE / 2;
  const y0 = PAD + LINE / 2;
  const w = box.width - 2 * x0;
  const h = box.height - 2 * y0;
  const sx = w - 2 * R;
  const sy = h - 2 * R;
  const arc = (Math.PI / 2) * R;
  const per = 2 * sx + 2 * sy + 4 * arc;
  const at = (s) => {
    s = ((s % per) + per) % per;
    const corner = (cx, cy, a0, t) => {
      const a = a0 + (t / arc) * (Math.PI / 2);
      return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) };
    };
    const legs = [
      [sx, (t) => ({ x: x0 + R + t, y: y0, nx: 0, ny: -1 })],
      [arc, (t) => corner(x0 + w - R, y0 + R, -Math.PI / 2, t)],
      [sy, (t) => ({ x: x0 + w, y: y0 + R + t, nx: 1, ny: 0 })],
      [arc, (t) => corner(x0 + w - R, y0 + h - R, 0, t)],
      [sx, (t) => ({ x: x0 + w - R - t, y: y0 + h, nx: 0, ny: 1 })],
      [arc, (t) => corner(x0 + R, y0 + h - R, Math.PI / 2, t)],
      [sy, (t) => ({ x: x0, y: y0 + h - R - t, nx: -1, ny: 0 })],
      [arc, (t) => corner(x0 + R, y0 + R, Math.PI, t)],
    ];
    for (const [len, fn] of legs) {
      if (s <= len) return fn(s);
      s -= len;
    }
    return legs[0][1](0);
  };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const GROW = 700; // мс — вырасти или сойти на нет
  const spawn = (t) => ({ s: rnd(0, per), v: rnd(0.04, 0.12) * per / 1000, len: rnd(0.12, 0.24) * per, born: t, dies: t + rnd(2500, 6000) });
  let comets = null;
  let last = 0;
  const frame = (t) => {
    if (scanner !== current || current.el.classList.contains('scan-failed')) return ctx.clearRect(0, 0, box.width, box.height);
    if (!comets) comets = Array.from({ length: 2 + Math.floor(Math.random() * 2) }, () => spawn(t - rnd(0, GROW)));
    const dt = last ? Math.min(50, t - last) : 0;
    last = t;
    // Догорели — убираем; меньше двух — вырастает новое, иногда и сверх того, но не больше четырёх
    comets = comets.filter((c) => t < c.dies + GROW);
    const alive = comets.filter((c) => t < c.dies).length;
    if (alive < 2 || (comets.length < 4 && Math.random() < dt / 2500)) comets.push(spawn(t));
    ctx.clearRect(0, 0, box.width, box.height);
    ctx.fillStyle = '#4ade80';
    for (const c of comets) {
      c.s += c.v * dt;
      const ease = (k) => k * k * (3 - 2 * k);
      const amp = ease(Math.min(1, (t - c.born) / GROW)) * ease(Math.max(0, Math.min(1, (c.dies + GROW - t) / GROW)));
      // Контур: от головы к хвосту по внешней стороне, обратно — по внутренней
      const N = Math.ceil(c.len / 1.5); // точка на каждые полтора пикселя: на скруглениях не видно граней
      const side = [];
      for (let i = 0; i <= N; i++) {
        const k = i / N; // 0 — голова, 1 — хвост
        const p = at(c.s - k * c.len);
        const half = (LINE + 2 * LINE * amp * (1 - k) ** 1.6) / 2;
        side.push([p, half]);
      }
      ctx.beginPath();
      side.forEach(([p, half], i) => ctx[i ? 'lineTo' : 'moveTo'](p.x + p.nx * half, p.y + p.ny * half));
      for (let i = side.length - 1; i >= 0; i--) ctx.lineTo(side[i][0].x - side[i][0].nx * side[i][1], side[i][0].y - side[i][0].ny * side[i][1]);
      ctx.closePath();
      ctx.fill();
      // Голова — скруглённая: кружок её толщины
      const head = at(c.s);
      ctx.beginPath();
      ctx.arc(head.x, head.y, side[0][1], 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Отправка распознанной строки и слежение за заданием до готовности. */
async function submitScan(current, qr) {
  current.el.classList.add('caught');
  const frame = current.el.querySelector('.scanner-frame');
  if (!frame.querySelector('.scanner-qr')) {
    frame.insertAdjacentHTML('afterbegin', scannerQr(qr));
    scannerRun(current);
  }
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
    current.el.classList.add('scan-failed');
    return scannerSay(current, esc(cap(err.message)), { error: true, actions: again });
  }

  job = await followScan(job, (j) => scannerSay(current, `${esc(cap(jobNote(j)))}…`));
  if (scanner !== current) return; // закрыли, не дождавшись: чек и так появится в списке

  if (job.status === 'done' && job.receipt_id) {
    closeScanner();
    go({ screen: 'added', added: String(job.receipt_id) });
  } else if (job.status === 'failed') {
    current.el.classList.add('scan-failed');
    feedData.delete('/api/scan?state=failed');
    apiFeed('/api/scan?state=failed').then((d) => updateBadge(d.counts.failed)).catch(() => {});
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
    return `<span class="pick-ic" style="background:var(--fill);color:var(--muted)">${groupIcon('none')}</span>
      <span class="cat-name muted">${T.income.pick}</span>`;
  }
  const color = found.group.color ?? 'var(--fill)';
  return `<span class="pick-ic" style="background:${color};color:${readableText(color)}">${groupIcon(catIcon(found))}</span>
    <span class="cat-name">${esc(found.name)}<small>${esc(found.group.name)}</small></span>`;
}

/** Отметить «перевод себе»: одну операцию или все такие же (и будущие). */
async function markTransfer(id, only) {
  const res = await post(`/api/bank/ops/${id}/kind`, { kind: 'transfer', only });
  screenCache.clear();
  toast(res.affected > 1 ? `Отмечено как перевод себе · ещё ${int.format(res.affected - 1)} таких же` : 'Отмечено как перевод себе');
  // Карточка операции больше не трата и не доход — возвращаемся к списку
  if (state.screen === 'op') history.back();
  else render();
}

async function saveIncomeCategory(id, slug, { only = false } = {}) {
  try {
    if (slug === TRANSFER) return await markTransfer(id, only);
    const res = await post(`/api/bank/ops/${id}/category`, { category: slug, only });
    screenCache.clear();
    toast(res.affected > 1 ? f(T.income.savedMore, { n: int.format(res.affected - 1) }) : only ? 'Категория выбрана · только для этого дохода' : T.income.saved);
    render();
  } catch (err) {
    toast(`Не сохранилось: ${err.message}`);
  }
}

function categoryButton(slug) {
  const found = findCategory(slug);
  if (!found) {
    return `<span class="pick-ic" style="background:var(--fill);color:var(--muted)">${groupIcon('none')}</span>
      <span class="cat-name muted">Выбрать категорию</span>`;
  }
  const color = found.group.color ?? 'var(--fill)';
  return `<span class="pick-ic" style="background:${color};color:${readableText(color)}">${groupIcon(catIcon(found))}</span>
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

/** Доход, вписанный вручную: те же поля, что у ручной траты, категория — из справочника доходов. */
let incomeAddCat = ''; // переживает перерисовку, как manualCategory

function screenIncomeAdd() {
  const today = isoDay(new Date());
  return `
    <form class="card form" id="income-form" novalidate>
      <label class="field">
        <span>Сумма, ₽</span>
        <input id="i-sum" class="sum-input" inputmode="decimal" autocomplete="off" placeholder="0" required />
      </label>
      <label class="field">
        <span>Откуда</span>
        <input id="i-name" type="text" maxlength="200" autocomplete="off" placeholder="Зарплата, возврат долга" />
      </label>
      <label class="field">
        <span>Дата</span>
        <input id="i-date" type="date" value="${today}" max="${today}" required />
      </label>
      <div class="field">
        <span>Категория</span>
        <button class="cat-pick" id="i-cat" type="button">${incomeButton(incomeAddCat)}</button>
      </div>
      <label class="field">
        <span>Комментарий</span>
        <textarea id="i-note" class="m-note" rows="2" maxlength="1000" placeholder="Необязательно"></textarea>
      </label>
      <p class="note" id="i-msg"></p>
      <button class="btn primary big" id="i-save" type="submit">Записать</button>
    </form>`;
}

async function saveIncome() {
  const msg = $('i-msg');
  const sum = $('i-sum').value.trim();
  const date = $('i-date').value;
  msg.classList.add('error');
  if (!(Number(sum.replace(/\s/g, '').replace(',', '.')) > 0)) {
    msg.textContent = 'Укажите сумму';
    return $('i-sum').focus();
  }
  if (!date) return (msg.textContent = 'Укажите дату');
  if (!incomeAddCat) return (msg.textContent = 'Выберите категорию');
  const now = new Date();
  const time = date === isoDay(now) ? `${pad(now.getHours())}:${pad(now.getMinutes())}` : '12:00';
  $('i-save').disabled = true;
  msg.classList.remove('error');
  msg.textContent = 'Записываем…';
  try {
    await post('/api/income/manual', { sum, date, time, name: $('i-name').value, category: incomeAddCat, note: $('i-note').value });
    incomeManual = true;
    toast('Доход записан');
    // В «Доход» — за месяц этой записи: она там видна сразу
    const d = parseDay(date);
    openTab('income', monthPeriod(d.getFullYear(), d.getMonth()));
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = `Не записалось: ${err.message}`;
  } finally {
    if ($('i-save')) $('i-save').disabled = false;
  }
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
  itemCtx.set(`item:${item.id}`, item);
  const group = findGroup(item.group_slug);
  const color = group?.color ?? 'var(--fill)';
  // Зелёная точка на значке — категорию предложил Чекер, без точки — выбрал человек
  const human = ['manual', 'pinned', 'seller'].includes(item.category_source);
  const guess = item.category_slug && !human ? ' guess' : '';

  const body = `
      <span class="pick-ic" style="background:${color};color:${readableText(color)}">${groupIcon(catIcon(findCategory(item.category_slug) ?? { group }))}</span>
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
// Что известно о записи, у которой меняют категорию, — для переключателей «для всех таких же»:
// продавец у товара, есть ли продавец у операции. Заполняется при отрисовке строк
const itemCtx = new Map(); // 'item:id' | 'op:id' → строка

/**
 * Переключатели «для всех таких же» в окне выбора категории: что считается «таким же» —
 * у позиции чека название, у траты банка продавец, у дохода описание. Число — если известно
 * (карточка открыта); одна-единственная — переключатель не нужен.
 */
function sameFor(kind, id) {
  const shown = itemShown?.id === id ? itemShown : null;
  const ctx = shown ?? itemCtx.get(`${kind === 'item' ? 'item' : 'op'}:${id}`) ?? null;
  const count = shown ? shown.same_name_count : null;
  const note = (word) => (count == null ? 'и для новых' : `${int.format(count)} ${word} · и для новых`);
  const many = count == null || count > 1;

  if (kind === 'op') {
    if (!many) return null;
    // Продавца нет (переводы, пополнения) — правило держится на описании, так и пишем
    const merchant = ctx ? Boolean(ctx.merchant) : true;
    return [{ key: 'all', title: merchant ? 'Для всех трат этого продавца' : 'Для всех с таким описанием', note: note(plural(count ?? 0, 'трата', 'траты', 'трат')) }];
  }
  if (kind === 'income') {
    return many ? [{ key: 'all', title: 'Для всех с таким описанием', note: note(pl(count ?? 0, T.income.many)) }] : null;
  }
  const out = [];
  if (many) out.push({ key: 'all', title: 'Для всех с таким названием', note: note(plural(count ?? 0, 'позиция', 'позиции', 'позиций')) });
  // Продавец — магазин, а не площадка: у маркетплейса в чеке сама площадка
  if (ctx?.seller_inn && !ctx.market) {
    out.push({ key: 'seller', title: 'Все товары этого продавца', note: `${ctx.seller ? `${sellerName(ctx)} · ` : ''}и новые покупки у него` });
  }
  return out.length ? out : null;
}

/** Не категория, а вид: «перевод себе». Выбирается в том же окне, что и категория. */
const TRANSFER = '#transfer';

function openCategoryPicker(itemId, onPick, groups = meta?.categories ?? [], same = null, { transfer = false, note = '', title = '' } = {}) {
  const income = groups === meta?.income;
  // Выключены (по умолчанию) — категория меняется только у этой записи; включают, когда нужно
  // разложить всех таких же разом. Помним между шагами (группа → категория)
  const on = {};
  const sameRow = () =>
    same?.length
      ? `<div class="picker-same">${same.map((x) => `
          <div class="picker-same-row">
            <span class="same-text">${esc(x.title)}<small class="note">${esc(x.note)}</small></span>
            ${toggle(`data-same="${x.key}"`, Boolean(on[x.key]), x.title)}
          </div>`).join('')}
        </div>`
      : '';
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
  // note — своё пояснение под заголовком (например, зачем выбирать при удалении категории)
  const subtitle = note
    ? `<small class="picker-for full">${esc(note)}</small>`
    : name ? `<small class="picker-for">${f(income ? T.income.pickFor : 'Выберите категорию для расхода «{name}»', { name: esc(name) })}</small>` : '';
  const closeBtn = `<button class="icon-btn soft" data-close type="button" aria-label="Отмена" title="Отмена">${UI.close}</button>`;

  const showGroups = () => {
    picker.innerHTML = `
      <div class="picker-box" role="dialog" aria-label="Выбор группы">
        <div class="picker-top"><div class="picker-title">${esc(title || 'Группа')}${subtitle}</div>${closeBtn}</div>
        ${sameRow()}
        ${transfer ? `
        <div class="picker-list picker-special">
          <button class="picker-item" type="button" data-category="${TRANSFER}">
            <span class="pick-ic" style="background:var(--fill);color:var(--muted)">${UI.swap}</span>
            <span class="picker-special-text">Перевод себе<small class="note">не расход и не доход: на свою карту, в копилку</small></span>
          </button>
        </div>` : ''}
        <div class="filt-grid">${groups.map((g) => pickTile(`data-group="${esc(g.slug)}"`, groupTileIc(g), g.name)).join('')}</div>
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
        ${sameRow()}
        <div class="picker-list">
          ${group.subcategories
            .map(
              (s, i) => `
              <button class="picker-item" type="button" data-category="${esc(s.slug)}">
                <span class="pick-ic" style="background:${tones[i] ?? group.color ?? 'var(--fill)'};color:${readableText(tones[i] ?? group.color ?? 'var(--fill)')}">${groupIcon(s.icon || group.icon || 'none')}</span>
                <span>${esc(s.name)}</span>
              </button>`,
            )
            .join('')}
        </div>
      </div>`;
  };

  picker.addEventListener('change', (e) => {
    if (e.target.matches('[data-same]')) on[e.target.dataset.same] = e.target.checked;
  });

  picker.addEventListener('click', (e) => {
    if (e.target === picker || e.target.closest('[data-close]')) return close();
    if (e.target.closest('[data-back]')) return showGroups();

    const group = e.target.closest('[data-group]');
    if (group) return showCategories(groups.find((g) => g.slug === group.dataset.group));

    const category = e.target.closest('[data-category]');
    if (category) {
      close(); // возвращаемся к списку товаров сразу, не дожидаясь сохранения
      // Переключателя «по названию» нет (запись одна такая) — выбор запоминается и для новых
      const byName = same?.some((x) => x.key === 'all') ? Boolean(on.all) : true;
      onPick(itemId, category.dataset.category, { only: !byName, seller: Boolean(on.seller) });
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
    if (pick) return openCategoryPicker(Number(pick.dataset.pick), saveCategory, undefined, sameFor('item', Number(pick.dataset.pick)));

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
async function saveOpCategory(id, slug, { only = false } = {}) {
  try {
    if (slug === TRANSFER) return await markTransfer(id, only);
    const res = await post(`/api/bank/ops/${id}/category`, { category: slug, only });
    toast(res.affected > 1 ? `Категория выбрана · ещё ${int.format(res.affected - 1)} у этого продавца` : only ? 'Категория выбрана · только для этой траты' : 'Категория выбрана');
    render();
  } catch (err) {
    toast(`Не сохранилось: ${err.message}`);
  }
}

/** Сохранение выбранной категории и обновление строки на месте. */
async function saveCategory(itemId, slug, { only = false, seller = false } = {}) {
  const row = document.querySelector(`.sheet-row[data-row="${itemId}"]`);
  if (!row) return;
  row.classList.add('saving');

  try {
    const data = await post(`/api/items/${itemId}/category`, { category: slug, only, seller });
    if (data.seller_affected > 1) toast(`У продавца теперь «${data.category?.name ?? ''}»: ${int.format(data.seller_affected)} ${plural(data.seller_affected, 'позиция', 'позиции', 'позиций')}`);

    const group = findCategory(slug)?.group;
    const color = group?.color ?? 'var(--fill)';
    const ic = row.querySelector('.pick-ic');
    ic.style.background = color;
    ic.style.color = readableText(color);
    ic.innerHTML = groupIcon(catIcon(findCategory(slug)));
    row.classList.remove('guess'); // выбор человека, точку снимаем
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
let wizCompact = false; // ход загрузки сжат: список под ним пролистан (см. обработчик прокрутки)

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
  wiz = { bank, step: 'intro', accounts: null, selected: [], result: null, ...(saved.state ?? {}), started: saved.started_at ?? null };
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
      <div class="stuck-head wiz-stuck${wizCompact ? ' compact' : ''}"><div class="card wiz-load">
        <h2 class="wiz-title">${failed ? T.wizard.load.titleFailed : paused ? T.wizard.load.titleStopped : T.wizard.load.title}</h2>
        <div class="wiz-bar${p.total ? '' : ' flow'}"><span id="wiz-bar" style="width:${p.total ? Math.min(100, Math.round(((p.done ?? 0) / p.total) * 100)) : 0}%"></span></div>
        <div class="wiz-nums">
          <div><b id="wiz-ops">0</b><small class="note">${isShop(w.bank) ? shopText(w.bank).receipts : T.wizard.load.ops}</small></div>
          <div><b id="wiz-mid">—</b><small class="note" id="wiz-mid-label">${isShop(w.bank) ? '' : T.wizard.load.parts}</small></div>
          <div><b id="wiz-eta">—</b><small class="note">${T.wizard.load.left}</small></div>
        </div>
        <p class="note" id="wiz-now"></p>
        ${failed ? `<p class="note error">${f(T.wizard.load.savedFailed, { why: esc(w.error ?? '') })}</p>` : ''}
        ${paused ? `<p class="note">${T.wizard.load.savedStopped}</p>` : ''}
      </div></div>
      <p class="note wiz-hint">${T.wizard.load.keepOpen}</p>
      ${w.started ? `
      <div class="card wiz-fresh">
        <div class="card-label">Что уже загрузили <span id="wiz-fresh-count"></span></div>
        <p class="note">Свежие — сверху. Нажмите на строку, чтобы поменять категорию, не дожидаясь конца загрузки; зелёная точка — категорию предложил Чекер.</p>
        <div class="sheet-list" id="wiz-fresh"></div>
      </div>` : ''}`;
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
      </div>
      ${wizReview()}`;
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
    </div>` : ''}
    ${wizReview()}`;
}

/** Итог мастера: всё загруженное можно сразу посмотреть по категориям и поправить. */
const wizReview = () =>
  wiz?.started
    ? `<div class="card"><button class="btn big" type="button" data-fresh-open="${esc(wiz.bank)}" data-since="${esc(wiz.started)}">Посмотреть загруженное и поправить категории</button></div>`
    : '';

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
  if ($('wiz-fresh') && !$('wiz-fresh').childElementCount) wizFreshDraw(); // после перерисовки экрана
  if (!wizFresh.data) wizFreshLoad(); // дальше список подтягивается по событиям загрузки
  const p = wiz.progress ?? {};
  const bar = $('wiz-bar');
  if (!bar) return;
  const total = p.total || 0;
  const done = p.done || 0;
  // У магазина — как у времени: число с единицей крупно («5 чеков», «3 мин»), подпись под ним
  $('wiz-ops').textContent = isShop(wiz.bank)
    ? `${int.format(p.ops ?? 0)} ${pl(p.ops ?? 0, T.common.receipts)}`
    : int.format(p.ops ?? 0);
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
    // У магазина «12 из 340» понятно и без подписи
    $('wiz-mid-label').textContent = isShop(wiz.bank) ? '' : p.byOps ? T.wizard.load.total : T.wizard.load.parts;
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
      const started = await post('/api/bank/history/start', { bank: wiz.bank });
      wiz.started = started.started_at ?? null;
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
    const prevOps = p.ops ?? 0;
    Object.assign(p, r, { waitUntil: 0 });
    if ((r.ops ?? 0) > prevOps) wizFreshLoad(); // пришло новое — сразу в список
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
  if (!box.checked && ops && !(await ask(f(T.bankCard.accounts.offConfirm, { ops: int.format(ops), opsWord: pl(ops, T.common.ops) }), { ok: T.common.disable }))) {
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
  summary: {
    title: () => ringTitle('Расходы', (k) => (k === NONE ? 'Без категории' : findGroup(k)?.name ?? findCategory(k)?.category.name)),
    render: screenSummary,
  },
  receipts: { title: 'Чеки', render: screenReceipts },
  add: { title: 'Добавить', render: screenAdd },
  // form — на экране поля, которые человек заполняет: закрытие попапа его не перерисовывает
  manual: { title: 'Вручную', render: screenManual, after: () => $('m-sum')?.focus(), form: true },
  income_add: { title: 'Доход вручную', render: screenIncomeAdd, after: () => $('i-sum')?.focus(), form: true },
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
  // Название категории, как у других экранов раздела (рядом — период)
  category: { title: () => (state.category === NONE ? 'Без категории' : findCategory(state.category)?.category.name ?? 'Расходы'), render: screenCategory },
  item: { title: 'Товар', render: screenItem, after: () => { mountItemMap(); fitNote(); } },
  bank: { title: 'Операции банка', render: screenBank },
  income: {
    title: () => ringTitle('Доход', (k) => (k === '-' ? T.income.noCategory : (meta?.income ?? []).find((g) => g.slug === k)?.name ?? incomeCat(k)?.name)),
    render: screenIncome,
  },
  stats: { title: 'Сводка', render: screenAnalytics, after: () => animateAnalytics() },
  settings: { title: 'Настройки', render: screenSettings, after: () => settingsSearch() },
  set_profile: { title: T.settings.profile.label, render: screenSetProfile },
  set_motion: { title: T.settings.look.motion, render: screenSetMotion },
  set_limits: { title: T.settings.limits.label, render: screenSetLimits, after: limitsFocus },
  set_backup: { title: T.settings.backup.label, render: screenSetBackup },
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
  autolabel: { title: 'Авторазметка', render: screenAutolabel, after: () => autoRun() },
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
  income: 'income', income_add: 'income', settings: 'settings', stats: 'stats', bank_card: 'settings', bank_add: 'settings',
  bank_safety: 'settings', bank_wizard: 'settings', op: 'summary', autolabel: 'summary',
  set_profile: 'settings', set_motion: 'settings', set_limits: 'settings', set_backup: 'settings', set_budget: 'settings', set_banks: 'settings', privacy: 'settings', set_cats: 'settings', set_group: 'settings', set_cat: 'settings',
};

/**
 * Сколько места внизу занимают закреплённые панели — вкладки и полоса кнопок. Столько
 * же отступа нужно ленте, иначе последние строки уйдут под панели. Высота разная:
 * полоса кнопок есть не на всех экранах, а у телефонов разная безопасная зона снизу.
 */
function updateDock() {
  // Меню — остров над низом экрана: место под ним считаем от его верха до низа экрана
  // «+» выступает над островом — считаем от того, что выше
  const top = Math.min(document.querySelector('.tabs').getBoundingClientRect().top, $('fab').getBoundingClientRect().top);
  const tabs = Math.ceil(window.innerHeight - top);
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
  // Круг — поверх страницы, в центре изменённой части: внутри подписи его обрезало
  const r = el.getBoundingClientRect();
  const ring = document.createElement('div');
  ring.className = 'note-ripple';
  ring.style.left = `${r.left + r.width / 2}px`;
  ring.style.top = `${r.top + r.height / 2}px`;
  document.body.appendChild(ring);
  // Снимаем по таймеру: событие конца анимации приходит не во всех браузерах
  setTimeout(() => {
    el.classList.remove('pulse');
    ring.remove();
  }, 1100);
}
// Куда шли к этому экрану: вглубь (go) или «назад» — по нему экраны въезжают справа
// или слева (slideScreen)
let navDir = '';
// Свайп вкладок — лента страниц: старый и новый экран стоят вплотную и едут вместе, без
// прозрачности. Старый уезжает в тот же кадр, что отпустили палец (pagerLeave), — в отдельном
// слое, анимацией браузера: она идёт, даже пока телефон собирает новый экран. Новый встаёт в
// ту же ленту по общим часам (pagerJoin из render): ровно там, где ему быть в эту минуту.
// { dx, done, finished } — от свайпа
let screenPager = null;

// Экран приехал движением (сдвиг по нажатию или лента страниц): строки приехали с ним и
// второй раз не проявляются, а заливки (кольцо, полосы, счётчик) ждут его остановки
let arrived = false;
// Следующая отрисовка — приехавшего движением (свайп периода ставит до go). Метка живёт одну
// отрисовку: render ставит её в начале — перебитая отрисовка больше не оставляет её висеть,
// а с ней — выключенными анимации списков
let arriveNext = false;
// Заливки (кольцо, полосы лимита) пока ждут: новый период ещё въезжает (swipeEnd)
let holdFills = false;
const PAGER_MS = 320;
const PAGER_EASE = 'cubic-bezier(0.25, 0.75, 0.35, 1)';

function pagerLeave(p) {
  const el = $('screen');
  const r = el.getBoundingClientRect();
  // Слой — высотой окна, содержимое сдвинуто на прокрутку: телефон растрирует только видимое,
  // а не всю ленту в сотни строк (на этом и запинался первый кадр)
  const box = document.createElement('div');
  box.className = 'pager-old';
  Object.assign(box.style, { left: `${r.left}px`, top: '0', width: `${r.width}px`, height: `${window.innerHeight}px` });
  const inner = document.createElement('div');
  inner.style.marginTop = `${r.top}px`;
  box.append(inner);
  // Шапка прилипала к верху — в отдельном слое прилипать не к чему: ставим её туда, где была
  const head = el.querySelector(':scope > .stuck-head');
  const headTop = head?.getBoundingClientRect().top;
  for (const c of [...el.children]) {
    c.style.transition = 'none';
    c.style.translate = '';
    inner.append(c);
  }
  document.body.append(box);
  if (head) {
    head.style.position = 'relative';
    head.style.top = '0';
    head.style.top = `${headTop - head.getBoundingClientRect().top}px`;
  }
  p.box = box;
  p.side = p.dx < 0 ? 1 : -1; // новый — с той стороны, куда тянули
  p.anim = box.animate([{ transform: `translateX(${p.dx}px)` }, { transform: `translateX(${-p.side * window.innerWidth}px)` }],
    { duration: PAGER_MS, easing: PAGER_EASE, fill: 'forwards' });
  p.moves = [p.anim];
}

function pagerJoin(p) {
  const start = p.side * window.innerWidth + p.dx; // вплотную к старому в начале пути
  const t = p.anim.startTime;
  // Вставлен вовремя (почти у края) — просто едет; опоздал — короткое проявление прячет
  // появление посреди пути. Иначе полупрозрачный новый рядом с плотным старым мерцал
  const late = (p.anim.currentTime ?? 0) > PAGER_MS * 0.25;
  const el = $('screen');
  el.classList.remove('busy'); // приглушение «идёт загрузка» — не новому экрану
  for (const c of el.children) {
    const move = c.animate([{ transform: `translateX(${start}px)` }, { transform: 'translateX(0)' }], { duration: PAGER_MS, easing: PAGER_EASE });
    if (t != null) move.startTime = t; // те же часы, что у старого: стоят вплотную
    p.moves.push(move);
    if (late) c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
  }
  pagerEnd(p);
}

function pagerEnd(p) {
  Promise.all(p.moves.map((m) => m.finished.catch(() => null))).then(() => {
    p.box.remove();
    // Готово — когда телефон перестроил страницу без старого экрана (два кадра): заливка
    // кольца, которая ждёт этого, не начнётся посреди тяжёлого кадра
    requestAnimationFrame(() => requestAnimationFrame(() => p.done?.()));
  });
}
let shownScreen = null; // что сейчас на экране: по нему решаем, мигать «Загрузкой» или нет

// Готовые экраны — чтобы вернуться на знакомый мгновенно. Ключ — адрес экрана со всеми
// параметрами (месяц, категория, банк). Только списки и настройки: у форм, карточек с
// картой и мастера после отрисовки своя жизнь (поля, таймеры), прошлый вид им не годится.
// Живут до перезагрузки страницы; свежий вид всё равно приходит следом и заменяет прошлый
const CACHED = ['summary', 'group', 'category', 'receipts', 'bank', 'income', 'settings', 'set_profile', 'set_budget', 'set_banks', 'set_cats', 'privacy', 'bank_card', 'bank_add', 'bank_safety'];
const screenCache = new Map();
/**
 * Ключ сохранённого вида экрана: адрес и то, что меняет вид, но в адрес не входит, — режим
 * «кольцо / список», раскрытая группа и «Остальное» кольца, поиск. Без них, вернувшись,
 * человек видел прошлый режим, а потом его подменял нужный.
 */
const viewKey = () => [location.search, state.mode, state.ringGroup, state.ringRest, state.q, state.same].join('|');

function remember(key, html) {
  screenCache.delete(key); // свежий — в конец очереди
  screenCache.set(key, html);
  if (screenCache.size > 40) screenCache.delete(screenCache.keys().next().value);
}
const EXPENSE = ['summary', 'receipts', 'bank']; // один раздел: переключатель в шапке, общая шапка
const NONE = '-'; // «Без категории»: у неразмеченного нет кода, но открывать его список нужно

async function render() {
  const seq = ++renderSeq;
  arrived = arriveNext;
  arriveNext = false;
  closeScanner(); // уходим с экрана (в том числе кнопкой «назад») — камера гаснет
  const screen = SCREENS[state.screen] ?? SCREENS.summary;
  const top = TOP.includes(state.screen);
  if (state.screen !== 'manual') manualPrefill = null; // заготовка из скана — только для этого захода
  if (state.screen !== 'added') manualCarry = null;

  setTitle(typeof screen.title === 'function' ? screen.title() : screen.title,
    state.screen === 'stats' || PERIOD_SCREENS.includes(state.screen) ? humanPeriod(state.from, state.to) : '');
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
  let ringNow = false;
  // Итог в шапке до перерисовки: на том же экране новый «прокрутится» к себе от него
  // (посреди прокрутки текст элемента — столбики цифр, поэтому показанное число — в data-sum)
  const prevEl = sameScreen ? document.querySelector('#screen .total-sum') : null;
  const prevSum = prevEl ? prevEl.dataset.sum ?? prevEl.textContent : null;
  // Переход на другой экран — сдвигом: пока новый грузится, виден прежний, без «Загрузки».
  // Смена вкладки — тоже сдвигом, по порядку вкладок: правее — въезжает справа, левее — слева
  const tabs = ['summary', 'income', 'settings', 'stats'];
  const tabSwitch = TOP.includes(state.screen) && TAB_OF[state.screen] !== TAB_OF[shownScreen]
    && tabs.includes(TAB_OF[state.screen]) && tabs.includes(TAB_OF[shownScreen]);
  const dir = tabSwitch ? (tabs.indexOf(TAB_OF[state.screen]) > tabs.indexOf(TAB_OF[shownScreen]) ? 'fwd' : 'back') : navDir;
  navDir = '';
  const pager = screenPager;
  screenPager = null;
  const slide = shown && !sameScreen && dir && !pager && motion('screens') ? dir : '';
  slideHead = Boolean(document.querySelector('#screen > .stuck-head .total'));
  const sameKind = (shown && ((EXPENSE.includes(state.screen) && EXPENSE.includes(shownScreen)) || Boolean(slide))) || Boolean(pager);
  // Экран уже открывали — сразу показываем, каким он был, а свежий вид подставим, когда
  // придут данные. Иначе «назад» каждый раз упирается в «Загрузку»
  const key = viewKey();
  const cached = !sameScreen && CACHED.includes(state.screen) ? screenCache.get(key) : null;
  // Экран въезжает (сдвиг или лента) — landed: когда он встанет на место
  let landed = null;
  const arrive = () => {
    $('screen').classList.remove('busy'); // приглушение было прежнему экрану, не новому
    landed = pager ? (pagerJoin(pager), pager.finished) : slideScreen(slide);
    if (!landed) return;
    arrived = true;
    if (state.screen === 'stats') {
      holdAnalytics(); // линии графика — пустыми, рисуются после остановки
    }
    playRing(false); // кольцо въезжает пустым
    playList(); // строки проявляются по одной прямо во время въезда
  };
  if (cached) {
    $('screen').innerHTML = cached;
    window.scrollTo(0, history.state?.scroll ?? 0); // «назад» — туда же, где оставили
    arrive();
    shownScreen = state.screen;
    // Без въезда кольцо заливается сразу, а свежие данные — после заливки (ниже): их разбор
    // занимает телефон, и заливка, идущая в это время, запиналась. Лента проявляется сразу
    // с сохранённым видом: иначе строки мелькнули бы и проявились заново со свежим
    if (!landed) {
      ringNow = playRing() === true;
      playList();
    }
  } else if (!sameScreen && !sameKind) {
    $('screen').innerHTML = loading();
    window.scrollTo(0, 0); // прокручивается страница, а не блок экрана
  }
  // Ответ задерживается — показываем это не пустотой, а приглушением списка. Если на экране
  // уже прошлый вид, не гасим: он почти наверняка верный, свежий тихо его заменит
  // Приглушается прежний экран, пока ждём; новый, уже въезжающий (landed), — никогда
  const dim = setTimeout(() => seq === renderSeq && !cached && !pager && !landed && $('screen').classList.add('busy'), 250);
  // (ringNow — с сохранённым видом пошла заливка кольца: свежие данные ждут её конца)

  try {
    // Экран едет — ничего тяжёлого: заливка кольца и свежие данные — после остановки
    if (landed) {
      await landed;
      if (seq !== renderSeq) return;
      ringNow = playRing() === true;
    }
    if (ringNow) {
      await new Promise((r) => setTimeout(r, RING_ANIM));
      if (seq !== renderSeq) return;
    }
    const html = await screen.render();
    if (seq !== renderSeq) return;
    if (CACHED.includes(state.screen)) remember(key, html);
    // Тот же список — остаёмся там же, где листали; другой — смотрим с начала
    const keepScroll = sameScreen || cached ? window.scrollY : 0;
    // Набирают в поиске — шапку с полем не трогаем, иначе закроется клавиатура
    if (sameScreen && document.activeElement?.id === 'q') patchKeepingSearch(html);
    // Ничего не изменилось — не трогаем: перерисовка сбросила бы нажатие и фокус
    else if (html !== cached) {
      $('screen').innerHTML = html;
      window.scrollTo(0, cached ? keepScroll : slide === 'back' ? history.state?.scroll ?? 0 : keepScroll);
      if (!cached) {
        arrive();
        if (landed) {
          await landed;
          if (seq !== renderSeq) return;
        }
      }
    } else if (pager && !cached) pager.done?.(); // экран не сменился — ждать нечего
    // Сумма прокручивается: впервые — от прежней; перерисовали посреди прокрутки — продолжаем её
    const sumEl = document.querySelector('#screen .total-sum');
    const rolling = rolled && sumEl?.textContent === rolled.to && performance.now() - rolled.at < ROLL_MS;
    if (rolling) rollNumber(sumEl, rolled.from, performance.now() - rolled.at);
    else if (prevSum) rollNumber(sumEl, prevSum);
    playRing(); // и когда свежий вид совпал с сохранённым: тот ждёт пустым
    playList();
    shownScreen = state.screen;
    screen.after?.();
    arrived = false;
    prefetchNeighbors();
    if (pendingReceipt) {
      const id = pendingReceipt;
      pendingReceipt = 0;
      // Номер чека из адреса убираем: «назад» закроет чек, а не откроет его снова
      const params = new URLSearchParams(location.search);
      params.delete('receipt');
      history.replaceState({ ...state }, '', `?${params}`);
      openReceiptSheet(id);
    }
    updateSecTop();
    watchFeedMore();
    if (pulseNext) pulse(pulseNext);
  } catch (err) {
    if (seq === renderSeq) $('screen').innerHTML = failed(err);
  } finally {
    clearTimeout(dim);
    if (seq === renderSeq) $('screen').classList.remove('busy');
  }
}

/**
 * Экран въезжает: вглубь и на вкладку правее — справа, «назад» и левее — слева. Шапка с итогом
 * (Расход, Доход, списки) остаётся на месте, если она была и на прежнем экране, — сдвигается
 * только содержимое под ней, как при свайпе периода: карточка с суммой не мигает.
 */
let slideHead = false; // на прежнем экране была шапка с итогом (render запоминает до перерисовки)
function slideScreen(dir) {
  if (!dir) return null;
  const el = $('screen');
  // Сдвигается содержимое, а не сам #screen: его обрезка по краю (overflow-x: clip) ловит
  // только содержимое. Сдвинутый целиком, он делал страницу шире окна, и Android WebView на
  // время анимации перестраивал окно — остров меню пропадал
  const keep = slideHead && el.querySelector(':scope > .stuck-head .total');
  const parts = [...el.children].filter((c) => !(keep && c.matches('.stuck-head')));
  if (!parts.length) return null;
  for (const p of el.children) p.classList.remove('slide-fwd', 'slide-back');
  void el.offsetWidth; // перезапустить анимацию, если прошлая не кончилась
  parts.forEach((p) => p.classList.add(`slide-${dir}`));
  clearTimeout(slideScreen.timer);
  // Конец именно сдвига: анимации строк внутри экрана всплывают сюда же и обрывали бы его
  const first = parts[0];
  return new Promise((resolve) => {
    const done = (e) => {
      if (e && e.target !== first) return;
      first.removeEventListener('animationend', done);
      clearTimeout(slideScreen.timer);
      parts.forEach((p) => p.classList.remove(`slide-${dir}`));
      resolve();
    };
    first.addEventListener('animationend', done);
    slideScreen.timer = setTimeout(() => done(), 600); // анимацию прервала перерисовка — всё равно вернуть как было
  });
}

/**
 * Новый вид экрана, но шапка с полем поиска остаётся та же (в ней фокус и клавиатура):
 * из новой шапки берём только итог и подпись, остальное экрана заменяем целиком.
 */
function patchKeepingSearch(html) {
  const screen = $('screen');
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const oldHead = screen.querySelector('.stuck-head');
  const newHead = tmp.querySelector('.stuck-head');
  if (!oldHead || !newHead) {
    screen.innerHTML = html;
    return;
  }
  for (const sel of ['.total-sum', '.total-note']) {
    const was = oldHead.querySelector(sel);
    const now = newHead.querySelector(sel);
    if (was && now) was.innerHTML = now.innerHTML;
  }
  for (const el of [...screen.children]) if (el !== oldHead) el.remove();
  newHead.remove();
  screen.append(...tmp.childNodes);
  updateSecTop();
}

// Поиск: выборка обновляется на каждый символ (с короткой паузой — чтобы не перерисовывать
// на каждое нажатие при быстром наборе). Ищется по уже загруженному, сервер не спрашиваем
let searchTimer = null;
$('screen').addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  state.q = e.target.value;
  state.same = ''; // поправили текст — это уже обычный поиск, а не «все такие же»
  e.target.closest('.search')?.querySelector('.search-x')?.toggleAttribute('hidden', !state.q);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => render(), 120);
});
// «Найти» на клавиатуре — убрать её: результат уже на экране
$('screen').addEventListener('keydown', (e) => {
  if (e.target.id === 'q' && e.key === 'Enter') e.target.blur();
});

// ── анимация раскрытия ───────────────────────────────────
// Лёгкая: только прозрачность и сдвиг (без высот — телефону это ничего не стоит). Анимируем
// первые строки раздела: остальные всё равно за краем экрана

const ANIMATED = 20;

/** Строки раздела: всё после заголовка до следующего заголовка (или пока stop не скажет). */
function sectionRows(head, stop = (el) => el.matches('.day, [data-section]')) {
  const rows = [];
  for (let el = head?.nextElementSibling; el && !stop(el); el = el.nextElementSibling) rows.push(el);
  return rows;
}

function animateIn(rows) {
  rows.slice(0, ANIMATED).forEach((el, i) => {
    el.style.setProperty('--i', i);
    el.classList.add('sec-in');
    el.addEventListener('animationend', () => el.classList.remove('sec-in'), { once: true });
  });
}

/** Сколько места строки занимают в видимой части экрана (то, что за краем, не важно). */
function visibleHeight(rows) {
  if (!rows.length) return 0;
  const top = Math.max(rows[0].getBoundingClientRect().top, secTop());
  const bottom = Math.min(rows[rows.length - 1].getBoundingClientRect().bottom, window.innerHeight);
  return Math.max(0, Math.round(bottom - top));
}

/**
 * Свернули — на месте строк пустой блок их высоты, и он плавно сжимается до нуля: всё, что
 * ниже, подтягивается мягко, а не прыжком. Анимируется один блок, а не строки.
 */
function collapseSpace(after, height) {
  if (height < 8 || !motion('sections')) return;
  const spacer = document.createElement('div');
  spacer.className = 'collapse-space';
  spacer.style.height = `${height}px`;
  after.after(spacer);
  spacer.getBoundingClientRect(); // зафиксировать начальную высоту перед переходом
  spacer.style.height = '0px';
  const done = () => spacer.remove();
  spacer.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 400); // на случай, если переход не случился
}

/**
 * Раскрыть или свернуть покупки группы одинаковых товаров — и по стрелке, и долгим нажатием.
 * Шторкой: свернуть — сначала закрыть, потом перерисовать; раскрыть — перерисовать и открыть.
 */
async function toggleGroup(group, row) {
  const key = expandKey(group);
  const wrapOf = (el) => (el?.nextElementSibling?.classList.contains('sub-wrap') ? el.nextElementSibling : null);
  const closing = expanded.has(key);
  if (closing) await slideWrap(wrapOf(row), false);
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
  await render(); // тот же экран — список перерисуется на месте, прокрутка не сбросится
  if (!closing) {
    const fresh = [...document.querySelectorAll('[data-long]')].find((el) => el.dataset.long === group);
    slideWrap(wrapOf(fresh), true);
  }
}

/**
 * Шторка: блок плавно раскрывается от нуля до своей высоты (или сворачивается до нуля), а всё,
 * что ниже, едет вместе с краем. Для покупок группы — их немного, и высота известна точно.
 */
async function slideWrap(wrap, open) {
  if (!wrap || !motion('sections')) return;
  const full = wrap.scrollHeight;
  wrap.style.height = `${open ? 0 : full}px`;
  wrap.getBoundingClientRect(); // начальная высота — до перехода
  wrap.classList.add('sliding');
  wrap.style.height = `${open ? full : 0}px`;
  await new Promise((r) => {
    const done = () => r();
    wrap.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 320);
  });
  wrap.classList.remove('sliding');
  if (open) wrap.style.height = ''; // дальше — обычная высота по содержимому
}

/** Погасить строки перед сворачиванием; ждём, только если есть что гасить. */
async function animateOut(rows) {
  const shown = rows.slice(0, ANIMATED);
  if (!shown.length || !motion('sections')) return;
  shown.forEach((el) => el.classList.add('sec-out'));
  // Не ждём полного угасания: место начинает сжиматься, пока строки ещё догасают
  await new Promise((r) => setTimeout(r, 70));
}

/**
 * Смена суммы — «счётчиком»: каждая цифра — окошко со столбиком 0–9, который сдвигается от
 * прежней цифры к новой (разряды совпадают по единицам; новый старший разряд едет от нуля).
 * Одно CSS-движение на цифру, без пересчёта страницы; потом — снова обычный текст.
 */
let rolled = null; // идущая прокрутка: откуда, куда и когда началась
const ROLL_MS = 900;

function rollNumber(el, from, elapsed = 0) {
  const to = el?.textContent;
  if (!to || to === from || !motion('counter')) return;
  el.dataset.sum = to;
  if (!elapsed) rolled = { from, to, at: performance.now() };
  // Продолжение после перерисовки: анимация начинается «в прошлом» — с того же места
  el.style.setProperty('--el', `${Math.round(elapsed)}ms`);
  const old = [...from].filter((c) => c >= '0' && c <= '9').reverse();
  const digits = [...to].filter((c) => c >= '0' && c <= '9').length;
  let k = digits; // номер разряда справа — у какой цифры старого числа брать начало
  el.innerHTML = [...to].map((c) => {
    if (c < '0' || c > '9') return esc(c);
    k -= 1;
    const start = Number(old[k] ?? 0);
    // Каждая цифра столбика — отдельный блок ровно в высоту окошка: перенос текста по пробелам
    // в WebView давал строки другой высоты, и цифры вставали криво
    const strip = Array.from({ length: 10 }, (_, d) => `<span>${d}</span>`).join('');
    return `<span class="odo"><span class="odo-strip" style="--from:${start};--to:${c};--i:${digits - 1 - k}">${strip}</span></span>`;
  }).join('');
  setTimeout(() => {
    if (el.isConnected) {
      el.textContent = to;
      delete el.dataset.sum;
    }
  }, ROLL_MS + 100 - elapsed);
}

/**
 * Подпись в шапке «Расходов»: сколько ещё можно тратить в день до конца месяца по лимитам
 * («Аналитика»). Только для текущего месяца целиком и без отборов — иначе цифра врала бы.
 */
function perDayNote(items, ops, part) {
  const lim = meta?.limits ?? {};
  const keys = Object.keys(lim);
  if (!keys.length || state.src || state.sg || state.q.trim()) return '';
  const now = new Date();
  const month = monthPeriod(now.getFullYear(), now.getMonth());
  if (state.from !== month.from || state.to !== month.to) return '';
  let spent = 0;
  const add = (slug, sum) => {
    const g = findCategory(slug)?.group.slug;
    if (g && lim[g]) spent += sum;
  };
  items.forEach((r) => add(r.category_slug, r.sum));
  ops.forEach((op) => add(op.category_slug, op.amount));
  const left = keys.reduce((n, k) => n + limitForRange(lim[k], meta.limit_period ?? 'month', month.from, month.to), 0) - spent;
  const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate() + 1;
  return part('day', left > 0 ? `≈ ${money(left / daysLeft)} в день` : 'лимиты превышены');
}

/** Где прилипают заголовки разделов: под шапкой с итогом (у каждого экрана своей высоты). */
function secTop() {
  const head = document.querySelector('#screen .stuck-head');
  if (!head) return 0;
  return (parseFloat(getComputedStyle(head).top) || 0) + head.offsetHeight;
}
function updateSecTop() {
  // Вниз и ещё на пиксель — под шапку: верх шапки на телефоне дробный (вырез под камеру), и при
  // округлении вверх между ней и прилипшим заголовком просвечивала строка ленты
  document.documentElement.style.setProperty('--sec-top', `${Math.floor(secTop()) - 1}px`);
}
addEventListener('resize', updateSecTop);

// Прилипший заголовок раздела — со скруглёнными верхними углами, как у начала блока: пометка
// stuck, когда он стоит под шапкой, а не на своём месте в начале списка
let stuckFrame = 0;
function markStuck() {
  stuckFrame = 0;
  const top = secTop();
  for (const el of document.querySelectorAll('#screen .list > .day.section.open')) {
    const at = el.getBoundingClientRect().top;
    const listTop = el.parentElement.getBoundingClientRect().top;
    el.classList.toggle('stuck', Math.abs(at - top) < 1.5 && listTop < at - 1);
  }
}
addEventListener('scroll', () => {
  stuckFrame ||= requestAnimationFrame(markStuck);
}, { passive: true });

/** Долистали до «Показать ещё» (с запасом в пару экранов) — следующая порция сама. */
let feedObserver = null;
function watchFeedMore() {
  feedObserver?.disconnect();
  const button = document.querySelector('[data-feed-more]');
  if (!button || !('IntersectionObserver' in window)) return;
  feedObserver = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    feedObserver.disconnect();
    button.click();
  }, { rootMargin: '1200px 0px' });
  feedObserver.observe(button);
}

// Мастер: ход загрузки прилипает к шапке. Листают список загруженного — карточка сжимается до
// полоски и цифр в строку; вернулись наверх — разворачивается. Пороги разные, чтобы на границе
// карточка не дёргалась: её высота меняется, а с ней и прокрутка
addEventListener('scroll', () => {
  const card = state.screen === 'bank_wizard' && document.querySelector('.wiz-stuck');
  if (!card) return;
  const next = wizCompact ? window.scrollY > 40 : window.scrollY > 160;
  if (next === wizCompact) return;
  wizCompact = next;
  card.classList.toggle('compact', next);
}, { passive: true });

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

// Касание на острове (тянут «+», ведут по попапу периода) — его жест: ни обновление, ни
// «резина» его не подхватывают. Свайп вбок по острову листает вкладки (PINNED) — кроме «+»
// (у него свой жест вверх) и попапа периода: там палец ведут к пункту
const onIsland = (e) => Boolean(e.target.closest?.('.tabs, .quick'));
const islandOwn = (e) => Boolean(e.target.closest?.('#fab, .quick')) || Boolean(quick.el);
// График аналитики — палец ведёт подсказку: ни обновление, ни «резина» жест не подхватывают
const onPlot = (e) => Boolean(e.target.closest?.('.ana-plot'));

addEventListener('touchstart', (e) => {
  const allowed = window.scrollY <= 0 && e.touches.length === 1 && !pulling && !$('app').hidden
    && PULLABLE.includes(state.screen) && !document.querySelector('.sheet, .picker') && !e.target.closest('.drop-menu') && !onIsland(e) && !onPlot(e);
  pullFrom = allowed ? e.touches[0].clientY : null;
  pullBy = 0;
}, { passive: true });

addEventListener('touchmove', (e) => {
  if (pullFrom == null) return;
  if (holdsDrop()) return; // палец ведут по попапу сортировки
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
    screenCache.delete(viewKey());
    feedData.clear();
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

// ── своя «резина» у краёв ────────────────────────────────
// Системную «резину» приложение выключает: Android растягивает ею всё окно, и закреплённые меню
// и шапка съезжают. Вместо неё — своя: содержимое под шапкой туго сдвигается за пальцем от того
// края, за который тянут; отпустили — упруго возвращается. Меню, верхняя полоса и шапка с итогом
// (те же, что не уезжают при свайпе периода — swipeParts) стоят на месте
const stretchEl = $('screen');
let stretchFrom = null; // где палец, пока лента ещё не упёрлась в край
let stretchEdge = null; // 'top' | 'bottom' — за какой край тянут

addEventListener('touchstart', (e) => {
  stretchFrom = null;
  stretchEdge = null;
  if (e.touches.length !== 1 || $('app').hidden || document.querySelector('.sheet, .picker')) return;
  // Выпадающее меню листается само: «резина» перехватила бы жест, и меню бы не сдвинулось
  if (e.target.closest('.drop-menu') || onIsland(e) || onPlot(e)) return;
  stretchFrom = e.touches[0].clientY;
  swipeParts().forEach((el) => (el.style.transition = ''));
}, { passive: true });

/** Сдвиг содержимого «резиной»: вниз (тянут за верхний край) или вверх (за нижний). */
function setStretch(offset, transition = '') {
  for (const el of swipeParts()) {
    el.style.transition = transition;
    el.style.transform = offset ? `translateY(${offset.toFixed(1)}px)` : '';
  }
}

addEventListener('touchmove', (e) => {
  if (stretchFrom == null) return;
  if (holdsDrop()) return; // палец ведут по попапу сортировки
  const y = e.touches[0].clientY;
  if (!stretchEdge) {
    const top = window.scrollY <= 0;
    const bottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1;
    if (top && y > stretchFrom) stretchEdge = 'top';
    else if (bottom && y < stretchFrom) stretchEdge = 'bottom';
    else {
      stretchFrom = y; // лента ещё листается — тянуть начнём от места, где она упрётся
      return;
    }
  }
  const pulled = Math.max(0, stretchEdge === 'top' ? y - stretchFrom : stretchFrom - y);
  // Чем дальше тянут, тем туже — не дальше 70 px
  const offset = 70 * (1 - Math.exp(-pulled / 220));
  setStretch(stretchEdge === 'top' ? offset : -offset);
  stretched = offset > 0;
}, { passive: true });

let stretched = false;
function stretchBack() {
  stretchFrom = null;
  stretchEdge = null;
  if (!stretched) return;
  stretched = false;
  setStretch(0, 'transform 0.35s cubic-bezier(0.2, 0.8, 0.3, 1)');
}
addEventListener('touchend', stretchBack);
addEventListener('touchcancel', stretchBack);

// ── листание периодов свайпом ────────────────────────────
// На экранах с периодом (стрелки ‹ ›) горизонтальный свайп — то же, что стрелка: влево — позже,
// вправо — раньше. Содержимое едет за пальцем; отпустили далеко или резко — уезжает, а новый
// период въезжает с другой стороны. Шапка с суммой и периодом стоит на месте, остров меню — тоже.
// Свайп по самой шапке или по острову меняет вкладку (swipeTab)
let swipeFrom = null; // { x, y, t } касания
let swipeLock = ''; // '' — ещё не ясно, 'x' — листаем периоды, 'y' — обычная прокрутка
let swipeBusy = false;
// Свайп по закреплённому — шапке, карточке итога аналитики, верхней панели или острову меню —
// меняет не период, а вкладку: влево — вкладка правее, вправо — левее
let swipeTab = false;
const SWIPE_TABS = ['summary', 'income', 'settings', 'stats'];
const PINNED = '.tabs, .bar, #screen > .stuck-head, #screen > .ana-hero';
// Шкала свайпа экранов и периодов (доли ширины): до SWIPE_FROM — ещё ничего, к SWIPE_TO —
// заполнено; протянули дальше SWIPE_TO — по отпусканию сменится вкладка (или период)
const SWIPE_FROM = 0.05;
const SWIPE_TO = 0.3;
/** Сколько протянули по шкале: 0 — до SWIPE_FROM, 1 — от SWIPE_TO. */
const swipeProgress = (dx) => Math.min(1, Math.max(0, (Math.abs(dx) / window.innerWidth - SWIPE_FROM) / (SWIPE_TO - SWIPE_FROM)));
/** Соседняя вкладка в сторону свайпа — по кругу: за «Аналитикой» снова «Расход», и наоборот. */
const swipeTabNext = (dx) => {
  const i = SWIPE_TABS.indexOf(TAB_OF[state.screen]);
  const step = dx < 0 ? 1 : -1;
  return i < 0 ? SWIPE_TABS[i + step] : SWIPE_TABS[(i + step + SWIPE_TABS.length) % SWIPE_TABS.length];
};
// Капсула выбранной вкладки на острове при свайпе: тянется к соседней вкладке вместе со сдвигом
// экрана (дотянулась — когда экран сдвинут на полширины), по отпусканию стягивается на новую
// вкладку или возвращается. Пока она видна, собственный фон выбранной вкладки спрятан (.pill-on)
let tabPill = null;
function pillSet(l, r, cur, transition) {
  if (!tabPill) {
    tabPill = document.createElement('span');
    tabPill.className = 'tab-pill';
    document.querySelector('.tabs').prepend(tabPill);
  }
  Object.assign(tabPill.style, {
    transition, left: `${l}px`, width: `${Math.max(0, r - l)}px`, top: `${cur.top}px`, height: `${cur.h}px`,
  });
}
function pillBox(name) {
  const tabs = document.querySelector('.tabs');
  const el = name && tabs.querySelector(`[data-tab="${name}"]`);
  if (!el) return null;
  const t = el.getBoundingClientRect();
  const box = tabs.getBoundingClientRect();
  return { l: t.left - box.left, r: t.right - box.left, top: t.top - box.top, h: t.height };
}
function pillDrag(dx, shift) {
  const cur = pillBox(TAB_OF[state.screen]);
  if (!cur) return;
  const tabs = document.querySelector('.tabs');
  tabs.classList.add('pill-on');
  // Протянули до места, где по отпусканию вкладка сменится, — соседняя плавно синеет, прежняя
  // сереет; не дотянули обратно — наоборот
  const name = swipeTabNext(dx);
  for (const t of tabs.querySelectorAll('[data-tab]')) t.classList.toggle('pill-next', t.dataset.tab === name);
  tabs.classList.toggle('pill-over', Boolean(name) && swipeProgress(dx) >= 1);
  const next = pillBox(name);
  let { l, r } = cur;
  if (next) {
    const p = swipeProgress(dx);
    if (next.l > cur.l) r += (next.r - cur.r) * p;
    else l += (next.l - cur.l) * p;
  } else if (shift < 0) r += -shift * 0.3; // крайняя вкладка — чуть тянется и вернётся
  else l -= shift * 0.3;
  pillSet(l, r, cur, '');
}
/**
 * Отпустили: капсула стягивается на вкладку name (новую или прежнюю) за ms. Прячет её pillDone —
 * сам по таймеру (вернулись) или после смены вкладки: успеть до отрисовки нового экрана, иначе
 * её движение запиналось бы о разбор.
 */
function pillSettle(name, ms, done = true) {
  const to = pillBox(name);
  if (!tabPill || !to) return;
  const ease = `${ms / 1000}s cubic-bezier(0.2, 0.8, 0.3, 1)`;
  pillSet(to.l, to.r, to, `left ${ease}, width ${ease}`);
  clearTimeout(pillSettle.timer);
  if (done) pillSettle.timer = setTimeout(pillDone, ms + 20);
}
/**
 * Нажатие на вкладку — та же капсула, что при свайпе: растягивается от выбранной вкладки до
 * нажатой и стягивается на неё; цвета вкладок переходят плавно (.pill-on)
 */
function pillTap(from, to) {
  const cur = pillBox(from);
  const next = pillBox(to);
  if (!cur || !next || from === to || !motion('screens')) return;
  document.querySelector('.tabs').classList.add('pill-on');
  pillSet(cur.l, cur.r, cur, '');
  void tabPill.offsetWidth; // исходное место — иначе растяжения не будет видно
  const ease = 'cubic-bezier(0.3, 0, 0.2, 1)';
  pillSet(Math.min(cur.l, next.l), Math.max(cur.r, next.r), cur, `left 140ms ${ease}, width 140ms ${ease}`);
  clearTimeout(pillSettle.timer);
  pillSettle.timer = setTimeout(() => pillSettle(to, 180), 140);
}

// Капсула уходит, фон вкладки появляется в том же кадре: без плавной смены фона вкладки
// (.pill-swap), иначе он проявлялся бы за капсулой и в конце мигало
function pillDone() {
  const tabs = document.querySelector('.tabs');
  tabs.classList.add('pill-swap');
  tabs.classList.remove('pill-on', 'pill-over');
  for (const t of tabs.querySelectorAll('.pill-next')) t.classList.remove('pill-next');
  tabPill?.remove();
  tabPill = null;
  requestAnimationFrame(() => requestAnimationFrame(() => tabs.classList.remove('pill-swap')));
}

// При смене вкладки за пальцем едет весь экран, с шапкой: меняется он целиком
const tabSet = (shift, opacity, transition) => [...stretchEl.children].forEach((el) => {
  el.style.transition = transition;
  el.style.translate = shift ? `${shift}px 0` : '';
  el.style.opacity = opacity;
});
// Что едет: всё на экране, кроме закреплённой шапки
// Шапка расходов и карточка итога аналитики стоят на месте — меняется только их содержимое
const swipeParts = () => [...stretchEl.children].filter((el) => !el.classList.contains('stuck-head') && !el.classList.contains('ana-hero'));
const swipeSet = (shift, opacity, transition) => swipeParts().forEach((el) => {
  el.style.transition = transition;
  el.style.translate = shift ? `${shift}px 0` : '';
  el.style.opacity = opacity;
});

addEventListener('touchstart', (e) => {
  swipeFrom = null;
  swipeLock = '';
  const t = e.touches[0];
  if (e.touches.length !== 1 || swipeBusy || $('app').hidden || document.querySelector('.sheet, .picker') || islandOwn(e)) return;
  // В настройках свайпать вбок больше нечего — там свайп по любому месту листает вкладки
  swipeTab = Boolean(e.target.closest(PINNED)) || (TAB_OF[state.screen] === 'settings' && !stretchEl.querySelector('[data-shift]'));
  if (!swipeTab && !stretchEl.querySelector('[data-shift]') && state.screen !== 'stats') return;
  // У краёв — системный жест «назад»; полосы, листающиеся вбок, и поля ввода — свои
  if (t.clientX < 24 || t.clientX > window.innerWidth - 24) return;
  // Поле в закреплённой шапке (поиск настроек) — свайп вкладок, пока в нём не пишут
  const field = e.target.closest('input, textarea');
  if (field && (!swipeTab || field === document.activeElement || field.type === 'range')) return; // ползунок — свой жест
  if (e.target.closest('.chips, .drop-menu') || (!swipeTab && e.target.closest('[data-shift]'))) return;
  if (!swipeTab && e.target.closest('.ana-plot')) return; // по графику палец ведёт подсказку (anaScrub)
  swipeFrom = { x: t.clientX, y: t.clientY, t: Date.now() };
  swipeSpeed = { trail: [{ x: t.clientX, at: performance.now() }], v: 0 };
}, { passive: true });

addEventListener('touchmove', (e) => {
  if (!swipeFrom) return;
  const dx = e.touches[0].clientX - swipeFrom.x;
  const dy = e.touches[0].clientY - swipeFrom.y;
  // Долгое нажатие на «Расход» / «Доход» или на сортировку открыло попап — палец ведут к пункту,
  // это не свайп
  if ((quick.el || holdsDrop()) && !swipeLock) {
    swipeFrom = null;
    return;
  }
  // Скорость пальца, сглаженная: по ней подсказка тише при быстром свайпе (peekShow)
  // Скорость — за последние 100 мс, а не между соседними событиями: телефон присылает их
  // неровно, иногда два почти разом, и скорость между ними подскакивала — подсказка мигала
  const now = performance.now();
  const trail = swipeSpeed.trail.filter((p) => now - p.at <= 100);
  trail.push({ x: e.touches[0].clientX, at: now });
  const span = now - trail[0].at;
  swipeSpeed = { trail, v: span >= 30 ? Math.abs(trail.at(-1).x - trail[0].x) / span : swipeSpeed.v }; // пикселей за мс
  if (!swipeLock) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    swipeLock = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'x' : 'y';
    if (swipeLock === 'y') {
      swipeFrom = null;
      return;
    }
    // Листаем вбок: натяжение и «резина» в этом жесте не участвуют
    if (pullFrom != null) {
      pullFrom = null;
      pullReset();
    }
    stretchFrom = null;
    stretched = false;
    setStretch(0);
  }
  e.preventDefault(); // страница вверх-вниз не ездит, пока листаем вбок
  if (swipeTab) {
    // Экран тянется за пальцем; дальше крайней вкладки — туго, как резина
    if (!motion('screens')) return;
    // Лента страниц — без прозрачности: бледный старый рядом с ярким новым мерцал
    const shift = swipeTabNext(dx) ? dx : dx * 0.25;
    tabSet(shift, '', '');
    pillDrag(dx, shift);
    peekShow(dx, tabLabel(swipeTabNext(dx)));
    return;
  }
  const next = swipeTarget(dx < 0 ? 1 : -1);
  prefetchPeriod(next); // данные периода, куда тянут, — уже сейчас, а не после отпускания
  if (!motion('swipe')) return; // сдвиг выключен: содержимое стоит, период сменится по отпусканию
  swipeSet(dx, String(1 - Math.min(0.5, Math.abs(dx) / window.innerWidth)), '');
  // Над полоской — раздел, под ней — период: «Расход», полоска, «Сентябрь 2026»
  peekShow(dx, next && tabLabel(TAB_OF[state.screen]), next && humanPeriod(next.from, next.to));
}, { passive: false });

// Подсказка в полосе, которая освобождается при свайпе (периода или вкладки): куда листаем —
// название, и полоска, заполненная тем больше, чем дальше протянули. Проявляется к половине
// пути до смены, держится посередине полосы (едет вместе с её краем) и заполнена целиком
// ровно там, где по отпусканию экран сменится (SWIPE_TO), — тогда и название синеет
let peekEl = null;
let swipeSpeed = { trail: [], v: 0 }; // палец: где был за последние 100 мс и скорость по ним
function peekShow(dx, name, below = '') {
  if (!name || !motion('peek')) return peekHide();
  if (!peekEl) {
    peekEl = document.createElement('div');
    peekEl.className = 'peek';
    // На растущем конце полоски — кружок со стрелкой туда, где стоит экран, который откроется
    peekEl.innerHTML = '<span class="peek-name"></span><span class="peek-bar"><i><b class="peek-knob">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></b></i></span><span class="peek-name peek-below"></span>';
    document.body.append(peekEl);
  }
  const w = window.innerWidth;
  const k = swipeProgress(dx);
  peekEl.querySelector('.peek-name').textContent = name;
  const low = peekEl.querySelector('.peek-below');
  low.textContent = below;
  low.hidden = !below;
  peekEl.style.transition = 'opacity 0.12s linear'; // место — сразу за пальцем, яркость — плавно
  peekEl.style.left = `${(dx < 0 ? w + dx / 2 : dx / 2).toFixed(1)}px`;
  // Не ярче 0,7: подсказка — на краю внимания, а не главное на экране
  // Быстрый свайп — подсказка почти не видна: человек и так знает, куда листает. Медленный
  // (до 0,3 пк/мс) — видна целиком (0,7), быстрее 1,2 пк/мс — едва (0,15 от неё)
  const quiet = 1 - 0.85 * Math.min(1, Math.max(0, (swipeSpeed.v - 0.3) / 0.9));
  peekEl.style.opacity = (0.7 * Math.min(1, k * 2) * quiet).toFixed(3);
  peekEl.style.setProperty('--k', k.toFixed(3));
  peekEl.classList.toggle('full', k >= 1);
  peekEl.classList.toggle('prev', dx > 0); // назад — полоска заполняется справа налево
}
function peekHide() {
  if (!peekEl) return;
  peekEl.style.transition = 'opacity 0.15s ease-out';
  peekEl.style.opacity = '0';
}
/** Подпись вкладки на острове — без счётчика на значке. */
function tabLabel(name) {
  const btn = name && document.querySelector(`.tabs [data-tab="${name}"]`);
  return btn ? [...btn.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() : '';
}

/**
 * Данные периода, куда тянут свайпом, — заранее, теми же запросами, что сделает экран: к
 * отпусканию они уже в памяти (apiFeed) или в пути, и новый период не ждёт сети. Повторно
 * в том же жесте не запрашивается: память лент сама отдаёт уже начатый запрос.
 */
function prefetchPeriod(p) {
  if (!p) return;
  const paths = state.screen === 'summary' ? Object.values(summaryFeeds(p.from, p.to))
    : state.screen === 'income' && incomeOn() ? Object.values(incomeFeeds(p.from, p.to))
      : state.screen === 'stats' ? anaPaths(p.from, p.to) : [];
  for (const path of paths) if (path) apiFeed(path).catch(() => {});
}

/**
 * Соседние периоды — заранее, пока экран просто открыт: свайп туда не ждёт сети. Не сразу,
 * а когда отыграли заливки (и человек, похоже, остался на экране), — чтобы загрузка с разбором
 * ответа не легла на анимации
 */
function prefetchNeighbors() {
  clearTimeout(prefetchNeighbors.timer);
  if (!['summary', 'income', 'stats'].includes(state.screen)) return;
  const at = viewKey();
  prefetchNeighbors.timer = setTimeout(() => {
    if (viewKey() !== at || swipeFrom) return; // ушли или уже листают
    prefetchPeriod(swipeTarget(-1));
    prefetchPeriod(swipeTarget(1));
  }, RING_ANIM + 500);
}

/** Куда листать свайпом: соседний период (в «Аналитике» — так же, как в «Расходе»). */
function swipeTarget(dir) {
  return shiftPeriod(state.from, state.to, dir);
}

async function swipeEnd(e) {
  peekHide();
  if (!swipeFrom || swipeLock !== 'x') {
    swipeFrom = null;
    return;
  }
  const dx = (e.changedTouches?.[0]?.clientX ?? swipeFrom.x) - swipeFrom.x;
  const fast = Math.abs(dx) > 30 && Math.abs(dx) / Math.max(1, Date.now() - swipeFrom.t) > 0.5;
  swipeFrom = null;
  if (swipeTab) {
    // Отпустили: мало протянули или дальше некуда — экран возвращается. Иначе уезжает вбок,
    // и соседняя вкладка открывается тем же нажатием на неё — новый экран въезжает с другой
    // стороны (render, slideScreen)
    const back = 'translate 0.18s ease-out, opacity 0.18s ease-out';
    const next = swipeTabNext(dx);
    if (e.type === 'touchcancel' || !next || (swipeProgress(dx) < 1 && !fast)) {
      tabSet(0, '', back);
      document.querySelector('.tabs').classList.remove('pill-over'); // цвета — плавно обратно
      pillSettle(TAB_OF[state.screen], 220);
      return;
    }
    if (!motion('screens')) {
      document.querySelector(`.tabs [data-tab="${next}"]`)?.click();
      return;
    }
    // Лента страниц (screenPager): вкладка открывается сразу, старый экран ждёт на месте
    // отпускания, пока новый не готов, — и дальше оба едут вместе
    pillSettle(next, PAGER_MS);
    document.querySelector('.tabs').classList.add('pill-over'); // быстрый взмах — не дотянули, а вкладка меняется
    swipeBusy = true;
    let finish;
    const finished = new Promise((r) => {
      finish = r;
    });
    const pager = { dx, done: finish, finished };
    pagerLeave(pager);
    // Новый экран собирается после того, как уход старого уже пошёл: тяжёлая сборка его не
    // задержит — анимацию ведёт браузер
    await pager.anim.ready;
    screenPager = pager;
    document.querySelector(`.tabs [data-tab="${next}"]`)?.click();
    await Promise.race([finished, new Promise((r) => setTimeout(r, 4000))]);
    pager.box.remove(); // новый экран так и не встал (ошибка) — старый слой всё равно убрать
    swipeBusy = false;
    return;
  }
  const ease = 'translate 0.18s ease-out, opacity 0.18s ease-out';
  if (e.type === 'touchcancel' || (swipeProgress(dx) < 1 && !fast)) {
    swipeSet(0, '', ease);
    return;
  }
  const dir = dx < 0 ? 1 : -1; // влево — следующий период
  const next = swipeTarget(dir);
  if (!next) {
    swipeSet(0, '', ease); // дальше листать некуда (аналитика — не позже текущего месяца)
    return;
  }
  swipeBusy = true;
  if (!motion('swipe')) {
    try {
      await go(next, true);
    } finally {
      swipeBusy = false;
    }
    return;
  }
  const w = window.innerWidth;
  swipeSet(-dir * w, '0', ease);
  try {
    await new Promise((r) => setTimeout(r, 180));
    // Новый период въезжает целиком, как экран при переходе: строки сразу видны (не проявляются
    // по одной — на их месте была пустота), кольцо въезжает пустым и заливается на месте
    arriveNext = true;
    holdFills = true;
    await go(next, true);
    // Новый период — уже на экране: ставим его чуть в стороне и въезжаем на место
    swipeSet(dir * w * 0.35, '0', 'none');
    void stretchEl.offsetWidth; // зафиксировать исходное место, иначе въезда не будет видно
  } finally {
    arriveNext = false;
    swipeSet(0, '', 'translate 0.22s cubic-bezier(0.2, 0.8, 0.3, 1), opacity 0.22s ease-out');
    await new Promise((r) => setTimeout(r, 220));
    holdFills = false;
    playRing();
    swipeBusy = false;
  }
}
addEventListener('touchend', swipeEnd);
addEventListener('touchcancel', swipeEnd);

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
  if (pick) return openCategoryPicker(Number(pick.dataset.pick), saveCategory, undefined, sameFor('item', Number(pick.dataset.pick)));

  // Категория в карточке товара
  // Фильтр по источнику: повторное нажатие снимает
  const inf = e.target.closest('[data-inf]');
  if (inf) return go({ inf: inf.dataset.inf }, true);
  if (e.target.closest('[data-reset-filters]')) {
    pulseNext = 'count';
    return go({ src: '', sg: '' }, true);
  }
  const sg = e.target.closest('[data-sg]');
  if (sg) {
    const next = state.sg === sg.dataset.sg ? '' : sg.dataset.sg;
    pulseNext = 'count';
    return go({ sg: next }, true);
  }

  const src = e.target.closest('[data-src]');
  if (src) {
    const next = !src.dataset.src || state.src === src.dataset.src ? '' : src.dataset.src;
    pulseNext = next ? 'src' : 'count'; // фильтр сняли — меняется число покупок
    return go({ src: next }, true);
  }

  // Заголовок раздела: свернуть или развернуть. При длинной ленте открыт только один
  if (e.target.closest('#wiz-fresh')) {
    const handled = onFreshClick(e, { collapsed: wizFresh.collapsed, redraw: wizFreshDraw, refresh: () => wizFreshLoad() });
    if (handled) return;
  }

  const freshOpen = e.target.closest('[data-fresh-open]');
  if (freshOpen) return openFresh(freshOpen.dataset.freshOpen, freshOpen.dataset.since, 'Загруженная история');

  if (e.target.closest('[data-q-clear]')) {
    e.preventDefault(); // не фокусировать поле: очистили — значит, искать больше не собираются
    state.q = '';
    state.same = '';
    const input = $('q');
    if (input) input.value = '';
    input?.blur();
    return render();
  }

  if (e.target.closest('[data-autolabel]')) return go({ screen: 'autolabel' });

  // Список ↔ кольцо: выбор помним на телефоне
  if (e.target.closest('[data-mode-toggle]')) {
    state.mode = state.mode === 'ring' ? 'list' : 'ring';
    // Из кольца группы — в список этой же группы: у расходов её экран, у доходов — список,
    // отобранный по группе. «Назад» с экрана группы вернёт к общему списку, а не к кольцу
    // «Остальное» — отбор по всем слитым в него группам (или категориям, если это кольцо группы)
    const opened = state.mode === 'list' ? state.ringRest || state.ringGroup : '';
    // И обратно: список, отобранный по группе, — в кольцо этой группы; по нескольким — в их
    // «Остальное» (категории — внутри кольца своей группы)
    const listed = state.mode === 'ring' ? (state.screen === 'summary' ? state.sg : state.screen === 'income' ? state.inf : '') : '';
    let back = null;
    if (listed) {
      const keys = listed.split(',');
      const catOf = (k) => (state.screen === 'summary' ? findCategory(k)?.group.slug : incomeCat(k)?.group.slug);
      const group = catOf(keys[0]);
      // Одна категория — кольцо её группы; несколько — их «Остальное» внутри группы
      if (group) back = { ringGroup: group, ringRest: keys.length > 1 ? keys.join(',') : '' };
      else if (keys.length > 1) back = { ringGroup: '', ringRest: keys.join(',') };
      else if (keys[0] !== NONE) back = { ringGroup: keys[0], ringRest: '' };
    }
    state.ringGroup = '';
    state.ringRest = '';
    try {
      localStorage.setItem('checker.mode', state.mode);
    } catch {
      // не запомнится — не беда
    }
    // И в записи истории: «назад» на этот экран вернёт его в том же виде
    history.replaceState({ ...history.state, mode: state.mode, ringGroup: '', ringRest: '' }, '', location.href);
    if (opened && state.screen === 'summary') return go({ sg: opened }, true);
    if (opened && state.screen === 'income') return go({ inf: opened }, true);
    if (back) return go({ ...back, [state.screen === 'summary' ? 'sg' : 'inf']: '' }, true);
    return render();
  }

  // Группа на кольце: у расходов — её экран, у доходов — список, отобранный по группе
  const ringPick = e.target.closest('[data-ring]');
  if (ringPick) {
    const [kind, key, how] = ringPick.dataset.ring.split('|');
    // «Остальное» — своё кольцо из слитых в него секторов («назад» вернёт к общему)
    if (key.startsWith('~')) return go({ ringRest: key.slice(1) });
    // Список, отобранный по нажатому, — новой записью истории: «назад» вернёт к кольцу.
    // Выбранный вид (localStorage) не трогаем: это переход, а не смена вида
    const toList = (patch) => go({ mode: 'list', ringGroup: '', ringRest: '', ...patch });
    // Группа — кольцо её категорий на том же экране («назад» вернёт к группам). В группе одна
    // непустая категория — сразу список: кольцо из одного сектора ничего не покажет
    if (kind === 'summary' || kind === 'income') {
      // Без категории — список неразмеченного (раздел «Без категории» с авторазметкой)
      if (key === NONE) return toList(kind === 'summary' ? { sg: NONE } : { inf: '-' });
      if (how === 'list') return toList(kind === 'summary' ? { sg: key } : { inf: key });
      return go({ ringGroup: key, ringRest: '' });
    }
    // Категория — основной список расходов, отобранный по ней (фильтр, поиск, кольцо — все на месте)
    if (kind === 'summary-cat') return toList({ sg: key });
    // Категория доходов: отдельного экрана нет — список доходов, отобранный по ней
    if (kind === 'income-cat') return toList({ inf: key });
    return null;
  }

  // «Затронет N таких же» → эти N: расходы или доходы за всё время, с поиском по продавцу
  // (у товара — по названию, у дохода — по описанию)
  const sameGo = e.target.closest('[data-same-go]');
  if (sameGo) {
    const all = { from: meta.stats.date_from.slice(0, 10), to: meta.stats.date_to.slice(0, 10) };
    return go({
      screen: sameGo.dataset.sameScreen, ...all, q: sameGo.dataset.sameGo, same: sameGo.dataset.same, sort: 'category', dir: 'asc',
      src: '', inf: '', group: '', category: '', item: '', op: '',
    });
  }

  // Авторазметка: строку можно разложить и руками, не дожидаясь модели
  const autoPick = state.screen === 'autolabel' && e.target.closest('[data-fresh-pick]');
  if (autoPick) {
    const [type, id] = autoPick.dataset.freshPick.split(':');
    return autoPickRow(type, Number(id));
  }

  if (e.target.closest('[data-feed-more]')) {
    feedLimit = { ...feedLimit, n: feedLimit.n + FEED_STEP };
    return render();
  }

  const sectionBtn = e.target.closest('[data-section]');
  if (sectionBtn) {
    const opened = openSections();
    const key = sectionBtn.dataset.section;
    // Сворачивают прилипший заголовок, уйдя вглубь раздела, — после сворачивания лента
    // встаёт так, чтобы этот заголовок был под шапкой, а не где-то ниже по списку
    const stuck = opened.has(key) && sectionBtn.getBoundingClientRect().top <= secTop() + 1;
    const closing = opened.has(key);
    const room = closing ? visibleHeight(sectionRows(sectionBtn)) : 0; // сколько места они занимали на экране
    if (closing) await animateOut(sectionRows(sectionBtn), sectionBtn); // строки гаснут — потом закрываем
    if (opened.has(key)) opened.delete(key);
    else {
      if (feedSections.single) opened.clear();
      opened.add(key);
    }
    await render();
    const head = [...document.querySelectorAll('[data-section]')].find((el) => el.dataset.section === key);
    if (head) {
      head.classList.add(closing ? 'arrow-closing' : 'arrow-opening');
      setTimeout(() => head.classList.remove('arrow-closing', 'arrow-opening'), 250);
      if (!closing) animateIn(sectionRows(head));
    }
    if (stuck && head) window.scrollBy(0, head.getBoundingClientRect().top - secTop());
    if (closing && head) collapseSpace(head, room); // то, что ниже, подтягивается плавно, а не рывком
    return;
  }

  // Сканы с ошибкой — ссылкой с «Расхода»: отдельной вкладки «Чеки» больше нет
  if (e.target.closest('[data-to-failed]')) return go({ screen: 'receipts', filter: 'failed' });

  // Убрать товар из расходов: задвоенный или учтённый где-то ещё
  const hide = e.target.closest('[data-item-hide]');
  if (hide) {
    const manual = hide.textContent.includes('Удалить');
    if (!(await ask(manual ? 'Удалить эту запись?' : 'Убрать товар из расходов? Он перестанет учитываться в суммах.',
      { ok: manual ? T.common.delete : T.common.remove, danger: true }))) return;
    try {
      await post(`/api/items/${hide.dataset.itemHide}/hide`, {});
      toast(manual ? 'Запись удалена' : 'Товар убран из расходов');
      return history.back(); // карточки больше нет — возвращаемся к ленте
    } catch (err) {
      return toast(`Не вышло: ${err.message}`);
    }
  }

  // Ручной доход — удалить
  const opDel = e.target.closest('[data-op-del]');
  if (opDel) {
    if (!(await ask('Удалить эту запись?', { ok: T.common.delete, danger: true }))) return;
    try {
      await api(`/api/income/manual/${opDel.dataset.opDel}`, { method: 'DELETE' });
      toast('Запись удалена');
      return history.back();
    } catch (err) {
      return toast(`Не вышло: ${err.message}`);
    }
  }

  // Трата из банка — перевод себе или не учитывать
  const opKind = e.target.closest('[data-op-kind]');
  if (opKind) {
    const transfer = opKind.dataset.opKind === 'transfer';
    const income = itemShown?.income;
    if (!(await ask(transfer
      ? income ? T.income.transferConfirm : 'Отметить как перевод себе? Он не будет считаться расходом.'
      : income ? T.income.excludeConfirm : 'Не учитывать эту трату? Она пропадёт из расходов.',
    { ok: transfer ? T.common.mark : T.common.skip }))) return;
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
    return toggleGroup(toggle.dataset.expand, toggle.closest('.row'));
  }

  // Трата из банка открывается карточкой, как товар; категория меняется уже в ней
  const opOpen = e.target.closest('[data-op]');
  if (opOpen) return go({ screen: 'op', op: opOpen.dataset.op });

  const opIncat = e.target.closest('[data-op-incat]');
  if (opIncat) return openCategoryPicker(Number(opIncat.dataset.opIncat), saveIncomeCategory, meta?.income ?? [], sameFor('income', Number(opIncat.dataset.opIncat)), { transfer: true });

  const opCat = e.target.closest('[data-op-cat]');
  if (opCat) return openCategoryPicker(Number(opCat.dataset.opCat), saveOpCategory, undefined, sameFor('op', Number(opCat.dataset.opCat)), { transfer: true });

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
      if (!(await ask(T.bankCard.manage.forgetConfirm, { ok: T.common.disable }))) return;
      bankBridge(id).forget();
      await api(`/api/bank?bank=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
      return render();
    }
    if (bank.dataset.bank === 'wipe') {
      const shop = bankById(id)?.shop;
      if (!(await ask(shop ? f(T.bankCard.manage.wipeShopConfirm, { name: bankById(id).from }) : T.bankCard.manage.wipeConfirm,
        { ok: T.common.delete, danger: true }))) return;
      bankBridge(id).forget();
      const res = await api(`/api/bank/ops?bank=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
      if (wiz?.bank === id) wiz = null; // мастер этого магазина — заново, со входа
      toast(res ? f(shop ? T.bankCard.manage.wipedShop : T.bankCard.manage.wiped, { n: int.format(res.ops ?? 0) }) : T.common.failed);
      bankLinked = false;
      return go({ screen: 'set_banks' });
    }
  }

  const itemReceipt = e.target.closest('[data-item-receipt]');
  if (itemReceipt) return openReceiptSheet(Number(itemReceipt.dataset.itemReceipt), { current: state.item });

  const itemCat = e.target.closest('[data-item-cat]');
  if (itemCat) return openCategoryPicker(Number(itemCat.dataset.itemCat), saveItemCategory, undefined, sameFor('item', Number(itemCat.dataset.itemCat)));

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

  if (e.target.closest('#i-cat')) {
    return openCategoryPicker(null, (_, slug) => {
      incomeAddCat = slug;
      $('i-cat').innerHTML = incomeButton(slug);
      $('i-msg').textContent = '';
    }, meta?.income ?? []);
  }

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
  if (e.target.id === 'income-form') {
    e.preventDefault();
    return saveIncome();
  }
  if (e.target.id !== 'manual-form') return;
  e.preventDefault();
  saveManual();
});

/** Категория из карточки товара: выбор тот же, что в разборе чека, итог — под кнопкой. */
async function saveItemCategory(itemId, slug, { only = false, seller = false } = {}) {
  const note = $('pick-note');
  const button = $('item-cat');
  note.classList.remove('error');
  note.textContent = 'Сохранение…';
  button.disabled = true;
  try {
    const data = await post(`/api/items/${itemId}/category`, { category: slug, only, seller });
    button.innerHTML = categoryButton(slug);
    note.textContent = data.only
      ? data.category
        ? `«${data.category.name}» — ${data.seller_affected ? `у продавца: ${int.format(data.seller_affected)} ${plural(data.seller_affected, 'позиция', 'позиции', 'позиций')}` : 'только для этой покупки'}`
        : 'Категория снята у этой покупки'
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
$('fab').addEventListener('click', () => {
  if (fabPulled) {
    fabPulled = false; // это был жест вверх, а не нажатие
    return;
  }
  go({ screen: TAB_OF[state.screen] === 'income' ? 'income_add' : 'add' }); // в «Доходе» «+» — сразу доход
});

// «+» потянули вверх — сразу сканер чеков. Из-за кнопки вырастает её продолжение — полоса той
// же ширины со значком сканера на конце; растёт вместе с пальцем. Дотянули — она цвета кнопки и
// сливается с ней, отпустили — сканер. Не дотянули — втягивается обратно. Свайп вбок по «+»
// листает вкладки, как по всему острову (swipeTab)
const FAB_PULL = 110; // столько протянуть вверх — и по отпусканию откроется сканер
const FAB_R = 25; // радиус синего круга «+» (58 − рамка 4 × 2) / 2 — и полосы, что из него растёт
let fabFrom = null; // { x, y, t } касания «+»
let fabLock = ''; // '' — ещё неясно, 'y' — тянем вверх, 'x' — это свайп вбок, не наш
let fabPulled = false; // жест вверх был — click после него не открывает «Добавить»
let fabEl = null;

function fabShow(up) {
  const fab = $('fab');
  const tabs = document.querySelector('.tabs');
  if (!fabEl) {
    fabEl = document.createElement('div');
    fabEl.className = 'fab-pull';
    fabEl.innerHTML = `<b class="fab-pull-knob">${UI.scan}</b>`; // как «Сканировать чек» на экране «Добавить»
    tabs.insertBefore(fabEl, fab); // раньше кнопки — она рисуется поверх и прячет низ полосы
  }
  const t = tabs.getBoundingClientRect();
  const r = fab.getBoundingClientRect();
  const pull = Math.min(FAB_PULL * 1.15, Math.max(0, up)); // дальше порога — туго
  // Нижний полукруг полосы — ровно синий круг кнопки (тот же центр и радиус, FAB_R): в начале
  // жеста полоса целиком за кнопкой, дальше растёт только вверх, со скруглением в полный радиус
  Object.assign(fabEl.style, {
    transition: 'none',
    left: `${(r.left - t.left + r.width / 2).toFixed(1)}px`,
    bottom: `${(t.bottom - r.top - r.height / 2 - FAB_R).toFixed(1)}px`,
    height: `${(FAB_R * 2 + pull).toFixed(1)}px`,
  });
  fabEl.classList.toggle('full', up >= FAB_PULL);
}

function fabHide() {
  if (!fabEl) return;
  // Втягивается обратно в круг кнопки (там её не видно) и убирается совсем: иначе от неё
  // оставалась полоска под «+»
  const el = fabEl;
  fabEl = null;
  el.style.transition = 'height 0.2s cubic-bezier(0.3, 0, 0.2, 1)';
  el.style.height = `${FAB_R * 2}px`;
  el.classList.remove('full');
  setTimeout(() => el.remove(), 220);
}

$('fab').addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  fabFrom = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
  fabLock = '';
}, { passive: true });

$('fab').addEventListener('touchmove', (e) => {
  if (!fabFrom) return;
  const dx = e.touches[0].clientX - fabFrom.x;
  const up = fabFrom.y - e.touches[0].clientY;
  if (!fabLock) {
    if (Math.abs(dx) < 8 && Math.abs(up) < 8) return;
    fabLock = up > Math.abs(dx) ? 'y' : 'x';
  }
  if (fabLock !== 'y') return;
  e.preventDefault();
  fabShow(up);
}, { passive: false });

function fabEnd(e) {
  if (!fabFrom || fabLock !== 'y') {
    fabFrom = null;
    return;
  }
  const up = fabFrom.y - (e.changedTouches?.[0]?.clientY ?? fabFrom.y);
  const fast = up > 30 && up / Math.max(1, Date.now() - fabFrom.t) > 0.6;
  fabFrom = null;
  fabPulled = true;
  setTimeout(() => (fabPulled = false), 400); // click, если и придёт, — сразу за касанием
  fabHide();
  if (e.type !== 'touchcancel' && (up >= FAB_PULL || fast)) openScanner();
}
$('fab').addEventListener('touchend', fabEnd);
$('fab').addEventListener('touchcancel', fabEnd);

// Вкладка сбрасывает глубину, но не период: переключение не должно терять выбор дат.
// В историю переходы по вкладкам не пишем: иначе «назад» из карточки товара возвращает
// не к списку, а туда, где человек был до переключения — например, в настройки
document.querySelector('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  // Нажатие закончило долгое — оно уже открыло выбор периода, вкладку не переключает
  if (quick.ate) {
    quick.ate = false;
    return;
  }
  // Нажал человек (свайп вкладок нажимает сам — у него капсула своя)
  openTab(tab.dataset.tab, {}, e.isTrusted);
});

function openTab(name, extra = {}, tapped = true) {
  if (tapped) pillTap(TAB_OF[state.screen], name);
  // «Сводка» открывается годом (по месяцам), если период не задан явно (попап острова, сценарий)
  if (name === 'stats' && !('from' in extra)) extra = { ...monthPeriod(new Date().getFullYear(), 0, 12), ...extra };
  const sort = defaultSort(name);
  go({ screen: name, group: '', category: '', item: '', bank: '', sort, dir: SORTS[sort][1], q: '', same: '', ringGroup: '', ringRest: '', sg: '', ...extra }, true);
}

// ── долгое нажатие на «Расход» / «Доход»: быстрый период ─────
// Палец задержали на кнопке — над ней вырастает «Сегодня / Неделя / Месяц / Год». Можно, не
// отпуская, провести до пункта и отпустить, а можно отпустить и нажать пункт. Выбор — как
// смена периода в шапке: открывает этот экран и остаётся. Обычное нажатие — как было.
// Периоды календарные, с начала: неделя с понедельника, месяц с 1-го, год с 1 января.
const QUICK_TABS = ['summary', 'income', 'stats'];
const QUICK_HOLD = 250; // мс — попап острова и сортировки: обычное нажатие короче ~150 мс, ждать дольше незачем
const quick = { press: null, el: null, tab: '', held: false, moved: false, ate: false };

function quickPeriods() {
  const now = new Date();
  const monday = addDays(now, -((now.getDay() + 6) % 7));
  const span = (a, b) => ({ from: isoDay(a), to: isoDay(b) });
  const Q = T.island.periods;
  return [
    [Q.today, span(now, now)],
    [Q.week, span(monday, addDays(monday, 6))],
    [Q.month, monthPeriod(now.getFullYear(), now.getMonth())],
    [Q.year, monthPeriod(now.getFullYear(), 0, 12)],
  ];
}

function quickOpen(btn) {
  quickClose(true);
  const periods = quickPeriods();
  const el = document.createElement('div');
  el.className = 'quick';
  el.innerHTML = periods.map(([label, p], i) => {
    const on = p.from === state.from && p.to === state.to;
    return `<button class="quick-item${on ? ' on' : ''}" type="button" data-quick="${i}"><span>${esc(label)}</span>${on ? UI.ok : ''}</button>`;
  }).join('');
  document.body.appendChild(el);
  // Над кнопкой, по её центру, не вылезая за края экрана
  const r = btn.getBoundingClientRect();
  const island = document.querySelector('.tabs').getBoundingClientRect();
  const w = el.offsetWidth;
  const left = Math.min(Math.max(10, r.left + r.width / 2 - w / 2), innerWidth - 10 - w);
  el.style.left = `${left}px`;
  // Выше и острова, и выступающего над ним «+»
  el.style.bottom = `${innerHeight - Math.min(island.top, $('fab').getBoundingClientRect().top) + 8}px`;
  el.style.transformOrigin = `${r.left + r.width / 2 - left}px 100%`;
  if (motion('sheets')) {
    el.animate([{ opacity: 0, transform: 'scale(0.5)' }, { opacity: 1, transform: 'none' }],
      { duration: 200, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.15)' });
  }
  quick.el = el;
  quick.tab = btn.dataset.tab;
  quick.held = true;
  quick.moved = false;
  navigator.vibrate?.(15);
}

function quickClose(now = false) {
  const el = quick.el;
  if (!el) return;
  quick.el = null;
  quick.held = false;
  if (now || !motion('sheets')) return el.remove();
  el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.8)' }], { duration: 120, easing: 'ease-in' })
    .finished.then(() => el.remove(), () => el.remove());
}

function quickPick(i) {
  const tab = quick.tab;
  const p = quickPeriods()[i]?.[1];
  quickClose();
  if (p) openTab(tab, p, TAB_OF[state.screen] !== tab);
}

/** Пункт под пальцем — подсвечиваем, пока ведут. */
function quickHot(x, y) {
  const item = document.elementFromPoint(x, y)?.closest('.quick-item');
  for (const b of quick.el.querySelectorAll('.quick-item')) b.classList.toggle('hot', b === item);
  return item;
}

const tabsEl = document.querySelector('.tabs');
tabsEl.addEventListener('pointerdown', (e) => {
  quick.ate = false;
  const btn = e.target.closest('[data-tab]');
  if (!btn || !QUICK_TABS.includes(btn.dataset.tab)) return;
  quick.press = {
    x: e.clientX,
    y: e.clientY,
    timer: setTimeout(() => {
      quick.press = null;
      quick.ate = true; // click, который придёт за отпусканием, — не переключение вкладки
      quickOpen(btn);
    }, QUICK_HOLD),
  };
});
tabsEl.addEventListener('pointermove', (e) => {
  if (quick.press) {
    // Палец поехал до срока — это не долгое нажатие
    if (Math.hypot(e.clientX - quick.press.x, e.clientY - quick.press.y) > 10) {
      clearTimeout(quick.press.timer);
      quick.press = null;
    }
    return;
  }
  if (quick.el && quick.held) {
    quick.moved = true;
    quickHot(e.clientX, e.clientY);
  }
});
const quickRelease = (e) => {
  if (quick.press) {
    clearTimeout(quick.press.timer);
    quick.press = null;
  }
  if (!quick.el || !quick.held) return;
  quick.held = false;
  const item = e.type === 'pointerup' && quickHot(e.clientX, e.clientY);
  if (item) return quickPick(Number(item.dataset.quick));
  // Отпустили, не уводя палец, — попап остаётся: пункт можно нажать
  if (quick.moved) quickClose();
};
tabsEl.addEventListener('pointerup', quickRelease);
// Касание, начатое на острове, никогда не прокручивает страницу: остров сам не листается, а
// жесты на нём (тянуть «+», вести палец по попапу периода) иначе тащили за собой ленту.
// Запрещать надо с первого движения: начав прокрутку, браузер отказ уже не принимает
tabsEl.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
tabsEl.addEventListener('pointercancel', quickRelease);
// Долгое нажатие на кнопке не должно вызывать меню телефона
tabsEl.addEventListener('contextmenu', (e) => {
  if (e.target.closest('[data-tab]')) e.preventDefault();
});
// Попап открыт и палец отпущен: нажали пункт — выбор, мимо — закрыть
document.addEventListener('click', (e) => {
  if (!quick.el || quick.held) return;
  if (quick.ate && e.target.closest('.tabs')) return; // click самого долгого нажатия
  const item = e.target.closest('.quick-item');
  if (item) return quickPick(Number(item.dataset.quick));
  if (!e.target.closest('.quick')) quickClose();
}, true);
window.addEventListener('popstate', () => quickClose(true));

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
  // Сообщения в Telegram о тратах и доходах других участников — только в общем бюджете. Строкой
  // в «Участниках»: это про них, а отдельным блоком она висела одна
  const notifyRow = budget.members.length > 1
    ? srow({
      icon: UI.telegram,
      title: B.notify,
      note: budget.telegram ? B.notifyNote : B.notifyNoTelegram,
      wrap: true,
      end: toggle(`data-notify-members${budget.telegram ? '' : ' disabled'}`, budget.notify_members && budget.telegram, B.notify),
    })
    : '';
  return section(B.main, '', name + leave)
    + section(B.members, budget.members.length > 1 ? B.noteShared : B.noteAlone, members + invite + notifyRow);
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
  const [me, budget, bank] = settingsData = await Promise.all([
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
  // разделы, а главный экран остаётся коротким. Сверху — поиск по всем настройкам (settingsSearch)
  return `
    <div class="stuck-head"><label class="search set-search">
      <span class="search-ic">${UI.search}</span>
      <input id="sq" type="search" value="${esc(settingsQ)}" placeholder="Поиск по настройкам и категориям" enterkeyhint="search" autocomplete="off" />
      <button class="search-x" type="button" data-sq-clear aria-label="Очистить"${settingsQ ? '' : ' hidden'}>${UI.close}</button>
    </label></div>
    <div id="set-results" hidden></div>
    <div id="set-main">`
    + section(S.menu.label, '',
    link('profile', UI.user, S.profile.label, me?.name || (me?.telegram ? S.profile.viaTelegram : S.profile.viaPassword))
    + (budget ? link('budget', UI.wallet, S.budget.label, `${budget.name} · ${int.format(members)} ${pl(members, S.menu.members)}`) : '')
    + (inApp() ? link('banks', UI.bank, S.banks.label, banks.length ? banks.join(', ') : S.menu.banksNone) : '')
    + (backupInfo() ? link('backup', UI.history, S.backup.label, backupLast(backupInfo())) : '')
    + link('limits', UI.limit, S.limits.label, limitsNote()))
    // Внешний вид: тема и анимации — выбор хранится на телефоне (index.html ставит их до отрисовки)
    + section(S.look.label, '',
      srow({ icon: UI.moon, title: S.menu.dark, end: toggle('data-theme-toggle', theme() === 'dark', S.menu.dark) })
      + link('motion', groupIcon('zap'), S.look.motion, motionNote()))
    + section(S.cats.label, S.cats.listNote,
      link('cats', UI.wallet, S.cats.expense, counts(meta?.categories))
      + link('incats', UI.income, S.cats.income, counts(meta?.income)))
    // Помощь: что хранится и как удалить; демо-режим — год трат вымышленного человека
    + section(S.help.label, S.help.note,
      // «Данные» — сразу страница о данных, без промежуточного экрана
      srow({ icon: UI.shield, title: S.data.label, note: S.data.note, attrs: 'data-privacy', end: GO })
      + srow({ icon: UI.sparkle, title: S.help.demo, note: S.help.demoNote, end: toggle('data-demo-toggle', Boolean(meta?.demo), S.help.demo) }))
    + '</div>';
}

// ── поиск по настройкам ──────────────────────────────────
// Ищет по всем пунктам и вложенным экранам, а главное — по справочнику: группы и категории
// расходов и доходов спрятаны на втором-третьем уровне. Результат — строка с подписью, где он
// («Категории расходов · Питание»); нажатие ведёт прямо туда. Переключатели (тема, анимации,
// демо-режим) переключаются прямо в результатах. Запрос держится, пока не очистят: «назад»
// со страницы результата возвращает к тем же результатам
let settingsQ = '';

let settingsData = []; // [me, budget, bank] последнего показа настроек — для поиска по вложенному

function settingsIndex() {
  const S = T.settings;
  const L = S.look;
  const B = S.budget;
  const budget = settingsData[1];
  const out = [];
  // how: { screen, … } — куда перейти; { toggle } — переключить прямо в результатах
  const add = (title, where, icon, how, words = '') => out.push({ title, where, icon, how, words });
  // Основные: разделы и то, что внутри них (находится сам пункт, а не его раздел)
  add(S.profile.label, S.menu.label, UI.user, { screen: 'set_profile' });
  add(S.profile.nameLabel, S.profile.label, UI.user, { screen: 'set_profile' }, 'имя как вас видят');
  add(S.profile.logout, S.profile.label, UI.logout, { screen: 'set_profile' }, 'выход выйти');
  add(T.settings.deleteAccount, S.profile.label, UI.trash, { screen: 'set_profile' }, 'удалить аккаунт');
  add(B.label, S.menu.label, UI.wallet, { screen: 'set_budget' });
  add(B.export.title, B.label, UI.upload, { screen: 'set_budget' }, 'экспорт выгрузка excel csv таблица архив поделиться');
  add(B.nameLabel, B.label, UI.wallet, { screen: 'set_budget' });
  add(B.members, B.label, UI.user, { screen: 'set_budget' }, 'семья участник');
  if (budget?.is_owner) add(B.invite, B.label, UI.userPlus, { screen: 'set_budget' }, 'приглашение семья ссылка');
  if (budget && !budget.is_home) add(B.leave, B.label, UI.logout, { screen: 'set_budget' });
  if (budget?.members.length > 1) add(B.notify, B.label, UI.telegram, { toggle: 'notify' }, 'уведомления сообщения бот телеграм');
  if (inApp()) {
    add(S.banks.label, S.menu.label, UI.bank, { screen: 'set_banks' });
    if (backupInfo()) add(S.backup.label, S.menu.label, UI.history, { screen: 'set_backup' }, 'резервная копия бэкап бекап сохранить восстановить архив');
    add(S.banks.add, S.banks.label, UI.bank, { screen: 'set_banks' }, 'т-банк тинькофф сбер сбербанк озон ozon wildberries вб подключить');
  }
  // Внешний вид
  add(S.menu.dark, L.label, UI.moon, { toggle: 'theme' }, 'тема ночная темная оформление');
  add(L.motion, L.label, groupIcon('zap'), { screen: 'set_motion' });
  add(L.allLabel, `${L.label} · ${L.motion}`, groupIcon('zap'), { toggle: 'motion' }, 'анимация движение');
  for (const k of MOTION_KINDS) add(L.kinds[k], `${L.label} · ${L.motion}`, groupIcon('zap'), { toggle: `kind:${k}` }, `${L.kindNotes[k]} анимация`);
  // Категории
  add(S.cats.expense, S.cats.label, UI.wallet, { screen: 'set_cats', tk: '' }, 'группы категории расходов справочник');
  add(S.cats.income, S.cats.label, UI.income, { screen: 'set_cats', tk: 'in' }, 'группы категории доходов справочник');
  add(S.limits.label, S.menu.label, UI.limit, { screen: 'set_limits', tg: '' }, 'лимит бюджет ограничение');
  add(S.limits.on, S.limits.label, UI.limit, { toggle: 'limits' }, 'лимит включить выключить');
  add(S.limits.period, S.limits.label, UI.limit, { screen: 'set_limits', tg: '' }, 'лимит период месяц квартал неделя день');
  // Помощь
  add(S.data.label, S.help.label, UI.shield, { privacy: true }, 'данные хранение конфиденциальность приватность');
  add(S.help.demo, S.help.label, UI.sparkle, { toggle: 'demo' }, 'демо тестовый пример');
  // Справочник: группы и их категории, расходы и доходы
  for (const [groups, tk, where] of [[meta?.categories ?? [], '', S.cats.expense], [meta?.income ?? [], 'in', S.cats.income]]) {
    for (const g of groups) {
      const color = g.color ?? 'var(--fill)';
      const badge = (icon) => `<span class="gic" style="background:${color};color:${readableText(color)}">${groupIcon(icon || 'none')}</span>`;
      add(g.name, `${S.cats.label} · ${where.toLowerCase()}`, badge(g.icon), { screen: 'set_group', tg: g.slug, tk }, 'группа');
      for (const c of g.subcategories) add(c.name, `${where} · ${g.name}`, badge(c.icon || g.icon), { screen: 'set_cat', tc: c.slug, tk }, 'категория');
    }
  }
  return out;
}

/** Переключатель найденного пункта — тот же, что на его экране: работают те же обработчики. */
function settingsToggle(kind, title) {
  const budget = settingsData[1];
  if (kind === 'theme') return toggle('data-theme-toggle', theme() === 'dark', title);
  if (kind === 'limits') return toggle('data-limits-toggle', meta?.limits_on !== false, title);
  if (kind === 'demo') return toggle('data-demo-toggle', Boolean(meta?.demo), title);
  if (kind === 'motion') return toggle('data-motion-toggle', document.documentElement.dataset.motion !== 'off', title);
  if (kind.startsWith('kind:')) {
    const k = kind.slice(5);
    const all = document.documentElement.dataset.motion !== 'off';
    return toggle(`data-motion-kind="${k}"${all ? '' : ' disabled'}`, motionPrefs()[k] !== false, title);
  }
  if (kind === 'notify') {
    return toggle(`data-notify-members${budget?.telegram ? '' : ' disabled'}`, Boolean(budget?.notify_members && budget?.telegram), title);
  }
  return '';
}

/** Показать результаты поиска (или вернуть разделы, если поле пустое). */
function settingsSearch() {
  const input = document.getElementById('sq');
  if (!input) return;
  const words = searchNorm(settingsQ).split(/\s+/).filter(Boolean);
  const results = document.getElementById('set-results');
  const main = document.getElementById('set-main');
  input.nextElementSibling.hidden = !settingsQ;
  if (!words.length) {
    results.hidden = true;
    main.hidden = false;
    return;
  }
  // Сначала — совпавшие названием, потом — найденные по разделу или ключевым словам
  const byTitle = (e) => words.every((w) => searchNorm(e.title).includes(w));
  const found = settingsIndex()
    .filter((e) => {
      const hay = searchNorm(`${e.title} ${e.where} ${e.words}`);
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => byTitle(b) - byTitle(a));
  const S = T.settings;
  const rows = found.slice(0, 40).map((e, i) => {
    const end = e.how.toggle ? settingsToggle(e.how.toggle, e.title) : '';
    return srow({
      icon: e.icon, bare: e.icon.startsWith('<span class="gic"'), title: esc(e.title), note: esc(e.where),
      attrs: e.how.toggle ? '' : `data-sjump="${i}"`, end: end || (e.how.toggle ? '' : GO),
    });
  }).join('');
  results.innerHTML = rows ? section('', '', rows) : `<p class="sec-foot">Ничего не нашлось</p>`;
  results.dataset.found = JSON.stringify(found.slice(0, 40).map((e) => e.how));
  results.hidden = false;
  main.hidden = true;
}

$('screen').addEventListener('input', (e) => {
  if (e.target.id !== 'sq') return;
  settingsQ = e.target.value;
  settingsSearch();
});

$('screen').addEventListener('click', (e) => {
  if (state.screen !== 'settings') return null;
  if (e.target.closest('[data-sq-clear]')) {
    settingsQ = '';
    const input = document.getElementById('sq');
    input.value = '';
    settingsSearch();
    return input.focus();
  }
  const jump = e.target.closest('[data-sjump]');
  if (!jump) return null;
  const how = JSON.parse(document.getElementById('set-results').dataset.found || '[]')[Number(jump.dataset.sjump)];
  if (!how) return null;
  if (how.privacy) return go({ screen: 'privacy' });
  return go(how);
});

async function screenSetProfile() {
  const me = await apiKept('/api/session').catch(() => null);
  const P = T.settings.profile;
  return section(P.block, me?.telegram ? P.footTelegram : P.footPassword,
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
  return budgetSection(await apiKept('/api/budget').catch(() => null)) + exportSection();
}

/** «Данные»: экспорт всего бюджета архивом CSV для Excel — через «Поделиться» телефона. */
function exportSection() {
  const E = T.settings.budget.export;
  return section(E.label, E.note, srow({ icon: UI.upload, title: E.title, attrs: 'data-export', end: GO }));
}

/**
 * Экспорт: сервер собирает архив (/api/export.zip), дальше — «Поделиться» с обычным списком
 * приложений. В приложении — мостом (Checker.shareFile): в WebView Web Share файлами не
 * делится. В браузере — Web Share, а нет его — скачивание
 */
async function exportBudget() {
  const E = T.settings.budget.export;
  if (inApp() && !window.Checker.shareFile) return toast(E.oldApp);
  toast(E.busy);
  try {
    const res = await fetch('/api/export.zip', { headers: token.get() ? { authorization: `Bearer ${token.get()}` } : {} });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'checker.zip';
    if (window.Checker?.shareFile) {
      const data = await new Promise((ok, fail) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(',')[1]);
        r.onerror = () => fail(r.error);
        r.readAsDataURL(blob);
      });
      if (!window.Checker.shareFile(data, name, 'application/zip')) toast(T.common.failed);
      return null;
    }
    const file = new File([blob], name, { type: 'application/zip' });
    // Chrome на Android ZIP через Web Share не отдаёт, хоть canShare и отвечает «да» (NotAllowedError,
    // 21.10.2026), — тогда скачиваем. Закрыл человек список сам (AbortError) — ничего не делаем
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return null;
      } catch (err) {
        if (err.name === 'AbortError') return null;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return null;
  } catch (err) {
    return toast(`${T.common.failed}: ${err.message}`);
  }
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-export]')) exportBudget();
});

async function screenSetBanks() {
  const [bank, budget] = await Promise.all([
    inApp() ? apiKept('/api/bank').catch(() => null) : null,
    apiKept('/api/budget').catch(() => null),
  ]);
  return bankSection(bank) + permSection() + syncSection('', budget);
}

// ── фоновая синхронизация: разрешения и настройки ────────
// Синхронизация идёт на телефоне, поэтому и настройки, и разрешения — там (мост Checker:
// background / askBackground / openAutostart, syncPrefs / setSyncPrefs). Старое приложение
// этого не умеет — тогда блоков нет.

/** Можно ли работать в фоне без ограничений и чей телефон; null — приложение не умеет. */
function bgInfo() {
  if (!window.Checker?.background) return null;
  try {
    return JSON.parse(window.Checker.background());
  } catch {
    return null;
  }
}
const isXiaomi = (maker) => ['xiaomi', 'redmi', 'poco'].includes(maker);

/** «Разрешения»: без них система будит фоновое обновление редко — сессии банков истекают. */
function permSection() {
  const bg = bgInfo();
  if (!bg) return '';
  const P = T.settings.perm;
  return section(P.label, P.note,
    srow({
      icon: groupIcon('battery'),
      title: P.bg,
      note: bg.unrestricted ? P.bgOk : `<span class="perm-bad">${P.bgNo}</span>`,
      attrs: 'data-perm-bg',
      end: GO,
    })
    + (isXiaomi(bg.maker) ? srow({
      icon: groupIcon('zap'),
      title: P.autostart,
      // Состояние знает приложение 0.7.10+; старое — только подсказка
      note: bg.autostart === true ? P.autostartOk : bg.autostart === false ? `<span class="perm-bad">${P.autostartNo}</span>` : P.autostartNote,
      attrs: 'data-perm-auto',
      end: GO,
    }) : ''));
}

/** Настройки синхронизации (SyncPrefs на телефоне); null — приложение не умеет. */
function syncPrefs() {
  if (!window.Checker?.syncPrefs) return null;
  try {
    return { all: true, every: 15, wifi: false, banks: {}, ...JSON.parse(window.Checker.syncPrefs()) };
  } catch {
    return null;
  }
}
function saveSyncPrefs(prefs) {
  window.Checker?.setSyncPrefs?.(JSON.stringify(prefs));
}
const SYNC_EVERY = [15, 30, 60, 180, 0]; // минуты; 0 — только вручную

/**
 * «Синхронизация»: как часто фоновое задание обходит банк и только ли по Wi-Fi.
 * Без bankId — общий блок в «Настройки → Банки»: «Для всех банков» включён — его настройки
 * действуют на все; выключен — у каждого свои, а общие неактивны.
 * С bankId — блок в карточке банка: свои настройки банка, правятся всегда; пока в общих
 * включено «Для всех банков», подпись говорит, что сейчас действуют общие.
 */
function syncSection(bankId = '', budget = null) {
  const prefs = syncPrefs();
  if (!prefs) return '';
  const S = T.settings.sync;
  const own = bankId ? prefs.banks?.[bankId] ?? {} : {};
  const every = own.every ?? prefs.every;
  const wifi = own.wifi ?? prefs.wifi;
  const off = !bankId && !prefs.all; // общие при выключенном «Для всех банков» ни на что не влияют
  const rows = (bankId ? '' : srow({ icon: UI.layers, title: S.all, end: toggle('data-sync-all', prefs.all, S.all) }))
    + srow({ icon: UI.refresh, title: S.every, note: S.everyOpts[every] ?? S.everyOpts[15], attrs: `data-sync-every="${esc(bankId)}"`, end: GO, off })
    + srow({ icon: groupIcon('wifi'), title: S.wifi, off, end: toggle(`data-sync-wifi="${esc(bankId)}"${off ? ' disabled' : ''}`, wifi, S.wifi) })
    // Напоминание войти — шлёт сервер (бот), поэтому это настройка человека, а не телефона;
    // без Telegram слать некуда
    + (bankId || !budget ? '' : srow({
      icon: UI.telegram,
      title: S.remind,
      note: budget.telegram ? S.remindNote : S.remindNoTg,
      wrap: true,
      end: toggle(`data-remind-login${budget.telegram ? '' : ' disabled'}`, Boolean(budget.remind_login && budget.telegram), S.remind),
    }));
  const foot = bankId ? (prefs.all ? S.lockedNote : S.ownNote) : prefs.all ? S.allNote : S.allOffNote;
  return section(S.label, foot, rows);
}

/** Поменять настройку синхронизации: общую (bankId пустой) или банка. */
function setSyncPref(bankId, key, value) {
  const prefs = syncPrefs();
  if (!prefs) return;
  if (bankId) {
    prefs.banks = { ...(prefs.banks ?? {}) };
    prefs.banks[bankId] = { ...(prefs.banks[bankId] ?? {}), [key]: value };
  } else prefs[key] = value;
  saveSyncPrefs(prefs);
}

$('screen').addEventListener('click', (e) => {
  if (!['set_banks', 'bank_card'].includes(state.screen)) return;
  if (e.target.closest('[data-perm-bg]')) return window.Checker?.askBackground?.();
  if (e.target.closest('[data-perm-auto]')) return window.Checker?.openAutostart?.();
  const pick = e.target.closest('[data-sync-every]');
  if (!pick) return null;
  const bankId = pick.dataset.syncEvery;
  const S = T.settings.sync;
  const prefs = syncPrefs();
  const current = (bankId ? prefs.banks?.[bankId]?.every : undefined) ?? prefs.every;
  const rows = SYNC_EVERY.map((m) => dropRow(`data-every="${m}"`, '', S.everyOpts[m], m === current)).join('');
  return openChoice(S.every, `<div class="choice-list">${rows}</div><p class="note lim-choice-note">${S.everyNote}</p>`, (ev, close) => {
    const row = ev.target.closest('[data-every]');
    if (!row) return;
    setSyncPref(bankId, 'every', Number(row.dataset.every));
    close();
    render();
  });
});

$('screen').addEventListener('change', (e) => {
  if (e.target.matches('[data-sync-all]')) {
    setSyncPref('', 'all', e.target.checked);
    render();
  }
  if (e.target.matches('[data-sync-wifi]')) setSyncPref(e.target.dataset.syncWifi, 'wifi', e.target.checked);
  if (e.target.matches('[data-remind-login]')) {
    const box = e.target;
    api('/api/session', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remind_login: box.checked }) })
      .then(() => kept.delete('/api/budget'))
      .catch((err) => {
        box.checked = !box.checked;
        toast(`${T.common.failed}: ${err.message}`);
      });
  }
});

// ── резервная копия ──────────────────────────────────────
// Копию делает телефон (Backup.java): сервер отдаёт снимок бюджета, телефон сжимает его в ZIP и
// кладёт в «Загрузки/Checker/backup». Здесь — частота, последняя копия и кнопки. Мост Checker:
// backupInfo / setBackupEvery / backupNow / shareBackup; старое приложение этого не умеет — экрана нет

/** Сведения о копиях с телефона; null — приложение не умеет. */
function backupInfo() {
  if (!window.Checker?.backupInfo) return null;
  try {
    return JSON.parse(window.Checker.backupInfo());
  } catch {
    return null;
  }
}
const BACKUP_EVERY = [1, 2, 3, 7]; // дней

/** «21 октября, 14:05 · 2,4 МБ» — или «ещё не было». */
function backupLast(info) {
  const B = T.settings.backup;
  if (!info?.last) return B.never;
  const when = new Date(info.last).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const mb = info.size / 1048576;
  const size = mb >= 1 ? `${mb.toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(info.size / 1024))} КБ`;
  return `${when} · ${size}`;
}

function screenSetBackup() {
  const B = T.settings.backup;
  const info = backupInfo();
  if (!info) return section('', B.noApp, '');
  const last = esc(backupLast(info)) + (info.error ? `<br><span class="perm-bad">${esc(f(B.failed, { error: info.error }))}</span>` : '');
  return section(B.label, f(B.note, { folder: info.folder }),
    srow({ icon: UI.refresh, title: B.every, note: B.everyOpts[info.every] ?? B.everyOpts[1], attrs: 'data-backup-every', end: GO })
    + srow({ icon: UI.history, title: B.last, note: last, wrap: true })
    + srow({ icon: UI.plus, title: B.now, attrs: 'data-backup-now', end: GO })
    + srow({ icon: UI.upload, title: B.share, attrs: 'data-backup-share', off: !info.last, end: GO }));
}

$('screen').addEventListener('click', (e) => {
  if (state.screen !== 'set_backup') return null;
  const B = T.settings.backup;
  if (e.target.closest('[data-backup-now]')) {
    toast(B.busy);
    return window.Checker?.backupNow?.();
  }
  if (e.target.closest('[data-backup-share]')) {
    if (!backupInfo()?.last) return toast(B.noFile);
    return window.Checker?.shareBackup?.() || toast(B.noFile);
  }
  if (!e.target.closest('[data-backup-every]')) return null;
  const current = backupInfo()?.every ?? 1;
  const rows = BACKUP_EVERY.map((d) => dropRow(`data-days="${d}"`, '', B.everyOpts[d], d === current)).join('');
  return openChoice(B.every, `<div class="choice-list">${rows}</div>`, (ev, close) => {
    const row = ev.target.closest('[data-days]');
    if (!row) return;
    window.Checker?.setBackupEvery?.(Number(row.dataset.days));
    close();
    render();
  });
});

// Итог «Сделать копию сейчас» приходит от приложения событием
window.addEventListener('checker-backup', (e) => {
  const B = T.settings.backup;
  toast(e.detail?.error ? f(B.failed, { error: e.detail.error }) : B.done);
  if (state.screen === 'set_backup' || state.screen === 'settings') render();
});

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
  const color = g.color ?? 'var(--fill)';
  return `<span class="gic" style="background:${color};color:${readableText(color)}">${groupIcon(g.icon ?? 'none')}</span>`;
};
const catDot = (color) => `<span class="cat-dot" style="background:${color ?? '#d7dbe2'}"></span>`;
// Значок категории в настройках: её оттенок и её значок (не выбран — значок группы)
const catBadge = (color, icon) => {
  const c = color ?? '#d7dbe2';
  return `<span class="gic" style="background:${c};color:${readableText(c)}">${groupIcon(icon || 'none')}</span>`;
};
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
      icon: catBadge(tones[i] ?? g.color, c.icon || g.icon).replace('class="gic"', 'class="gic" data-tone'),
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
      <div class="dual" style="background:linear-gradient(90deg, ${shades(color, 2, 1, 99).join(', ')})">
        <input type="range" min="1" max="99" value="${g.shade_from}" data-shade="shade_from" aria-label="${esc(C.shadeFrom)}" />
        <input type="range" min="1" max="99" value="${g.shade_to}" data-shade="shade_to" aria-label="${esc(C.shadeTo)}" />
      </div>
    </div>`;
  return section(C.groupSettings, '',
    srow({ icon: groupBadge(g), bare: true, title: inlineEdit('tgroup', g.name, { cls: 'srow-input', label: C.group, max: 40 }), note: C.nameNote })
    + srow({ icon: UI.grid, title: C.icon, attrs: 'data-tgroup-icon', end: GO })
    + bars)
    + section(C.catsBlock, '', cats.join('') + srow({ icon: UI.plus, title: C.addCat, attrs: `data-tcat-add="${esc(g.slug)}"` }))
    + section(C.manage, '', (state.tk === 'in' ? '' : srow({ icon: UI.limit, title: T.settings.limits.manage, attrs: `data-lim-manage="${esc(g.slug)}"`, end: GO }))
    + srow({
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
    srow({ icon: catBadge(tone, c.icon || g.icon), bare: true, title: inlineEdit('tcat', c.name, { cls: 'srow-input', label: C.category, max: 40 }), note: C.nameNote })
    + srow({ icon: UI.grid, title: C.icon, note: c.icon ? '' : C.iconOfGroup, attrs: 'data-tcat-icon', end: GO })
    + srow({ icon: groupBadge(g), bare: true, title: C.inGroup, note: esc(g.name), attrs: 'data-tcat-move', end: GO })
    // Подсказка нужна разметке чеков — у доходов её нет
    + (state.tk === 'in' ? '' : srow({ icon: UI.pen, title: inlineEdit('thint', c.hint ?? '', { cls: 'srow-input', label: C.hintPlaceholder, placeholder: C.hintPlaceholder, max: 200, multi: true }), note: C.hintNote })))
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

/**
 * Лист выбора поверх экрана: заголовок, содержимое, закрытие крестиком и нажатием мимо.
 * action — кнопка справа в заголовке вместо крестика (лист закрывают «назад» и нажатием мимо);
 * note — пояснение мелким под заголовком;
 * dirty — есть ли несохранённое: тогда закрытие сначала спрашивает (closeGuarded).
 */
function openChoice(title, body, onClick, { action = '', dirty = null, note = '' } = {}) {
  const el = document.createElement('div');
  el.className = 'picker';
  el.innerHTML = `
    <div class="picker-box" role="dialog" aria-label="${esc(title)}">
      <div class="picker-top"><div class="picker-title">${esc(title)}${note ? `<small class="note picker-note">${esc(note)}</small>` : ''}</div>
        ${action || `<button class="icon-btn soft" data-close type="button" aria-label="Закрыть" title="Закрыть">${UI.close}</button>`}</div>
      ${body}
    </div>`;
  el.guard = dirty;
  openPopup(el);
  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('[data-close]')) return closeGuarded(el);
    onClick(e, () => closePopup(el));
  });
  return el;
}

/** Закрыть лист; осталось несохранённое — сначала спросить. */
function closeGuarded(el) {
  if (!el.guard?.()) return closePopup(el);
  if (el.asking) return null;
  el.asking = true;
  return ask(T.common.unsaved, { ok: T.common.discard, danger: true }).then((yes) => {
    el.asking = false;
    if (!yes) return;
    el.guard = null;
    closePopup(el);
  });
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
  row.querySelector('.dual').style.background = `linear-gradient(90deg, ${shades(color, 2, 1, 99).join(', ')})`;
  const badge = document.querySelector('#screen .gic');
  badge.style.background = color;
  badge.style.color = readableText(color);
  const dots = [...document.querySelectorAll('#screen [data-tone]')];
  shades(color, dots.length, shade_from, shade_to).forEach((tone, i) => {
    dots[i].style.background = tone;
    dots[i].style.color = readableText(tone);
  });
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

/** Значок категории: из того же набора, что у групп, или «как у группы». */
async function openCatLook(slug) {
  const { groups } = await taxo();
  const g = groups.find((x) => x.categories.some((c) => c.slug === slug));
  const c = g?.categories.find((x) => x.slug === slug);
  if (!c) return;
  const tone = catTones(g)[g.categories.indexOf(c)] ?? g.color;
  openLook({
    name: c.name, color: tone, icon: c.icon ?? '', inherit: g.icon ?? 'none',
    save: (body) => taxoCall('PATCH', `/categories/${encodeURIComponent(slug)}`, body),
  }, 'icon');
}

/**
 * g — у чего меняем вид: название, цвет, значок и save(изменения) — куда сохранять.
 * inherit — значок группы: у категории можно выбрать «как у группы» (значок — пустая строка).
 */
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
    ${g.inherit ? `<button class="icon-inherit${icon === '' ? ' on' : ''}" type="button" data-icon="">${groupIcon(g.inherit)}<span>${esc(C.iconOfGroup)}</span></button>` : ''}
    <input class="icon-search" type="search" placeholder="${esc(C.iconSearch)}" />
    <div class="icon-cells">${grid(searchIcons(''))}</div>`,
  async (ev, close) => {
    const picked = ev.target.closest('[data-icon]')?.dataset.icon;
    if (picked == null) return;
    icon = picked;
    paint();
    for (const cell of el.querySelectorAll('.icon-cell, .icon-inherit')) cell.classList.toggle('on', cell.dataset.icon === icon);
    await save({ icon });
    if (what === 'icon') close();
  });

  // Значок в шапке попапа показывает выбор сразу, ещё до сохранения
  function paint() {
    const badge = el.querySelector('#look-badge');
    badge.style.background = color;
    badge.style.color = readableText(color);
    badge.innerHTML = groupIcon(icon || g.inherit);
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
  if (hit('[data-lim-manage]')) return go({ screen: 'set_limits', tg: hit('[data-lim-manage]').dataset.limManage });

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
  if (hit('[data-tcat-icon]')) return openCatLook(state.tc);
  if (hit('[data-tgroup-delete]')) {
    const g = (await taxo()).groups.find((x) => x.slug === state.tg);
    if (!g || !(await ask(f(C.deleteGroupConfirm, { name: g.name }), { ok: T.common.delete, danger: true }))) return;
    try {
      await taxoCall('DELETE', `/groups/${encodeURIComponent(g.slug)}`);
      history.back();
    } catch (err) { failed(err); }
    return;
  }

  if (hit('[data-tcat-move]')) {
    const { groups } = await taxo();
    // Сеткой плиток, как выбор группы везде в приложении; текущая группа отмечена
    const current = groups.find((g) => g.categories.some((c) => c.slug === state.tc))?.slug;
    const body = `<div class="filt-grid">${groups.map((g) => pickTile(`data-to="${esc(g.slug)}"`, groupTileIc(g), g.name, g.slug === current)).join('')}</div>`;
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
        setTimeout(async () => {
          if (await ask(f(income ? C.moveIncomeConfirm : C.moveConfirm, { name: c.name, to: to.name }), { ok: T.common.move, danger: true })) remove(slug);
        }, 150);
      }, income ? meta?.income ?? [] : undefined, null, { title: C.moveTitle, note: f(C.moveNote, { name: c.name, what: income ? C.moveWhatIncome : C.moveWhat }) });
    } else if (await ask(f(C.deleteCatConfirm, { name: c.name }), { ok: T.common.delete, danger: true })) remove('');
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
// Состояние банков у приложения: экраны спрашивают его помногу раз за отрисовку, а вопрос
// к приложению не бесплатный. Помним ответ пару секунд; вернулись из окна банка или закончилось
// обновление — забываем сразу (checker-resume, checker-bank)
let appInfoCache = null;
const appInfo = () => {
  if (appInfoCache && Date.now() - appInfoCache.at < 2000) return appInfoCache.value;
  let value = {};
  try {
    value = JSON.parse(window.Checker.info());
  } catch {
    // приложения нет или ответ не разобрать — как будто банков нет
  }
  appInfoCache = { value, at: Date.now() };
  return value;
};
const forgetAppInfo = () => {
  appInfoCache = null;
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

/** Тема оформления: 'dark' или 'light'. Хранится на телефоне; ставит её index.html до отрисовки. */
const theme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
function setTheme(next) {
  document.documentElement.dataset.theme = next;
  screenCache.clear(); // сохранённые экраны нарисованы оттенками прошлой темы
  // Полоса браузера и системная строка — в тон верхней панели
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'dark' ? '#0b0f14' : '#131a26');
  try {
    localStorage.setItem('checker.theme', next);
  } catch {
    // не запомнится — до перезапуска
  }
}

/**
 * Анимации выключены — в настройках («Внешний вид») или системным «уменьшить движение».
 * Тогда кольцо, счётчик суммы, листы и разделы появляются сразу; CSS-анимации гасит
 * правило :root[data-motion="off"] в стилях.
 */
function calm() {
  return document.documentElement.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches;
}
// Отдельные виды анимации: выключенные — в localStorage (checker.motion.kinds)
const MOTION_KINDS = ['ring', 'counter', 'sheets', 'sections', 'swipe', 'screens', 'peek'];
function motionPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem('checker.motion.kinds') || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
/** Этот вид анимации сейчас показывать? Нет, если выключены все или он сам. */
const motion = (kind) => !calm() && motionPrefs()[kind] !== false;
function setMotionKind(kind, on) {
  const prefs = { ...motionPrefs(), [kind]: on };
  try {
    localStorage.setItem('checker.motion.kinds', JSON.stringify(prefs));
  } catch {
    // не запомнится — до перезапуска
  }
  // Листы — CSS-анимации: гасит правило :root[data-no-sheets]
  if (prefs.sheets === false) document.documentElement.dataset.noSheets = '1';
  else delete document.documentElement.dataset.noSheets;
}

/** Экран «Анимации»: все разом и каждая по отдельности. */
function screenSetMotion() {
  const L = T.settings.look;
  const all = document.documentElement.dataset.motion !== 'off';
  const prefs = motionPrefs();
  const system = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Без заголовка: экран уже называется «Анимации»
  return section('', system ? L.systemNote : '',
    srow({ icon: groupIcon('zap'), title: L.allLabel, end: toggle('data-motion-toggle', all, L.allLabel) }))
    + section(L.kindsLabel, L.kindsNote, MOTION_KINDS.map((k) => srow({
      title: L.kinds[k], note: L.kindNotes[k], wrap: true, off: !all, // пояснение — целиком, в две строки
      end: toggle(`data-motion-kind="${k}"${all ? '' : ' disabled'}`, prefs[k] !== false, L.kinds[k]),
    })).join(''));
}

/** Подстрочник строки «Лимиты» в настройках: сколько групп с лимитом и на какой период. */
function limitsNote() {
  const P = T.settings.limits;
  if (meta?.limits_on === false) return P.off;
  const n = Object.keys(meta?.limits ?? {}).length;
  return n ? `${int.format(n)} ${pl(n, T.settings.cats.groupsW)} · ${P.per[meta.limit_period ?? 'month']}` : P.none;
}

/** Подстрочник строки «Анимации» в настройках: все, выключены или сколько из скольких. */
function motionNote() {
  const L = T.settings.look;
  if (calm()) return L.allOff;
  const on = MOTION_KINDS.filter((k) => motionPrefs()[k] !== false).length;
  return on === MOTION_KINDS.length ? L.allOn : f(L.some, { n: on, total: MOTION_KINDS.length });
}

function setMotion(on) {
  if (on) delete document.documentElement.dataset.motion;
  else document.documentElement.dataset.motion = 'off';
  try {
    localStorage.setItem('checker.motion', on ? 'on' : 'off');
  } catch {
    // не запомнится — до перезапуска
  }
}

$('screen').addEventListener('change', (e) => {
  if (e.target.matches('[data-theme-toggle]')) setTheme(e.target.checked ? 'dark' : 'light');
  if (e.target.matches('[data-motion-toggle]')) {
    setMotion(e.target.checked);
    if (state.screen === 'set_motion') render(); // отдельные переключатели — доступны или нет
  }
  if (e.target.matches('[data-motion-kind]')) setMotionKind(e.target.dataset.motionKind, e.target.checked);
  if (e.target.matches('[data-demo-toggle]')) switchDemo(e.target.checked, e.target);
  if (e.target.matches('[data-notify-members]')) {
    const box = e.target;
    api('/api/session', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notify_members: box.checked }) })
      .then(() => kept.delete('/api/budget'))
      .catch((err) => {
        box.checked = !box.checked;
        toast(`${T.common.failed}: ${err.message}`);
      });
  }
});

/**
 * Тестовая база: включить или выключить (сервер переключает бюджет, demo.mjs). Дальше
 * перезагрузка: справочники, сохранённые экраны и счётчики — уже другого бюджета.
 */
async function switchDemo(on, box = null) {
  if (box) box.disabled = true;
  try {
    await post('/api/demo', { on });
    location.reload();
  } catch (err) {
    if (box) {
      box.checked = !on;
      box.disabled = false;
    }
    toast(`${T.common.failed}: ${err.message}`);
  }
}

demoPill.addEventListener('click', async () => {
  if (await ask(T.settings.help.offConfirm, { ok: T.settings.help.off })) switchDemo(false);
});

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
      <div class="sec-title">${T.bankCard.main}</div>
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
    ${T.bankCard.limits[b.id] ? `<p class="sec-foot">${T.bankCard.limits[b.id]}</p>` : ''}

    ${accounts.length ? section(T.bankCard.accounts.label, T.bankCard.accounts.hint, accounts.map((a) => srow({
      ...accountIcon(a),
      // Цифры счёта не обрезаются: у Сбера три «Сберегательных счёта» различаются только ими
      title: `<span class="acc-title"><span class="acc-name">${esc(a.name || a.id)}</span><span class="acc-tail">${esc(tail(a))}</span></span>`,
      // Вид счёта: у Т-Банка — тип от банка, у Сбера типа нет — по тому, что узнал сервер
      note: `${esc(T.accountTypes[a.type] ?? T.bankCard.accounts.kinds[a.kind] ?? a.type ?? T.bankCard.accounts.kind)}${a.currency && a.currency !== 'RUB' ? ` · ${esc(a.currency)}` : ''} · ${int.format(a.ops)} ${pl(a.ops, T.common.ops)}`,
      end: toggle(`data-bank-acc="${esc(a.id)}" data-ops="${a.ops}"`, a.enabled, T.bankCard.accounts.toggle),
    })).join('')) : ''}

    ${connected ? syncSection(b.id) : ''}

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
            + (ops ? act('wipe', b.id, b.shop ? T.bankCard.manage.wipeShop : T.bankCard.manage.wipe, UI.trash, true) : ''))}`;
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
      if (!(await ask(T.settings.budget.leaveConfirm, { ok: T.common.leave, danger: true }))) return;
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
      if (!(await ask(T.settings.budget.removeConfirm, { ok: T.common.exclude, danger: true }))) return;
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
      if (!(await ask(T.settings.profile.logoutConfirm, { ok: T.common.leave }))) return;
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      token.clear();
      location.reload();
    }

    if (e.target.closest('[data-delete-account]')) {
      if (!(await ask(T.settings.deleteConfirm, { ok: T.common.delete, danger: true }))) return;
      if (!(await ask(T.settings.deleteConfirm2, { ok: T.common.delete, danger: true }))) return;
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
  if (e.target.closest('[data-tlook], [data-tcat], [data-tgroup], [data-tcat-add], [data-tgroup-add], [data-tgroup-icon], [data-tcat-icon], [data-tgroup-delete], [data-tcat-move], [data-tcat-delete], [data-lim-manage]')) return onCatsClick(e);
  onSettingsClick(e);
});

/**
 * Правка на месте: имя в настройках, название бюджета. В настройках нажимается почти каждая
 * строка, поэтому значков у действий нет: нажатие на текст открывает поле и клавиатуру.
 * Сохраняется, когда человек закончил: «Готово» на клавиатуре или уход из поля.
 */
function inlineEdit(field, value, { cls = '', label = '', placeholder = '', max = 60, multi = false } = {}) {
  // multi — длинный текст (подсказка категории). В покое — строка текста с многоточием (поле
  // ввода обрезать многоточием не умеет); нажали — на её месте поле на четыре строки
  if (multi) {
    return `
    <div class="inline-multi">
      <span class="inline-view${value ? '' : ' empty'}" data-inline-view>${esc(value || placeholder)}</span>
      <textarea class="inline-input multi ${cls}" data-inline="${field}" rows="4" maxlength="${max}" enterkeyhint="done"
        readonly placeholder="${esc(placeholder)}" aria-label="${esc(label)} — нажмите, чтобы изменить">${esc(value)}</textarea>
    </div>`;
  }
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
  const view = e.target.closest('[data-inline-view]');
  const input = view ? view.nextElementSibling : e.target.closest('[data-inline]');
  if (!input?.readOnly) return;
  input.readOnly = false;
  input.focus(); // в обработчике нажатия, иначе iOS не покажет клавиатуру
  input.select();
});

$('screen').addEventListener('keydown', (e) => {
  // Enter — «готово» и в многострочном поле: подсказка — один абзац, перенос строки ей не нужен
  if (e.target.matches?.('[data-inline]') && e.key === 'Enter') {
    e.preventDefault();
    e.target.blur();
  }
});

$('screen').addEventListener('focusout', async (e) => {
  const input = e.target;
  if (!input.matches?.('[data-inline]') || input.readOnly) return;
  input.readOnly = true;
  input.setSelectionRange(0, 0); // снимаем выделение, оставшееся от начала правки
  input.scrollTop = 0; // свёрнутое многострочное поле — с начала текста
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
  // Строка-показ у многострочного поля — с новым текстом
  const view = input.previousElementSibling;
  if (view?.matches('[data-inline-view]')) {
    view.textContent = input.value || input.placeholder;
    view.classList.toggle('empty', !input.value);
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
      toggleGroup(row.dataset.long, row);
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
  forgetAppInfo();
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
/** Действия с банком в приложении. Любое из них меняет состояние банка — запомненное забываем. */
function bankBridge(id) {
  const raw = bankBridgeRaw(id);
  return Object.fromEntries(Object.entries(raw).map(([name, fn]) => [name, (...args) => {
    forgetAppInfo();
    return fn(...args);
  }]));
}

function bankBridgeRaw(id) {
  const c = window.Checker;
  if (id === 'ozon') return { login: () => c.ozonLogin(), sync: () => c.ozonSync(token.get()), forget: () => c.ozonForget() };
  if (id === 'wb') return { login: () => c.wbLogin(), sync: () => c.wbSync(token.get()), forget: () => c.wbForget() };
  return id === 'sber'
    ? { login: () => c.sberLogin(), sync: () => c.sberSync(token.get()), forget: () => c.sberForget() }
    : { login: () => c.bankLogin(), sync: () => c.bankSync(token.get()), forget: () => c.bankForget() };
}

async function startBankSync(id) {
  bankSyncing = id;
  if (state.screen === 'set_banks') render();
  syncSince.set(id, await serverNow()); // потом спросим «что пришло с этого момента»
  bankBridge(id).sync();
}

// Банк дозавершил вход уже после того, как окно ушло с экрана
window.addEventListener('checker-bank-ready', (e) => {
  forgetAppInfo();
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
  forgetAppInfo();
  feedData.clear(); // пришли новые операции или чеки
  bankSyncing = null;
  const r = e.detail ?? {};
  // Пришло новое и известно, с какого момента, — показываем, что именно и куда легло
  const since = syncSince.get(r.bank ?? 'tbank');
  syncSince.delete(r.bank ?? 'tbank');
  if (r.ok && !r.error && r.ops && since) {
    if (state.screen === 'set_banks' || state.screen === 'bank_card') render();
    return openFresh(r.bank ?? 'tbank', since, f(bankById(r.bank)?.shop ? T.bankCard.sync.addedShop : T.bankCard.sync.added, { n: int.format(r.ops) }));
  }
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

// ── что пришло с обновлением ─────────────────────────────
// После обновления банка или магазина — окно с тем, что пришло, по категориям: человек сразу
// видит, куда разложились новые траты, и поправляет, пока помнит покупку. То же окно — в итоге
// мастера для всей загруженной истории.

const syncSince = new Map(); // банк → время сервера перед обновлением

/** Время сервера: «что нового» спрашиваем по его часам, а не по часам телефона. */
const serverNow = () => api('/api/fresh').then((r) => r.now).catch(() => null);

/** Новое у банка или магазина с момента since — с сервера. */
const loadFresh = (bank, since) => api(`/api/fresh?bank=${encodeURIComponent(bank)}&since=${encodeURIComponent(since)}`);

/** Как показать строку нового: название раздела, цвет и значок. */
function freshLook(r) {
  if (r.kind === 'covered') return { name: 'С чеком', note: 'по товарам чека', color: 'var(--fill)', icon: 'receipt' };
  if (r.kind === 'income') {
    const c = r.category_slug ? incomeCat(r.category_slug) : null;
    return { name: c?.name ?? 'Доход без категории', color: c?.color ?? 'var(--fill)', icon: catIcon(c) };
  }
  const found = r.category_slug ? findCategory(r.category_slug) : null;
  return { name: found?.category.name ?? 'Без категории', color: found?.group.color ?? 'var(--fill)', icon: catIcon(found) };
}

/** Одна строка нового: значок категории (с зелёной точкой, если её предложил Чекер), название, сумма. */
function freshRow(r) {
  itemCtx.set(`${r.type}:${r.id}`, r);
  const l = freshLook(r);
  const human = ['manual', 'pinned', 'seller'].includes(r.category_source);
  const guess = r.category_slug && !human ? ' guess' : '';
  const when = `${dateRu(r.at.slice(0, 10))}${r.at.length > 10 ? ` ${esc(timeRu(r.at))}` : ''}`;
  const attrs = r.kind === 'covered' ? 'disabled' : `data-fresh-pick="${r.type}:${r.id}:${r.kind}"`;
  return `
    <button class="sheet-row${guess}" type="button" ${attrs}>
      <span class="pick-ic" style="background:${l.color};color:${readableText(l.color)}">${groupIcon(l.icon)}</span>
      <span class="sheet-main">
        <span class="sheet-name">${esc(r.name ?? '')}</span>
        <span class="sheet-cat">${when} · ${esc(l.note ?? l.name)}</span>
      </span>
      <span class="sheet-sum${r.kind === 'income' ? ' income' : ''}">${r.kind === 'income' ? '+' : ''}${money(r.sum, true)}</span>
    </button>`;
}

/** Мастер во время загрузки: сколько строк показываем — свежие сверху, остальное в итоге. */
const WIZ_FRESH_ROWS = 200;

/**
 * Список нового по разделам-категориям: «Без категории» первыми (их и надо разобрать), дальше
 * по сумме. collapsed — свёрнутые разделы; новый раздел при длинном списке появляется свёрнутым,
 * чтобы растущий во время загрузки список не разъезжался на тысячи строк.
 */
function freshSections(data, collapsed, seen) {
  const buckets = new Map();
  for (const r of data.rows) {
    const key = r.kind === 'covered' ? 'covered' : r.kind === 'income' ? `in|${r.category_slug ?? ''}` : r.category_slug ?? '';
    if (!buckets.has(key)) buckets.set(key, { key, rows: [], sum: 0 });
    const bucket = buckets.get(key);
    bucket.rows.push(r);
    bucket.sum += r.sum;
  }
  const order = [...buckets.values()].sort((x, y) =>
    (x.key === '' ? -1 : 0) - (y.key === '' ? -1 : 0) || (x.key === 'covered') - (y.key === 'covered') || y.sum - x.sum);
  for (const [i, bucket] of order.entries()) {
    if (seen.has(bucket.key)) continue;
    seen.add(bucket.key);
    if (data.rows.length > 60 && (i > 0 || bucket.key !== '')) collapsed.add(bucket.key);
  }

  return order.map((bucket) => {
    const head = freshLook(bucket.rows[0]);
    const open = !collapsed.has(bucket.key);
    const rows = !open ? '' : bucket.rows.map(freshRow).join('');
    return `
      <button class="fresh-head${open ? ' open' : ''}" type="button" data-fresh-section="${esc(bucket.key)}">
        <span class="section-arrow">${UI.chevron}</span>
        <span class="fresh-title">${esc(head.name)} · ${int.format(bucket.rows.length)}</span>
        <b>${money(bucket.sum)}</b>
      </button>${rows}`;
  }).join('');
}

/**
 * Нажатие в списке нового: раздел — свернуть или развернуть, строка — выбрать категорию
 * (или «перевод себе»). redraw — перерисовать как есть, refresh — перечитать с сервера.
 * true — нажатие было наше.
 */
function onFreshClick(e, { collapsed, redraw, refresh }) {
  const head = e.target.closest('[data-fresh-section]');
  if (head) {
    const key = head.dataset.freshSection;
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    redraw();
    return true;
  }
  const pick = e.target.closest('[data-fresh-pick]');
  if (!pick) return false;
  const [type, raw, kind] = pick.dataset.freshPick.split(':');
  const id = Number(raw);
  const save = (path) => async (_, slug, { only = false, seller = false } = {}) => {
    try {
      if (slug === TRANSFER) await post(`/api/bank/ops/${id}/kind`, { kind: 'transfer', only });
      else await post(path, { category: slug, only, seller });
      await refresh();
    } catch (err) {
      toast(`Не сохранилось: ${err.message}`);
    }
  };
  if (type === 'item') openCategoryPicker(id, save(`/api/items/${id}/category`), undefined, sameFor('item', id));
  else if (kind === 'income') openCategoryPicker(id, save(`/api/bank/ops/${id}/category`), meta?.income ?? [], sameFor('income', id), { transfer: true });
  else openCategoryPicker(id, save(`/api/bank/ops/${id}/category`), undefined, sameFor('op', id), { transfer: true });
  return true;
}

async function openFresh(bank, since, title) {
  const b = bankById(bank);
  let data;
  try {
    data = await loadFresh(bank, since);
  } catch (err) {
    return toast(`Не открылось: ${err.message}`);
  }
  if (!data.rows.length) return toast(b?.shop ? T.bankCard.sync.noneShop : T.bankCard.sync.none);

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  const collapsed = new Set();
  const seen = new Set();

  const draw = () => {
    const box = sheet.querySelector('.sheet-list');
    const scroll = box?.scrollTop ?? 0;
    const n = data.total;
    const word = b?.shop ? plural(n, 'позиция', 'позиции', 'позиций') : pl(n, T.common.ops);
    sheet.innerHTML = `
      <div class="sheet-box" role="dialog" aria-label="${esc(title)}">
        <div class="sheet-top">
          <div>
            <div class="sheet-sum-total">${esc(title)}</div>
            <div class="note">${esc(b?.name ?? '')} · ${int.format(n)} ${word}${data.cut ? ' (показаны последние)' : ''}</div>
          </div>
          <button class="icon-btn primary" data-close type="button" aria-label="Готово" title="Готово">${UI.ok}</button>
        </div>
        <p class="note sheet-hint">Нажмите на строку, чтобы поменять категорию. Зелёная точка у значка — категорию предложил Чекер.</p>
        <div class="sheet-list">${freshSections(data, collapsed, seen)}</div>
      </div>`;
    sheet.querySelector('.sheet-list').scrollTop = scroll;
  };

  draw();
  openPopup(sheet);

  const refresh = async () => {
    try {
      data = await loadFresh(bank, since);
      draw();
    } catch {
      // останется прежний вид
    }
  };

  sheet.addEventListener('click', (e) => {
    if (e.target === sheet || e.target.closest('[data-close]')) {
      closePopup(sheet);
      return render(); // списки под окном — со свежими категориями
    }
    onFreshClick(e, { collapsed, redraw: draw, refresh });
  });
}

// Мастер: что уже загрузили — растёт по ходу загрузки, категорию можно поправить сразу
const wizFresh = { data: null, collapsed: new Set(), seen: new Set(), at: 0, busy: false, key: '' };

function wizFreshDraw() {
  const box = $('wiz-fresh');
  if (!box || !wizFresh.data) return;
  const n = wizFresh.data.total;
  $('wiz-fresh-count').textContent = n ? `· ${int.format(n)}` : '';
  // Во время загрузки — без разделов, в порядке поступления: новое всегда сверху, его не надо
  // искать по категориям. Разделы — в итоге, когда всё загружено
  const rows = wizFresh.data.rows.slice(0, WIZ_FRESH_ROWS);
  box.innerHTML = n
    ? rows.map(freshRow).join('') + (n > rows.length ? `<p class="note wiz-fresh-empty">Ещё ${int.format(n - rows.length)} — в итоге загрузки</p>` : '')
    : `<p class="note wiz-fresh-empty">${isShop(wiz.bank) ? 'Товары появятся здесь по мере загрузки' : 'Операции появятся здесь по мере загрузки'}</p>`;
}

/**
 * Перечитать загруженное. Зовётся, когда приложение сообщило о новых чеках или операциях;
 * пока идёт прошлый запрос, новый не шлём, а повторяем сразу после него.
 */
async function wizFreshLoad() {
  if (!wiz?.started) return;
  if (wizFresh.busy) {
    wizFresh.again = true;
    return;
  }
  const key = `${wiz.bank}|${wiz.started}`;
  if (wizFresh.key !== key) Object.assign(wizFresh, { data: null, collapsed: new Set(), seen: new Set(), at: 0, key });
  wizFresh.busy = true;
  wizFresh.again = false;
  try {
    wizFresh.data = await loadFresh(wiz.bank, wiz.started);
    wizFresh.at = Date.now();
    if (state.screen === 'bank_wizard') wizFreshDraw();
  } catch {
    // попробуем при следующем событии
  } finally {
    wizFresh.busy = false;
    if (wizFresh.again) wizFreshLoad();
  }
}

// ── авторазметка ─────────────────────────────────────────
// Товары без категории за период — модели, порциями по 20 названий, у человека на глазах:
// строки перекрашиваются по мере ответов. Кончился суточный лимит — останавливаемся до завтра.
// Состояние живёт, пока открыт экран: вернулись к нему — видно, что уже разложено.

const AUTO_NAMES = 20;
const auto = { key: '', rows: [], tried: new Set(), done: new Set(), running: false, quotaOut: false, error: null };

async function screenAutolabel() {
  const key = `${state.from}|${state.to}`;
  if (auto.key !== key) {
    const data = await api(`/api/autolabel?from=${state.from}&to=${state.to}`);
    Object.assign(auto, {
      key, rows: data.rows.map((r) => ({ ...r, kind: 'expense', uid: `${r.type}:${r.id}` })), cut: data.cut,
      tried: new Set(), done: new Set(), running: false, quotaOut: false, error: null,
    });
  }
  if (!auto.rows.length) return '<div class="empty">Всё за этот период разложено по категориям</div>';
  return `
    <div class="stuck-head"><div class="card auto-head" id="auto-head">${autoHead()}</div></div>
    <div class="list sheet-list auto-list">${auto.rows.map(autoRow).join('')}</div>`;
}

function autoHead() {
  const total = auto.rows.length;
  const labeled = auto.rows.filter((r) => r.category_slug).length;
  const left = auto.rows.filter((r) => !auto.tried.has(r.uid) && !r.category_slug).length;
  const missed = auto.rows.filter((r) => auto.tried.has(r.uid) && !r.category_slug).length;
  const status = auto.error
    ? `Не получилось: ${esc(auto.error)}. Откройте экран ещё раз, чтобы продолжить.`
    : auto.quotaOut
    ? 'Лимит разметки на сегодня закончился — продолжим завтра: откройте этот экран снова.'
    : left
    ? 'Размечаем… Строку можно разложить и руками, не дожидаясь.'
    : missed
    ? `Готово. Не узнали ${int.format(missed)} — их можно разложить руками.`
    : 'Готово: всё разложено.';
  return `
    <div class="auto-top"><b>Размечено ${int.format(labeled)} из ${int.format(total)}${auto.cut ? '+' : ''}</b></div>
    <div class="wiz-bar"><span style="width:${total ? Math.round(((total - left) / total) * 100) : 100}%"></span></div>
    <p class="note">${status}</p>`;
}

/** Строка: ещё не спрашивали — приглушена, спрашиваем сейчас — мигает. */
function autoRow(r) {
  const cls = r.category_slug ? '' : r.now ? ' auto-now' : auto.tried.has(r.uid) ? ' auto-missed' : ' auto-wait';
  return freshRow(r).replace('class="sheet-row', `data-auto-row="${r.uid}" class="sheet-row${cls}`);
}

function autoRedraw(ids) {
  const head = $('auto-head');
  if (head) head.innerHTML = autoHead();
  for (const r of auto.rows) {
    if (ids && !ids.has(r.uid)) continue;
    const el = document.querySelector(`[data-auto-row="${r.uid}"]`);
    if (el) el.outerHTML = autoRow(r);
  }
}

/** Следующая порция: до AUTO_NAMES разных названий (у трат — продавцов) из ещё не спрошенных. */
function autoBatch() {
  const names = new Set();
  const uids = [];
  for (const r of auto.rows) {
    if (auto.tried.has(r.uid) || r.category_slug) continue;
    if (!names.has(r.key) && names.size >= AUTO_NAMES) continue;
    names.add(r.key);
    uids.push(r.uid);
  }
  return uids;
}

async function autoRun() {
  if (auto.running || auto.quotaOut || state.screen !== 'autolabel') return;
  auto.running = true;
  auto.error = null;
  try {
    for (;;) {
      if (state.screen !== 'autolabel') break;
      const uids = autoBatch();
      if (!uids.length) break;
      const batch = new Set(uids);
      const part = auto.rows.filter((r) => batch.has(r.uid));
      for (const r of part) {
        auto.tried.add(r.uid);
        r.now = true;
      }
      autoRedraw(batch);
      const res = await post('/api/autolabel', {
        ids: part.filter((r) => r.type === 'item').map((r) => r.id),
        ops: part.filter((r) => r.type === 'op').map((r) => r.id),
      });
      const got = new Map(res.rows.map((x) => [`${x.type}:${x.id}`, x]));
      for (const r of part) {
        r.now = false;
        const x = got.get(r.uid);
        if (x?.category_slug) {
          r.category_slug = x.category_slug;
          r.category_source = x.category_source;
        }
      }
      if (res.quota_out) {
        // Лимит кончился до вопроса: эти строки ещё не спрашивали — вернём их в очередь на завтра
        for (const r of part) if (!r.category_slug) auto.tried.delete(r.uid);
        auto.quotaOut = true;
      }
      autoRedraw(batch);
      if (auto.quotaOut) break;
    }
  } catch (err) {
    auto.error = err.message;
  } finally {
    auto.running = false;
    autoRedraw();
    feedData.clear(); // в расходах категории поменялись
  }
}

/** Разложить строку руками: то же окно выбора, что везде (у трат банка — и «перевод себе»). */
function autoPickRow(type, id) {
  const row = auto.rows.find((r) => r.type === type && r.id === id);
  if (!row) return;
  const op = type === 'op';
  openCategoryPicker(id, async (_, slug, { only = false, seller = false } = {}) => {
    try {
      if (slug === TRANSFER) {
        await post(`/api/bank/ops/${id}/kind`, { kind: 'transfer', only });
        // Перевод — не трата: такие строки уходят из списка
        auto.rows = auto.rows.filter((r) => !(r === row || (op && !only && r.type === 'op' && r.key === row.key)));
        return render();
      }
      await post(op ? `/api/bank/ops/${id}/category` : `/api/items/${id}/category`, { category: slug, only, seller });
      // «Для всех таких же» — и у соседних строк: того же товара, продавца или трат продавца
      const touched = new Set();
      for (const r of auto.rows) {
        const same = r === row
          || (!only && r.type === row.type && r.key === row.key)
          || (seller && !op && r.type === 'item' && r.seller_inn === row.seller_inn);
        if (!same) continue;
        r.category_slug = slug;
        r.category_source = 'manual';
        auto.tried.add(r.uid);
        touched.add(r.uid);
      }
      autoRedraw(touched);
    } catch (err) {
      toast(`Не сохранилось: ${err.message}`);
    }
  }, undefined, sameFor(op ? 'op' : 'item', id), { transfer: op });
}

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
  // Есть ли банк — вместе с остальным стартовым, до первой отрисовки: от него зависит вид
  // «Расхода», и ответ, пришедший позже, перерисовывал экран посреди заливки кольца
  const [m, bank] = await Promise.all([api('/api/meta'), api('/api/bank').catch(() => null)]);
  meta = m;
  // Банк в бюджете — у себя или у другого участника: операции из него видны всем
  if (bank) bankLinked = (bank.links ?? []).some((l) => l.ops > 0) || bank.budget_ops > 0;
  incomeManual = (bank?.manual_ops ?? 0) > 0;

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
  sheet.classList.add('opening'); // выезжает, как остальные листы (openPopup тут не нужен: без записи истории)
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
// ── Аналитика: этот период против прошлого ────────────────
// Ответ фразой (сколько потрачено и на сколько больше или меньше прошлого периода к этому же
// дню, прогноз), график накопленных трат — этот период ярко, прошлый бледно, прогноз точками, —
// строка про доходы и группы строками: две полосы (этот и прошлый период к этому же дню),
// перерасход сверх лимита — штриховкой. Нажатие на группу — её категории тем же видом.
// Данные — те же ленты, что у «Расхода», по дням (collapse=day), с теми же отборами.
// Решено по макетам 22.10.2026 (первая версия — линии всех групп на одном графике — не читалась)

const ANA_USUAL = 3; // прошлых периодов для прогноза (сам прогноз «обычно» не рисуется)
const ANA_IN = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
const ANA_NAME = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const ANA_TO = ['январю', 'февралю', 'марту', 'апрелю', 'маю', 'июню', 'июлю', 'августу', 'сентябрю', 'октябрю', 'ноябрю', 'декабрю'];

function anaFeeds(from, to) {
  const items = new URLSearchParams({ from, to, collapse: 'day', per: '20000', sort: 'date', dir: 'asc' });
  const ops = new URLSearchParams({ from, to, direction: 'debit', kind: 'expense', per: '20000' });
  const income = new URLSearchParams({ from, to, direction: 'credit', kind: 'income', per: '20000' });
  return { items: `/api/items?${items}`, ops: `/api/bank/ops?${ops}`, income: incomeOn() ? `/api/bank/ops?${income}` : null };
}

/** Лимиты — только у групп и без отборов: иначе потраченное не сравнить с лимитом. */
const anaWithLimits = () => meta?.limits_on !== false && !state.src && !state.sg && !state.q.trim();

/**
 * Все запросы, которые сделает аналитика за период (screenAnalytics): его траты и доходы, доходы
 * прошлого периода, лимиты и траты трёх прошлых периодов — для прогноза. Предзагрузка соседнего
 * периода берёт их все: иначе после отпускания свайпа шли запросы и экран ждал сети
 */
function anaPaths(from, to) {
  const prev = shiftPeriod(from, to, -1);
  const past = Array.from({ length: ANA_USUAL }, (_, i) => shiftPeriod(from, to, -(i + 1)));
  return [
    ...Object.values(anaFeeds(from, to)),
    anaFeeds(prev.from, prev.to).income,
    anaWithLimits() ? `/api/limits/state?from=${from}&to=${to}` : null,
    ...past.flatMap((p) => [anaFeeds(p.from, p.to).items, anaFeeds(p.from, p.to).ops]),
  ].filter(Boolean);
}

/** Траты периода с отборами экрана (источник, группы, поиск) — как в «Расходе»: [{ day, slug, sum }]. */
function anaSpend(items, ops) {
  const picked = new Set(state.sg ? state.sg.split(',') : []);
  const inGroup = (slug) => !state.sg || picked.has(slug ?? '') || picked.has(findCategory(slug)?.group.slug ?? NONE);
  const out = [];
  {
    for (const r of items) {
      if (!srcOn(itemSource(r))) continue;
      if (!matchesQ([r.name, r.seller, r.retail_place, findCategory(r.category_slug)?.category.name], [r.sum])) continue;
      if (inGroup(r.category_slug)) out.push({ day: r.day ?? r.purchased_at.slice(0, 10), slug: r.category_slug, sum: r.sum });
    }
  }
  if (srcOn('bank')) {
    for (const op of ops) {
      if (!matchesQ([op.merchant, op.description, op.account_name, findCategory(op.category_slug)?.category.name], [op.amount])) continue;
      if (inGroup(op.category_slug)) out.push({ day: op.at.slice(0, 10), slug: op.category_slug, sum: op.amount });
    }
  }
  return out;
}

/**
 * Деления оси: до двух месяцев — дни, до года — недели (по семь дней от начала периода; ключ —
 * первый день), до трёх лет — месяцы, до двенадцати — кварталы, дольше — годы.
 */
function anaBuckets(from, to, step = '') {
  const days = Math.round((parseDay(to) - parseDay(from)) / 86400000) + 1;
  const months = anaMonths(from, to);
  const s = anaStep(from, to, step);
  if (s === 'd' || s === 'w') {
    const dayKeys = Array.from({ length: days }, (_, i) => isoDay(addDays(parseDay(from), i)));
    if (s === 'd') {
      const at = new Map(dayKeys.map((k, i) => [k, i]));
      return { keys: dayKeys, step: s, monthly: false, of: (day) => at.get(day) ?? -1 };
    }
    const at = new Map(dayKeys.map((k, i) => [k, Math.floor(i / 7)]));
    const keys = dayKeys.filter((_, i) => i % 7 === 0);
    const ends = keys.map((_, i) => dayKeys[Math.min(i * 7 + 6, days - 1)]); // последний день недели
    return { keys, ends, step: s, weekly: true, monthly: false, of: (day) => at.get(day) ?? -1 };
  }
  const span = s === 'y' ? 'year' : s === 'q' ? 'quarter' : '';
  const keyOf = (month) => (span === 'year' ? month.slice(0, 4)
    : span === 'quarter' ? `${month.slice(0, 4)}-Q${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}` : month);
  const keys = [...new Set(months.map(keyOf))];
  const at = new Map(keys.map((k, i) => [k, i]));
  return { keys, step: s, monthly: !span, span, of: (day) => at.get(keyOf(day.slice(0, 7))) ?? -1 };
}

/** Месяцы периода: ['2026-10', '2026-11', …]. */
function anaMonths(from, to) {
  const out = [];
  for (let d = parseDay(from); isoDay(d) <= to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) out.push(isoDay(d).slice(0, 7));
  return out;
}

/**
 * Какие деления предлагать (кнопка в карточке графика): до двух месяцев — дни, недели, месяцы;
 * до трёх лет — недели, месяцы, кварталы, годы; дольше — месяцы, кварталы, годы.
 */
function anaSteps(from, to) {
  const days = Math.round((parseDay(to) - parseDay(from)) / 86400000) + 1;
  if (days <= 62) return ['d', 'w', 'm'];
  return anaMonths(from, to).length <= 36 ? ['w', 'm', 'q', 'y'] : ['m', 'q', 'y'];
}

/**
 * Деление графика: выбранное (state.step), если для периода его предлагают, иначе — по длине:
 * до двух месяцев — дни, до года — недели, до трёх лет — месяцы, до двенадцати — кварталы, дольше — годы.
 */
function anaStep(from, to, step = '') {
  if (step && anaSteps(from, to).includes(step)) return step;
  const days = Math.round((parseDay(to) - parseDay(from)) / 86400000) + 1;
  const months = anaMonths(from, to).length;
  return days <= 62 ? 'd' : days <= 366 ? 'w' : months <= 36 ? 'm' : months <= 144 ? 'q' : 'y';
}

/** Деление столбиков по умолчанию: крупнее, чем у линий, — до двух месяцев дни, до полугода недели, дальше месяцы. */
function anaBarsStep(from, to) {
  const days = Math.round((parseDay(to) - parseDay(from)) / 86400000) + 1;
  return days <= 62 ? 'd' : days <= 186 ? 'w' : anaMonths(from, to).length <= 36 ? 'm' : '';
}

const ANA_STEP_NAMES = { d: 'по дням', w: 'по неделям', m: 'по месяцам', q: 'по кварталам', y: 'по годам' };

/** Кнопка деления в карточке графика: попап, как у сортировки, — варианты под длину периода. */
function anaStepDrop(from, to, current) {
  const rows = anaSteps(from, to).map((k) => dropRow(`data-ana-step="${k}"`, UI.calendar, cap(ANA_STEP_NAMES[k]), k === current)).join('');
  return `<div class="drop ana-step">
    <button class="ana-step-btn" type="button" data-drop data-pop aria-label="Деление графика" title="Деление графика">${esc(ANA_STEP_NAMES[current])}${UI.chevron}</button>
    <div class="drop-menu" role="menu" hidden>${rows}</div>
  </div>`;
}

/** Накопленная сумма по делениям: [5, 0, 3] → [5, 5, 8]. */
function anaCum(arr) {
  let n = 0;
  return arr.map((v) => (n += v));
}

/** Суммы по делениям: всего и по ключу (группа или категория). */
function anaSplit(rows, B, keyOf) {
  const n = B.keys.length;
  const total = new Array(n).fill(0);
  const byKey = new Map();
  for (const r of rows) {
    const i = B.of(r.day);
    if (i < 0) continue;
    total[i] += r.sum;
    const k = keyOf(r.slug);
    if (!byKey.has(k)) byKey.set(k, new Array(n).fill(0));
    byKey.get(k)[i] += r.sum;
  }
  return { total, byKey };
}

/** Как назвать прошлый период: «в сентябре» / «к сентябрю» — у календарного месяца, иначе общо. */
function anaPrevNames(prev) {
  const months = wholeMonths(prev.from, prev.to);
  if (months === 1) {
    const m = parseDay(prev.from).getMonth();
    return { in: `в ${ANA_IN[m]}`, to: `к ${ANA_TO[m]}`, key: ANA_NAME[m] };
  }
  return { in: 'в прошлом периоде', to: 'к прошлому периоду', key: 'прошлый период' };
}

async function screenAnalytics() {
  const from = state.from;
  const to = state.to;
  const today = isoDay(new Date());
  const prev = shiftPeriod(from, to, -1);
  const past = Array.from({ length: ANA_USUAL }, (_, i) => shiftPeriod(from, to, -(i + 1)));
  // Лимиты — только у групп и без отборов: иначе потраченное не сравнить с лимитом
  const withLimits = anaWithLimits();
  const feeds = anaFeeds(from, to);
  const prevIncome = anaFeeds(prev.from, prev.to).income;
  const [items, ops, income, incomeWas, limits, ...history] = await Promise.all([
    apiFeed(feeds.items),
    apiFeed(feeds.ops).catch(() => null),
    feeds.income ? apiFeed(feeds.income).catch(() => null) : null,
    prevIncome ? apiFeed(prevIncome).catch(() => null) : null,
    withLimits ? apiFeed(`/api/limits/state?from=${from}&to=${to}`).catch(() => null) : null,
    ...past.flatMap((p) => {
      const f = anaFeeds(p.from, p.to);
      return [apiFeed(f.items).catch(() => null), apiFeed(f.ops).catch(() => null)];
    }),
  ]);

  // Деление на выбор — только у столбиков (по умолчанию у них крупнее: год — по месяцам); линиям
  // мелкое деление и нужно — кривая плавнее
  const B = anaBuckets(from, to, anaView() === 'bars' ? state.step || anaBarsStep(from, to) : '');
  const n = B.keys.length;
  // Уровень: группы или категории раскрытой группы (или единственной группы в фильтре)
  const one = state.sg && !state.sg.includes(',') && findGroup(state.sg) ? state.sg : '';
  const open = findGroup(one);
  const keyOf = open ? (slug) => slug ?? NONE : (slug) => findCategory(slug)?.group.slug ?? NONE;
  // Раскрытая группа — только её траты: и строки, и график, и сумма в шапке
  const spend = (its, ops2) => anaSpend(its, ops2).filter((r) => !open || (findCategory(r.slug)?.group.slug ?? NONE) === open.slug);
  const cur = anaSplit(spend(items.rows, ops?.rows ?? []), B, keyOf);
  const curRows = spend(items.rows, ops?.rows ?? []);

  // Где обрывается этот период: в идущем — сегодня; будущий — пусто
  const cut = from > today ? -1 : to < today ? n - 1 : B.of(today);
  // Вид графика — накопительные линии или столбики по дням (неделям, месяцам); помним на телефоне
  const bars = anaView() === 'bars';
  const viewBtn = `<button class="drop-btn" type="button" data-ana-view aria-label="${bars ? 'Показать линиями' : 'Показать столбиками'}"
    title="${bars ? 'Линиями' : 'Столбиками'}">${bars ? UI.chartLine : UI.chartBars}</button>`;
  const head = (sum, note) => `<div class="stuck-head">${listHead({ sum: money(sum), note, sorts: ANA_SORTS, filters: sourceChips(), search: true, extra: viewBtn })}</div>`;
  const sort = ANA_SORTS.includes(state.sort) ? state.sort : 'category';
  if (cut < 0) return `${head(0, '')}<div class="empty">Период ещё не начался</div>`;

  const all = anaCum(cur.total);
  // Линия прошлого периода на графике — по номеру деления, рядом с этим днём
  const pB = anaBuckets(prev.from, prev.to, B.step);
  const prevSplit = anaSplit(spend(history[0]?.rows ?? [], history[1]?.rows ?? []), { ...pB, of: (day) => {
    const i = pB.of(day);
    return i >= n ? -1 : i;
  }, keys: B.keys }, keyOf);
  const prevAll = anaCum(prevSplit.total);

  // Прогноз «Всего» до конца идущего периода: к сегодняшнему — сколько обычно уходит дальше
  // (среднее по трём прошлым периодам), без истории — нынешний темп
  let forecast = null;
  if (cut < n - 1) {
    const runs = [];
    for (let p = 0; p < ANA_USUAL; p += 1) {
      if (!history[p * 2]) continue;
      const pb = anaBuckets(past[p].from, past[p].to, B.step);
      const run = anaSplit(spend(history[p * 2].rows, history[p * 2 + 1]?.rows ?? []), { ...pb, of: (day) => {
        const i = pb.of(day);
        return i >= n ? -1 : i;
      }, keys: B.keys }, keyOf).total;
      if (run.some((v) => v > 0)) runs.push(anaCum(run));
    }
    const now = all[cut];
    forecast = all.map((_, i) => {
      if (i < cut) return null;
      if (runs.length) return now + runs.reduce((s, r) => s + (r[i] - r[cut]), 0) / runs.length;
      return now + (now / (cut + 1)) * (i - cut);
    });
  }

  // Доходы — к этому же дню, без отборов (они про траты)
  const inc = new Array(n).fill(0);
  for (const op of income?.rows ?? []) {
    const i = B.of(op.at.slice(0, 10));
    if (i >= 0) inc[i] += op.amount;
  }
  const incNow = anaCum(inc)[cut];
  const incPrev = new Array(n).fill(0);
  for (const op of incomeWas?.rows ?? []) {
    const i = pB.of(op.at.slice(0, 10));
    if (i >= 0 && i < n) incPrev[i] += op.amount;
  }

  const names = anaPrevNames(prev);
  // Этот период словами: у календарного месяца — его название, «к концу месяца»
  const month = wholeMonths(from, to) === 1;
  names.cur = month ? ANA_NAME[parseDay(from).getMonth()] : 'этот период';
  const now = all[cut];
  // Прошлый период — целиком: сколько ушло за весь прошлый месяц, а не к этому же дню
  const prevRows = spend(history[0]?.rows ?? [], history[1]?.rows ?? []);
  const prevFull = new Map();
  for (const r of prevRows) prevFull.set(keyOf(r.slug), (prevFull.get(keyOf(r.slug)) ?? 0) + r.sum);
  const was = prevRows.reduce((sum, r) => sum + r.sum, 0);
  const going = cut < n - 1;
  // Отбор, поиск или раскрытая группа — на графике только эти траты: доходы с ними не сравнить
  const plain = !open && !state.src && !state.sg && !state.q.trim();

  // Шапка — как в «Расходе»: сумма, подпись, период, поиск; справа — сортировка и фильтр
  const part = (name, text) => `<span class="note-part" data-note-part="${name}">${esc(text)}</span>`;
  const picked = state.sg ? state.sg.split(',') : [];
  const note = [
    part('count', going ? `по ${ANA_DAY.format(parseDay(today))}` : `${int.format(curRows.length)} ${plural(curRows.length, 'покупка', 'покупки', 'покупок')}`),
    part('sort', SORTS[sort][0].toLowerCase()),
    open ? part('src', open.name) : '',
    state.src ? part('src', srcNote()) : '',
    picked.length && !open ? part('src', picked.map((k) => (k === NONE ? 'без категории' : findGroup(k)?.name ?? findCategory(k)?.category.name ?? '')).join(', ')) : '',
    state.q ? part('q', `поиск «${state.q.trim()}»`) : '',
    forecast ? part('forecast', `прогноз ${anaShort(forecast[n - 1])} ₽`) : '',
  ].filter(Boolean).join(' · ');
  if (!curRows.length && !was) return `${head(0, note)}<div class="empty">${state.q ? 'Ничего не нашлось' : 'За этот период трат нет'}</div>`;

  // Под графиком — пришло и потрачено, в скобках — к прошлому периоду целиком. Больше трат —
  // красным, больше доходов — зелёным
  const incWas = (incomeWas?.rows ?? []).reduce((sum, op) => sum + op.amount, 0);
  const pct = (v, base, good) => {
    if (!base) return '';
    const d = Math.round((v / base - 1) * 100);
    if (!d) return ' <span class="ana-same">(0%)</span>';
    return ` <span class="${(d > 0) === good ? 'ana-less' : 'ana-more'}">(${d > 0 ? '+' : '−'}${Math.abs(d)}%)</span>`;
  };
  const sums = [
    income ? `Пришло <span class="ana-sum"><b>${anaShort(incNow)} ₽</b>${pct(incNow, incWas, true)}</span>` : '',
    `потрачено <span class="ana-sum"><b>${anaShort(now)} ₽</b>${pct(now, was, false)}</span>`,
  ].filter(Boolean).join(' · ');

  // Сортировка: по сумме этого периода, по названию или как в настройках (без категории — в конце)
  const order = (k) => {
    const i = (open ? open.subcategories : meta?.categories ?? []).findIndex((c) => c.slug === k);
    return i < 0 ? Infinity : i;
  };
  const back = state.dir === SORTS[sort][1] ? 1 : -1;
  const compare = {
    sum: (a, b) => b.now - a.now || b.was - a.was,
    name: (a, b) => a.name.localeCompare(b.name, 'ru'),
    category: (a, b) => (order(a.key) - order(b.key)) || 0,
  }[sort];
  const range = limits?.range ?? {};
  const rows = new Set([...cur.byKey.keys(), ...prevFull.keys()]);
  const groupsRows = [...rows].map((k) => {
    const c = cur.byKey.get(k);
    const g = open ? null : findGroup(k);
    const cat = open ? findCategory(k) : null;
    return {
      key: k,
      name: open ? cat?.category.name ?? 'Без категории' : g?.name ?? 'Без категории',
      icon: open ? cat?.category.icon || open.icon || 'none' : g?.icon ?? 'none',
      color: open ? categoryColor(open.slug, k) ?? open.color : g?.color ?? '#9aa3ad',
      now: c ? anaCum(c)[cut] : 0,
      was: prevFull.get(k) ?? 0,
      limit: open ? 0 : range[k] ?? 0,
    };
  }).filter((r) => r.now || r.was)
    .sort((a, b) => compare(a, b) * back);

  return head(now, note)
    + `<div class="card ana-card">${bars ? anaBars({ B, n, cut, now: cur.total, was: prevSplit.total, names, tint: open?.color, stepBtn: anaStepDrop(from, to, B.step) }) : anaChart({ B, n, cut, all, prevAll, forecast, names, incAll: plain && income ? anaCum(inc) : null, incPrevAll: plain && incomeWas ? anaCum(incPrev) : null })}`
    + `<div class="ana-income-row">${sums.charAt(0).toUpperCase()}${sums.slice(1)}</div>`
    + '</div>'
    + section(open ? open.name : 'Группы', open ? 'Нажмите на категорию, чтобы открыть её траты' : 'Нажмите на группу, чтобы увидеть её категории',
      groupsRows.map((r) => anaRow(r, names)).join(''));
}

/** Подпись суммы: 12 тыс., 1,2 млн. */
function anaShort(kop) {
  const r = kop / 100;
  if (r >= 1e6) return `${(r / 1e6).toFixed(r >= 1e7 ? 0 : 1).replace('.', ',')} млн`;
  if (r >= 1e3) return `${Math.round(r / 1e3)} тыс.`;
  return `${Math.round(r)}`;
}

/** Подпись деления: «5 окт.», у недели — «5–11 окт.», у месяца — «окт.». */
function anaTick(B, i) {
  const k = B.keys[i];
  // Форматы — готовые: toLocaleDateString на каждое деление заметно тормозил листание
  if (B.monthly) return ANA_MONTH.format(new Date(`${k}-01T12:00:00`));
  if (B.span === 'quarter') return `${k.slice(6)} кв. ${k.slice(0, 4)}`;
  if (B.span === 'year') return k;
  if (B.weekly) {
    const end = B.ends[i];
    const last = ANA_DAY.format(new Date(`${end}T12:00:00`));
    if (end === k) return last;
    return end.slice(5, 7) === k.slice(5, 7) ? `${Number(k.slice(8, 10))}–${last}` : `${ANA_DAY.format(new Date(`${k}T12:00:00`))} – ${last}`;
  }
  return ANA_DAY.format(new Date(`${k}T12:00:00`));
}
const ANA_MONTH = new Intl.DateTimeFormat('ru-RU', { month: 'short' });
const ANA_DAY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

/** Круглый шаг шкалы не меньше v: 1, 2 или 5 × 10ⁿ (в копейках — от рубля). */
function anaNiceStep(v) {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 100)));
  return [1, 2, 5, 10].map((k) => k * p).find((s) => s >= v);
}

/**
 * Подпись деления оси X или '' — без подписи. Дни: до недели — каждый, до месяца — 1, 5, 10…,
 * до двух месяцев — 1, 10, 20; недели — по началу месяца; смена месяца — с его названием (сам период виден в шапке). Месяцы — так, чтобы
 * подписей было не больше семи.
 */
function anaAxisLabel(B, i, n) {
  const k = B.keys[i];
  // Месяцы дольше года: январь подписан годом — иначе «янв. июль янв.» не различить
  if (B.monthly) return i % Math.ceil(n / 7) === 0 ? (n > 12 && k.endsWith('-01') ? k.slice(0, 4) : ANA_MONTH.format(new Date(`${k}-01T12:00:00`))) : '';
  if (B.span === 'year') return i % Math.ceil(n / 7) === 0 ? k : '';
  if (B.span === 'quarter') {
    // Кварталы: подписан год у первого квартала; лет больше семи — через год-другой
    if (!k.endsWith('-Q1')) return '';
    const years = B.keys.filter((q) => q.endsWith('-Q1'));
    return years.indexOf(k) % Math.ceil(years.length / 7) === 0 ? k.slice(0, 4) : '';
  }
  if (B.weekly) {
    // Недели: подписана та, в которую начался месяц (или первая, если период начат 1-го);
    // месяцев больше семи — через один
    const month = (j) => {
      const s = B.keys[j];
      if (s.endsWith('-01')) return s.slice(0, 7);
      return B.ends[j].slice(5, 7) !== s.slice(5, 7) ? B.ends[j].slice(0, 7) : null;
    };
    const m = month(i);
    if (!m) return '';
    const starts = B.keys.map((_, j) => month(j)).filter(Boolean);
    return starts.indexOf(m) % Math.ceil(starts.length / 7) === 0 ? ANA_MONTH.format(new Date(`${m}-01T12:00:00`)) : '';
  }
  const day = Number(k.slice(8, 10));
  const marks = n <= 8 ? null : n <= 31 ? [1, 5, 10, 15, 20, 25, 30] : [1, 10, 20];
  const marked = (j) => j >= 0 && j < n && (!marks || marks.includes(Number(B.keys[j].slice(8, 10))));
  // Первый день — подписан, если до следующей подписи не меньше трёх делений
  const on = (j) => marked(j) || (j === 0 && ![1, 2].some(marked));
  if (!on(i)) return '';
  let j = i - 1;
  while (j >= 0 && !on(j)) j--;
  return j >= 0 && B.keys[j].slice(5, 7) !== k.slice(5, 7) ? ANA_DAY.format(new Date(`${k}T12:00:00`)) : String(day);
}

/**
 * Путь SVG монотонным кубическим сплайном (Fritsch–Carlson) по точкам P [[x, y]], от a до b.
 * Проходит через все точки и не перелетает: где ряд стоит — линия горизонтальна, где растёт —
 * растёт. Обычный сплайн у накопительной кривой проседал перед скачком, будто траты уменьшались
 */
function anaMonotone(P, a = 0, b = P.length - 1) {
  const n = P.length;
  const f = (v) => v.toFixed(1);
  if (n < 2 || b <= a) return `M${f(P[a][0])},${f(P[a][1])}`;
  const s = []; // наклоны отрезков
  for (let i = 0; i < n - 1; i++) s.push((P[i + 1][1] - P[i][1]) / (P[i + 1][0] - P[i][0] || 1));
  const m = P.map((_, i) => {
    if (i === 0) return s[0];
    if (i === n - 1) return s[n - 2];
    if (s[i - 1] * s[i] <= 0) return 0;
    const h0 = P[i][0] - P[i - 1][0];
    const h1 = P[i + 1][0] - P[i][0];
    const mid = (s[i - 1] * h1 + s[i] * h0) / (h0 + h1);
    return Math.sign(s[i]) * Math.min(Math.abs(s[i - 1]), Math.abs(s[i]), 0.5 * Math.abs(mid)) * 2;
  });
  let d = `M${f(P[a][0])},${f(P[a][1])}`;
  for (let i = a; i < b; i++) {
    const dx = (P[i + 1][0] - P[i][0]) / 3;
    d += `C${f(P[i][0] + dx)},${f(P[i][1] + dx * m[i])} ${f(P[i + 1][0] - dx)},${f(P[i + 1][1] - dx * m[i + 1])} ${f(P[i + 1][0])},${f(P[i + 1][1])}`;
  }
  return d;
}

/** График: этот период ярко, прошлый — бледнее, прогноз — точками. SVG 0–1000 × 0–600. */
function anaChart({ B, n, cut, all, prevAll, forecast, names, incAll, incPrevAll }) {
  const W = 1000;
  const H = 600;
  const top = Math.max(all[cut], ...prevAll, ...(forecast ?? []).filter((v) => v != null),
    incAll?.[cut] ?? 0, ...(incPrevAll ?? []), 1) * 1.05;
  const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v) => H - (v / top) * H;
  // Линия — монотонным сплайном по всему ряду, нарисована от start до upto: изгибы считаются по
  // соседям, поэтому сплошная часть и пунктир прогноза из одного ряда сходятся без излома
  const path = (arr, upto, start = 0) => anaMonotone(arr.map((v, i) => [x(i), y(v)]), start, upto);
  // Этот период и прогноз — один ряд: факт до сегодня, дальше — прогноз
  const run = forecast ? all.slice(0, cut + 1).concat(forecast.slice(cut + 1)) : all.slice(0, cut + 1);
  const { axis, grid, yLabels } = anaAxes(B, n, x, y, top);
  const fc = forecast ? `<path class="ana-fc" d="${path(run, n - 1, cut)}" />` : '';
  const fcEnd = forecast ? `<span class="ana-end" style="left:100%;top:${(y(forecast[n - 1]) / H) * 100}%"></span>` : '';
  anaTip = { ticks: B.keys.map((_, i) => anaTick(B, i)), cut, all, prev: prevAll, prevName: names.key, curName: names.cur, inc: incAll, incPrev: incPrevAll };
  // Доходы (опыт): зелёные линии — этот период ярко, прошлый бледнее
  const incPrevLine = incPrevAll ? `<path class="ana-line ana-inc ana-prev" d="${path(incPrevAll, n - 1)}" />` : '';
  const incLine = incAll ? `<path class="ana-line ana-inc" d="${path(incAll.slice(0, cut + 1), cut)}" />` : '';
  // Линии открываются шторками, как полосы групп, каждая следующая — с задержкой: этот период с
  // прогнозом (одним движением), прошлый, доходы этого, доходы прошлого. Шторка — прямоугольник
  // обрезки; id — свои у каждого графика: при листании на экране бывают два графика сразу
  const id = `ana${++anaClipSeq}`;
  const shut = (name) => `<clipPath id="${id}-${name}"><rect class="ana-shut" x="0" y="${-H}" width="${W}" height="${3 * H}" /></clipPath>`;
  return `
    <div class="ana-plot">
      <svg class="ana-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <defs>${[0, 1, 2, 3].map((k) => shut(k)).join('')}</defs>
        ${grid}<line class="ana-base" x1="0" x2="${W}" y1="${H}" y2="${H}" />
        <g clip-path="url(#${id}-3)" data-shut="3">${incPrevLine}</g>
        <g clip-path="url(#${id}-2)" data-shut="2">${incLine}</g>
        <g clip-path="url(#${id}-1)" data-shut="1"><path class="ana-line ana-prev" d="${path(prevAll, prevAll.length - 1)}" /></g>
        <g clip-path="url(#${id}-0)" data-shut="0">${fc}<path class="ana-line ana-now" d="${path(run, cut)}" /></g>
        <line class="ana-cursor" x1="0" x2="0" y1="0" y2="${H}" />
      </svg>
      <span class="ana-dot" data-at="${(x(cut) / W).toFixed(3)}" style="left:${(x(cut) / W) * 100}%;top:${(y(all[cut]) / H) * 100}%"></span>
      ${fcEnd}
      ${yLabels}
      <div class="ana-tip" hidden></div>
    </div>
    <div class="ana-axis">${axis}</div>
    <div class="ana-keys"><span><i class="k-now"></i>${esc(names.cur)}</span><span><i class="k-prev"></i>${esc(names.key)}</span>${forecast ? '<span><i class="k-fc"></i>прогноз</span>' : ''}${incAll || incPrevAll ? '<span><i class="k-inc"></i>доходы</span>' : ''}</div>`;
}
let anaTip = null; // суммы по делениям — для подсказки под пальцем
let anaClipSeq = 0; // номера шторок графиков

/**
 * Ось X и шкала слева. Ось: деление на каждый день (неделю, месяц), подписи — реже, чтобы не
 * слипались; у недель и месяцев подписан и конец — последний день периода (месяц), соседняя
 * подпись вплотную — убирается. Шкала — редкая: две-три круглые отметки, подпись над линией.
 */
function anaAxes(B, n, x, y, top) {
  const W = 1000;
  const H = 600;
  const labels = B.keys.map((_, i) => anaAxisLabel(B, i, n));
  if ((B.weekly || B.monthly || B.span) && n > 1) {
    const last = n - 1;
    let j = last - 1;
    while (j > 0 && !labels[j]) j--;
    if (labels[j] && x(last) - x(j) < W * 0.25) labels[j] = ''; // конец подписан вправо от деления — места нужно больше
    labels[last] = B.weekly ? ANA_DAY.format(new Date(`${B.ends[last]}T12:00:00`))
      : B.monthly ? ANA_MONTH.format(new Date(`${B.keys[last]}-01T12:00:00`)) : anaTick(B, last);
  }
  const axis = B.keys.map((_, i) => {
    const left = (x(i) / W) * 100;
    const label = labels[i];
    const side = left < 4 ? ' ana-x-l' : left > 96 ? ' ana-x-r' : '';
    return `<i class="ana-xt${label ? ' ana-xt-on' : ''}" style="left:${left}%"></i>`
      + (label ? `<span class="ana-x${side}" style="left:${left}%">${esc(label)}</span>` : '');
  }).join('');
  const step = anaNiceStep(top / 3);
  const scale = [];
  for (let v = step; v < top * 0.97; v += step) scale.push(v);
  const grid = scale.map((v) => `<line class="ana-grid" x1="0" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" />`).join('');
  const yLabels = scale.map((v) => `<span class="ana-y" style="top:${(y(v) / H) * 100}%">${anaShort(v)}</span>`).join('');
  return { axis, grid, yLabels };
}

/** Вид графика аналитики: 'line' — накопительные линии, 'bars' — столбики по делениям. */
function anaView() {
  try {
    return localStorage.getItem('checker.anaView') === 'line' ? 'line' : 'bars'; // по умолчанию — столбики
  } catch {
    return 'bars';
  }
}

/**
 * Столбики: сколько ушло за каждый день (неделю, месяц) — не накопительно. Прошлый период —
 * широким бледным столбиком, этот — узким ярким спереди; у раскрытой группы — её цветом. Растут снизу вверх
 * (animateAnalytics).
 */
function anaBars({ B, n, cut, now, was, names, tint, stepBtn = '' }) {
  const W = 1000;
  const H = 600;
  const top = Math.max(...now.slice(0, cut + 1), ...was, 1) * 1.05;
  const x = (i) => ((i + 0.5) / n) * W; // середина столбика
  const y = (v) => H - (v / top) * H;
  const { axis, grid, yLabels } = anaAxes(B, n, x, y, top);
  // Столбик в столбике: прошлый период — широкий бледный, этот — узкий яркий спереди
  const col = (v, cls) => (v > 0 ? `<span class="ana-h ${cls}" style="height:${((v / top) * 100).toFixed(2)}%"></span>` : '');
  const cols = B.keys.map((_, i) => `<span class="ana-c" data-i="${i}" style="left:${(x(i) / 10).toFixed(2)}%;width:${(70 / n).toFixed(3)}%">`
    + col(was[i] ?? 0, 'ana-h-was') + col(i <= cut ? now[i] : 0, 'ana-h-now') + '</span>').join('');
  anaTip = { ticks: B.keys.map((_, i) => anaTick(B, i)), cut, all: now, prev: was, prevName: names.key, curName: names.cur, bars: true };
  return `
    <div class="ana-plot"${tint ? ` style="--accent:${tint}"` : ''}>
      <svg class="ana-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        ${grid}<line class="ana-base" x1="0" x2="${W}" y1="${H}" y2="${H}" />
      </svg>
      <div class="ana-cols">${cols}</div>
      <svg class="ana-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <line class="ana-cursor" x1="0" x2="0" y1="0" y2="${H}" />
      </svg>
      ${yLabels}
      <div class="ana-tip" hidden></div>
    </div>
    <div class="ana-axis">${axis}</div>
    <div class="ana-keys"${tint ? ` style="--accent:${tint}"` : ''}><span><i class="k-col"></i>${esc(names.cur)}</span><span><i class="k-col k-col-prev"></i>${esc(names.key)}</span>${stepBtn}</div>`;
}

/**
 * Строка группы: название и сумма этого периода; две полосы — сверху этот период, снизу прошлый
 * к этому же дню (бледнее), тонкий зазор между ними; справа — сумма прошлого, бледно. Сверх
 * лимита — штриховкой. Подпись — разница и перерасход
 */
function anaRow(r, names) {
  // Полная длина — не меньше лимита: видно, сколько от него потрачено
  const topv = Math.max(r.now, r.was, r.limit, 1);
  const w = (r.now / topv) * 100;
  const pw = (r.was / topv) * 100;
  const over = r.limit > 0 && r.now > r.limit;
  const lw = over ? (r.limit / topv) * 100 : w;
  // Заливки — прямоугольные: скругляет их маска — весь блок из двух полос (.ana-bars) обрезан
  // одним прямоугольником со скруглёнными углами. Каждая полоса проявляется одной шторкой
  // (.ana-clip): расход и перерасход — одним движением
  const fill = `<i style="width:${lw.toFixed(1)}%;background:${r.color}"></i>`
    + (over ? `<i class="ana-over" style="left:${lw.toFixed(1)}%;width:${(w - lw).toFixed(1)}%;--c:${r.color}"></i>` : '');
  const wasFill = `<i style="width:${pw.toFixed(1)}%;background:${r.color}"></i>`;
  const clip = (wd, html) => `<span class="ana-clip" data-w="${wd.toFixed(1)}">${html}</span>`;
  const d = r.now - r.was;
  const diff = Math.abs(d) < 50000
    ? `<span class="ana-same">как ${esc(names.in)}</span>`
    : `<span class="${d > 0 ? 'ana-more' : 'ana-less'}">${d > 0 ? '+' : '−'}${anaShort(Math.abs(d))} ₽ ${esc(names.to)}</span>`;
  const overNote = over ? ` · <span class="ana-more">сверх лимита ${anaShort(r.now - r.limit)} ₽</span>` : '';
  return `<button class="ana-row" type="button" data-ana="${esc(r.key)}">
    <span class="ic" style="background:${r.color};color:${readableText(r.color)}">${groupIcon(r.icon)}</span>
    <span class="ana-mid">
      <span class="ana-top"><span class="ana-name">${esc(r.name)}</span><b>${anaShort(r.now)} ₽</b></span>
      <span class="ana-twin">
        <span class="ana-bars"><span class="ana-bar">${clip(w, fill)}</span><span class="ana-bar ana-was">${clip(pw, wasFill)}</span></span>
        <span class="ana-psum">${anaShort(r.was)} ₽</span>
      </span>
      <span class="ana-note">${diff}${overNote}</span>
    </span>
  </button>`;
}

/** Экран приехал лентой страниц: линии и полосы — пустыми до остановки (рисует animateAnalytics). */
function holdAnalytics() {
  if (!motion('ring')) return;
  document.querySelectorAll('#screen .ana-shut').forEach((r) => (r.style.width = '0'));
  document.querySelectorAll('#screen .ana-h').forEach((h) => (h.style.transform = 'scaleY(0)'));
  document.querySelectorAll('#screen .ana-dot, #screen .ana-end').forEach((p) => p.classList.add('ana-hold'));
  // Полосы этого же вида уже залиты (тихое обновление данных) — не прячем
  if (anaBarsKey !== anaKey()) document.querySelectorAll('#screen .ana-clip').forEach((b) => (b.style.clipPath = 'inset(0 100% 0 0)'));
}

/** Вид аналитики: период, отборы и раскрытая группа. */
const anaKey = () => `${sectionsKey()}|${state.ringGroup ?? ''}`;
let anaBarsKey = ''; // вид, полосы которого уже заливаются по строкам (playList)

/**
 * Полосы строки открываются шторкой: этот период (перерасход — тем же движением), прошлый —
 * следом. Анимацией, а не переходом: переходу нужен пересчёт раскладки всей страницы, чтобы
 * начать с закрытой шторки, — на телефоне это заметная пауза при листании
 */
function anaFillRow(row, wait) {
  row.querySelectorAll('.ana-clip').forEach((b) => {
    const delay = wait + (b.parentElement.classList.contains('ana-was') ? ANA_WAS : 0);
    b.style.clipPath = ''; // закрытую шторку до начала держит сама анимация (fill: backwards)
    b.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: `inset(0 ${(100 - Number(b.dataset.w)).toFixed(1)}% 0 0)` }],
      { duration: ANA_FILL, easing: ANA_EASE, delay, fill: 'backwards' });
  });
}

const ANA_SORTS = ['category', 'name', 'sum']; // сортировки строк групп и категорий
const ANA_FILL = 800; // шторка полосы, мс
const ANA_WAS = 150; // прошлый период — следом, с этим сдвигом
const ANA_LINE_STEP = 220; // линии графика: каждая следующая — с этой задержкой
const ANA_EASE = 'cubic-bezier(0.3, 0, 0.2, 1)'; // шторки полос и линий

/** Когда шторка (ANA_EASE) дойдёт до доли пути at: 0–1 от её длительности. */
function anaEaseTime(at) {
  // Кривая Безье с точками (0.3, 0) и (0.2, 1): ищем, где путь дошёл до at, перебором
  const bz = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  for (let k = 0; k <= 100; k++) {
    const u = k / 100;
    if (bz(u, 0, 1) >= at) return bz(u, 0.3, 0.2);
  }
  return 1;
}

/**
 * Линии открываются шторками слева направо — тем же движением, что полосы; точка «сегодня»
 * появляется, когда до неё дошла шторка, кружок конца прогноза — в конце. Полосы заливает
 * playList — каждой строке сразу, как она проявилась; здесь — только если строки не
 * проявлялись (тогда лесенкой).
 */
function animateAnalytics() {
  if (!motion('ring')) return;
  const shuts = [...document.querySelectorAll('#screen [data-shut]')]
    .filter((g) => g.firstElementChild) // пустые (доходов нет) — не ждём
    .map((g) => ({ rect: document.querySelector(`#screen ${g.getAttribute('clip-path').slice(4, -1)} .ana-shut`) }));
  const dot = document.querySelector('#screen .ana-dot');
  const end = document.querySelector('#screen .ana-end');
  const rows = anaBarsKey === anaKey() ? [] : [...document.querySelectorAll('#screen .ana-row')];
  anaBarsKey = anaKey();
  [dot, end].forEach((p) => p?.classList.add('ana-hold'));
  // Порядок в разметке — снизу вверх; рисуются сверху: этот период первым, каждая следующая — позже
  shuts.reverse().forEach(({ rect }, k) => {
    rect.style.width = '';
    rect.animate([{ width: '0px' }, { width: '1000px' }], { duration: ANA_FILL, easing: ANA_EASE, delay: k * ANA_LINE_STEP, fill: 'backwards' });
  });
  // Столбики растут снизу вверх слева направо, прошлый период — чуть позже своего. Масштабом,
  // а не обрезкой: масштаб считает видеокарта, обрезка перерисовывала все столбики каждый кадр
  const cols = [...document.querySelectorAll('#screen .ana-c')];
  cols.forEach((c, k) => c.querySelectorAll('.ana-h').forEach((h) => {
    h.style.transform = '';
    h.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], {
      duration: ANA_FILL * 0.75, easing: ANA_EASE, fill: 'backwards',
      delay: (k / cols.length) * ANA_FILL * 0.6 + (h.classList.contains('ana-h-was') ? ANA_WAS / 2 : 0),
    });
  }));
  rows.forEach((row, k) => anaFillRow(row, 120 + k * 40));
  if (dot) setTimeout(() => dot.classList.remove('ana-hold'), ANA_FILL * anaEaseTime(Number(dot.dataset.at)));
  if (end) setTimeout(() => end.classList.remove('ana-hold'), ANA_FILL);
}

/** Подсказка под пальцем: дата и суммы этого и прошлого периода. */
function anaPoint(clientX) {
  const plot = document.querySelector('#screen .ana-plot');
  if (!plot || !anaTip) return;
  const r = plot.getBoundingClientRect();
  const n = anaTip.ticks.length;
  const frac = (clientX - r.left) / r.width;
  const i = Math.max(0, Math.min(anaTip.cut, anaTip.bars ? Math.floor(frac * n) : Math.round(frac * (n - 1))));
  const px = anaTip.bars ? (i + 0.5) / n : n === 1 ? 0.5 : i / (n - 1);
  const cursor = plot.querySelector('.ana-cursor');
  cursor.setAttribute('x1', px * 1000);
  cursor.setAttribute('x2', px * 1000);
  cursor.classList.add('on');
  const tip = plot.querySelector('.ana-tip');
  tip.innerHTML = `<div class="ana-tip-day">${esc(anaTip.ticks[i])}</div>`
    + `<div><i class="${anaTip.bars ? 'k-col' : 'k-now'}"></i>${esc(anaTip.curName)}<b>${money(anaTip.all[i])}</b></div>`
    + `<div><i class="${anaTip.bars ? 'k-col k-col-prev' : 'k-prev'}"></i>${esc(anaTip.prevName)}<b>${money(anaTip.prev[Math.min(i, anaTip.prev.length - 1)] ?? 0)}</b></div>`
    + (anaTip.inc ? `<div><i class="k-inc"></i>доходы, ${esc(anaTip.curName)}<b>${money(anaTip.inc[i])}</b></div>` : '')
    + (anaTip.incPrev ? `<div><i class="k-inc-prev"></i>доходы, ${esc(anaTip.prevName)}<b>${money(anaTip.incPrev[i] ?? 0)}</b></div>` : '');
  tip.hidden = false;
  // Сбоку от курсора, где больше места, и не за краями графика
  const w = tip.offsetWidth;
  const at = px * r.width;
  const left = px > 0.5 ? at - 12 - w : at + 12;
  tip.style.left = `${Math.max(0, Math.min(r.width - w, left))}px`;
  tip.style.right = '';
}

// Палец на графике ведёт подсказку по дням — в любую сторону, страница под ним не прокручивается
// (у .ana-plot touch-action: none). Остальная карточка листает периоды, как весь экран
let anaScrub = false;
$('screen').addEventListener('touchstart', (e) => {
  anaScrub = state.screen === 'stats' && e.touches.length === 1 && Boolean(e.target.closest('.ana-plot'));
  if (anaScrub) anaPoint(e.touches[0].clientX);
}, { passive: true });
$('screen').addEventListener('touchmove', (e) => {
  if (!anaScrub) return;
  e.preventDefault();
  anaPoint(e.touches[0].clientX);
}, { passive: false });

$('screen').addEventListener('click', (e) => {
  if (state.screen !== 'stats') return null;
  // Группа — её категории; категория — её траты в «Расходе»
  const row = e.target.closest('[data-ana]');
  if (row) {
    const key = row.dataset.ana;
    const one = state.sg && !state.sg.includes(',') && findGroup(state.sg);
    // Группа раскрывается фильтром по ней — тем же, что в листе фильтров: видно, что отобрано, и снимается там же
    if (!one && key !== NONE) return go({ sg: key, ringGroup: '', ringRest: '' });
    return go({ screen: 'summary', mode: 'list', sg: key, ringGroup: '', ringRest: '' });
  }
  if (e.target.closest('.ana-plot')) return anaPoint(e.clientX);
  const step = e.target.closest('[data-ana-step]');
  if (step) return go({ step: step.dataset.anaStep }, true);
  if (e.target.closest('[data-ana-view]')) {
    try {
      localStorage.setItem('checker.anaView', anaView() === 'bars' ? 'line' : 'bars');
    } catch {
      // не запомнится — до перезапуска не переключится
    }
    return go({}, true);
  }
  // Мимо графика — подсказка убирается
  document.querySelector('#screen .ana-tip')?.setAttribute('hidden', '');
  document.querySelector('#screen .ana-cursor')?.classList.remove('on');
  return null;
});

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

// ── съёмка роликов: выделение ────────────────────────────
// Сценарий ролика (scripts/film.mjs — с компьютера, через отладку WebView в эмуляторе) зовёт
// film.spot(…): всё вокруг элемента плавно темнеет, вырез повторяет его форму и едет за ним —
// кольцо заливается, экран листается, а выделение остаётся на месте. Касания проходят насквозь.
// Без вызова ничего не создаётся: люди этого не видят.
// Цель — селектор, элемент или 'text:Питание' (видимый элемент с этим текстом, самый вложенный).
const film = {
  el: null,
  node: null,
  raf: 0,
  find(target) {
    if (target instanceof Element) return target;
    if (typeof target !== 'string') return null;
    if (!target.startsWith('text:')) return document.querySelector(target);
    const text = target.slice(5).trim();
    // Только видимое: у значков кольца есть спрятанные подписи с тем же текстом
    const seen = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== 'hidden';
    };
    const all = [...document.querySelectorAll('#screen *, .tabs *, .quick *, .sheet *, .picker *')]
      .filter((el) => (el.textContent.trim() === text || el.getAttribute('aria-label')?.startsWith(`${text}:`)) && seen(el));
    return all.find((el) => ![...el.children].some((c) => all.includes(c))) ?? null;
  },
  /** Где элемент: центр — для касаний сценария, в пикселях страницы. */
  rect(target) {
    const r = film.find(target)?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, top: r.top, left: r.left } : null;
  },
  // Переезд к новой цели — своей траекторией (FILM_MOVE мс, с замедлением): цель может
  // двигаться (экран выезжает, лента листается), и рамка должна прийти туда, где цель будет,
  // а дальше ехать вместе с ней без отставания. Цель пропала со страницы — затемнение гаснет
  // up — выделить весь блок вокруг найденного (строку, карточку): 'text:…' находит только текст
  spot(target, { pad = 6, radius = null, dim = 0.62, up = null } = {}) {
    // Несколько целей — один вырез вокруг всех (две кнопки рядом)
    const nodes = (Array.isArray(target) ? target : [target]).map((t) => (up ? film.find(t)?.closest(up) : film.find(t)));
    const node = nodes[0];
    if (!node || nodes.some((n) => !n)) return false;
    film.extra = nodes.slice(1);
    if (!film.el) film.build();
    const own = parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0;
    // Откуда едем: где вырез сейчас. Было погашено — «наезд»: вырез сжимается к цели от краёв
    // экрана, пока проступает затемнение. Внезапно выделение не появляется никогда
    film.from = film.el.classList.contains('on') && film.shown ? film.shown : film.full();
    film.at = performance.now();
    film.node = node;
    film.pad = pad;
    film.radius = radius ?? Math.max(10, own + pad);
    film.el.style.setProperty('--film-dim', String(dim));
    film.el.classList.add('on');
    if (!film.raf) film.follow();
    return true;
  },
  // Затемнение — из восьми кусков: четыре полосы вокруг выреза и четыре скругления в его углах.
  // Все двигаются только сдвигом и масштабом: видеокарта делает это без перерисовки. Прежняя
  // огромная тень, меняя размер, перерисовывала весь экран каждый кадр (замер 20.10.2026:
  // 46 кадров вместо 60 в эмуляторе — и рывки в записи)
  build() {
    film.el = document.createElement('div');
    film.el.className = 'film-spot';
    film.el.innerHTML = '<i></i><i></i><i></i><i></i><b></b><b></b><b></b><b></b>';
    document.body.appendChild(film.el);
    film.parts = [...film.el.children];
  },
  draw({ x, y, w, h, r }) {
    const W = innerWidth;
    const H = innerHeight;
    const R = Math.max(0, Math.min(r, w / 2, h / 2));
    const box = (el, bx, by, bw, bh) => {
      el.style.transform = `translate(${bx.toFixed(2)}px, ${by.toFixed(2)}px) scale(${(Math.max(0, bw) / 100).toFixed(4)}, ${(Math.max(0, bh) / 100).toFixed(4)})`;
    };
    const [top, bottom, left, right, ...corners] = film.parts;
    // Полосы заходят друг на друга на пиксель: швов не видно (непрозрачность — у всего слоя)
    box(top, -1, -1, W + 2, y + 1.5);
    box(bottom, -1, y + h - 0.5, W + 2, H - y - h + 1.5);
    box(left, -1, y - 0.5, x + 1.5, h + 1);
    box(right, x + w - 0.5, y - 0.5, W - x - w + 1.5, h + 1);
    // Уголки: квадрат FILM_CORNER с прозрачной четвертью круга, масштаб — под радиус
    const k = (R / FILM_CORNER).toFixed(4);
    const at = [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]];
    corners.forEach((el, i) => {
      const [cx, cy, sx, sy] = at[i];
      el.style.transform = `translate(${cx.toFixed(2)}px, ${cy.toFixed(2)}px) scale(${sx * k}, ${sy * k})`;
    });
  },
  /** Перейти на вкладку без перезагрузки страницы (та остаётся во весь экран): как нажатие. */
  // tapped — как нажатие на остров (капсула перетекает); сценарий сам ставит отметку касания
  tab: (name, extra = {}, tapped = false) => (openTab(name, extra, tapped), true),
  /** Вырез во весь экран (чуть шире краёв): с него начинается наезд. */
  full: () => ({ x: -4, y: -4, w: innerWidth + 8, h: innerHeight + 8, r: 0 }),
  /** Промежуточный вырез: от from к goal, доля t (с замедлением к концу). */
  blend(from, goal, t) {
    const e = 1 - (1 - t) ** 3;
    const mix = (a, b) => a + (b - a) * e;
    return t < 1 ? { x: mix(from.x, goal.x), y: mix(from.y, goal.y), w: mix(from.w, goal.w), h: mix(from.h, goal.h), r: mix(from.r, goal.r) } : goal;
  },
  follow() {
    const now = performance.now();
    const alive = film.node?.isConnected && film.node.getClientRects().length;
    if (film.node && !alive) film.clear(); // элемент исчез — не держать рамку на пустом месте
    if (alive) {
      const rs = [film.node, ...(film.extra ?? [])].map((n) => n.getBoundingClientRect());
      const left = Math.min(...rs.map((x) => x.left));
      const top = Math.min(...rs.map((x) => x.top));
      const r = { left, top, width: Math.max(...rs.map((x) => x.right)) - left, height: Math.max(...rs.map((x) => x.bottom)) - top };
      const p = film.pad;
      const goal = { x: r.left - p, y: r.top - p, w: r.width + p * 2, h: r.height + p * 2, r: film.radius };
      film.shown = film.blend(film.from, goal, Math.min(1, (now - film.at) / FILM_MOVE));
      film.draw(film.shown);
    }
    film.raf = requestAnimationFrame(film.follow);
  },
  // Уход — плавное растворение затемнения: вырез остаётся где был, не расходится к краям
  clear() {
    film.el?.classList.remove('on');
    film.node = null;
  },
};
const FILM_MOVE = 550;

// Отметка касания для роликов (зовёт scripts/film.mjs на каждое касание сценария): касания
// приходят из скрипта, и системное «показывать касания» их не рисует. Небольшой круг под
// пальцем: едет за ним, при отпускании гаснет
film.touch = {
  el: null,
  down(x, y) {
    film.touch.up();
    const el = document.createElement('div');
    el.className = 'film-touch';
    el.style.transform = `translate(${x}px, ${y}px)`;
    document.body.appendChild(el);
    film.touch.el = el;
  },
  move(x, y) {
    if (film.touch.el) film.touch.el.style.transform = `translate(${x}px, ${y}px)`;
  },
  up() {
    const el = film.touch.el;
    if (!el) return;
    film.touch.el = null;
    el.classList.add('off');
    setTimeout(() => el.remove(), 700);
  },
};
const FILM_CORNER = 64;
window.film = film;
