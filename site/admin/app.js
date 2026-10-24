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
const LINK_STATUS = { active: 'работает', expired: 'отвалился', demo: 'демо' };
const SCAN_STATUS = { new: 'в очереди', sent: 'ждёт ФНС', done: 'готов', failed: 'с ошибкой' };
const bankName = (b) => BANKS[b] ?? b;
// withBank=false — в таблице, где банк уже стоит своей колонкой
const linkLabel = (l, withBank = true) =>
  `<span class="label ${l.status === 'active' ? 'ok' : l.status === 'expired' ? 'bad' : ''}">${withBank ? `${esc(bankName(l.bank))} · ` : ''}${esc(LINK_STATUS[l.status] ?? l.status)}</span>`;

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
  sort: { people: { key: 'created_at', dir: -1 }, links: { key: 'synced_at', dir: -1 } },
  filter: { q: '', channel: '', activity: '' },
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
function table(id, cols, rows, { href = null, empty = 'Пусто' } = {}) {
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
    .map((r) => `<tr${href ? ` class="link" data-href="${esc(href(r))}"` : ''}>${cols.map((c) => `<td class="${c.r ? 'r' : ''}${c.nw ? ' nw' : ''}">${c.cell ? c.cell(r) : esc(r[c.key] ?? '—')}</td>`).join('')}</tr>`)
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
  { id: 'people', title: 'Люди', icon: 'people', count: (d) => d.totals.people },
  { id: 'sources', title: 'Каналы прихода', icon: 'link' },
  { group: 'Система' },
  { id: 'load', title: 'Нагрузка', icon: 'gauge' },
  { id: 'links', title: 'Подключения', icon: 'bank', count: (d) => brokenLinks(d).length || null, bad: true },
  { id: 'errors', title: 'Ошибки', icon: 'alert', count: (d) => d.load.scan_errors.reduce((s, e) => s + e.n, 0) || null, bad: true },
];

const allLinks = (d) => d.people.flatMap((u) => u.banks.map((b) => ({ ...b, person: u })));
const brokenLinks = (d) => allLinks(d).filter((l) => l.status === 'expired');
const silent = (d) => d.people.filter((u) => !u.receipts && !u.manual && !u.banks.length && daysSince(u.created_at) >= 1);

function renderNav(current) {
  $('nav').innerHTML = PAGES.map((p) => {
    if (p.group) return `<div class="nav-group">${esc(p.group)}</div>`;
    const n = p.count?.(state.data);
    const counter = n ? `<span class="counter${p.bad ? ' bad' : ''}">${int.format(n)}</span>` : '';
    return `<a class="nav-item" href="#/${p.id}"${p.id === current ? ' aria-current="page"' : ''}>${icon(p.icon)}${esc(p.title)}${counter}</a>`;
  }).join('');
}

function pageOverview(d) {
  const t = d.totals;
  const stats = `<div class="box"><div class="stats">
      ${stat('Людей', t.people, `+${t.joined_today} сегодня`, '#/people')}
      ${stat('Новых за 7 дней', t.joined_7)}
      ${stat('Заходили сегодня', t.active_today)}
      ${stat('Заходили за 7 дней', t.active_7, t.people ? `${Math.round((t.active_7 / t.people) * 100)}% от всех` : '')}
      ${stat('Заходили за 30 дней', t.active_30)}
      ${stat('Внесли чеки или траты', t.with_receipts)}
      ${stat('Подключили банк', t.with_bank, '', '#/links')}
      ${stat('В общем бюджете', t.shared)}
    </div></div>`;
  const charts = box(
    'Активность за 30 дней',
    `<div class="box-body charts">${columns(d.days, 'active', 'Заходили в приложение')}${columns(d.days, 'joined', 'Зарегистрировались')}</div>`,
    { foot: 'Заходил — открыл приложение или кабинет хотя бы раз за день. Отметки пишутся с версии 0.61.0.' },
  );

  const share = d.load.fns.today / d.load.fns.limit;
  const broken = brokenLinks(d).length;
  const errors = d.load.scan_errors.reduce((s, e) => s + e.n, 0);
  const quiet = silent(d).length;
  const attention = box(
    'Требует внимания',
    `<div class="box-row"><div class="grow"><div class="title">ФНС сегодня</div><div class="meter ${meterCls(share)}" style="margin-top:6px"><i style="width:${Math.min(100, share * 100)}%"></i></div></div><div class="num"><b>${d.load.fns.today}</b> из ${d.load.fns.limit}</div></div>
     <div class="box-row"><div class="grow"><a href="#/links">Отвалившиеся подключения</a></div><span class="label ${broken ? 'bad' : 'ok'}">${broken}</span></div>
     <div class="box-row"><div class="grow"><a href="#/errors">Сканы с ошибкой за 7 дней</a></div><span class="label ${errors ? 'warn' : 'ok'}">${errors}</span></div>
     <div class="box-row"><div class="grow"><a href="#/people" data-activity="silent">Зарегистрировались и ничего не внесли</a></div><span class="label ${quiet ? 'warn' : 'ok'}">${quiet}</span></div>`,
  );
  const top = d.sources.slice(0, 6);
  const channels = box(
    'Каналы прихода',
    top.length
      ? top.map((s) => `<div class="box-row"><div class="grow">${esc(channelName(s.slug))}</div><span class="muted">пользуются ${s.used}</span><b class="num">${s.people}</b></div>`).join('')
      : blank('Пока никого'),
    { end: '<a href="#/sources">Все каналы</a>' },
  );
  const fresh = box(
    'Новые люди',
    d.people.slice(0, 5).map((u) => `<div class="box-row"><span class="avatar sm">${esc(initials(u.name))}</span><div class="grow"><a href="#/people/${u.id}">${esc(u.name)}</a> <span class="muted">· ${esc(channelName(u.channel))}</span></div><span class="muted">${esc(dateRu(u.created_at))}</span></div>`).join('') || blank('Пока никого'),
    { end: '<a href="#/people">Все люди</a>' },
  );
  return subhead('Обзор') + stats + charts + `<div class="grid2">${attention}${channels}</div><div style="height:16px"></div>` + fresh;
}

