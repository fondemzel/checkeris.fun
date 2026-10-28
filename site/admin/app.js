// Админка — центр управления и наблюдения (api/src/admin.mjs). Раскладка — как настройки
// GitHub: слева меню разделов с группами, справа раздел; адрес раздела — в #/…, поэтому
// «назад» в браузере и ссылки на человека работают.
//
// С кабинетом и приложением не связана: свой вход (Telegram или пароль администратора) и свой
// токен (checker.admin-token) — выход из кабинета её не трогает, и наоборот. Вход через Telegram
// с пометкой client = admin сервер пускает только к администратору и аккаунтов не заводит.
import { TG_ICON, keepLinkReady, markWaiting, pendingLogin, forgetLogin, waitLogin } from '/shared/tglogin.js';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'checker.admin-token';
const THEME_KEY = 'checker.admin-theme';
// Значок чека — тот же, что в шапке (index.html) и у приложения
const LOGO = document.querySelector('.head .logo').outerHTML;
const SITE = location.origin;

const token = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (v) => {
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* без хранилища вход проживёт до перезагрузки */
    }
  },
};

// ── форматирование ───────────────────────────────────────

const int = new Intl.NumberFormat('ru-RU');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Год — только у прошлых лет: «12 окт.», но «12 окт. 2025 г.»
const dateRu = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const year = d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year });
};
const dateTimeRu = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const dayRu = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
const monthRu = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

const plural = (n, one, few, many) => {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
};

/** «только что», «3 ч назад», «вчера», «5 дн назад». */
function ago(iso) {
  if (!iso) return 'никогда';
  const ms = Date.now() - Date.parse(iso);
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) {
    const h = Math.floor(ms / 3_600_000);
    return h < 1 ? 'только что' : `${h} ч назад`;
  }
  return days === 1 ? 'вчера' : `${days} дн назад`;
}
const daysSince = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 86_400_000 : Infinity);

const BANKS = { tbank: 'Т-Банк', sber: 'Сбер', ozon: 'Озон', wb: 'Wildberries' };
// Логотипы — те же, что в приложении (site/shared/brand)
const LOGOS = { tbank: '/shared/brand/tbank.png', sber: '/shared/brand/sber.svg', ozon: '/shared/brand/ozon.svg', wb: '/shared/brand/wb.svg' };
// device — подключение на телефоне: операции присылает приложение, сессии на сервере нет
const LINK_STATUS = { active: 'работает', device: 'с телефона', expired: 'отвалился', demo: 'демо' };
const SCAN_STATUS = { new: 'в очереди', sent: 'ждёт ФНС', done: 'готов', failed: 'с ошибкой' };
const bankName = (b) => BANKS[b] ?? b;
// withBank=false — в таблице, где банк уже стоит своей колонкой
const linkLabel = (l, withBank = true) =>
  `<span class="label ${HEALTH_CLS[l.health] ?? ''}">${withBank ? `${esc(bankName(l.bank))} · ` : ''}${esc(l.health_text ?? LINK_STATUS[l.status] ?? l.status)}</span>`;

// Состояние подключения (health с сервера): цвет точки и метки
const HEALTH_CLS = { ok: 'ok', warn: 'warn', bad: 'bad', idle: '' };
const WORST = { bad: 3, warn: 2, ok: 1, idle: 0 };

/** Строка подсказки про одно подключение: чьё, что с ним, когда обновлялось. */
const linkLine = (l, who = true) =>
  [who && l.person, l.health_text, l.synced_at ? `обновлялся ${ago(l.synced_at)}` : 'не обновлялся', l.error].filter(Boolean).join(' · ');

/**
 * Подключение значком: логотип банка или магазина, состояние — точкой в углу. Банк подключён у
 * нескольких в бюджете — один значок, точка — по худшему, в подсказке — по строке на каждого.
 */
const linkIcon = (bank, links) => {
  const worst = links.reduce((w, l) => (WORST[l.health] > WORST[w] ? l.health : w), 'idle');
  const tip = `${bankName(bank)}\n${links.map((l) => linkLine(l, links.length > 1 || Boolean(l.person))).join('\n')}`;
  const pic = LOGOS[bank] ? `<img src="${LOGOS[bank]}" alt="" />` : `<b>${esc(bankName(bank).slice(0, 1).toUpperCase())}</b>`;
  return `<span class="bank-ic st-${worst}" title="${esc(tip)}" aria-label="${esc(tip)}">${pic}</span>`;
};
const linkIcons = (links) => {
  const byBank = new Map();
  for (const l of links) byBank.set(l.bank, [...(byBank.get(l.bank) ?? []), l]);
  return `<span class="bank-icons">${[...byBank].map(([bank, ls]) => linkIcon(bank, ls)).join('')}</span>`;
};

const channelName = (slug) =>
  slug === 'direct' ? 'Напрямую' : slug === 'invite' ? 'По приглашению' : state.names.get(slug) || slug;
