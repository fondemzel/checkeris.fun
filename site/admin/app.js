// Админка: сколько людей, откуда пришли и как пользуются (api/src/admin.mjs).
// С кабинетом и приложением не связана: свой вход по паролю администратора и свой токен
// (checker.admin-token) — выход из кабинета её не трогает, и наоборот.

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'checker.admin-token';
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
const SITE = location.origin;

const int = new Intl.NumberFormat('ru-RU');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dateRu = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '—');
const dayRu = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

/** «сегодня», «вчера», «5 дн назад» — для последнего входа. */
function ago(iso) {
  if (!iso) return 'не заходил';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) {
    const h = Math.floor((Date.now() - Date.parse(iso)) / 3_600_000);
    return h < 1 ? 'только что' : `${h} ч назад`;
  }
  if (days === 1) return 'вчера';
  return `${days} дн назад`;
}

const plural = (n, one, few, many) => {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
};

const BANKS = { tbank: 'Т-Банк', sber: 'Сбер', ozon: 'Озон', wb: 'Wildberries' };
const LINK_STATUS = { active: 'работает', expired: 'отвалился', demo: 'демо' };

const channelName = (slug, name) =>
  slug === 'direct' ? 'Напрямую' : slug === 'invite' ? 'По приглашению в бюджет' : name || slug;

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

// ── части страницы ───────────────────────────────────────

const section = (title, body, foot = '') =>
  `<section class="sec"><div class="sec-title">${esc(title)}</div>${body}</section>${foot ? `<p class="sec-foot">${foot}</p>` : '<div style="height:12px"></div>'}`;

const row = ({ title, note = '', end = '', extra = '' }) =>
  `<div class="row"><div class="row-main"><div class="row-title">${title}</div>${note ? `<div class="row-note">${note}</div>` : ''}${extra}</div>${end ? `<div class="row-end">${end}</div>` : ''}</div>`;

const tile = (title, num, sub = '') =>
  `<div class="tile"><div class="tile-title">${esc(title)}</div><div class="tile-num">${int.format(num)}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ''}</div>`;

function tiles(t) {
  return `<div class="tiles">
    ${tile('Людей', t.people, `сегодня +${t.joined_today}, за неделю +${t.joined_7}`)}
    ${tile('Заходили сегодня', t.active_today)}
    ${tile('За 7 дней', t.active_7)}
    ${tile('За 30 дней', t.active_30)}
    ${tile('Внесли чеки или траты', t.with_receipts)}
    ${tile('Подключили банк', t.with_bank)}
    ${tile('В общем бюджете', t.shared)}
  </div>`;
}

/** Столбики по дням: один ряд — один цвет, значение — в подсказке при наведении. */
function columns(days, key, label) {
  const max = Math.max(1, ...days.map((d) => d[key]));
  const cols = days
    .map((d) => {
      const v = d[key];
      const tip = `${dayRu(d.day)}: ${v} ${plural(v, 'человек', 'человека', 'человек')}`;
      return `<div class="col${v ? '' : ' zero'}" data-tip="${esc(tip)}"><i style="height:${(v / max) * 100}%"></i></div>`;
    })
    .join('');
  const total = days.reduce((s, d) => s + d[key], 0);
  return `<div class="chart-head"><span>${esc(label)}</span><span>максимум ${max}${key === 'joined' ? ` · всего ${total}` : ''}</span></div>
    <div class="cols">${cols}</div>
    <div class="axis"><span>${dayRu(days[0].day)}</span><span>сегодня</span></div>`;
}

function activity(days) {
  return section(
    'Активность за 30 дней',
    `<div class="sec-body">${columns(days, 'active', 'Заходили в приложение')}${columns(days, 'joined', 'Зарегистрировались')}</div>`,
    'Заходил — открыл приложение или кабинет хотя бы раз за день. Считается с выкладки 0.61.0: раньше такие отметки не записывались.',
  );
}

function sources(list) {
  const rows = list
    .map((s) => {
      const named = s.slug !== 'direct' && s.slug !== 'invite';
      const url = `${SITE}/?from=${encodeURIComponent(s.slug)}`;
      const note = named
        ? `<span class="link-code">${esc(url)}</span>${s.name ? '' : ' · <span class="warn-t">метка не заведена</span>'}`
        : '';
      const actions = named
        ? `<div class="chips"><button class="btn small" data-copy="${esc(url)}">Скопировать ссылку</button>${s.name ? `<button class="btn small" data-remove="${esc(s.slug)}">Убрать</button>` : ''}</div>`
        : '';
      return row({
        title: esc(channelName(s.slug, s.name)),
        note,
        extra: actions,
        end: `<b>${s.people}</b><div class="row-note">пользуются ${s.used} · за неделю ${s.active7}</div>`,
      });
    })
    .join('');
  const form = `<form class="form" id="source-form">
      <input name="name" placeholder="Название: «Пост в канале», «Чат соседей»" required maxlength="80" />
      <input name="slug" placeholder="Метка: post1, chat-sosedi" required maxlength="32" pattern="[A-Za-z0-9_\\-]{1,32}" />
      <button class="btn primary" type="submit">Завести ссылку</button>
    </form>`;
  return section(
    'Откуда пришли',
    (rows || '<div class="empty">Пока никого</div>') + form,
    'Метка запоминается при первом заходе по ссылке и достаётся аккаунту при регистрации через Telegram. «Пользуются» — внесли хоть один чек, трату или подключили банк; «за неделю» — заходили в последние 7 дней.',
  );
}

