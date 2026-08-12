// Кабинет: слева список чеков или товаров, справа карточка выбранной строки.
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

const DEFAULTS = {
  view: 'receipts',
  q: '',
  from: '',
  to: '',
  seller_inn: '',
  operation: '',
  min_sum: '',
  max_sum: '',
  sort: 'date',
  dir: 'desc',
  page: 1,
  per: 50,
  card: '', // выбранная карточка: r<id> — чек, i<id> — позиция
};

const state = { ...DEFAULTS };
let meta = null;
let requestSeq = 0;
let cardSeq = 0;

function readUrl() {
  const params = new URLSearchParams(location.search);
  for (const key of Object.keys(DEFAULTS)) {
    if (!params.has(key)) continue;
    const value = params.get(key);
    state[key] = key === 'page' || key === 'per' ? Number(value) || DEFAULTS[key] : value;
  }
  if (state.view !== 'items') state.view = 'receipts';
  if (!/^[ri]\d+$/.test(state.card)) state.card = '';
}

function writeUrl() {
  const params = new URLSearchParams();
  for (const [key, def] of Object.entries(DEFAULTS)) {
    if (String(state[key]) !== String(def)) params.set(key, state[key]);
  }
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function apiParams() {
  const params = new URLSearchParams();
  for (const key of ['q', 'from', 'to', 'seller_inn', 'operation', 'min_sum', 'max_sum']) {
    if (state[key] !== '') params.set(key, state[key]);
  }
  params.set('sort', state.sort);
  params.set('dir', state.dir);
  params.set('page', String(state.page));
  params.set('per', String(state.per));
  return params;
}

// ── колонки списка ───────────────────────────────────────
// В списке только то, по чему выбирают строку. Реквизиты — в карточке справа.

const COLUMNS = {
  receipts: [
    { key: 'date', title: 'Дата', sort: 'date', render: (r) =>
      `<span class="nowrap">${dateRu(r.purchased_at)}</span> <span class="dim small">${timeRu(r.purchased_at)}</span>` },
    { key: 'seller', title: 'Продавец', sort: 'seller', cls: 'ellipsis', render: (r) =>
      `${esc(r.seller ?? '—')}${r.operation_type === 2 ? ' <span class="badge refund">возврат</span>' : ''}` },
    { key: 'items', title: 'Поз.', sort: 'items', cls: 'num dim', render: (r) => int.format(r.item_count) },
    { key: 'sum', title: 'Сумма', sort: 'sum', cls: 'num', render: (r) => `<b>${money(r.total_sum)}</b>` },
  ],
  items: [
    { key: 'date', title: 'Дата', sort: 'date', render: (r) =>
      `<span class="nowrap">${dateRu(r.purchased_at)}</span> <span class="dim small">${timeRu(r.purchased_at)}</span>` },
    { key: 'name', title: 'Товар', sort: 'name', cls: 'ellipsis', render: (r) => esc(r.name) },
    { key: 'quantity', title: 'Кол-во', sort: 'quantity', cls: 'num dim', render: (r) => qty(r.quantity) },
    { key: 'sum', title: 'Сумма', sort: 'sum', cls: 'num', render: (r) => `<b>${money(r.sum)}</b>` },
  ],
};

// ── список ───────────────────────────────────────────────

function renderHead() {
  const columns = COLUMNS[state.view];
  $('thead').innerHTML = `<tr>${columns
    .map((col) => {
      if (!col.sort) return `<th class="${col.cls ?? ''}">${col.title}</th>`;
      const active = state.sort === col.sort;
      const arrow = active ? (state.dir === 'asc' ? '▲' : '▼') : '↕';
      const sorted = active ? ` aria-sort="${state.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
      return `<th class="sortable ${col.cls ?? ''}" data-sort="${col.sort}"${sorted}>${col.title}<span class="arrow">${arrow}</span></th>`;
    })
    .join('')}</tr>`;
}

function renderRows(rows) {
  const columns = COLUMNS[state.view];
  const prefix = state.view === 'receipts' ? 'r' : 'i';
  const body = $('tbody');

  if (!rows.length) {
    body.innerHTML = '';
    showState('Ничего не найдено. Смягчите фильтры или очистите поиск.');
    return;
  }

  hideState();
  body.innerHTML = rows
    .map((row) => {
      const card = prefix + row.id;
      const cells = columns.map((col) => `<td class="${col.cls ?? ''}">${col.render(row)}</td>`).join('');
      return `<tr class="clickable${card === state.card ? ' selected' : ''}" data-card="${card}">${cells}</tr>`;
    })
    .join('');
}

function renderSummary(totals) {
  const isItems = state.view === 'items';
  const count = totals.count ?? 0;
  const receipts = isItems ? totals.receipts ?? 0 : count;
  const items = isItems ? count : totals.items ?? 0;
  const avg = count ? money((totals.sum ?? 0) / count, true) : '—';
  $('totals-left').textContent =
    `${int.format(receipts)} ${plural(receipts, 'чек', 'чека', 'чеков')} · ` +
    `${int.format(items)} ${plural(items, 'позиция', 'позиции', 'позиций')} · ` +
    `${isItems ? 'средняя позиция' : 'средний чек'} ${avg}`;
  $('totals-right').innerHTML = `Итого: <b>${money(totals.sum)}</b>`;
}

function renderFooter(data) {
  const total = data.totals.count ?? 0;
  const first = total ? (data.page - 1) * data.per + 1 : 0;
  const last = Math.min(data.page * data.per, total);
  const pages = Math.max(1, Math.ceil(total / data.per));
  const noun =
    state.view === 'items'
      ? plural(total, 'позиции', 'позиций', 'позиций')
      : plural(total, 'чека', 'чеков', 'чеков');
  $('range-info').textContent = total
    ? `${int.format(first)}–${int.format(last)} из ${int.format(total)} ${noun}`
    : 'ничего не найдено';
  $('page-info').textContent = `стр. ${data.page} из ${int.format(pages)}`;
  $('prev-btn').disabled = data.page <= 1;
  $('next-btn').disabled = data.page >= pages;
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
        <div class="dim">${dateRu(r.purchased_at)} ${timeRu(r.purchased_at)}${r.operation_type === 2 ? ' · <span class="badge refund">возврат</span>' : ''}</div>
      </div>
      <button class="btn" type="button" data-close>✕</button>
    </div>
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
    <div class="card-section">Позиции · ${int.format(r.item_count)}</div>
    <table class="card-table">
      <thead><tr><th class="num">№</th><th>Название</th><th class="num">Кол-во</th><th class="num">Сумма</th></tr></thead>
      <tbody>${items}</tbody>
    </table>
    ${mismatch}`;
}

