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
  summary,
  getReceipt,
  getItem,
  getMeta,
  setItemCategory,
} from './queries.mjs';
import { loadCategories, syncCategories } from './categories.mjs';
import { findUser, verifyPassword, issueToken, userByToken, revokeToken, bearer, hasUsers } from './auth.mjs';
import { addScan, getScan, listScans, retryScan, deleteScan, runScanQueue } from './scan.mjs';
import { addManual, deleteManual } from './import_manual.mjs';
import { fnsReady, fnsUsage } from './fns.mjs';
import { geocoderReady, runGeocoder } from './geocoder.mjs';
import {
  banksReady, keepAlive, syncAll, takeOutbox, importOps, listLinks, unlink, listBankOps, forgetBank, getBankOp,
} from './banks.mjs';
import { bankTotals, matchBank, setOpCategory } from './bankmatch.mjs';
import { loadEnv } from './llm.mjs';
import {
  telegramReady,
  startLogin,
  pollLogin,
  describeLogin,
  prepareLogin,
  confirmLogin,
  confirmLink,
  verifyRelay,
  noteBotMessage,
} from './telegram.mjs';
import { scanQuota } from './quota.mjs';
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
import {
  ensureBudget,
  getBudget,
  renameBudget,
  createInvite,
  revokeInvite,
  describeInvite,
  acceptInvite,
  leaveBudget,
  removeMember,
  deleteAccount,
} from './budgets.mjs';

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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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

// Системный справочник живёт в базе. Файл categories.json — начальное наполнение:
// заливаем его только в пустую базу, иначе перезапуск затирал бы правки администратора.
// Осознанный переимпорт — categories.mjs --sync.
if (!db.prepare('SELECT COUNT(*) c FROM sys_categories').get().c) {
  try {
    const { total, groups } = syncCategories(db, loadCategories());
    console.log(`системный справочник залит из файла: ${groups} групп, ${total} подкатегорий`);
  } catch (err) {
    console.error('системный справочник не залит:', err.message);
  }
}