function load(l) {
  const share = l.fns.today / l.fns.limit;
  const fnsCls = share >= 0.9 ? 'bad' : share >= 0.7 ? 'warn' : '';
  const fnsDays = l.fns.days.map((d) => `${dayRu(d.day)} — ${d.calls}`).join(' · ') || 'обращений не было';
  const dadata = l.dadata.map((d) => `${d.service}: ${d.calls}`).join(' · ') || 'не обращались';
  const errors = l.scan_errors.length
    ? l.scan_errors.map((e) => row({ title: `Код ${esc(e.code)}`, note: esc(e.sample ?? ''), end: `<b>${e.n}</b>` })).join('')
    : '';
  const links = l.links.length
    ? `<div class="chips">${l.links.map((x) => `<span class="chip${x.status === 'expired' ? ' bad' : ''}">${esc(BANKS[x.bank] ?? x.bank)} · ${esc(LINK_STATUS[x.status] ?? x.status)} · ${x.n}</span>`).join('')}</div>`
    : '';
  return section(
    'Нагрузка и общие лимиты',
    row({
      title: 'ФНС сегодня',
      note: `за неделю: ${esc(fnsDays)}`,
      end: `<b>${l.fns.today}</b> из ${l.fns.limit}`,
      extra: `<div class="meter ${fnsCls}"><i style="width:${Math.min(100, share * 100)}%"></i></div>`,
    })
      + row({ title: 'Сканов сегодня', end: `<b>${l.scans_today}</b>` })
      + row({ title: 'Названий на разметку моделью сегодня', end: `<b>${l.model_names}</b>` })
      + row({ title: 'DaData сегодня', note: esc(dadata) })
      + row({ title: 'Подключения банков и магазинов', note: links ? '' : 'пока нет', extra: links })
      + (errors ? `<div class="sec-title" style="padding-top:10px">Сканы с ошибкой за 7 дней</div>${errors}` : ''),
    'ФНС отвечает не больше чем на 1000 обращений в сутки на всё приложение — с опросами и продлением сессии. Один скан — несколько обращений.',
  );
}

function person(u) {
  const chips = [];
  const n = (v, one, few, many) => `${int.format(v)} ${plural(v, one, few, many)}`;
  if (u.receipts) chips.push(`<span class="chip">${n(u.receipts, 'чек', 'чека', 'чеков')}</span>`);
  if (u.manual) chips.push(`<span class="chip">${n(u.manual, 'запись', 'записи', 'записей')} вручную</span>`);
  if (u.scans) chips.push(`<span class="chip${u.scans_failed ? ' warn' : ''}">${n(u.scans, 'скан', 'скана', 'сканов')}${u.scans_failed ? `, с ошибкой ${u.scans_failed}` : ''}</span>`);
  if (u.bank_ops) chips.push(`<span class="chip">${n(u.bank_ops, 'операция', 'операции', 'операций')} банка</span>`);
  for (const b of u.banks) {
    const when = b.synced_at ? `, обновлён ${ago(b.synced_at)}` : '';
    chips.push(`<span class="chip${b.status === 'expired' ? ' bad' : ''}" title="${esc(b.error ?? '')}">${esc(BANKS[b.bank] ?? b.bank)} · ${esc(LINK_STATUS[b.status] ?? b.status)}${esc(when)}</span>`);
  }
  if (u.shared) chips.push(`<span class="chip">общий бюджет, ${u.members} уч.</span>`);
  if (u.limits) chips.push('<span class="chip">лимиты</span>');
  if (u.in_demo) chips.push('<span class="chip muted">сейчас в демо</span>');
  if (!chips.length) chips.push('<span class="chip muted">ещё ничего не внёс</span>');

  const who = `${esc(u.name)}${u.tg_username ? ` <a href="https://t.me/${esc(u.tg_username)}" target="_blank" rel="noopener">@${esc(u.tg_username)}</a>` : ''}`;
  const from = u.channel === 'invite' && u.invited_by ? `по приглашению ${esc(u.invited_by)}` : esc(channelName(u.channel, state.names.get(u.channel)));
  const banksErr = u.banks.filter((b) => b.error).map((b) => `${esc(BANKS[b.bank] ?? b.bank)}: ${esc(b.error)}`).join(' · ');
  return row({
    title: who,
    note: `с ${dateRu(u.created_at)} · ${from}${banksErr ? ` · <span class="err">${banksErr}</span>` : ''}`,
    extra: `<div class="chips">${chips.join('')}</div>`,
    end: `${esc(ago(u.last_seen))}<div class="row-note">${u.active_days} ${plural(u.active_days, 'день', 'дня', 'дней')} из 30</div>`,
  });
}

