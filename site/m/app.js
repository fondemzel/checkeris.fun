// Мобильный кабинет: сводка за месяц → группа → категория → позиция.
//
// Это не уменьшенный десктопный кабинет, а другой инструмент на тех же данных.
// Десктоп нужен для разбора: 24 тысячи строк, сортировки, справочник. Телефон
// отвечает на два вопроса — сколько ушло и на что, — и даёт поправить категорию.
//
// Клиент намеренно маленький и самодостаточный: именно его предстоит повторить
// в приложении на Rust, поэтому вся логика здесь про экраны, а всё, что можно
// посчитать в базе, считает сервер (/api/summary).
import { groupIcon } from '/shared/icons.js';
import { shades, tint, edge, readableText } from '/shared/colors.js';

const $ = (id) => document.getElementById(id);
const rub = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
const rubExact = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('ru-RU');

const money = (k, exact = false) => (exact ? rubExact : rub).format(Number(k ?? 0) / 100);
const dateRu = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '');
const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

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

// ── состояние ────────────────────────────────────────────

let meta = null;
const state = {
  month: new Date().toISOString().slice(0, 7),
  screen: 'summary', // summary | group | category | item | scan
  group: '',
  category: '',
  item: '',
};

/** Границы выбранного месяца: сводка и списки живут в одном периоде. */
function monthRange(month = state.month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

const shiftMonth = (month, delta) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const monthTitle = (month) => {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};

const findGroup = (slug) => (meta?.categories ?? []).find((g) => g.slug === slug) ?? null;

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
  const params = new URLSearchParams({ screen: state.screen, month: state.month });
  if (state.group) params.set('group', state.group);
  if (state.category) params.set('category', state.category);
  if (state.item) params.set('item', state.item);
  history[replace ? 'replaceState' : 'pushState']({ ...state }, '', `?${params}`);
  render();
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.screen = ['summary', 'group', 'category', 'item', 'scan'].includes(p.get('screen')) ? p.get('screen') : 'summary';
  if (/^\d{4}-\d{2}$/.test(p.get('month') ?? '')) state.month = p.get('month');
  state.group = p.get('group') ?? '';
  state.category = p.get('category') ?? '';
  state.item = p.get('item') ?? '';
}

window.addEventListener('popstate', (e) => {
  if (e.state) Object.assign(state, e.state);
  else readUrl();
  render();
});

// ── экраны ───────────────────────────────────────────────

const loading = () => '<div class="empty">Загрузка…</div>';
const failed = (err) => `<div class="empty error">${esc(err.message)}</div>`;

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

async function screenSummary() {
  const { from, to } = monthRange();
  const data = await api(`/api/summary?by=group&from=${from}&to=${to}`);
  const max = Math.max(1, ...data.rows.map((r) => r.sum));

  const nav = `
    <div class="month">
      <button class="month-arrow" type="button" data-month="-1" aria-label="Предыдущий месяц">‹</button>
      <span class="month-name">${monthTitle(state.month)}</span>
      <button class="month-arrow" type="button" data-month="1" aria-label="Следующий месяц">›</button>
    </div>
    <div class="total">
      <span class="total-sum">${money(data.totals.sum)}</span>
      <span class="total-note">${int.format(data.totals.receipts)} ${plural(data.totals.receipts, 'чек', 'чека', 'чеков')} ·
        ${int.format(data.totals.count)} ${plural(data.totals.count, 'позиция', 'позиции', 'позиций')}</span>
    </div>`;

  if (!data.rows.length) return `${nav}<div class="empty">За этот месяц трат нет</div>`;

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

  return `${nav}<div class="list">${rows}</div>` +
    '<button class="fab" type="button" data-screen="scan" aria-label="Сканировать чек">+</button>';
}