// У каждого пользователя есть бюджет со справочником. Если кого-то завели без него
// (раньше бюджетов или когда системного справочника ещё не было) — выдаём сейчас
for (const { id } of db.prepare('SELECT id FROM users WHERE budget_id IS NULL').all()) {
  console.log(`пользователю #${id} выдан бюджет #${ensureBudget(db, id)}`);
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

/** Тело запроса как текст; лимит защищает от бесконечного потока. */
async function readRaw(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Тело запроса как JSON. */
async function readJson(req, limit) {
  const raw = await readRaw(req, limit);
  return raw ? JSON.parse(raw) : {};
}

// Адрес клиента: сервер стоит за nginx, настоящий адрес приходит в X-Real-IP
const clientIp = (req) => String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '');

/**
 * Ограничение частоты по адресу для открытых ручек. В памяти: процесс один,
 * а сброс при перезапуске не страшен — это защита от перебора, не учёт.
 */
const hits = new Map();
function tooOften(key, limit, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return recent.length > limit;
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

  // Открыто наружу: по нему выкладка проверяет, что поднялась нужная версия.
  // Данных здесь нет — только номер и есть ли кому входить.
  if (pathname === '/api/version') return sendJson(res, 200, { version: VERSION, users: hasUsers(db) });

  if (pathname === '/api/token') {
    if (tooOften(`token:${clientIp(req)}`, 20, 10 * 60_000)) return sendJson(res, 429, { error: 'слишком много попыток, подождите' });
    return handleToken(req, res);
  }

  // ── вход через Telegram ──
  // Начало: браузер получает одноразовый код. С токеном и link=true — привязка
  // Telegram к уже вошедшему аккаунту, а не вход
  if (pathname === '/api/auth/telegram/start') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    if (!telegramReady()) return sendJson(res, 503, { error: 'вход через Telegram не настроен' });
    if (tooOften(`tg:${clientIp(req)}`, 20, 10 * 60_000)) return sendJson(res, 429, { error: 'слишком много попыток, подождите' });
    let body = {};
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'bad request body' });
    }
    let linkUserId = null;
    if (body.link) {
      const me = userByToken(db, bearer(req));
      if (!me) return sendJson(res, 401, { error: 'нужен вход' });
      linkUserId = me.id;
    }
    return sendJson(
      res,
      200,
      startLogin(db, { ua: req.headers['user-agent'], ip: clientIp(req), linkUserId, client: body.client }),
    );
  }

  // Подтверждение со страницы, открытой ссылкой «Войти» в сообщении бота
  if (pathname === '/api/auth/telegram/confirm-link') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    if (tooOften(`tgc:${clientIp(req)}`, 30, 10 * 60_000)) return sendJson(res, 429, { error: 'слишком много попыток, подождите' });
    let body = {};
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'bad request body' });
    }
    return sendJson(res, 200, confirmLink(db, body));
  }

  // Опрос: пока человек не подтвердил в боте — pending, потом один раз токен
  if (pathname === '/api/auth/telegram/poll') {
    const result = pollLogin(db, searchParams.get('nonce'));
    return sendJson(res, result.status === 'unknown' ? 404 : 200, result);
  }

  // Бот с зарубежного сервера. Открыто наружу, но без верной подписи не принимается
  if (['/api/telegram/describe', '/api/telegram/prepare', '/api/telegram/confirm', '/api/telegram/outbox',
       '/api/telegram/sent'].includes(pathname)) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    let raw;
    let body;
    try {
      raw = await readRaw(req);
      body = JSON.parse(raw || '{}');
    } catch {
      return sendJson(res, 400, { error: 'bad request body' });
    }
    if (!verifyRelay(req.headers['x-checker-ts'], req.headers['x-checker-signature'], raw)) {
      return sendJson(res, 401, { error: 'bad signature' });
    }
    // Сообщения, которые Чекер хочет отправить людям: бот забирает их и отправляет сам
    if (pathname.endsWith('/outbox')) return sendJson(res, 200, { messages: takeOutbox(db) });
    if (pathname.endsWith('/sent')) return sendJson(res, 200, noteBotMessage(db, body));
    return sendJson(
      res,
      200,
      pathname.endsWith('/describe')
        ? describeLogin(db, body.nonce)
        : pathname.endsWith('/prepare')
          ? prepareLogin(db, body)
          : confirmLogin(db, body),
    );
  }

  // Всё остальное — только по токену. Кабинет и телефон ходят одинаково.
  const user = userByToken(db, bearer(req));
  if (!user) return sendJson(res, 401, { error: 'нужен вход' });
  // Бюджет мог пропасть (удалён вместе с последним участником) — выдаём свой
  if (!user.budget_id) user.budget_id = ensureBudget(db, user.id);

  // Кабинет спрашивает при загрузке, жив ли сохранённый токен
  if (pathname === '/api/session') {
    // Своё имя вместо имени из Telegram: его видят участники общего бюджета
    if (req.method === 'PATCH') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'bad request body' });
      }
      const name = String(body.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!name) return sendJson(res, 400, { error: 'нужно имя' });
      db.prepare('UPDATE users SET name = ?, name_set = 1 WHERE id = ?').run(name, user.id);
      return sendJson(res, 200, { name });
    }
    return sendJson(res, 200, {
      login: user.login,
      name: user.name ?? user.login,
      role: user.role,
      telegram: user.telegram,
      telegram_login: telegramReady(),
    });
  }

  // Удаление аккаунта самим пользователем. Всё его — чеки, сканы, справочник, правки,
  // токены — уходит каскадом внешних ключей одним запросом. Администратора так не удалить:
  // одно неосторожное нажатие не должно стирать владельца проекта
  if (pathname === '/api/account') {
    if (req.method !== 'DELETE') return sendJson(res, 405, { error: 'method not allowed' });
    if (user.role === 'admin') return sendJson(res, 403, { error: 'аккаунт администратора удаляется только из консоли' });
    const result = deleteAccount(db, user.id);
    return result.error ? sendJson(res, result.status ?? 400, result) : sendJson(res, 200, result);
  }

  if (pathname === '/api/logout') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    revokeToken(db, bearer(req));
    return sendJson(res, 200, { ok: true });
  }

  // ── банк на телефоне ──
  // Вход в интернет-банк человек делает сам, в приложении на своём устройстве; сюда
  // приезжают уже готовые операции. Сессии банка на сервере нет.
  if (pathname === '/api/bank' || pathname.startsWith('/api/bank/')) {
    if (pathname === '/api/bank' && req.method === 'GET') {
      const p = url.searchParams;
      const period = p.get('from') && p.get('to') ? bankTotals(db, user.budget_id, p.get('from'), p.get('to')) : null;
      return sendJson(res, 200, { links: listLinks(db, user.id), totals: period });
    }
    if (pathname === '/api/bank' && req.method === 'DELETE') {
      return sendJson(res, 200, unlink(db, user.id, String(url.searchParams.get('bank') ?? 'tbank')));
    }
    // Одна операция — для её карточки
    const opOne = pathname.match(/^\/api\/bank\/ops\/(\d+)$/);
    if (opOne && req.method === 'GET') {
      const op = getBankOp(db, user.budget_id, Number(opOne[1]));
      return op ? sendJson(res, 200, op) : sendJson(res, 404, { error: 'operation not found' });
    }

    // Категория траты без чека: выбор человека запоминается для этого продавца
    const opCategory = pathname.match(/^\/api\/bank\/ops\/(\d+)\/category$/);
    if (opCategory && req.method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'bad request body' });
      }
      const result = setOpCategory(db, user.budget_id, Number(opCategory[1]), String(body.category ?? '').trim());
      return result.error ? sendJson(res, result.status ?? 400, result) : sendJson(res, 200, result);
    }

    if (pathname === '/api/bank/ops' && req.method === 'GET') {
      const p = url.searchParams;
      return sendJson(res, 200, listBankOps(db, user.budget_id, {
        from: p.get('from'),
        to: p.get('to'),
        direction: p.get('direction') ?? 'debit',
        kind: p.get('kind'),
        group: p.get('group'),
        category: p.get('category'),
        sort: p.get('sort') ?? 'date',
        dir: p.get('dir') ?? 'desc',
        per: Math.min(500, Number(p.get('per')) || 200),
        page: Math.max(1, Number(p.get('page')) || 1),
      }));
    }

    // Удалить загруженное из банка: операции уходят вместе с подключением
    if (pathname === '/api/bank/ops' && req.method === 'DELETE') {
      const bank = String(url.searchParams.get('bank') ?? 'tbank');
      return sendJson(res, 200, forgetBank(db, user.id, bank));
    }

    if (pathname === '/api/bank/ops' && req.method === 'POST') {
      let body;
      try {
        body = await readJson(req, 8 * 1024 * 1024); // чек-лист операций за 90 дней — это мегабайты
      } catch {
        return sendJson(res, 400, { error: 'bad request body' });
      }
      const bank = /^[a-z]{2,20}$/.test(body.bank ?? '') ? body.bank : 'tbank';
      try {
        return sendJson(res, 200, importOps(db, user.id, bank, body.ops));
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  // ── бюджет: состав, приглашения, выход ──
  if (pathname.startsWith('/api/budget') || pathname.startsWith('/api/invites/')) {
    let body = {};
    if (req.method === 'POST' || req.method === 'PATCH') {
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'bad request body' });
      }
    }
    // Адрес для ссылки приглашения: за nginx настоящий хост приходит в Host
    const origin = `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers.host}`;
    const inviteMatch = pathname.match(/^\/api\/invites\/([\w-]{10,64})(\/accept)?$/);
    const memberMatch = pathname.match(/^\/api\/budget\/members\/(\d+)$/);
    const revokeMatch = pathname.match(/^\/api\/budget\/invites\/(\d+)$/);

    let result;
    if (pathname === '/api/budget' && req.method === 'GET') result = getBudget(db, user);
    else if (pathname === '/api/budget' && req.method === 'PATCH') result = renameBudget(db, user, body.name);
    else if (pathname === '/api/budget/invites' && req.method === 'POST') result = createInvite(db, user, origin);
    else if (revokeMatch && req.method === 'DELETE') result = revokeInvite(db, user, Number(revokeMatch[1]));
    else if (pathname === '/api/budget/leave' && req.method === 'POST') result = leaveBudget(db, user);
    else if (memberMatch && req.method === 'DELETE') result = removeMember(db, user, Number(memberMatch[1]));
    else if (inviteMatch && !inviteMatch[2] && req.method === 'GET') result = describeInvite(db, user, inviteMatch[1]);
    else if (inviteMatch && inviteMatch[2] && req.method === 'POST') {
      result = acceptInvite(db, user, inviteMatch[1], { move: Boolean(body.move) });
    } else return sendJson(res, 404, { error: 'unknown endpoint' });

    return result.error ? sendJson(res, result.status ?? 400, result) : sendJson(res, 200, result);
  }

  // ── справочник категорий: правится из раздела «Категории» ──
  if (pathname === '/api/taxonomy') {
    if (req.method === 'GET') return sendJson(res, 200, getTaxonomy(db, user.budget_id));
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
    const result = reorder(db, user.budget_id, body);
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
    if (req.method === 'POST' && !slug) result = (isGroup ? createGroup : createCategory)(db, user.budget_id, body);
    else if (req.method === 'PATCH' && slug) result = (isGroup ? updateGroup : updateCategory)(db, user.budget_id, slug, body);
    else if (req.method === 'DELETE' && slug) {
      result = isGroup ? deleteGroup(db, user.budget_id, slug) : deleteCategory(db, user.budget_id, slug, searchParams.get('move_to'));
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
    const result = setItemCategory(db, user.budget_id, Number(categoryMatch[1]), String(body.category ?? '').trim());
    return result.error
      ? sendJson(res, result.status ?? 400, { error: result.error })
      : sendJson(res, 200, result);
  }

  if (pathname === '/api/meta') {
    // Ключ карт — браузерный, он и так виден в запросах к Яндексу; ограничен адресом сайта
    // в кабинете разработчика Яндекса
    loadEnv();
    const maps = process.env.YANDEX_JAVASCRIPT_API_KEY ? { key: process.env.YANDEX_JAVASCRIPT_API_KEY } : null;
    return sendJson(res, 200, { version: VERSION, ...getMeta(db, user.budget_id), maps });
  }

  // ── сканирование чеков ──
  // Приём скана: строка QR кладётся в очередь, ответ ФНС приезжает фоном.
  if (pathname === '/api/scan') {
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'bad request body' });
      }
      if (!fnsReady()) return sendJson(res, 503, { error: 'доступ к ФНС не настроен' });
      const quota = scanQuota(db, user);
      if (quota.left <= 0) {
        return sendJson(res, 429, { error: `на сегодня сканов больше нет (${quota.limit} в сутки) — завтра снова можно` });
      }

      const result = addScan(db, user.budget_id, user.id, body.qr);
      if (result.error) return sendJson(res, result.status ?? 400, { error: result.error });

      runScanQueue(db); // не ждём: клиент опрашивает состояние сам
      return sendJson(res, 200, { ...result, usage: fnsUsage(db) });
    }
    // Сканы без чека: ?state=failed | pending, без него — и те и другие
    if (req.method === 'GET') {
      return sendJson(res, 200, { ...listScans(db, user.budget_id, searchParams.get('state') ?? ''), usage: fnsUsage(db) });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  const scanMatch = pathname.match(/^\/api\/scan\/(\d+)(\/retry)?$/);
  if (scanMatch) {
    const id = Number(scanMatch[1]);
    let result;
    if (scanMatch[2]) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      result = retryScan(db, user.budget_id, id);
      if (!result.error) runScanQueue(db);
    } else if (req.method === 'DELETE') {
      result = deleteScan(db, user.budget_id, id);
    } else {
      const job = getScan(db, user.budget_id, id);
      return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { error: 'скан не найден' });
    }
    return result.error ? sendJson(res, result.status ?? 400, { error: result.error }) : sendJson(res, 200, result);
  }

  // Трата без чека, вбитая с телефона
  if (pathname === '/api/manual') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    let body;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'bad request body' });
    }
    const result = addManual(db, user.budget_id, body, user.id);
    return result.error ? sendJson(res, result.status ?? 400, { error: result.error }) : sendJson(res, 200, result);
  }

  // Сводка: сколько и на что. Главный запрос телефона — один вместо выкачивания строк
  if (pathname === '/api/summary') return sendJson(res, 200, summary(db, user.budget_id, searchParams));

  if (pathname === '/api/receipts') return sendJson(res, 200, listReceipts(db, user.budget_id, searchParams));

  const receiptMatch = pathname.match(/^\/api\/receipts\/(\d+)$/);
  if (receiptMatch && req.method === 'DELETE') {
    const result = deleteManual(db, user.budget_id, Number(receiptMatch[1]));
    return result.error ? sendJson(res, result.status ?? 400, { error: result.error }) : sendJson(res, 200, result);
  }
  if (receiptMatch) {
    const receipt = getReceipt(db, user.budget_id, Number(receiptMatch[1]));
    return receipt ? sendJson(res, 200, receipt) : sendJson(res, 404, { error: 'receipt not found' });
  }

  // collapse=1 — одна строка на название; раскрытие группы идёт обычным списком с name_norm
  if (pathname === '/api/items') {
    const collapse = searchParams.get('collapse') === '1' && !searchParams.get('name_norm');
    return sendJson(res, 200, (collapse ? listItemGroups : listItems)(db, user.budget_id, searchParams));
  }

  const itemMatch = pathname.match(/^\/api\/items\/(\d+)$/);
  if (itemMatch) {
    const item = getItem(db, user.budget_id, Number(itemMatch[1]));
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
        const chunk = listReceipts(db, user.budget_id, params).rows;
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
      const chunk = listItems(db, user.budget_id, params).rows;
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

// Очередь сканов: раз в пять секунд смотрим, кому пришло время. Тик дешёвый —
// без заданий это один запрос к индексу, обращений к ФНС он не тратит.
if (fnsReady()) {
  setInterval(() => {
    runScanQueue(db).catch((err) => console.error('очередь сканов:', err.message));
  }, 5000).unref();
} else {
  console.error('ФНС: доступ не настроен (нужны FNS_MASTER_TOKEN, FNS_AUTH_URL, FNS_KKT_URL) — сканирование выключено');
}

// Места покупок: адреса из новых чеков — в координаты. Раз в минуту по несколько адресов,
// поэтому первая разметка всей базы (сотни адресов) займёт десяток-другой минут
if (geocoderReady()) {
  const tick = () => runGeocoder(db).catch((err) => console.error('геокодер:', err.message));
  setTimeout(tick, 10_000).unref();
  setInterval(tick, 60_000).unref();
} else {
  console.error('DaData: ключ не задан (DADATA_API_KEY) — адреса покупок на карту не попадут');
}

// Операции, загруженные до появления разбора, размечаем один раз при запуске:
// что покрыто чеком, что перевод между своими счетами, что доход
setTimeout(() => {
  try {
    const budgets = db.prepare('SELECT DISTINCT budget_id FROM bank_ops WHERE kind IS NULL').all();
    for (const { budget_id } of budgets) {
      const res = matchBank(db, budget_id);
      console.log(`банк: разбор бюджета #${budget_id} — чеков ${res.receipts}, переводов ${res.transfers}`);
    }
  } catch (err) {
    console.error('банк, разбор:', err.message);
  }
}, 3000).unref();

// Банки: сессию пингуем раз в минуту — иначе банк её сбросит, операции забираем раз в 15 минут
if (banksReady()) {
  setInterval(() => keepAlive(db).catch((err) => console.error('банк, пинг:', err.message)), 60_000).unref();
  const sync = () => syncAll(db).catch((err) => console.error('банк, загрузка:', err.message));
  setTimeout(sync, 20_000).unref();
  setInterval(sync, 15 * 60_000).unref();
} else {
  console.error('Банки: нет BANK_KEY в api/.env — подключения к банкам выключены');
}

server.listen(PORT, HOST, () => {
  // Сводка по всей базе, без владельца: это журнал сервера, а не экран пользователя
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS receipts, (SELECT COUNT(*) FROM items) AS items, (SELECT COUNT(*) FROM users) AS users,
              MIN(purchased_date) AS date_from, MAX(purchased_date) AS date_to FROM receipts`,
    )
    .get();
  console.log(`Кабинет:  http://${HOST}:${PORT}/cabinet`);
  console.log(`API:      http://${HOST}:${PORT}/api/meta`);
  console.log(`База:     ${DB_PATH}`);
  console.log(`Статика:  ${SITE_ROOT}`);
  console.log(
    `Данные:   пользователей ${stats.users}, чеков ${stats.receipts}, позиций ${stats.items}, ` +
      `период ${stats.date_from ?? '—'} — ${stats.date_to ?? '—'}`,
  );
  if (!stats.receipts) console.log('\nБаза пустая — запустите: node api/src/import.mjs');
});