function itemCard(it) {
  return `
    <div class="card-head">
      <div>
        <div class="card-title">${money(it.sum)}</div>
        <div class="dim">${dateRu(it.purchased_at)} ${timeRu(it.purchased_at)}${it.operation_type === 2 ? ' · <span class="badge refund">возврат</span>' : ''}</div>
      </div>
      <button class="btn" type="button" data-close>✕</button>
    </div>
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
    <div class="card-section">Чек</div>
    <p><button class="btn" type="button" data-receipt="${it.receipt_id}">Открыть чек на ${money(it.receipt_total)}</button></p>`;
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

// ── загрузка ─────────────────────────────────────────────

async function load() {
  const seq = ++requestSeq;
  const pane = document.querySelector('.list-pane');
  pane.classList.add('is-loading');
  writeUrl();

  try {
    const res = await fetch(`/api/${state.view}?${apiParams()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== requestSeq) return; // ответ устарел, пришёл более свежий запрос

    state.page = data.page;
    renderHead();
    renderRows(data.rows);
    renderSummary(data.totals);
    renderFooter(data);
  } catch (err) {
    if (seq !== requestSeq) return;
    $('tbody').innerHTML = '';
    showState(`Ошибка загрузки данных: ${err.message}. Проверьте, что запущен api/src/server.mjs.`, true);
  } finally {
    if (seq === requestSeq) pane.classList.remove('is-loading');
  }
}

async function loadMeta() {
  try {
    meta = await fetch('/api/meta').then((r) => r.json());
  } catch {
    $('data-period').textContent = 'нет связи с API';
    return;
  }

  const { stats, sellers, lastImport } = meta;
  $('data-period').textContent = stats.receipts
    ? `${int.format(stats.receipts)} чеков · ${dateRu(stats.date_from)} — ${dateRu(stats.date_to)}`
    : 'база пуста — запустите импорт';

  $('last-import').textContent = lastImport ? `импорт: ${dateRu(lastImport.imported_at)}` : '';

  const select = $('f-seller');
  select.innerHTML =
    '<option value="">Все продавцы</option>' +
    sellers
      .map((s) => `<option value="${esc(s.seller_inn)}">${esc(s.seller)} — ${int.format(s.receipts)} чек.</option>`)
      .join('');
  select.value = state.seller_inn;

  if (stats.date_from) {
    $('f-from').min = stats.date_from;
    $('f-to').min = stats.date_from;
    $('f-from').max = stats.date_to;
    $('f-to').max = stats.date_to;
  }
}

// ── события ──────────────────────────────────────────────

function syncControls() {
  $('f-q').value = state.q;
  $('f-from').value = state.from;
  $('f-to').value = state.to;
  $('f-operation').value = state.operation;
  $('f-min').value = state.min_sum;
  $('f-max').value = state.max_sum;
  $('f-per').value = String(state.per);
  $('f-seller').value = state.seller_inn;
  $('page-title').textContent = state.view === 'items' ? 'Товары' : 'Чеки';
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.setAttribute('aria-current', String(item.dataset.view === state.view));
  });
}

function update(patch, { resetPage = true } = {}) {
  Object.assign(state, patch);
  if (resetPage && !('page' in patch)) state.page = 1;
  load();
}

function bind() {
  let searchTimer;
  $('f-q').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const value = e.target.value;
    searchTimer = setTimeout(() => update({ q: value }), 300);
  });

  $('f-from').addEventListener('change', (e) => update({ from: e.target.value }));
  $('f-to').addEventListener('change', (e) => update({ to: e.target.value }));
  $('f-seller').addEventListener('change', (e) => update({ seller_inn: e.target.value }));
  $('f-operation').addEventListener('change', (e) => update({ operation: e.target.value }));
  $('f-min').addEventListener('change', (e) => update({ min_sum: e.target.value }));
  $('f-max').addEventListener('change', (e) => update({ max_sum: e.target.value }));
  $('f-per').addEventListener('change', (e) => update({ per: Number(e.target.value) }));

  $('reset-btn').addEventListener('click', () => {
    const view = state.view;
    Object.assign(state, DEFAULTS, { view });
    syncControls();
    renderCard();
    update({});
  });

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      if (state.view === view) return;
      // сортировка «по дате» есть в обоих разделах, остальные ключи не пересекаются
      const sort = COLUMNS[view].some((c) => c.sort === state.sort) ? state.sort : 'date';
      state.view = view;
      syncControls();
      if (!state.card) renderCard(); // текст заглушки зависит от раздела
      update({ sort });
    });
  });

  $('thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const sort = th.dataset.sort;
    const dir = state.sort === sort && state.dir === 'desc' ? 'asc' : 'desc';
    update({ sort, dir });
  });

  $('tbody').addEventListener('click', (e) => {
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

  $('prev-btn').addEventListener('click', () => update({ page: Math.max(1, state.page - 1) }, { resetPage: false }));
  $('next-btn').addEventListener('click', () => update({ page: state.page + 1 }, { resetPage: false }));

  $('export-btn').addEventListener('click', () => {
    const params = apiParams();
    params.set('type', state.view);
    location.href = `/api/export.csv?${params}`;
  });
}

readUrl();
syncControls();
bind();
loadMeta();
renderCard();
load();