async function screenGroup() {
  const { from, to } = monthRange();
  const data = await api(`/api/summary?by=category&group=${encodeURIComponent(state.group)}&from=${from}&to=${to}`);
  const g = findGroup(state.group);
  const max = Math.max(1, ...data.rows.map((r) => r.sum));

  const head = `
    <div class="total">
      <span class="total-sum">${money(data.totals.sum)}</span>
      <span class="total-note">${monthTitle(state.month)} · ${esc(g?.name ?? '')}</span>
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
  const { from, to } = monthRange();
  const params = new URLSearchParams({ from, to, collapse: '1', sort: 'sum', dir: 'desc', per: '100' });
  if (state.category) params.set('category', state.category);
  else params.set('group', state.group);

  const data = await api(`/api/items?${params}`);
  const name = state.category
    ? findGroup(state.group)?.subcategories.find((s) => s.slug === state.category)?.name
    : findGroup(state.group)?.name;

  const head = `
    <div class="total">
      <span class="total-sum">${money(data.totals.sum)}</span>
      <span class="total-note">${monthTitle(state.month)} · ${esc(name ?? '')}</span>
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
        ['Дата', `${dateRu(it.purchased_at)} ${esc(it.purchased_at.slice(11, 16))}`],
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

// ── сканирование ─────────────────────────────────────────
// QR чека содержит только реквизиты, позиции запрашиваются у ФНС, а обмен там
// асинхронный. Поэтому экран не ждёт ответа: скан уходит в очередь на сервере,
// а мы показываем, как он продвигается.

let camera = null; // активный поток, чтобы погасить его при уходе с экрана

function stopCamera() {
  if (!camera) return;
  camera.stop = true;
  camera.stream?.getTracks().forEach((t) => t.stop());
  camera = null;
}

const scanSupported = () => 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);

async function screenScan() {
  const { jobs, usage } = await api('/api/scan');
  const rows = jobs.length
    ? jobs
        .slice(0, 8)
        .map(
          (j) => `
          <div class="scan-row"${j.receipt_id ? ` data-receipt="${j.receipt_id}"` : ''}>
            <span class="scan-dot ${esc(j.status)}"></span>
            <span class="row-main">
              <span class="row-title">${esc(scanTitle(j))}</span>
              <span class="row-note">${dateRu(j.purchased_at)} · ${esc(scanState(j))}</span>
            </span>
            <span class="row-sum">${money(j.total_sum)}</span>
          </div>`,
        )
        .join('')
    : '<p class="note">Пока ничего не сканировали</p>';

  return `
    <div class="scan-view" id="scan-view" hidden>
      <video id="scan-video" playsinline muted autoplay></video>
      <span class="scan-frame"></span>
    </div>

    <button class="btn primary big" id="scan-start">Навести камеру на чек</button>
    <p class="note" id="scan-note">${
      scanSupported()
        ? 'Наведите на QR-код внизу чека'
        : 'Браузер не умеет читать QR — введите строку из чека вручную'
    }</p>

    <div id="scan-result"></div>

    <details class="card scan-manual"${scanSupported() ? '' : ' open'}>
      <summary>Ввести строку вручную</summary>
      <textarea id="scan-text" rows="3" placeholder="t=20250514T1830&amp;s=1234.00&amp;fn=…&amp;i=…&amp;fp=…&amp;n=1"></textarea>
      <button class="btn" id="scan-send">Отправить</button>
    </details>

    <div class="card">
      <div class="card-label">Последние сканы</div>
      ${rows}
      <p class="note">Запросов к ФНС сегодня: ${int.format(usage.calls)} из ${int.format(usage.limit)}</p>
    </div>`;
}

const scanTitle = (job) => (job.receipt_id ? `Чек №${job.receipt_id}` : `ФД ${job.fiscal_doc}`);

const scanState = (job) =>
  ({
    new: 'в очереди',
    sent: 'ждём ответа ФНС',
    done: 'готово',
    failed: job.error ? `не вышло: ${job.error}` : 'не вышло',
  })[job.status] ?? job.status;

/** Отправка распознанной строки и слежение за заданием до готовности. */
async function submitScan(qr) {
  const box = $('scan-result');
  box.innerHTML = '<div class="card"><p class="note">Отправляем…</p></div>';

  let job;
  try {
    const data = await api('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qr }),
    });
    job = data.job;
    if (data.known) {
      box.innerHTML = '<div class="card"><p class="note">Этот чек уже был в базе</p></div>';
      return;
    }
  } catch (err) {
    box.innerHTML = `<div class="card"><p class="note error">${esc(err.message)}</p></div>`;
    return;
  }

  // Ответ ФНС приходит за несколько секунд, но бывает и дольше — спрашиваем с паузой
  for (let i = 0; i < 30; i += 1) {
    box.innerHTML = `<div class="card"><p class="note">${esc(scanState(job))}…</p></div>`;
    if (job.status === 'done' || job.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 2000));
    try {
      ({ job } = await api(`/api/scan/${job.id}`));
    } catch {
      break;
    }
  }

  if (job.status === 'done' && job.receipt_id) {
    box.innerHTML = '';
    await openReceiptSheet(job.receipt_id);
  } else if (job.status === 'failed') {
    box.innerHTML = `<div class="card"><p class="note error">${esc(scanState(job))}</p></div>`;
  }
  render();
}