function peopleSection(list) {
  const q = state.query.trim().toLowerCase();
  const shown = q
    ? list.filter((u) => [u.name, u.tg_username, u.channel, u.invited_by].some((v) => String(v ?? '').toLowerCase().includes(q)))
    : list;
  return section(
    `Люди · ${list.length}`,
    `<div class="form"><input class="search" id="search" placeholder="Поиск: имя, @ник, метка" value="${esc(state.query)}" /></div>`
      + `<div id="people">${shown.map(person).join('') || '<div class="empty">Никого не нашлось</div>'}</div>`,
    'Новые сверху. Только служебное: сколько внесено и подключено, — без сумм, покупок и операций. Демо-пользователи и администратор не считаются.',
  );
}

// ── страница ─────────────────────────────────────────────

const state = { data: null, query: '', names: new Map() };

function render() {
  const d = state.data;
  state.names = new Map(d.sources.map((s) => [s.slug, s.name]));
  $('page').innerHTML = tiles(d.totals) + activity(d.days) + sources(d.sources) + peopleSection(d.people) + load(d.load);
  $('stamp').textContent = `обновлено ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}

function notice(html) {
  $('page').innerHTML = `<div class="notice">${html}</div>`;
}

function showLogin(error = '') {
  $('refresh').hidden = true;
  $('logout').hidden = true;
  $('stamp').textContent = '';
  notice(`<form class="login" id="login-form">
      <div class="login-title">Вход администратора</div>
      <input name="login" placeholder="Логин" autocomplete="username" required />
      <input name="password" type="password" placeholder="Пароль" autocomplete="current-password" required />
      <button class="btn primary" type="submit">Войти</button>
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
    </form>`);
}

async function refresh() {
  try {
    state.data = await api('/api/admin/overview');
    $('refresh').hidden = false;
    $('logout').hidden = false;
    render();
  } catch (err) {
    if (err.status === 401) {
      token.set(null);
      showLogin();
    } else if (err.status === 403) {
      // Вошёл не администратор: токен ему здесь ни к чему — гасим
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      token.set(null);
      showLogin('Это вход только для администратора');
    } else notice(`Не загрузилось: ${esc(err.message)}`);
  }
}

$('refresh').addEventListener('click', refresh);

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  token.set(null);
  showLogin();
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'search') return;
  state.query = e.target.value;
  const q = state.query.trim().toLowerCase();
  const list = state.data.people;
  const shown = q ? list.filter((u) => [u.name, u.tg_username, u.channel, u.invited_by].some((v) => String(v ?? '').toLowerCase().includes(q))) : list;
  $('people').innerHTML = shown.map(person).join('') || '<div class="empty">Никого не нашлось</div>';
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'login-form') {
    e.preventDefault();
    const form = new FormData(e.target);
    const res = await fetch('/api/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: form.get('login'), password: form.get('password'), label: 'админка' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showLogin(data.error ?? `HTTP ${res.status}`);
    token.set(data.token);
    return refresh();
  }
  if (e.target.id !== 'source-form') return;
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api('/api/admin/sources', { method: 'POST', body: JSON.stringify({ slug: form.get('slug'), name: form.get('name') }) });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

document.addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    await navigator.clipboard?.writeText(copy.dataset.copy).catch(() => {});
    copy.textContent = 'Скопировано';
    setTimeout(() => (copy.textContent = 'Скопировать ссылку'), 1500);
    return;
  }
  const remove = e.target.closest('[data-remove]');
  if (remove && confirm('Убрать метку из списка? Людям, пришедшим по ней, она останется.')) {
    await api(`/api/admin/sources/${encodeURIComponent(remove.dataset.remove)}`, { method: 'DELETE' }).catch((err) => alert(err.message));
    await refresh();
  }
});

// Подсказка у столбика: день и число людей
const tip = document.createElement('div');
tip.className = 'tip';
tip.hidden = true;
document.body.append(tip);
document.addEventListener('pointermove', (e) => {
  const col = e.target.closest?.('[data-tip]');
  if (!col) {
    tip.hidden = true;
    return;
  }
  tip.textContent = col.dataset.tip;
  tip.hidden = false;
  tip.style.left = `${Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${e.clientY - 34}px`;
});

refresh();
