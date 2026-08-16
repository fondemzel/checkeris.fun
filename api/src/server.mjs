// HTTP-сервер кабинета: JSON API поверх SQLite + отдача статики из site/.
//
//   node api/src/server.mjs            → http://localhost:8787/cabinet
//   PORT=3000 node api/src/server.mjs
//
// Зависимостей нет: только встроенные модули Node.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { openDb, migrate, PROJECT_ROOT, API_ROOT, DB_PATH } from './db.mjs';
import {
  listReceipts,
  listItems,
  listItemGroups,
  getReceipt,
  getItem,
  getMeta,
  setItemCategory,
} from './queries.mjs';
import { loadCategories, syncCategories } from './categories.mjs';
import { findUser, verifyPassword, issueToken, userByToken, revokeToken, bearer, hasUsers } from './auth.mjs';
import {
  getTaxonomy,
  createGroup,
  updateGroup,
  deleteGroup,
  createCategory,
  updateCategory,
  deleteCategory,
  reorder,
} from './taxonomy.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const SITE_ROOT = resolve(process.env.CHECKER_SITE ?? join(PROJECT_ROOT, 'site'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Версия из package.json — по ней после выкладки видно, что на сервере свежий код
const VERSION = JSON.parse(readFileSync(join(API_ROOT, 'package.json'), 'utf8')).version;

const db = openDb();
migrate(db);

// Без пользователей API никого не пустит — предупреждаем сразу, а не при первом 401
if (!hasUsers(db)) {
  console.error('ВНИМАНИЕ: пользователей нет, войти в кабинет не получится.');
  console.error('  заведите первого: node api/src/users.mjs --add <логин> <пароль>');
}

// Справочник живёт в базе и правится в кабинете. Файл categories.json — начальное
// наполнение: заливаем его только в пустую базу, иначе перезапуск затирал бы правки
// из интерфейса. Осознанный переимпорт — categories.mjs --sync.
if (!db.prepare('SELECT COUNT(*) c FROM categories').get().c) {
  try {
    const { total, groups } = syncCategories(db, loadCategories());
    console.log(`справочник категорий залит из файла: ${groups} групп, ${total} подкатегорий`);
  } catch (err) {
    console.error('начальный справочник категорий не залит:', err.message);
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV для Excel: разделитель «;», десятичная запятая, BOM. */
function sendCsv(res, filename, header, rows) {
  const lines = [header.join(';'), ...rows.map((r) => r.map(csvCell).join(';'))];
  const body = Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(lines.join('\r\n'), 'utf8')]);
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': body.length,
  });
  res.end(body);
}

const money = (kopecks) => (Number(kopecks ?? 0) / 100).toFixed(2).replace('.', ',');

/** Тело запроса как JSON; лимит защищает от бесконечного потока. */
async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// коды ставок НДС из ФФД
const NDS_LABELS = { 1: '20%', 2: '10%', 3: '20/120', 4: '10/110', 5: '0%', 6: 'без НДС' };
const ndsLabel = (code) => NDS_LABELS[code] ?? (code == null ? '' : String(code));

async function serveStatic(req, res, pathname) {
  // /cabinet и /cabinet/ → site/cabinet/index.html
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  let filePath = resolve(join(SITE_ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, '')));
  if (!filePath.startsWith(SITE_ROOT + sep) && filePath !== SITE_ROOT) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  try {
    const info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) filePath = join(filePath, 'index.html');
    else if (!info && existsSync(`${filePath}.html`)) filePath = `${filePath}.html`;

    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 — страница не найдена');
  }
}

/**
 * Вход: логин и пароль → токен на 90 дней. Единственный эндпойнт без токена.
 * Задержка при неудаче — чтобы перебор паролей был дороже; сам scrypt и так медленный.
 */