const ACTIVITY = {
  '': 'Все',
  week: 'Заходили за 7 дней',
  gone: 'Не заходят 7+ дней',
  silent: 'Ничего не внесли',
  bank: 'С банком',
  shared: 'В общем бюджете',
  demo: 'Сейчас в демо',
};

function filterPeople(list) {
  const { q, channel, activity } = state.filter;
  const needle = q.trim().toLowerCase();
  return list.filter((u) => {
    if (needle && ![u.name, u.tg_username, channelName(u.channel), u.invited_by].some((v) => String(v ?? '').toLowerCase().includes(needle))) return false;
    if (channel && u.channel !== channel) return false;
    if (activity === 'week' && daysSince(u.last_seen) > 7) return false;
    if (activity === 'gone' && daysSince(u.last_seen) <= 7) return false;
    if (activity === 'silent' && (u.receipts || u.manual || u.banks.length)) return false;
    if (activity === 'bank' && !u.banks.length) return false;
    if (activity === 'shared' && !u.shared) return false;
    if (activity === 'demo' && !u.in_demo) return false;
    return true;
  });
}

const PEOPLE_COLS = [
  {
    key: 'name',
    label: 'Человек',
    value: (u) => u.name.toLowerCase(),
    cell: (u) => `<div class="who">${esc(u.name)}</div>${u.tg_username ? `<div class="sub">@${esc(u.tg_username)}</div>` : ''}`,
  },
  {
    key: 'created_at',
    label: 'Пришёл',
    nw: true,
    cell: (u) => `${esc(dateRu(u.created_at))}<div class="sub">${esc(u.channel === 'invite' && u.invited_by ? `приглашён: ${u.invited_by}` : channelName(u.channel))}</div>`,
  },
  { key: 'last_seen', label: 'Заходил', nw: true, cell: (u) => esc(ago(u.last_seen)) },
  { key: 'active_days', label: 'Дней из 30', r: true, cell: (u) => String(u.active_days) },
  { key: 'receipts', label: 'Чеки', r: true, cell: (u) => (u.receipts ? int.format(u.receipts) : '<span class="muted">—</span>') },
  { key: 'manual', label: 'Вручную', r: true, cell: (u) => (u.manual ? int.format(u.manual) : '<span class="muted">—</span>') },
  {
    key: 'scans',
    label: 'Сканы',
    r: true,
    cell: (u) => (u.scans ? `${int.format(u.scans)}${u.scans_failed ? `<div class="sub warn-t">ошибок ${u.scans_failed}</div>` : ''}` : '<span class="muted">—</span>'),
  },
  {
    key: 'banks',
    label: 'Подключения',
    value: (u) => u.banks.length,
    cell: (u) => {
      const labels = u.banks.map((l) => linkLabel(l));
      if (u.shared) labels.push(`<span class="label accent">общий бюджет · ${u.members}</span>`);
      if (u.in_demo) labels.push('<span class="label">в демо</span>');
      return labels.length ? `<div class="labels">${labels.join('')}</div>` : '<span class="muted">—</span>';
    },
  },
];

