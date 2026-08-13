// Кабинет: слева список с подгрузкой по скроллу, справа карточка выбранной строки.
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
  more: '', // '1' — от порога и больше
  less: '1', // '1' — от порога и меньше
  min_sum: '', // рубли, если диапазон задан полями вручную
  max_sum: '',
  sort: 'date',
  dir: 'desc',
  card: '', // выбранная карточка: r<id> — чек, i<id> — позиция
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
  if (state.view !== 'items') state.view = 'receipts';
  if (!['', 'day', 'week', 'month', 'year'].includes(state.period)) state.period = '';
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
 * Границы суммы. Чипс задаёт порог, галочки — в какую сторону он действует:
 * «и меньше» → не больше порога, «и больше» → не меньше. Если не отмечено ничего
 * или отмечено и то и другое, обе границы сходятся в точную сумму.
 * Поля «от — до» задают диапазон напрямую и отменяют чипс.
 */
function sumBounds() {
  if (!state.sum) return { min: state.min_sum, max: state.max_sum };
  const more = state.more === '1';
  const less = state.less === '1';
  if (more && !less) return { min: state.sum, max: '' };
  if (less && !more) return { min: '', max: state.sum };
  return { min: state.sum, max: state.sum };
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
  params.set('sort', state.sort);
  params.set('dir', state.dir);
  params.set('page', String(page));
  params.set('per', String(PER));
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
  $('thead').innerHTML = `<tr><th class="idx">#</th>${columns
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
      const card = prefix + row.id;
      const cells = columns.map((col) => `<td class="${col.cls ?? ''}">${col.render(row)}</td>`).join('');
      return `<tr class="clickable${card === state.card ? ' selected' : ''}" data-card="${card}">
        <td class="idx">${int.format(startIndex + i)}</td>${cells}</tr>`;
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

function renderFooter() {
  const noun =
    state.view === 'items'
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
        <div class="dim">${dateRu(r.purchased_at)} ${timeRu(r.purchased_at)}${r.operation_type === 2 ? ' · <span class="badge refund">возврат</span>' : ''}</div>
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

function itemCard(it) {
  return `
    <div class="card-head">
      <div>
        <div class="card-title">${money(it.sum)}</div>
        <div class="dim">${dateRu(it.purchased_at)} ${timeRu(it.purchased_at)}${it.operation_type === 2 ? ' · <span class="badge refund">возврат</span>' : ''}</div>
      </div>
      <button class="btn" type="button" data-close>✕</button>
    </div>
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
    <div class="card-section">Чек</div>
    <p><button class="btn" type="button" data-receipt="${it.receipt_id}">Открыть чек на ${money(it.receipt_total)}</button></p>
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
}

// ── события ──────────────────────────────────────────────

function syncControls() {
  $('f-q').value = state.q;
  const { from, to } = periodRange();
  $('f-from').value = from;
  $('f-to').value = to;
  const bounds = sumBounds();
  $('f-min').value = bounds.min;
  $('f-max').value = bounds.max;
  $('f-more').checked = state.more === '1';
  $('f-less').checked = state.less === '1';

  // сдвигать нечего, пока диапазон не задан
  $('period-prev').disabled = !from || !to;
  $('period-next').disabled = !from || !to;

  document.querySelectorAll('#chips-period .chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.period === state.period));
  });
  document.querySelectorAll('#chips-sum .chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.sum === state.sum));
  });

  $('page-title').textContent = state.view === 'items' ? 'Товары' : 'Чеки';
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.setAttribute('aria-current', String(item.dataset.view === state.view));
  });
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

  $('chips-sum').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) update({ sum: chip.dataset.sum, min_sum: '', max_sum: '' });
  });

  $('f-more').addEventListener('change', (e) => update({ more: e.target.checked ? '1' : '' }));
  $('f-less').addEventListener('change', (e) => update({ less: e.target.checked ? '1' : '' }));

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
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      if (state.view === view) return;
      // сортировка «по дате» есть в обоих разделах, остальные ключи не пересекаются
      const sort = COLUMNS[view].some((c) => c.sort === state.sort) ? state.sort : 'date';
      state.view = view;
      if (!state.card) renderCard(); // текст заглушки зависит от раздела
      update({ sort });
    });
  });

  $('thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const sort = th.dataset.sort;
    update({ sort, dir: state.sort === sort && state.dir === 'desc' ? 'asc' : 'desc' });
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
loadMeta();
renderCard();
reload();