/** Камера и поиск QR в кадре. Разрешение спрашивается по нажатию, а не при входе. */
async function startCamera() {
  if (!scanSupported()) return;
  stopCamera();

  const view = $('scan-view');
  const video = $('scan-video');
  const note = $('scan-note');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    camera = { stream, stop: false };
    video.srcObject = stream;
    await video.play();
    view.hidden = false;
    $('scan-start').hidden = true;
    note.textContent = 'Ищем QR-код…';
  } catch (err) {
    note.textContent = `Камера недоступна: ${err.message}`;
    note.classList.add('error');
    return;
  }

  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const current = camera;

  while (camera === current && !current.stop) {
    try {
      const found = await detector.detect(video);
      const qr = found.find((c) => /(^|[?&])fn=/.test(c.rawValue ?? ''));
      if (qr) {
        navigator.vibrate?.(60);
        stopCamera();
        view.hidden = true;
        $('scan-start').hidden = false;
        note.textContent = 'Код прочитан';
        await submitScan(qr.rawValue);
        return;
      }
    } catch {
      /* кадр не разобрался — просто пробуем следующий */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ── разбор чека после сканирования ───────────────────────
// Модель угадывает категорию, но угадывает не всегда. Показываем разобранный чек
// сразу после распознавания: согласиться — ничего не делать, поправить — один выбор.
// Правка уходит в словарь и распространяется на все позиции с таким же названием,
// поэтому следующий такой чек разберётся уже правильно.

/** Один список с заголовками групп: два выпадающих списка подряд на телефоне неудобны. */
function categorySelect(item) {
  const groups = meta?.categories ?? [];
  const current = item.category_slug ?? '';
  const option = (slug, label) =>
    `<option value="${esc(slug)}"${slug === current ? ' selected' : ''}>${esc(label)}</option>`;

  return (
    `<select class="pick" data-item="${item.id}">` +
    option('', '— не определена —') +
    groups
      .map(
        (g) =>
          `<optgroup label="${esc(g.name)}">${g.subcategories.map((s) => option(s.slug, s.name)).join('')}</optgroup>`,
      )
      .join('') +
    '</select>'
  );
}

function sheetRow(item) {
  const color = categoryColor(item.group_slug, item.category_slug);
  const guess = item.category_source === 'manual' ? '' : ' guess';
  return `
    <div class="sheet-row" data-row="${item.id}">
      <div class="sheet-head">
        <span class="dot${guess}" style="background:${color ?? '#eef1f5'}"></span>
        <span class="sheet-name">${esc(item.name)}</span>
        <span class="sheet-sum">${money(item.sum, true)}</span>
      </div>
      ${categorySelect(item)}
    </div>`;
}

async function openReceiptSheet(receiptId) {
  const receipt = await api(`/api/receipts/${receiptId}`).catch(() => null);
  if (!receipt) return;

  const unknown = receipt.items.filter((i) => !i.category_slug).length;
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `
    <div class="sheet-box" role="dialog" aria-label="Разбор чека">
      <div class="sheet-top">
        <div>
          <div class="sheet-sum-total">${money(receipt.total_sum, true)}</div>
          <div class="note">${esc(receipt.seller ?? '')}</div>
        </div>
        <button class="btn" data-close type="button">Готово</button>
      </div>
      <p class="note sheet-hint">${
        unknown
          ? `${int.format(unknown)} ${plural(unknown, 'позиция', 'позиции', 'позиций')} без категории — выберите вручную`
          : 'Категории проставлены автоматически. Если ошиблись — поправьте'
      }</p>
      <div class="sheet-list">${receipt.items.map(sheetRow).join('')}</div>
    </div>`;

  document.body.appendChild(sheet);

  sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === sheet) {
      sheet.remove();
      render(); // сводка могла измениться
    }
  });

  sheet.addEventListener('change', async (e) => {
    const select = e.target.closest('.pick');
    if (!select) return;
    const row = select.closest('.sheet-row');
    select.disabled = true;
    try {
      const data = await api(`/api/items/${select.dataset.item}/category`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: select.value }),
      });
      // Ручной выбор — уже не догадка: точка становится сплошной и меняет цвет
      const group = (meta?.categories ?? []).find((g) => g.subcategories.some((s) => s.slug === select.value));
      const dot = row.querySelector('.dot');
      dot.classList.remove('guess');
      dot.style.background = categoryColor(group?.slug, select.value) ?? '#eef1f5';
      row.classList.add('picked');
      if (data.affected > 1) {
        row.querySelector('.sheet-name').insertAdjacentHTML(
          'afterend',
          `<span class="sheet-applied">и ещё ${int.format(data.affected - 1)}</span>`,
        );
      }
      meta = await api('/api/meta');
    } catch (err) {
      row.insertAdjacentHTML('beforeend', `<p class="note error">${esc(err.message)}</p>`);
    } finally {
      select.disabled = false;
    }
  });
}

