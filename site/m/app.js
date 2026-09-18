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
};

const SCREEN_NAMES = ['summary', 'group', 'category', 'item', 'receipts', 'add', 'manual', 'added'];
const FILTERS = ['all', 'failed', 'pending', 'manual'];
const TOP = ['summary', 'receipts']; // корневые экраны: у них нет «назад», зато есть «+»

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
}

window.addEventListener('popstate', (e) => {
  if (e.state) Object.assign(state, e.state);
  else readUrl();
  render();
});

// ── общие куски экранов ──────────────────────────────────

const loading = () => '<div class="empty">Загрузка…</div>';
const failed = (err) => `<div class="empty error">${esc(err.message)}</div>`;

/** Строка периода: стрелки листают, нажатие на даты открывает календарь. */
const periodNav = () => `
  <div class="month">
    <button class="month-arrow" type="button" data-shift="-1" aria-label="Раньше">‹</button>
    <button class="month-name" type="button" data-period>${UI.calendar}<span>${esc(periodTitle(state.from, state.to))}</span></button>
    <button class="month-arrow" type="button" data-shift="1" aria-label="Позже">›</button>
  </div>`;

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

  const head = `
    ${periodNav()}
    <div class="total">
      <span class="total-sum">${money(data.totals.sum)}</span>
      <span class="total-note">${int.format(data.totals.receipts)} ${plural(data.totals.receipts, 'чек', 'чека', 'чеков')} ·
        ${int.format(data.totals.count)} ${plural(data.totals.count, 'позиция', 'позиции', 'позиций')}</span>
    </div>`;

  if (!data.rows.length) return `${head}<div class="empty">За этот период трат нет</div>`;

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

  const head = `
    <div class="total">
      <span class="total-sum">${money(data.totals.sum)}</span>
      <span class="total-note">${esc(periodTitle(state.from, state.to))} · ${esc(g?.name ?? '')}</span>
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
    from: state.from, to: state.to, collapse: '1', sort: 'sum', dir: 'desc', per: '100',
  });
  if (state.category) params.set('category', state.category);
  else params.set('group', state.group);

  const data = await api(`/api/items?${params}`);
  const name = state.category
    ? findGroup(state.group)?.subcategories.find((s) => s.slug === state.category)?.name
    : findGroup(state.group)?.name;

  const head = `
    <div class="total">
      <span class="total-sum">${money(data.totals.sum)}</span>
      <span class="total-note">${esc(periodTitle(state.from, state.to))} · ${esc(name ?? '')}</span>
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