function pagePeople(d) {
  const list = filterPeople(d.people);
  const channels = [...new Set(d.people.map((u) => u.channel))];
  const filters = `<div class="filters">
      <input class="input" type="search" id="f-q" placeholder="Найти: имя, @ник, канал" value="${esc(state.filter.q)}" />
      <select class="input" id="f-channel"><option value="">Все каналы</option>${channels.map((c) => `<option value="${esc(c)}"${c === state.filter.channel ? ' selected' : ''}>${esc(channelName(c))}</option>`).join('')}</select>
      <select class="input" id="f-activity">${Object.entries(ACTIVITY).map(([k, v]) => `<option value="${k}"${k === state.filter.activity ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
    </div>`;
  return subhead('Люди')
    + `<p class="lead">Новые сверху; щелчок по заголовку — сортировка, по строке — подробно о человеке. Только служебное: сколько внесено и подключено, без сумм и покупок. Демо-пользователи и администратор не считаются.</p>`
    + filters
    + box(`${int.format(list.length)} ${plural(list.length, 'человек', 'человека', 'человек')}${list.length !== d.people.length ? ` <span class="muted">из ${d.people.length}</span>` : ''}`,
      table('people', PEOPLE_COLS, list, { href: (u) => `#/people/${u.id}`, empty: 'Никого не нашлось' }));
}

function pagePerson(u) {
  if (!u) return subhead('Человек') + blank('Нет такого человека');
  const from = u.channel === 'invite' && u.invited_by ? `по приглашению ${u.invited_by}` : channelName(u.channel);
  const head = `<a class="back" href="#/people">← Люди</a>
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
      <div class="k">Вход</div><div>${u.telegram ? 'Telegram' : 'пароль'}</div>
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
  return head + stats + activity + `<div class="grid2">${summary}${budget}</div><div style="height:16px"></div>` + months + links + devices;
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
      const bad = mine.filter((l) => l.status === 'expired').length;
      return stat(bankName(b), mine.length, bad ? `<span class="err-t">отвалились: ${bad}</span>` : 'все работают');
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
    'Отвалившиеся подключения',
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
  if (known === 'people' && arg) {
    try {
      state.person = await api(`/api/admin/people/${encodeURIComponent(arg)}`);
    } catch {
      state.person = null;
    }
    html = pagePerson(state.person);
  } else {
    html = { overview: pageOverview, people: pagePeople, sources: pageSources, load: pageLoad, links: pageLinks, errors: pageErrors }[known](d);
  }
  $('main').innerHTML = html;
  document.title = `${PAGES.find((p) => p.id === known)?.title ?? 'Админка'} — Чекер`;
}

function rerenderPeopleTable() {
  const list = filterPeople(state.data.people);
  const box = $('main').querySelector('.box');
  if (!box) return;
  box.outerHTML = `<div class="box"><div class="box-head">${int.format(list.length)} ${plural(list.length, 'человек', 'человека', 'человек')}${list.length !== state.data.people.length ? ` <span class="muted">из ${state.data.people.length}</span>` : ''}</div>${table('people', PEOPLE_COLS, list, { href: (u) => `#/people/${u.id}`, empty: 'Никого не нашлось' })}</div>`;
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
  if (e.target.id === 'source-form') {
    try {
      await api('/api/admin/sources', { method: 'POST', body: JSON.stringify({ slug: form.get('slug'), name: form.get('name') }) });
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'f-q') {
    state.filter.q = e.target.value;
    rerenderPeopleTable();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'f-channel') state.filter.channel = e.target.value;
  else if (e.target.id === 'f-activity') state.filter.activity = e.target.value;
  else return;
  rerenderPeopleTable();
});

document.addEventListener('click', async (e) => {
  const sort = e.target.closest('th[data-sort]');
  if (sort?.dataset.sort) {
    const [id, key] = sort.dataset.sort.split(':');
    const cur = state.sort[id];
    state.sort[id] = cur?.key === key ? { key, dir: -cur.dir } : { key, dir: -1 };
    if (id === 'people') rerenderPeopleTable();
    else route();
    return;
  }
  // Ссылка из «Требует внимания» сразу с отбором
  const preset = e.target.closest('[data-activity]');
  if (preset) state.filter = { q: '', channel: '', activity: preset.dataset.activity };
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a, button')) {
    location.hash = row.dataset.href;
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