const SCREENS = {
  summary: { title: 'Расходы', render: screenSummary },
  scan: { title: 'Сканировать', render: screenScan },
  group: { title: () => findGroup(state.group)?.name ?? 'Группа', render: screenGroup },
  category: { title: 'Позиции', render: screenCategory },
  item: { title: 'Товар', render: screenItem },
};

let renderSeq = 0;

async function render() {
  const seq = ++renderSeq;
  stopCamera(); // уходим с экрана — гасим поток, иначе камера остаётся включённой
  const screen = SCREENS[state.screen] ?? SCREENS.summary;
  $('title').textContent = typeof screen.title === 'function' ? screen.title() : screen.title;
  $('back').hidden = state.screen === 'summary';
  $('screen').innerHTML = loading();

  try {
    const html = await screen.render();
    if (seq === renderSeq) $('screen').innerHTML = html;
  } catch (err) {
    if (seq === renderSeq) $('screen').innerHTML = failed(err);
  }
}

// ── события ──────────────────────────────────────────────

$('screen').addEventListener('click', (e) => {
  const month = e.target.closest('[data-month]');
  if (month) return go({ month: shiftMonth(state.month, Number(month.dataset.month)) }, true);

  const group = e.target.closest('[data-group]');
  if (group) return go({ screen: 'group', group: group.dataset.group, category: '' });

  const category = e.target.closest('[data-category]');
  if (category) return go({ screen: 'category', category: category.dataset.category });

  const item = e.target.closest('[data-item]');
  if (item) return go({ screen: 'item', item: item.dataset.item });

  const screen = e.target.closest('[data-screen]');
  if (screen) return go({ screen: screen.dataset.screen });

  const scanRow = e.target.closest('[data-receipt]');
  if (scanRow) return openReceiptSheet(Number(scanRow.dataset.receipt));

  if (e.target.closest('#scan-start')) return startCamera();
  if (e.target.closest('#scan-send')) {
    const value = $('scan-text').value.trim();
    if (value) submitScan(value);
  }
});

// Смена категории: группа перезаполняет второй список, выбор категории сохраняет
$('screen').addEventListener('change', async (e) => {
  const card = e.target.closest('[data-item-card]');
  if (!card) return;

  if (e.target.id === 'pick-group') {
    const subs = (meta?.categories ?? []).find((g) => g.slug === e.target.value)?.subcategories ?? [];
    $('pick-category').innerHTML =
      '<option value="">— не выбрана —</option>' +
      subs.map((s) => `<option value="${esc(s.slug)}">${esc(s.name)}</option>`).join('');
    return;
  }

  if (e.target.id !== 'pick-category') return;
  const note = $('pick-note');
  note.textContent = 'Сохранение…';
  try {
    const data = await api(`/api/items/${card.dataset.itemCard}/category`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: e.target.value }),
    });
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

$('logout').addEventListener('click', async () => {
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
  meta = await api('/api/meta');

  // Пустой месяц на старте — не повод показывать ноль: открываем последний с данными
  if (!new URLSearchParams(location.search).get('month') && meta.stats.date_to) {
    state.month = meta.stats.date_to.slice(0, 7);
  }
  go({}, true);
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