async function handleToken(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: 'bad request body' });
  }

  const user = findUser(db, body.login);
  if (!user || !verifyPassword(String(body.password ?? ''), user.password)) {
    await new Promise((r) => setTimeout(r, 400));
    return sendJson(res, 401, { error: 'неверный логин или пароль' });
  }

  const { token, expires_at } = issueToken(db, user.id, String(body.label ?? '').trim() || null);
  return sendJson(res, 200, { token, expires_at, login: user.login });
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

  if (pathname === '/api/token') return handleToken(req, res);

  // Всё остальное — только по токену. Кабинет и телефон ходят одинаково.
  const user = userByToken(db, bearer(req));
  if (!user) return sendJson(res, 401, { error: 'нужен вход' });

  // Кабинет спрашивает при загрузке, жив ли сохранённый токен
  if (pathname === '/api/session') return sendJson(res, 200, { login: user.login });

  if (pathname === '/api/logout') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    revokeToken(db, bearer(req));
    return sendJson(res, 200, { ok: true });
  }

  // ── справочник категорий: правится из раздела «Категории» ──
  if (pathname === '/api/taxonomy') {
    if (req.method === 'GET') return sendJson(res, 200, getTaxonomy(db));
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  // Перестановка перетаскиванием: приходит весь новый порядок группы
  if (pathname === '/api/taxonomy/reorder') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    let body;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'bad request body' });
    }
    const result = reorder(db, body);
    return result.error ? sendJson(res, result.status ?? 400, result) : sendJson(res, 200, result);
  }

  const taxonomyMatch = pathname.match(/^\/api\/taxonomy\/(groups|categories)(?:\/(.+))?$/);
  if (taxonomyMatch) {
    const [, kind, slugRaw] = taxonomyMatch;
    const slug = slugRaw ? decodeURIComponent(slugRaw) : '';
    const isGroup = kind === 'groups';

    let body = {};
    if (req.method === 'POST' || req.method === 'PATCH') {
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'bad request body' });
      }
    }

    let result;
    if (req.method === 'POST' && !slug) result = (isGroup ? createGroup : createCategory)(db, body);
    else if (req.method === 'PATCH' && slug) result = (isGroup ? updateGroup : updateCategory)(db, slug, body);
    else if (req.method === 'DELETE' && slug) {
      result = isGroup ? deleteGroup(db, slug) : deleteCategory(db, slug, searchParams.get('move_to'));
    } else return sendJson(res, 405, { error: 'method not allowed' });

    return result.error
      ? sendJson(res, result.status ?? 400, result)
      : sendJson(res, 200, result);
  }

  // Категория товара из карточки — правка словаря, а не справочника
  const categoryMatch = pathname.match(/^\/api\/items\/(\d+)\/category$/);
  if (categoryMatch) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    let body;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'bad request body' });
    }
    const result = setItemCategory(db, Number(categoryMatch[1]), String(body.category ?? '').trim());
    return result.error
      ? sendJson(res, result.status ?? 400, { error: result.error })
      : sendJson(res, 200, result);
  }

  if (pathname === '/api/meta') return sendJson(res, 200, { version: VERSION, ...getMeta(db) });

  if (pathname === '/api/receipts') return sendJson(res, 200, listReceipts(db, searchParams));

  const receiptMatch = pathname.match(/^\/api\/receipts\/(\d+)$/);
  if (receiptMatch) {
    const receipt = getReceipt(db, Number(receiptMatch[1]));
    return receipt ? sendJson(res, 200, receipt) : sendJson(res, 404, { error: 'receipt not found' });
  }

  // collapse=1 — одна строка на название; раскрытие группы идёт обычным списком с name_norm
  if (pathname === '/api/items') {
    const collapse = searchParams.get('collapse') === '1' && !searchParams.get('name_norm');
    return sendJson(res, 200, (collapse ? listItemGroups : listItems)(db, searchParams));
  }

  const itemMatch = pathname.match(/^\/api\/items\/(\d+)$/);
  if (itemMatch) {
    const item = getItem(db, Number(itemMatch[1]));
    return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: 'item not found' });
  }

  if (pathname === '/api/export.csv') {
    const type = searchParams.get('type') === 'receipts' ? 'receipts' : 'items';
    const params = new URLSearchParams(searchParams);
    params.set('per', '500');
    if (type === 'receipts') {
      const rows = [];
      for (let page = 1; ; page += 1) {
        params.set('page', String(page));
        const chunk = listReceipts(db, params).rows;
        rows.push(...chunk);
        if (chunk.length < 500 || rows.length >= 50000) break;
      }
      return sendCsv(
        res,
        'receipts.csv',
        ['Дата', 'Время', 'Продавец', 'ИНН', 'Точка', 'Позиций', 'Сумма, ₽', 'Наличными, ₽', 'Картой, ₽', 'Операция'],
        rows.map((r) => [
          r.purchased_date,
          r.purchased_at.slice(11, 16),
          r.seller,
          r.seller_inn,
          r.retail_place,
          r.item_count,
          money(r.total_sum),
          money(r.cash_sum),
          money(r.ecash_sum),
          r.operation_type === 2 ? 'возврат' : 'приход',
        ]),
      );
    }
    const rows = [];
    for (let page = 1; ; page += 1) {
      params.set('page', String(page));
      const chunk = listItems(db, params).rows;
      rows.push(...chunk);
      if (chunk.length < 500 || rows.length >= 50000) break;
    }
    return sendCsv(
      res,
      'items.csv',
      ['Дата', 'Время', 'Товар', 'Кол-во', 'Цена, ₽', 'Сумма, ₽', 'НДС', 'GTIN', 'Продавец', 'ИНН', 'Точка', 'Чек'],
      rows.map((r) => [
        r.purchased_date,
        r.purchased_at.slice(11, 16),
        r.name,
        String(r.quantity).replace('.', ','),
        money(r.price),
        money(r.sum),
        ndsLabel(r.nds),
        r.gtin ?? '',
        r.seller,
        r.seller_inn,
        r.retail_place,
        r.receipt_id,
      ]),
    );
  }

  return sendJson(res, 404, { error: 'unknown endpoint' });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  // Статика только на чтение; POST разбирается внутри handleApi
  if (req.method !== 'GET' && req.method !== 'HEAD' && !url.pathname.startsWith('/api/')) {
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(`${req.method} ${req.url} →`, err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const { stats } = getMeta(db);
  console.log(`Кабинет:  http://${HOST}:${PORT}/cabinet`);
  console.log(`API:      http://${HOST}:${PORT}/api/meta`);
  console.log(`База:     ${DB_PATH}`);
  console.log(`Статика:  ${SITE_ROOT}`);
  console.log(`Данные:   чеков ${stats.receipts}, позиций ${stats.items}, период ${stats.date_from ?? '—'} — ${stats.date_to ?? '—'}`);
  if (!stats.receipts) console.log('\nБаза пустая — запустите: node api/src/import.mjs');
});