async function screenItem() {
  const it = await api(`/api/items/${state.item}`);
  const groups = meta?.categories ?? [];
  const subs = groups.find((g) => g.slug === it.group_slug)?.subcategories ?? [];
  const option = (slug, label, selected) =>
    `<option value="${esc(slug)}"${slug === selected ? ' selected' : ''}>${esc(label)}</option>`;

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
      ])}
    </div>

    <div class="card" data-item-card="${it.id}">
      <div class="card-label">Категория</div>
      <select id="pick-group">${option('', '— не выбрана —', it.group_slug ?? '')}${groups
        .map((g) => option(g.slug, g.name, it.group_slug ?? ''))
        .join('')}</select>
      <select id="pick-category">${option('', '— не выбрана —', it.category_slug ?? '')}${subs
        .map((s) => option(s.slug, s.name, it.category_slug ?? ''))
        .join('')}</select>
      <p class="note" id="pick-note">${
        it.same_name_count > 1
          ? `Выбор применится к ${int.format(it.same_name_count)} ${plural(it.same_name_count, 'позиции', 'позициям', 'позициям')} с таким же названием`
          : 'Это название встречается только здесь'
      }</p>
    </div>`;
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
      ? `${chips}${hint}<div class="list">${scans.jobs.map(jobRow).join('')}</div>`
      : `${chips}<div class="empty">${f === 'failed' ? 'Сканов с ошибкой нет' : 'Очередь пуста'}</div>`;
  }

  receiptsPage = 1;
  lastDay = '';
  const data = await api(`/api/receipts?${receiptsQuery(1)}`);
  // В общем списке застрявшие сканы — те, что попадают в период
  const stuck = f === 'all'
    ? scans.jobs.filter((j) => j.purchased_at.slice(0, 10) >= state.from && j.purchased_at.slice(0, 10) <= state.to)
    : [];

  const head = `
    ${chips}
    ${periodNav()}
    <div class="total">
      <span class="total-sum">${money(data.totals.sum)}</span>
      <span class="total-note">${int.format(data.totals.count)} ${plural(data.totals.count, 'чек', 'чека', 'чеков')}${
        data.totals.excluded_count ? ` · ${int.format(data.totals.excluded_count)} вне суммы` : ''
      }</span>
    </div>`;

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
  const badge = $('tab-badge');
  badge.hidden = !count;
  badge.textContent = count > 99 ? '99+' : String(count ?? '');
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
          <button class="btn" data-close type="button">Закрыть</button>
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
            <button class="btn danger" type="button" data-delete${busy ? ' disabled' : ''}>Удалить скан</button>
          </div>` : ''}
      </div>`;
  };

  sheet.addEventListener('click', async (e) => {
    if (e.target === sheet || e.target.closest('[data-close]')) return close();

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
async function screenAdded() {
  const receipt = await api(`/api/receipts/${state.added}`);
  const manual = receipt.fiscal_drive === 'manual';
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
  return `
    <form class="card form" id="manual-form" novalidate>
      <label class="field">
        <span>Сумма, ₽</span>
        <input id="m-sum" class="sum-input" inputmode="decimal" autocomplete="off" placeholder="0" required />
      </label>
      <label class="field">
        <span>Что купили</span>
        <input id="m-name" type="text" maxlength="200" autocomplete="off" placeholder="Необязательно" />
      </label>
      <label class="field">
        <span>Дата</span>
        <input id="m-date" type="date" value="${today}" max="${today}" required />
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
  const time = date === isoDay(now) ? `${pad(now.getHours())}:${pad(now.getMinutes())}` : '12:00';

  $('m-save').disabled = true;
  note.classList.remove('error');
  note.textContent = 'Записываем…';
  try {
    const saved = await post('/api/manual', { sum, date, time, name: $('m-name').value, category: manualCategory });
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
 * Нажатие на строку открывает выбор — цель шире, чем один значок.
 */
function sheetRow(item) {
  const group = findGroup(item.group_slug);
  const color = group?.color ?? '#eef1f5';
  // Значок в кольце — категорию предложила модель, сплошной — выбрал человек
  const human = item.category_source === 'manual' || item.category_source === 'pinned';
  const guess = item.category_slug && !human ? ' guess' : '';

  return `
    <button class="sheet-row${guess}" type="button" data-row="${item.id}" data-pick="${item.id}">
      <span class="pick-ic" style="background:${color};color:${readableText(color)}">${groupIcon(group?.icon ?? 'none')}</span>
      <span class="sheet-main">
        <span class="sheet-name">${esc(item.name)}</span>
        <span class="sheet-cat">${esc(item.category_name ?? 'выбрать категорию')}</span>
      </span>
      <span class="sheet-sum">${money(item.sum, true)}</span>
    </button>`;
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

  const showGroups = () => {
    picker.innerHTML = `
      <div class="picker-box" role="dialog" aria-label="Выбор группы">
        <div class="picker-top"><span>Группа</span><button class="btn" data-close type="button">Отмена</button></div>
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
          <span>${esc(group.name)}</span>
          <button class="btn" data-close type="button">Отмена</button>
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

async function openReceiptSheet(receiptId) {
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
          <div class="note">${esc(manual ? 'Записано вручную' : sellerName(receipt))} · ${dateRu(receipt.purchased_at)} ${esc(timeRu(receipt.purchased_at))}</div>
        </div>
        <button class="btn" data-close type="button">Готово</button>
      </div>
      <p class="note sheet-hint">${
        unknown
          ? `${int.format(unknown)} ${plural(unknown, 'позиция', 'позиции', 'позиций')} без категории — выберите вручную`
          : manual
            ? 'Нажмите на строку, чтобы сменить категорию'
            : 'Категории проставлены автоматически. Если ошиблись — поправьте'
      }</p>
      <div class="sheet-list">${receipt.items.map(sheetRow).join('')}</div>
      ${manual ? '<div class="sheet-actions"><button class="btn danger" type="button" data-remove>Удалить запись</button></div>' : ''}
    </div>`;

  document.body.appendChild(sheet);

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

    // Нажатие на строку открывает выбор; сохранение — уже по возврату
    const pick = e.target.closest('[data-pick]');
    if (pick) openCategoryPicker(Number(pick.dataset.pick), saveCategory);
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
    actions: () => `
      <button class="btn primary big" type="button" data-screen="add">Добавить ещё</button>
      <button class="btn big" type="button" data-back-home>Вернуться</button>`,
  },
  group: { title: () => findGroup(state.group)?.name ?? 'Группа', render: screenGroup },
  category: { title: 'Позиции', render: screenCategory },
  item: { title: 'Товар', render: screenItem },
};

// Какая вкладка горит: вглубь расходов — «Расходы», добавление — ни одна
const TAB_OF = { summary: 'summary', group: 'summary', category: 'summary', item: 'summary', receipts: 'receipts' };

let renderSeq = 0;

async function render() {
  const seq = ++renderSeq;
  closeScanner(); // уходим с экрана (в том числе кнопкой «назад») — камера гаснет
  const screen = SCREENS[state.screen] ?? SCREENS.summary;
  const top = TOP.includes(state.screen);

  $('title').textContent = typeof screen.title === 'function' ? screen.title() : screen.title;
  $('back').hidden = top;
  $('fab').hidden = !top;

  const actions = screen.actions?.() ?? '';
  $('actions').innerHTML = actions;
  $('actions').hidden = !actions;
  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.classList.toggle('on', tab.dataset.tab === TAB_OF[state.screen]);
  }
  $('screen').innerHTML = loading();
  $('screen').scrollTop = 0;

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

  const shift = e.target.closest('[data-shift]');
  if (shift) return go(shiftPeriod(state.from, state.to, Number(shift.dataset.shift)), true);

  if (e.target.closest('[data-period]')) return openPeriodPicker();

  const filter = e.target.closest('[data-filter]');
  if (filter) return go({ filter: filter.dataset.filter }, true);

  const group = e.target.closest('[data-group]');
  if (group) return go({ screen: 'group', group: group.dataset.group, category: '' });

  const category = e.target.closest('[data-category]');
  if (category) return go({ screen: 'category', category: category.dataset.category });

  const item = e.target.closest('[data-item]');
  if (item) return go({ screen: 'item', item: item.dataset.item });

  if (e.target.closest('[data-scanner]')) return openScanner();

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

// Смена категории: группа перезаполняет второй список, выбор категории сохраняет
$('screen').addEventListener('change', async (e) => {
  const card = e.target.closest('[data-item-card]');
  if (!card) return;

  if (e.target.id === 'pick-group') {
    const subs = findGroup(e.target.value)?.subcategories ?? [];
    $('pick-category').innerHTML =
      '<option value="">— не выбрана —</option>' +
      subs.map((s) => `<option value="${esc(s.slug)}">${esc(s.name)}</option>`).join('');
    return;
  }

  if (e.target.id !== 'pick-category') return;
  const note = $('pick-note');
  note.textContent = 'Сохранение…';
  try {
    const data = await post(`/api/items/${card.dataset.itemCard}/category`, { category: e.target.value });
    note.textContent = data.category
      ? `«${data.category.name}» — обновлено ${int.format(data.affected)} ${plural(data.affected, 'позиция', 'позиции', 'позиций')}`
      : `Категория снята, затронуто ${int.format(data.affected)}`;
    meta = await api('/api/meta'); // счётчики и цвета могли измениться
  } catch (err) {
    note.textContent = `Не удалось сохранить: ${err.message}`;
    note.classList.add('error');
  }
});

$('back').addEventListener('click', () => history.back());
$('fab').addEventListener('click', () => go({ screen: 'add' }));

// Вкладка сбрасывает глубину, но не период: переключение не должно терять выбор дат
document.querySelector('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) go({ screen: tab.dataset.tab, group: '', category: '', item: '' });
});

$('logout').addEventListener('click', async () => {
  if (!confirm('Выйти из аккаунта на этом устройстве?')) return;
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  token.clear();
  location.reload();
});

// ── запуск ───────────────────────────────────────────────

function showLogin(note) {
  $('login').hidden = false;
  $('app').hidden = true;
  $('login-note').textContent = note ?? 'Внутри личные чеки';
  $('login-note').classList.toggle('error', Boolean(note));
}

async function start() {
  $('login').hidden = true;
  $('app').hidden = false;
  $('logout').innerHTML = UI.logout;
  $('tab-summary-ic').innerHTML = UI.wallet;
  $('tab-receipts-ic').innerHTML = UI.receipt;
  meta = await api('/api/meta');

  // Пустой месяц на старте — не повод показывать ноль: открываем последний с данными
  const p = new URLSearchParams(location.search);
  if (!p.get('from') && !p.get('month') && meta.stats.date_to) {
    const last = parseDay(meta.stats.date_to.slice(0, 10));
    Object.assign(state, monthPeriod(last.getFullYear(), last.getMonth()));
  }
  go({}, true);

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