const initials = (name) =>
  String(name ?? '?').replace(/^@/, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

// Значки меню: контурные, 24×24
const ICON = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  bank: '<path d="M3 22h18"/><path d="M6 18v-7"/><path d="M10 18v-7"/><path d="M14 18v-7"/><path d="M18 18v-7"/><path d="M12 2 20 7H4z"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

// ── API ──────────────────────────────────────────────────

async function api(path, options = {}) {
  const t = token.get();
  if (!t) throw Object.assign(new Error('нужен вход'), { status: 401 });
  const res = await fetch(path, {
    ...options,
    headers: { authorization: `Bearer ${t}`, ...(options.body ? { 'content-type': 'application/json' } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

// ── состояние ────────────────────────────────────────────

const state = {
  data: null,
  names: new Map(),
  person: null,
  sort: { users: { key: 'created_at', dir: -1 }, links: { key: 'synced_at', dir: -1 } },
  filter: { q: '', channel: '', activity: '', plan: '' },
  selBudget: null, // «Пользователи»: выбранная строка — её кратко показывает правая панель
};

// ── части страницы ───────────────────────────────────────

const subhead = (title, actions = '') =>
  `<div class="subhead"><h2>${esc(title)}</h2>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
const box = (title, body, { end = '', foot = '', cls = '' } = {}) =>
  `<div class="box ${cls}">${title ? `<div class="box-head">${title}${end ? `<span class="end">${end}</span>` : ''}</div>` : ''}${body}${foot ? `<div class="box-foot">${foot}</div>` : ''}</div>`;
const stat = (label, num, note = '', href = '') => {
  const inner = `<div class="stat-label">${esc(label)}</div><div class="stat-num">${typeof num === 'number' ? int.format(num) : num}</div>${note ? `<div class="stat-note">${note}</div>` : ''}`;
  return `<div class="stat">${href ? `<a href="${href}">${inner}</a>` : inner}</div>`;
};
const blank = (text) => `<div class="blank">${esc(text)}</div>`;

/**
 * Таблица с сортировкой по щелчку на заголовок. cols: { key, label, value(row) для сортировки,
 * cell(row) — разметка, r — по правому краю }. href(row) — строка ведёт на страницу.
 */
function table(id, cols, rows, { href = null, select = null, selected = null, empty = 'Пусто' } = {}) {
  const sort = state.sort[id];
  if (sort) {
    const col = cols.find((c) => c.key === sort.key);
    if (col) {
      const v = col.value ?? ((r) => r[col.key]);
      rows = [...rows].sort((a, b) => {
        const x = v(a);
        const y = v(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1; // пустые — всегда в конце
        if (y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
      });
    }
  }
  const head = cols
    .map((c) => {
      const sorted = sort && sort.key === c.key ? ` aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : '';
      return `<th class="${sort && c.sort !== false ? 'sortable' : ''}${c.r ? ' r' : ''}" data-sort="${sort && c.sort !== false ? `${id}:${c.key}` : ''}"${sorted}>${esc(c.label)}</th>`;
    })
    .join('');
  const body = rows
    .map((r) => `<tr${select ? ` class="link${select(r) === selected ? ' sel' : ''}" data-select="${select(r)}" data-open="${esc(href?.(r) ?? '')}"` : href ? ` class="link" data-href="${esc(href(r))}"` : ''}>${cols.map((c) => `<td class="${c.r ? 'r' : ''}${c.nw ? ' nw' : ''}">${c.cell ? c.cell(r) : esc(r[c.key] ?? '—')}</td>`).join('')}</tr>`)
    .join('');
  return rows.length
    ? `<div class="table-wrap"><table class="t"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
    : blank(empty);
}

/** Столбики по дням: один ряд — один цвет, значение — в подсказке. */
function columns(days, key, label) {
  const max = Math.max(1, ...days.map((d) => d[key]));
  const total = days.reduce((s, d) => s + d[key], 0);
  const cols = days
    .map((d) => {
      const v = d[key];
      return `<div class="col${v ? '' : ' zero'}" data-tip="${esc(`${dayRu(d.day)}: ${v} ${plural(v, 'человек', 'человека', 'человек')}`)}"><i style="height:${(v / max) * 100}%"></i></div>`;
    })
    .join('');
  const sub = key === 'joined' ? `всего <b>${total}</b>` : `в среднем <b>${Math.round(total / days.length)}</b> в день`;
  return `<div><div class="chart-head"><span><b>${esc(label)}</b></span><span>${sub}</span></div>
    <div class="cols">${cols}</div>
    <div class="axis"><span>${dayRu(days[0].day)}</span><span>сегодня</span></div></div>`;
}

/** Дни, когда человек заходил, — сетка недель (понедельник сверху), как вклады на GitHub. */
function dayGrid(activeDays, span = 91) {
  const on = new Set(activeDays);
  const today = new Date();
  const start = new Date(today.getTime() - (span - 1) * 86_400_000);
  const pad = (start.getUTCDay() + 6) % 7;
  let cells = '<span class="day pad"></span>'.repeat(pad);
  for (let i = 0; i < span; i += 1) {
    const day = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    cells += `<span class="day${on.has(day) ? ' on' : ''}" data-tip="${esc(`${dayRu(day)}: ${on.has(day) ? 'заходил' : 'не заходил'}`)}"></span>`;
  }
  return `<div class="days">${cells}</div>
    <div class="legend">не заходил <span class="day"></span> <span class="day on"></span> заходил</div>`;
}

const meterCls = (share) => (share >= 0.9 ? 'bad' : share >= 0.7 ? 'warn' : '');

// ── разделы ──────────────────────────────────────────────

const PAGES = [
  { group: 'Наблюдение' },
  { id: 'overview', title: 'Обзор', icon: 'home' },
  { id: 'users', title: 'Пользователи', icon: 'people', count: (d) => d.budgets.length },
  { id: 'people', title: 'Человек', hidden: true, under: 'users' }, // страница участника — из бюджета
  { id: 'sources', title: 'Каналы прихода', icon: 'link' },
  { id: 'support', title: 'Поддержка', icon: 'chat', count: (d) => d.support_waiting || null, bad: true },
  { group: 'Система' },
  { id: 'load', title: 'Нагрузка', icon: 'gauge' },
  { id: 'links', title: 'Подключения', icon: 'bank', count: (d) => brokenLinks(d).length || null, bad: true },
  { id: 'errors', title: 'Ошибки', icon: 'alert', count: (d) => d.load.scan_errors.reduce((s, e) => s + e.n, 0) || null, bad: true },
];

const allLinks = (d) => d.people.flatMap((u) => u.banks.map((b) => ({ ...b, person: u })));
const brokenLinks = (d) => allLinks(d).filter((l) => l.health === 'bad'); // нужен вход заново
const silent = (d) => d.people.filter((u) => !u.receipts && !u.manual && !u.banks.length && daysSince(u.created_at) >= 1);

function renderNav(current) {
  const lit = PAGES.find((p) => p.id === current)?.under ?? current; // страница участника — подсветить «Пользователи»
  $('nav').innerHTML = PAGES.map((p) => {
    if (p.hidden) return '';
    if (p.group) return `<div class="nav-group">${esc(p.group)}</div>`;
    const n = p.count?.(state.data);
    const counter = n ? `<span class="counter${p.bad ? ' bad' : ''}">${int.format(n)}</span>` : '';
    return `<a class="nav-item" href="#/${p.id}"${p.id === lit ? ' aria-current="page"' : ''}>${icon(p.icon)}${esc(p.title)}${counter}</a>`;
  }).join('');
}

function pageOverview(d) {
  const t = d.totals;
  const stats = `<div class="box"><div class="stats">
      ${stat('Людей', t.people, `+${t.joined_today} сегодня`, '#/users')}
      ${stat('Новых за 7 дней', t.joined_7)}
      ${stat('Заходили сегодня', t.active_today)}
      ${stat('Заходили за 7 дней', t.active_7, t.people ? `${Math.round((t.active_7 / t.people) * 100)}% от всех` : '')}
      ${stat('Заходили за 30 дней', t.active_30)}
      ${stat('Внесли чеки или траты', t.with_receipts)}
      ${stat('Подключили банк', t.with_bank, '', '#/links')}
      ${stat('Платные тарифы', d.plans.plus + d.plans.premium, `Премиум ${d.plans.premium} · Плюс ${d.plans.plus} · бесплатно ${d.plans.free}`, '#/users')}
    </div></div>`;
  const charts = box(
    'Активность за 30 дней',
    `<div class="box-body charts">${columns(d.days, 'active', 'Заходили в приложение')}${columns(d.days, 'joined', 'Зарегистрировались')}</div>`,
    { foot: 'Заходил — открыл приложение или кабинет хотя бы раз за день. Отметки пишутся с версии 0.61.0.' },
  );

  // «Требует внимания» — в правой колонке «Сейчас» (nowPanel): на всех страницах, не только здесь
  const top = d.sources.slice(0, 6);
  const channels = box(
    'Каналы прихода',
    top.length
      ? top.map((s) => `<div class="box-row"><div class="grow">${esc(channelName(s.slug))}</div><span class="muted">пользуются ${s.used}</span><b class="num">${s.people}</b></div>`).join('')
      : blank('Пока никого'),
    { end: '<a href="#/sources">Все каналы</a>' },
  );
  const fresh = box(
    'Новые пользователи',
    d.budgets.slice(0, 5).map((b) => `<div class="box-row"><span class="avatar sm">${esc(initials(b.owner.name))}</span><div class="grow"><a href="#/users/${b.id}">${esc(b.owner.name)}</a> <span class="muted">· ${esc(channelName(b.owner.channel))}</span></div>${planLabel(b.plan)}<span class="muted">${esc(dateRu(b.created_at))}</span></div>`).join('') || blank('Пока никого'),
    { end: '<a href="#/users">Все пользователи</a>' },
  );
  return subhead('Обзор') + stats + charts + `<div class="grid2">${channels}${fresh}</div>`;
}

const ACTIVITY = {
  '': 'Все',
  week: 'Заходили за 7 дней',
  gone: 'Не заходят 7+ дней',
  silent: 'Ничего не внесли',
  bank: 'С банком',
  shared: 'Семья (несколько человек)',
  demo: 'Сейчас в демо',
};
const PLAN_FILTER = { '': 'Все тарифы', free: 'Бесплатно', plus: 'Плюс', premium: 'Премиум' };

/** Тариф меткой: Премиум — золотистый, Плюс — синий, Бесплатно — серый; ниже — откуда и до когда. */
function planLabel(p, { sub = false } = {}) {
  const tag = `<span class="label plan-${p.id}">${esc(p.title)}</span>`;
  if (!sub) return tag;
  const note = p.expired
    ? `закончился ${dateRu(p.until)}`
    : [p.label_title, p.id === 'free' ? '' : p.until ? `до ${dateRu(p.until)}` : 'навсегда'].filter(Boolean).join(' · ');
  return `${tag}${note ? `<div class="sub${p.expired ? ' warn-t' : ''}">${esc(note)}</div>` : ''}`;
}

function filterBudgets(list) {
  const { q, channel, activity, plan } = state.filter;
  const needle = q.trim().toLowerCase();
  return list.filter((b) => {
    const hay = [b.owner.name, b.owner.tg_username, b.owner.email, channelName(b.owner.channel), b.owner.invited_by, ...b.members.map((m) => m.name)];
    if (needle && !hay.some((v) => String(v ?? '').toLowerCase().includes(needle))) return false;
    if (channel && b.owner.channel !== channel) return false;
    if (plan && b.plan.id !== plan) return false;
    if (activity === 'week' && daysSince(b.last_seen) > 7) return false;
    if (activity === 'gone' && daysSince(b.last_seen) <= 7) return false;
    if (activity === 'silent' && (b.receipts || b.manual || b.banks.length || daysSince(b.created_at) < 1)) return false;
    if (activity === 'bank' && !b.banks.length) return false;
    if (activity === 'shared' && b.members.length < 2) return false;
    if (activity === 'demo' && !b.in_demo) return false;
    return true;
  });
}

const dash = '<span class="muted">—</span>';
const USER_COLS = [
  {
    key: 'name',
    label: 'Пользователь',
    value: (b) => b.owner.name.toLowerCase(),
    // Не больше трёх строк — строка таблицы фиксированной высоты: имя, один контакт (@ник или
    // почта), семья. Остальное — в правой панели
    cell: (b) => `<div class="one"><a class="who" href="#/users/${b.id}">${esc(b.owner.name)}</a>${b.admin ? ' <span class="label accent">администратор</span>' : ''}</div>`
      + `${b.owner.tg_username || b.owner.email ? `<div class="sub one">${esc(b.owner.tg_username ? `@${b.owner.tg_username}` : b.owner.email)}</div>` : ''}`
      + `${b.members.length > 1 ? `<div class="sub one">семья · ${b.members.length} ${plural(b.members.length, 'человек', 'человека', 'человек')}</div>` : ''}`,
  },
  { key: 'plan', label: 'Тариф', nw: true, value: (b) => ({ free: 0, plus: 1, premium: 2 })[b.plan.id], cell: (b) => planLabel(b.plan, { sub: true }) },
  {
    key: 'created_at',
    label: 'Пришёл',
    nw: true,
    cell: (b) => `${esc(dateRu(b.created_at))}<div class="sub">${esc(b.owner.channel === 'invite' && b.owner.invited_by ? `приглашён: ${b.owner.invited_by}` : channelName(b.owner.channel))}</div>`,
  },
  { key: 'last_seen', label: 'Заходили', nw: true, cell: (b) => esc(ago(b.last_seen)) },
  { key: 'active_days', label: 'Дней из 30', r: true, cell: (b) => String(b.active_days) },
  // Вручную и сканы — в панели и на странице бюджета: рядом с панелью таблица должна помещаться
  { key: 'receipts', label: 'Чеки', r: true, cell: (b) => (b.receipts ? int.format(b.receipts) : dash) },
  {
    key: 'banks',
    label: 'Подключения',
    value: (b) => b.banks.length,
    cell: (b) => {
      if (!b.banks.length && !b.in_demo) return dash;
      return `${b.banks.length ? linkIcons(b.banks) : ''}${b.in_demo ? ' <span class="label">в демо</span>' : ''}`;
    },
  },
];

function usersBox(list, all) {
  if (!list.some((b) => b.id === state.selBudget)) state.selBudget = list[0]?.id ?? null;
  return box(`${int.format(list.length)} ${plural(list.length, 'пользователь', 'пользователя', 'пользователей')}${list.length !== all ? ` <span class="muted">из ${all}</span>` : ''}`,
    `<div class="users-t">${table('users', USER_COLS, list, { select: (b) => b.id, selected: state.selBudget, href: (b) => `#/users/${b.id}`, empty: 'Никого не нашлось' })}</div>`);
}

/** Правая панель: выбранный пользователь кратко. Подробно — страница бюджета. */
function userPanel(b) {
  if (!b) return box('Пользователь', blank('Выберите строку'));
  const row = (k, v) => `<div class="pp-row"><span class="muted">${esc(k)}</span><span>${v}</span></div>`;
  const members = b.members
    .map((m) => `<a href="#/people/${m.id}">${esc(m.name)}</a>${m.owner && b.members.length > 1 ? ' <span class="muted">(владелец)</span>' : ''}`)
    .join('<br>');
  return `<div class="box"><div class="pp-head"><span class="avatar">${esc(initials(b.owner.name))}</span><div>
      <div class="pp-name">${esc(b.owner.name)}</div>
      <div class="muted">${esc([b.owner.tg_username && `@${b.owner.tg_username}`, b.owner.email].filter(Boolean).join(' · ') || 'без Telegram и почты')}</div>
    </div></div>
    <div class="pp-body">
      ${row('Тариф', planLabel(b.plan, { sub: true }))}
      ${row(b.members.length > 1 ? `Семья · ${b.members.length}` : 'Участник', members)}
      ${row('Пришёл', `${esc(dateRu(b.created_at))}<div class="sub">${esc(channelName(b.owner.channel))}</div>`)}
      ${row('Заходили', `${esc(ago(b.last_seen))}<div class="sub">${b.active_days} ${plural(b.active_days, 'день', 'дня', 'дней')} из 30</div>`)}
      ${row('Внесено', esc([b.receipts && `чеков ${int.format(b.receipts)}`, b.manual && `вручную ${int.format(b.manual)}`, b.scans && `сканов ${int.format(b.scans)}`, b.bank_ops && `операций банка ${int.format(b.bank_ops)}`].filter(Boolean).join(', ') || 'ничего'))}
      ${row('Подключения', b.banks.length ? linkIcons(b.banks) : dash)}
    </div>
    <div class="pp-foot"><a class="btn sm" href="#/users/${b.id}">Открыть бюджет →</a></div></div>`;
}

function pageUsers(d) {
  const list = filterBudgets(d.budgets);
  const channels = [...new Set(d.budgets.map((b) => b.owner.channel))];
  const opts = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
  const filters = `<div class="filters">
      <input class="input" type="search" id="f-q" placeholder="Найти: имя, @ник, почта, канал" value="${esc(state.filter.q)}" />
      <select class="input" id="f-channel"><option value="">Все каналы</option>${channels.map((c) => `<option value="${esc(c)}"${c === state.filter.channel ? ' selected' : ''}>${esc(channelName(c))}</option>`).join('')}</select>
      <select class="input" id="f-plan">${opts(PLAN_FILTER, state.filter.plan)}</select>
      <select class="input" id="f-activity">${opts(ACTIVITY, state.filter.activity)}</select>
    </div>`;
  const table = usersBox(list, d.budgets.length);
  return subhead('Пользователи')
    + '<p class="lead">Бюджеты, которыми пользуются, — по владельцу; семья — внутри бюджета. Щелчок по строке — кратко справа, по имени или Enter — страница бюджета. Только служебное: без сумм и покупок. Администратор — в списке, но не в подсчётах.</p>'
    + filters
    + `<div id="users-table">${table}</div>`;
}

function rerenderUsers() {
  const d = state.data;
  const list = filterBudgets(d.budgets);
  const wrap = $('users-table');
  if (!wrap) return;
  wrap.innerHTML = usersBox(list, d.budgets.length);
  $('panel-col').innerHTML = userPanel(d.budgets.find((b) => b.id === state.selBudget));
}

/** «Сейчас» — правая колонка на страницах без своей панели: главное числами, каждое ведёт в раздел. */
function nowPanel(d) {
  const t = d.totals;
  const share = d.load.fns.today / d.load.fns.limit;
  const broken = brokenLinks(d).length;
  const errors = d.load.scan_errors.reduce((sum, e) => sum + e.n, 0);
  const row = (href, k, v, cls = '', attrs = '') => `<a class="now-row" href="${href}"${attrs}><span>${esc(k)}</span><span class="label ${cls}">${v}</span></a>`;
  const quiet = silent(d).length;
  return `<div class="box"><div class="box-head">Сейчас</div>
    <div class="now-body">
      ${row('#/users', 'Заходили сегодня', `${t.active_today} из ${t.people}`)}
      <a class="now-row" href="#/load"><span>ФНС сегодня</span><span class="num muted">${d.load.fns.today} из ${d.load.fns.limit}</span></a>
      <div class="meter ${meterCls(share)} now-meter"><i style="width:${Math.min(100, share * 100)}%"></i></div>
      ${row('#/support', 'Ждут ответа', d.support_waiting, d.support_waiting ? 'bad' : 'ok')}
      ${row('#/links', 'Нужен вход в банк', broken, broken ? 'bad' : 'ok')}
      ${row('#/errors', 'Сканы с ошибкой за 7 дней', errors, errors ? 'warn' : 'ok')}
      ${row('#/users', 'Пришли и ничего не внесли', quiet, quiet ? 'warn' : 'ok', ' data-activity="silent"')}
      ${row('#/users', 'Платные тарифы', d.plans.plus + d.plans.premium)}
    </div></div>`;
}

/** Страница бюджета: тариф (сменить), участники, активность, внесено, подключения, обращения. */
function pageBudget(b) {
  if (!b) return '<a class="back" href="#/users">← Пользователи</a>' + blank('Нет такого бюджета');
  const head = `<a class="back" href="#/users">← Пользователи</a>
    <div class="person-head"><span class="avatar">${esc(initials(b.owner.name))}</span><div>
      <div class="person-name">${esc(b.owner.name)}${b.admin ? ' <span class="label accent">администратор</span>' : ''}</div>
      <div class="muted">бюджет «${esc(b.name)}» · с ${esc(dateRu(b.created_at))} · ${esc(channelName(b.owner.channel))}</div>
    </div></div>`;
  const stats = `<div class="box"><div class="stats">
      ${stat('Заходили', esc(ago(b.last_seen)))}
      ${stat('Дней из 30', b.active_days)}
      ${stat('Чеков', b.receipts, b.manual ? `и ${b.manual} вручную` : '')}
      ${stat('Операций банка', b.bank_ops)}
    </div></div>`;
  const p = b.plan;
  const planBox = box('Тариф', `<form class="box-body plan-form" id="plan-form" data-id="${b.id}">
      <div class="plan-now">${planLabel(p, { sub: true })}</div>
      <label class="field">Тариф<select class="input" name="plan">${b.plans.map((x) => `<option value="${x.id}"${x.id === (p.was ?? p.id) ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}</select></label>
      <label class="field">Откуда<select class="input" name="label"><option value="">—</option>${Object.entries(b.labels).map(([k, v]) => `<option value="${k}"${k === p.label ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label class="field">До<input class="input" type="date" name="until" value="${esc(p.until ?? '')}" /><span class="note">пусто — навсегда</span></label>
      <button class="btn primary" type="submit">Сохранить</button>
    </form>`, { foot: 'Оплаты пока нет — тариф меняется здесь. Срок прошёл — бюджет на «Бесплатно», данные не трогаются.' });
  const members = box(`Участники · ${b.people.length}`, b.people
    .map((m) => `<div class="box-row"><span class="avatar sm">${esc(initials(m.name))}</span><div class="grow"><a href="#/people/${m.id}">${esc(m.name)}</a>${m.id === b.owner.id ? ' <span class="label">владелец</span>' : ''}${m.admin ? ' <span class="label accent">администратор</span>' : ''}
        <div class="muted" style="font-size:12px">${esc([m.tg_username && `@${m.tg_username}`, m.email].filter(Boolean).join(' · '))}</div></div><span class="muted nw">${esc(ago(m.last_seen))}</span></div>`)
    .join(''));
  const activity = box('Активность за 13 недель', `<div class="box-body">${dayGrid(b.days)}</div>`, { end: `<span class="muted">${b.days.length} ${plural(b.days.length, 'день', 'дня', 'дней')} — заходил хоть кто-то из участников</span>` });
  const months = box('Внесено по месяцам', table('budget-months', [
    { key: 'month', label: 'Месяц', cell: (m) => esc(monthRu(m.month)) },
    { key: 'receipts', label: 'Чеков', r: true },
    { key: 'manual', label: 'Вручную', r: true },
  ], [...b.months].reverse(), { empty: 'За год ничего не внесено' }), { foot: 'Только количество — без сумм и покупок.' });
  const links = box('Банки и магазины', table('budget-links', [
    { key: 'person', label: 'Чьё', cell: (l) => esc(l.person) },
    { key: 'bank', label: 'Подключение', cell: (l) => esc(bankName(l.bank)) },
    { key: 'status', label: 'Состояние', cell: (l) => linkLabel(l, false) },
    { key: 'synced_at', label: 'Обновлялся', nw: true, cell: (l) => esc(ago(l.synced_at)) },
    { key: 'error', label: 'Ошибка', cell: (l) => (l.error ? `<span class="err-t">${esc(l.error)}</span>` : dash) },
  ], b.banks, { empty: 'Не подключали' }));
  const support = b.support.length ? box('Обращения в поддержку', supportRows(b.support)) : '';
  // Откуда данные: чеки по источникам и операции банка по видам — иначе числа не сходятся
  const o = b.origin;
  const part = (k, n) => `<div class="pp-row"><span class="muted">${esc(k)}</span><span class="num">${int.format(n)}</span></div>`;
  const span = (x) => (x.from ? `${dateRu(x.from)} — ${dateRu(x.to)}` : 'нет');
  const origin = box('Откуда данные', `<div class="grid2 origin">
      <div><div class="origin-head"><b>Чеки · ${int.format(o.receipts.total)}</b><span class="muted">${esc(span(o.receipts))}</span></div>
        ${part('из выгрузки ФНС', o.receipts.export)}${part('из сканов', o.receipts.scans)}${part('из магазинов (Озон, WB)', o.receipts.shops)}</div>
      <div><div class="origin-head"><b>Операции банка · ${int.format(o.ops.total)}</b><span class="muted">${esc(span(o.ops))}</span></div>
        ${part('расходы без чека', o.ops.expense)}${part('покрыты чеком', o.ops.covered)}${part('переводы', o.ops.transfer)}${part('доходы', o.ops.income)}${o.ops.excluded ? part('исключены', o.ops.excluded) : ''}</div>
    </div>`, { foot: `Записи «вручную» (${int.format(b.manual)}) — траты без чека, в «Чеки» не входят. «Покрыты чеком» — те же покупки, что среди чеков, только со стороны банка.` });
  return head + stats + `<div class="grid2">${planBox}${members}</div><div style="height:16px"></div>` + origin + activity + support + months + links;
}

function pagePerson(u) {
  if (!u) return subhead('Человек') + blank('Нет такого человека');
  const from = u.channel === 'invite' && u.invited_by ? `по приглашению ${u.invited_by}` : channelName(u.channel);
  const head = `<a class="back" href="#/users/${u.budget_id}">← Бюджет</a>
    <div class="person-head"><span class="avatar">${esc(initials(u.name))}</span><div>
      <div class="person-name">${esc(u.name)}</div>
      <div class="muted">${u.tg_username ? `<a href="https://t.me/${esc(u.tg_username)}" target="_blank" rel="noopener">@${esc(u.tg_username)}</a> · ` : ''}с ${esc(dateRu(u.created_at))} · ${esc(from)}</div>
    </div></div>`;
  const stats = `<div class="box"><div class="stats">
      ${stat('Заходил', esc(ago(u.last_seen)))}
      ${stat('Дней из 30', u.active_days)}
      ${stat('Чеков', u.receipts, u.manual ? `и ${u.manual} вручную` : '')}
      ${stat('Операций банка', u.bank_ops)}
    </div></div>`;
  const activity = box('Активность за 13 недель', `<div class="box-body">${dayGrid(u.days)}</div>`, { end: `<span class="muted">${u.days.length} ${plural(u.days.length, 'день', 'дня', 'дней')}</span>` });
  const scans = u.scans.map((s) => `${SCAN_STATUS[s.status] ?? s.status}: ${s.n}`).join(', ') || 'не сканировал';
  const summary = box(
    'Сводка',
    `<div class="kv">
      <div class="k">Зарегистрирован</div><div>${esc(dateTimeRu(u.created_at))}</div>
      <div class="k">Откуда</div><div>${esc(from)}</div>
      <div class="k">Вход</div><div>${esc([u.telegram && 'Telegram', u.email && `почта ${u.email}`].filter(Boolean).join(', ') || 'пароль')}</div>
      <div class="k">Сканы</div><div>${esc(scans)}</div>
      <div class="k">Лимиты</div><div>${u.limits ? 'заданы' : 'нет'}</div>
      <div class="k">Демо-режим</div><div>${u.in_demo ? 'включён сейчас' : 'выключен'}</div>
    </div>`,
  );
  const budget = box(
    u.budget ? `Бюджет «${esc(u.budget.name)}»` : 'Бюджет',
    u.budget?.members.length
      ? u.budget.members.map((m) => `<div class="box-row"><span class="avatar sm">${esc(initials(m.name))}</span><div class="grow">${m.me ? esc(m.name) : `<a href="#/people/${m.id}">${esc(m.name)}</a>`}</div>${m.owner ? '<span class="label">владелец</span>' : ''}</div>`).join('')
      : blank('Нет бюджета'),
  );
  const months = box(
    'Внесено по месяцам',
    table('months', [
      { key: 'month', label: 'Месяц', cell: (m) => esc(monthRu(m.month)) },
      { key: 'receipts', label: 'Чеков', r: true },
      { key: 'manual', label: 'Вручную', r: true },
    ], [...u.months].reverse(), { empty: 'За год ничего не внесено' }),
    { foot: 'Только количество — без сумм и покупок.' },
  );
  const links = box(
    'Банки и магазины',
    table('person-links', [
      { key: 'bank', label: 'Подключение', cell: (l) => esc(bankName(l.bank)) },
      { key: 'status', label: 'Состояние', cell: (l) => linkLabel(l, false) },
      { key: 'since', label: 'Подключён', nw: true, cell: (l) => esc(dateRu(l.since)) },
      { key: 'synced_at', label: 'Обновлялся', nw: true, cell: (l) => esc(ago(l.synced_at)) },
      { key: 'error', label: 'Ошибка', cell: (l) => (l.error ? `<span class="err-t">${esc(l.error)}</span>` : '<span class="muted">—</span>') },
    ], u.banks, { empty: 'Не подключал' }),
  );
  const devices = box(
    'Входы',
    table('devices', [
      { key: 'label', label: 'Откуда', cell: (t) => esc(t.label ?? '—') },
      { key: 'created_at', label: 'Вошёл', cell: (t) => esc(dateTimeRu(t.created_at)) },
      { key: 'used_at', label: 'Последний раз', cell: (t) => esc(ago(t.used_at)) },
      { key: 'expires_at', label: 'Действует до', cell: (t) => esc(dateRu(t.expires_at)) },
    ], u.devices, { empty: 'Действующих входов нет' }),
  );
  const support = u.support.length ? box('Обращения в поддержку', supportRows(u.support)) : '';
  return head + stats + activity + `<div class="grid2">${summary}${budget}</div><div style="height:16px"></div>` + support + months + links + devices;
}

// ── поддержка ────────────────────────────────────────────

const SUPPORT_STATUS = { new: ['ждёт ответа', 'bad'], answered: ['отвечено', 'ok'], closed: ['закрыто', ''] };
const supportLabel = (s) => `<span class="label ${SUPPORT_STATUS[s]?.[1] ?? ''}">${esc(SUPPORT_STATUS[s]?.[0] ?? s)}</span>`;

function supportRows(threads) {
  return threads
    .map((t) => `<div class="box-row"><div class="grow"><a href="#/support/${t.id}"><b>${esc(t.name)}</b></a>${t.user_id ? '' : ' <span class="label">без аккаунта</span>'}
        <div class="muted" style="font-size:12px">${t.last_from_admin ? 'Вы: ' : ''}${esc(t.last)}</div></div>
        <span class="muted nw">${esc(ago(t.updated_at))}</span>${supportLabel(t.status)}</div>`)
    .join('');
}

function pageSupport(threads) {
  const waiting = threads.filter((t) => t.status === 'new').length;
  return subhead('Поддержка')
    + '<p class="lead">Люди пишут из приложения («Настройки → Помощь → Поддержка») или боту @checker_costs_bot. Отвечают здесь: ответ придёт человеку в приложение и в Telegram. Вам в Telegram — только уведомления о новых сообщениях.</p>'
    + box(`${threads.length} ${plural(threads.length, 'обращение', 'обращения', 'обращений')}${waiting ? ` <span class="muted">· ждут ответа ${waiting}</span>` : ''}`,
      threads.length ? supportRows(threads) : blank('Обращений пока нет'));
}

/** Где человек увидит ответ: в приложении (есть аккаунт) и в Telegram (привязан). */
const replyWhere = (t) =>
  t.user_id ? (t.telegram ? 'Ответ придёт человеку в приложение и в Telegram' : 'Ответ придёт человеку в приложение') : 'Ответ придёт человеку в Telegram — аккаунта в Чекере у него нет';

function pageThread(t) {
  if (!t) return '<a class="back" href="#/support">← Поддержка</a>' + blank('Нет такого обращения');
  const who = t.user_id ? `<a href="#/people/${t.user_id}">${esc(t.name)}</a>` : `${esc(t.name)} <span class="label">без аккаунта</span>`;
  const msgs = t.messages
    .map((m) => {
      const body = m.text ? esc(m.text) : '';
      const att = m.file
        ? `<img class="msg-img" data-file="${m.id}" alt="картинка" title="Открыть" />`
        : m.kind !== 'text' ? `<div class="att">📎 ${esc(m.kind_name ?? 'вложение')} — копия пришла вам в Telegram</div>` : '';
      return `<div class="msg${m.from_admin ? ' mine' : ''}"><div class="msg-meta">${esc(m.from_admin ? (m.author ?? 'Поддержка') : t.name)} · ${esc(dateTimeRu(m.created_at))}</div>${att}${body}</div>`;
    })
    .join('');
  const next = t.status === 'closed'
    ? '<button class="btn sm" data-status="new">Открыть снова</button>'
    : '<button class="btn sm" data-status="closed">Закрыть обращение</button>';
  return '<a class="back" href="#/support">← Поддержка</a>'
    + `<div class="subhead"><h2>Обращение #${t.id}</h2><div class="actions">${supportLabel(t.status)}${next}</div></div>`
    + `<p class="lead">${who}${t.tg_username ? ` · <a href="https://t.me/${esc(t.tg_username)}" target="_blank" rel="noopener">@${esc(t.tg_username)}</a>` : ''} · с ${esc(dateTimeRu(t.created_at))}</p>`
    + box('Переписка', `<div class="chat">${msgs}</div>`)
    + box('Ответ', `<form class="box-body reply" id="reply-form" data-id="${t.id}">
        <textarea class="input" name="text" rows="4" required placeholder="${esc(replyWhere(t))}"></textarea>
        <div class="reply-foot"><span class="muted">Ctrl+Enter — отправить</span><button class="btn primary" type="submit">Отправить</button></div>
      </form>`);
}

function pageSources(d) {
  const rows = d.sources.map((s) => ({ ...s, conv: s.people ? s.used / s.people : null }));
  const cols = [
    {
      key: 'slug',
      label: 'Канал',
      cell: (s) => {
        const named = s.slug !== 'direct' && s.slug !== 'invite';
        return `<div class="who">${esc(channelName(s.slug))}</div>${named ? `<div class="sub mono">${esc(`${SITE}/?from=${s.slug}`)}</div>` : ''}${named && !s.name ? '<div class="sub warn-t">метка не заведена: пришли по ссылке, которой нет в списке</div>' : ''}`;
      },
    },
    { key: 'people', label: 'Пришло', r: true },
    { key: 'used', label: 'Пользуются', r: true },
    { key: 'conv', label: 'Доля', r: true, cell: (s) => (s.conv == null ? '—' : `${Math.round(s.conv * 100)}%`) },
    { key: 'active7', label: 'Заходили за неделю', r: true },
    {
      key: 'act',
      label: '',
      sort: false,
      cell: (s) => (s.slug === 'direct' || s.slug === 'invite'
        ? ''
        : `<div class="labels nowrap"><button class="btn sm" data-copy="${esc(`${SITE}/?from=${s.slug}`)}">Скопировать</button>${s.name ? `<button class="btn sm danger" data-remove="${esc(s.slug)}">Убрать</button>` : ''}</div>`),
    },
  ];
  state.sort.sources ??= { key: 'people', dir: -1 };
  const form = box(
    'Новая ссылка',
    `<form class="box-body form-row" id="source-form">
      <label class="field">Название<span class="note">Для себя: «Пост в канале», «Чат соседей»</span><input class="input" name="name" required maxlength="80" /></label>
      <label class="field">Метка<span class="note">Латиница, цифры, «-» и «_»: попадёт в ссылку</span><input class="input" name="slug" required maxlength="32" pattern="[A-Za-z0-9_\\-]{1,32}" /></label>
      <button class="btn primary" type="submit">Завести ссылку</button>
    </form>`,
  );
  return subhead('Каналы прихода')
    + '<p class="lead">Метка из ссылки запоминается при первом заходе и достаётся аккаунту при регистрации через Telegram. «Пользуются» — внесли хоть один чек, трату или подключили банк.</p>'
    + box('Откуда пришли люди', table('sources', cols, rows, { empty: 'Пока никого' }))
    + form;
}

function pageLoad(d) {
  const l = d.load;
  const share = l.fns.today / l.fns.limit;
  const fnsDays = table('fns', [
    { key: 'day', label: 'День', cell: (r) => esc(dayRu(r.day)) },
    { key: 'calls', label: 'Обращений', r: true },
    { key: 'share', label: 'Из лимита', sort: false, cell: (r) => `<div class="meter ${meterCls(r.calls / l.fns.limit)}" style="min-width:160px;margin-top:7px"><i style="width:${Math.min(100, (r.calls / l.fns.limit) * 100)}%"></i></div>` },
  ], [...l.fns.days].reverse(), { empty: 'За неделю обращений не было' });
  const fns = box(
    'ФНС',
    `<div class="box-body"><div class="chart-head"><span>Сегодня</span><span><b>${l.fns.today}</b> из ${l.fns.limit} · ${Math.round(share * 100)}%</span></div><div class="meter ${meterCls(share)}"><i style="width:${Math.min(100, share * 100)}%"></i></div></div>${fnsDays}`,
    { foot: 'Не больше 1000 обращений в сутки на всё приложение, с опросами и продлением сессии. Один скан — несколько обращений. Сутки — по UTC.' },
  );
  const today = box(
    'Сегодня',
    `<div class="box-row"><div class="grow">Сканов</div><b class="num">${l.scans_today}</b></div>
     <div class="box-row"><div class="grow">Названий на разметку моделью<div class="muted" style="font-size:12px">у каждого человека — до 100 в сутки</div></div><b class="num">${l.model_names}</b></div>
     ${l.dadata.length ? l.dadata.map((x) => `<div class="box-row"><div class="grow">DaData · ${esc(x.service)}</div><b class="num">${x.calls}</b></div>`).join('') : '<div class="box-row"><div class="grow">DaData</div><span class="muted">не обращались</span></div>'}`,
  );
  return subhead('Нагрузка') + '<p class="lead">Общие ресурсы приложения: во что упрёмся, когда людей станет больше.</p>' + fns + today;
}

function pageLinks(d) {
  const links = allLinks(d);
  const banks = [...new Set(links.map((l) => l.bank))];
  const summary = banks.length
    ? `<div class="box"><div class="stats" style="grid-template-columns:repeat(${Math.min(4, banks.length)},minmax(0,1fr))">${banks.slice(0, 4).map((b) => {
      const mine = links.filter((l) => l.bank === b);
      const bad = mine.filter((l) => l.health === 'bad').length;
      return stat(bankName(b), mine.length, bad ? `<span class="err-t">нужен вход: ${bad}</span>` : 'входить заново не нужно');
    }).join('')}</div></div>`
    : '';
  const cols = [
    { key: 'person', label: 'Человек', value: (l) => l.person.name.toLowerCase(), cell: (l) => `<a href="#/people/${l.person.id}">${esc(l.person.name)}</a>` },
    { key: 'bank', label: 'Подключение', cell: (l) => esc(bankName(l.bank)) },
    { key: 'status', label: 'Состояние', cell: (l) => linkLabel(l, false) },
    { key: 'since', label: 'Подключён', nw: true, cell: (l) => esc(dateRu(l.since)) },
    { key: 'synced_at', label: 'Обновлялся', nw: true, cell: (l) => esc(ago(l.synced_at)) },
    { key: 'error', label: 'Ошибка', cell: (l) => (l.error ? `<span class="err-t">${esc(l.error)}</span>` : '<span class="muted">—</span>') },
  ];
  return subhead('Подключения')
    + '<p class="lead">Банки и магазины людей: работает ли подключение и когда обновлялось. Операций и сумм здесь нет.</p>'
    + summary
    + box(`${links.length} ${plural(links.length, 'подключение', 'подключения', 'подключений')}`, table('links', cols, links, { empty: 'Никто ещё не подключал банк' }));
}

function pageErrors(d) {
  const scans = box(
    'Сканы с ошибкой за 7 дней',
    table('scan-errors', [
      { key: 'code', label: 'Код ФНС', cell: (e) => `<span class="mono">${esc(e.code)}</span>` },
      { key: 'n', label: 'Сканов', r: true },
      { key: 'sample', label: 'Пример ответа', cell: (e) => `<span class="muted">${esc(e.sample ?? '—')}</span>` },
    ], d.load.scan_errors, { empty: 'Ошибок не было' }),
    { foot: '455 и 544 значат «данных ещё нет»: такие сканы повторяются сами.' },
  );
  const broken = brokenLinks(d);
  const links = box(
    'Нужен вход заново',
    broken.length
      ? broken.map((l) => `<div class="box-row"><div class="grow"><a href="#/people/${l.person.id}">${esc(l.person.name)}</a> · ${esc(bankName(l.bank))}<div class="err-t" style="font-size:12px">${esc(l.error ?? 'сессия истекла')}</div></div><span class="muted">обновлялся ${esc(ago(l.synced_at))}</span></div>`).join('')
      : blank('Все подключения работают'),
    { cls: broken.length ? 'danger' : '' },
  );
  return subhead('Ошибки') + scans + links;
}

// ── маршруты ─────────────────────────────────────────────

async function route() {
  if (!state.data) return;
  const [page = 'overview', arg] = location.hash.replace(/^#\/?/, '').split('/');
  const known = PAGES.some((p) => p.id === page) ? page : 'overview';
  renderNav(known);
  const d = state.data;
  let html;
  if (known === 'support') {
    try {
      html = arg ? pageThread(await api(`/api/admin/support/${encodeURIComponent(arg)}`)) : pageSupport((await api('/api/admin/support')).threads);
    } catch (err) {
      html = arg ? pageThread(null) : `<div class="flash bad">Не загрузилось: ${esc(err.message)}</div>`;
    }
  } else if (known === 'users' && arg) {
    let b = null;
    try {
      b = await api(`/api/admin/budgets/${encodeURIComponent(arg)}`);
    } catch {
      /* нет такого — покажем пустую */
    }
    html = pageBudget(b);
  } else if (known === 'people' && arg) {
    try {
      state.person = await api(`/api/admin/people/${encodeURIComponent(arg)}`);
    } catch {
      state.person = null;
    }
    html = pagePerson(state.person);
  } else {
    html = { overview: pageOverview, users: pageUsers, people: pageUsers, sources: pageSources, load: pageLoad, links: pageLinks, errors: pageErrors }[known](d);
  }
  $('main').innerHTML = html;
  // Три колонки — только у списка «Пользователи»: справа выбранный кратко
  // Три колонки на всех страницах — меню и середина не прыгают при переключении. Справа: у списка
  // «Пользователи» — выбранный кратко, на остальных — «Сейчас»: что горит
  $('panel-col').innerHTML = known === 'users' && !arg ? userPanel(d.budgets.find((b) => b.id === state.selBudget)) : nowPanel(d);
  document.title = `${PAGES.find((p) => p.id === known)?.title ?? 'Админка'} — Чекер`;
  loadImages();
}

/** Картинки из поддержки — по токену администратора: обычной ссылкой их не отдать. */
async function loadImages() {
  for (const img of $('main').querySelectorAll('img[data-file]:not([src])')) {
    try {
      const res = await fetch(`/api/admin/support/file/${img.dataset.file}`, { headers: { authorization: `Bearer ${token.get()}` } });
      if (res.ok) img.src = URL.createObjectURL(await res.blob());
    } catch {
      /* не загрузилась — переписка читается и так */
    }
  }
}

// ── вход и загрузка ──────────────────────────────────────

let stopLinkRefresh = null;
let stopWaiting = null;

function showLogin(error = '') {
  stopWaiting?.();
  $('layout').hidden = true;
  $('head-end').hidden = true;
  $('login').hidden = false;
  $('login').innerHTML = `<div class="login">
      ${LOGO}
      <h1>Вход в центр управления</h1>
      ${error ? `<div class="flash bad">${esc(error)}</div>` : ''}
      <div class="login-card" id="tg-box">
        <a class="btn primary tg disabled" id="tg-login">${TG_ICON}Войти через Telegram</a>
        <div id="tg-wait" hidden>
          <p style="margin:0 0 8px"><b>Подтвердите вход в Telegram</b></p>
          <p class="muted" style="margin:0 0 12px">Бот покажет запрос — нажмите «Войти». Пустит только администратора.</p>
          <div class="labels"><a class="btn sm" id="tg-again" target="_blank" rel="noopener">Открыть Telegram ещё раз</a><button class="btn sm" id="tg-cancel" type="button">Отмена</button></div>
        </div>
      </div>
      <details class="login-pass">
        <summary class="muted">Войти по паролю</summary>
        <form class="login-card" id="login-form" style="margin-top:12px">
          <label class="field">Логин<input class="input" name="login" autocomplete="username" required /></label>
          <label class="field">Пароль<input class="input" name="password" type="password" autocomplete="current-password" required /></label>
          <button class="btn" type="submit">Войти</button>
        </form>
      </details>
    </div>`;

  stopLinkRefresh?.();
  stopLinkRefresh = keepLinkReady($('tg-login'), {
    client: 'admin',
    onError: (err) => {
      if (err.status === 503) $('tg-box').hidden = true; // вход через Telegram не настроен — только пароль
    },
  });
  $('tg-login').addEventListener('click', (e) => {
    if ($('tg-login').classList.contains('disabled')) return e.preventDefault();
    awaitTelegram(markWaiting($('tg-login')));
  });
  $('tg-cancel').addEventListener('click', () => {
    forgetLogin();
    showLogin();
  });

  // Страница перезагрузилась, пока человек был в Telegram, — ждём дальше. Только свой вход:
  // начатый в кабинете сюда не относится
  const pending = pendingLogin();
  if (pending?.client === 'admin') awaitTelegram(pending);
}

function awaitTelegram(login) {
  $('tg-login').hidden = true;
  $('tg-wait').hidden = false;
  $('tg-again').href = login.url;
  stopWaiting?.();
  stopWaiting = waitLogin(login.nonce, {
    onDone: (data) => {
      token.set(data.token);
      stopLinkRefresh?.();
      refresh();
    },
    // used — токен забрала страница подтверждения в этом же браузере: он уже у нас
    onFail: (message, status) => (status === 'used' && token.get() ? refresh() : showLogin(message)),
  });
}

async function refresh() {
  try {
    state.data = await api('/api/admin/overview');
    state.names = new Map(state.data.sources.map((s) => [s.slug, s.name]));
    $('login').hidden = true;
    $('layout').hidden = false;
    $('head-end').hidden = false;
    $('stamp').textContent = `обновлено ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
    $('context-note').textContent = `Бета · ${state.data.totals.people} ${plural(state.data.totals.people, 'человек', 'человека', 'человек')}`;
    await route();
  } catch (err) {
    if (err.status === 401) {
      token.set(null);
      showLogin();
    } else if (err.status === 403) {
      // Вошёл не администратор: токен ему здесь ни к чему — гасим
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      token.set(null);
      showLogin('Это вход только для администратора');
    } else {
      $('main').innerHTML = `<div class="flash bad">Не загрузилось: ${esc(err.message)}</div>`;
    }
  }
}

// ── тема ─────────────────────────────────────────────────
// Пока человек не выбрал, тема — как в системе. Значок показывает, куда переключит:
// в светлой — месяц, в тёмной — солнце
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => (document.documentElement.dataset.theme ?? (systemDark.matches ? 'dark' : 'light')) === 'dark';
const paintThemeButton = () => {
  $('theme').innerHTML = isDark() ? SUN : MOON;
  $('theme').title = isDark() ? 'Светлая тема' : 'Тёмная тема';
};
$('theme').addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* выбор проживёт до перезагрузки */
  }
  paintThemeButton();
});
systemDark.addEventListener('change', paintThemeButton);
paintThemeButton();

window.addEventListener('hashchange', route);
$('refresh').addEventListener('click', refresh);
$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  token.set(null);
  state.data = null;
  showLogin();
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  if (e.target.id === 'login-form') {
    const res = await fetch('/api/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: form.get('login'), password: form.get('password'), label: 'админка' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showLogin(data.error ?? `HTTP ${res.status}`);
    token.set(data.token);
    stopLinkRefresh?.();
    return refresh();
  }
  if (e.target.id === 'plan-form') {
    const until = form.get('until');
    try {
      await api(`/api/admin/budgets/${e.target.dataset.id}/plan`, {
        method: 'POST',
        body: JSON.stringify({ plan: form.get('plan'), label: form.get('label') || null, until: until || null }),
      });
      await refresh();
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  if (e.target.id === 'reply-form') {
    const button = e.target.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api(`/api/admin/support/${e.target.dataset.id}/reply`, { method: 'POST', body: JSON.stringify({ text: form.get('text') }) });
      await refresh(); // счётчик «ждут ответа» в меню и сама переписка
    } catch (err) {
      alert(err.message);
      button.disabled = false;
    }
    return;
  }
  if (e.target.id === 'source-form') {
    try {
      await api('/api/admin/sources', { method: 'POST', body: JSON.stringify({ slug: form.get('slug'), name: form.get('name') }) });
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  }
});

// «Пользователи»: стрелки — по строкам, Enter — открыть бюджет выбранного
document.addEventListener('keydown', (e) => {
  if (!$('users-table') || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const rows = [...$('users-table').querySelectorAll('tr[data-select]')];
  const at = rows.findIndex((r) => Number(r.dataset.select) === state.selBudget);
  if (e.key === 'Enter' && at >= 0) {
    location.hash = rows[at].dataset.open;
  } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
    e.preventDefault();
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    state.selBudget = Number(next.dataset.select);
    rerenderUsers();
    $('users-table').querySelector('tr.sel')?.scrollIntoView({ block: 'nearest' });
  }
});

// Ctrl+Enter в ответе — отправить
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.closest('#reply-form')) {
    e.preventDefault();
    e.target.closest('form').requestSubmit();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'f-q') {
    state.filter.q = e.target.value;
    rerenderUsers();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'f-channel') state.filter.channel = e.target.value;
  else if (e.target.id === 'f-activity') state.filter.activity = e.target.value;
  else if (e.target.id === 'f-plan') state.filter.plan = e.target.value;
  else return;
  rerenderUsers();
});

document.addEventListener('click', async (e) => {
  const sort = e.target.closest('th[data-sort]');
  if (sort?.dataset.sort) {
    const [id, key] = sort.dataset.sort.split(':');
    const cur = state.sort[id];
    state.sort[id] = cur?.key === key ? { key, dir: -cur.dir } : { key, dir: -1 };
    if (id === 'users') rerenderUsers();
    else route();
    return;
  }
  const status = e.target.closest('[data-status]');
  if (status) {
    const id = location.hash.split('/')[2];
    await api(`/api/admin/support/${id}/status`, { method: 'POST', body: JSON.stringify({ status: status.dataset.status }) }).catch((err) => alert(err.message));
    await refresh();
    return;
  }
  // Ссылка из «Требует внимания» сразу с отбором
  const preset = e.target.closest('[data-activity]');
  if (preset) state.filter = { q: '', channel: '', activity: preset.dataset.activity };
  // «Пользователи»: щелчок — выбрать строку (кратко справа); по имени — страница бюджета
  const pick = e.target.closest('tr[data-select]');
  if (pick && !e.target.closest('a, button')) {
    state.selBudget = Number(pick.dataset.select);
    rerenderUsers();
    return;
  }
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a, button')) {
    location.hash = row.dataset.href;
    return;
  }
  // Картинку из поддержки — во весь размер, в новой вкладке
  const pic = e.target.closest('img.msg-img[src]');
  if (pic) {
    window.open(pic.src, '_blank');
    return;
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    await navigator.clipboard?.writeText(copy.dataset.copy).catch(() => {});
    copy.textContent = 'Скопировано';
    setTimeout(() => (copy.textContent = 'Скопировать'), 1500);
    return;
  }
  const remove = e.target.closest('[data-remove]');
  if (remove && confirm('Убрать метку из списка? Людям, пришедшим по ней, она останется.')) {
    await api(`/api/admin/sources/${encodeURIComponent(remove.dataset.remove)}`, { method: 'DELETE' }).catch((err) => alert(err.message));
    await refresh();
  }
});

// Подсказка у столбика и клетки дня
const tip = document.createElement('div');
tip.className = 'tip';
tip.hidden = true;
document.body.append(tip);
document.addEventListener('pointermove', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) {
    tip.hidden = true;
    return;
  }
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  tip.style.left = `${Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${e.clientY - 34}px`;
});

if (token.get()) refresh();
else showLogin();
