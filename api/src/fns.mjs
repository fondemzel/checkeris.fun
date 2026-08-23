// Клиент Открытых API ФНС: получение чека по данным из его QR-кода.
//
// Обмен асинхронный и в два шага: SendMessage кладёт запрос и возвращает MessageId,
// затем GetMessage по этому идентификатору отдаёт PROCESSING или COMPLETED с ответом.
// Поэтому сканирование не может быть синхронным — этим занимается очередь в scan.mjs.
//
// Доступ выдан на конкретные IP, поэтому вызовы уходят только с сервера: с машины
// разработчика ФНС ответит отказом. Мастер-токен лежит в api/.env и в репозиторий не едет.
//
// ЛИМИТ 1000 ЗАПРОСОВ В СУТКИ. Считается каждое обращение, включая опросы и обновление
// сессии, поэтому расход учитывается в таблице fns_usage, а опрос идёт с нарастающей паузой.
import { loadEnv } from './llm.mjs';

const NS = {
  sync: 'urn://x-artefacts-gnivc-ru/inplat/servin/OpenApiMessageConsumerService/types/1.0',
  async: 'urn://x-artefacts-gnivc-ru/inplat/servin/OpenApiAsyncMessageConsumerService/types/1.0',
  auth: 'urn://x-artefacts-gnivc-ru/ais3/kkt/AuthService/types/1.0',
  kkt: 'urn://x-artefacts-gnivc-ru/ais3/kkt/KktTicketService/types/1.0',
};

const DAILY_LIMIT = Number(process.env.FNS_DAILY_LIMIT ?? 1000);

// Токен живёт час, ФНС кэширует его 40 минут и просит обновлять за 5–10 минут до конца
const REFRESH_BEFORE_MS = 7 * 60 * 1000;

let session = null; // { token, expires }

export function fnsConfig() {
  loadEnv();
  return {
    masterToken: process.env.FNS_MASTER_TOKEN ?? '',
    authUrl: process.env.FNS_AUTH_URL ?? '',
    kktUrl: process.env.FNS_KKT_URL ?? '',
  };
}

export const fnsReady = () => {
  const c = fnsConfig();
  return Boolean(c.masterToken && /^https:\/\//.test(c.authUrl) && /^https:\/\//.test(c.kktUrl));
};

const today = () => new Date().toISOString().slice(0, 10);

/** Сколько обращений к ФНС потрачено сегодня и сколько осталось. */
export function fnsUsage(db) {
  const row = db.prepare('SELECT calls FROM fns_usage WHERE day = ?').get(today());
  const calls = row?.calls ?? 0;
  return { day: today(), calls, limit: DAILY_LIMIT, left: Math.max(0, DAILY_LIMIT - calls) };
}

/** Резервируем обращение до его совершения: лучше недосчитать право, чем упереться в блокировку. */
function spend(db) {
  const { left } = fnsUsage(db);
  if (left <= 0) throw new Error(`исчерпан суточный лимит обращений к ФНС (${DAILY_LIMIT})`);
  db.prepare(
    `INSERT INTO fns_usage (day, calls) VALUES (?, 1)
     ON CONFLICT (day) DO UPDATE SET calls = calls + 1`,
  ).run(today());
}

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));

/** Значение первого тега с таким именем, без учёта пространства имён. */
export function tag(xml, name) {
  const m = new RegExp(`<(?:[A-Za-z0-9_]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${name}>`).exec(xml);
  return m ? m[1] : null;
}

const envelope = (body) =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  `<soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

async function call(db, url, action, body, token = null) {
  spend(db);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml;charset=UTF-8',
      soapaction: `"${action}"`,
      ...(token ? { 'FNS-OpenApi-Token': token } : {}),
    },
    body: envelope(body),
    signal: AbortSignal.timeout(40_000),
  });

  const text = await res.text();
  if (!res.ok) {
    // Отдельно ловим превышение лимита: повторять такое бессмысленно до следующих суток
    const limited = /RateLimiting/i.test(text);
    const err = new Error(`ФНС ответила ${res.status}${limited ? ' (превышен лимит обращений)' : ''}`);
    err.limited = limited;
    err.body = text.slice(0, 400);
    throw err;
  }
  return text;
}

/** Временный токен сессии. Держим в памяти: ФНС всё равно отдаёт тот же в течение 40 минут. */
export async function fnsSession(db) {
  if (session && session.expires - Date.now() > REFRESH_BEFORE_MS) return session.token;

  const { masterToken, authUrl } = fnsConfig();
  if (!masterToken || !authUrl) throw new Error('не задан FNS_MASTER_TOKEN или FNS_AUTH_URL');

  const xml = await call(
    db,
    authUrl,
    'urn:GetMessageRequest',
    `<ns:GetMessageRequest xmlns:ns="${NS.sync}"><ns:Message>` +
      `<tns:AuthRequest xmlns:tns="${NS.auth}"><tns:AuthAppInfo>` +
      `<tns:MasterToken>${esc(masterToken)}</tns:MasterToken>` +
      '</tns:AuthAppInfo></tns:AuthRequest></ns:Message></ns:GetMessageRequest>',
  );

  const token = tag(xml, 'Token');
  const expire = tag(xml, 'ExpireTime');
  if (!token) throw new Error(`ФНС не выдала токен: ${(tag(xml, 'Message') ?? xml).slice(0, 200)}`);

  session = { token, expires: expire ? Date.parse(expire) : Date.now() + 3_600_000 };
  return token;
}

/**
 * Данные из QR чека. Строка вида
 * t=20250514T1830&s=1234.00&fn=9960...&i=12345&fp=1234567890&n=1
 */
export function parseQr(text) {
  const params = new URLSearchParams(String(text ?? '').trim().replace(/^[^?]*\?/, ''));
  const t = params.get('t') ?? '';
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/.exec(t);
  const sum = Number(params.get('s'));
  const fn = params.get('fn');
  const fd = params.get('i');
  const fp = params.get('fp');

  if (!m || !fn || !fd || !fp || !Number.isFinite(sum)) return null;

  return {
    date: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}`,
    sum: Math.round(sum * 100), // ФНС ждёт копейки
    fn,
    fd: Number(fd),
    fp: Number(fp),
    type: Number(params.get('n') ?? 1),
  };
}

/** Отправка запроса на чек. Возвращает MessageId, по которому потом забирается ответ. */
export async function requestTicket(db, qr) {
  const token = await fnsSession(db);
  const { kktUrl } = fnsConfig();

  const xml = await call(
    db,
    kktUrl,
    'urn:SendMessageRequest',
    `<ns:SendMessageRequest xmlns:ns="${NS.async}"><ns:Message>` +
      `<tns:GetTicketRequest xmlns:tns="${NS.kkt}"><tns:GetTicketInfo>` +
      `<tns:Sum>${qr.sum}</tns:Sum>` +
      `<tns:Date>${esc(qr.date)}</tns:Date>` +
      `<tns:Fn>${esc(qr.fn)}</tns:Fn>` +
      `<tns:TypeOperation>${qr.type}</tns:TypeOperation>` +
      `<tns:FiscalDocumentId>${qr.fd}</tns:FiscalDocumentId>` +
      `<tns:FiscalSign>${qr.fp}</tns:FiscalSign>` +
      '<tns:RawData>true</tns:RawData>' +
      '</tns:GetTicketInfo></tns:GetTicketRequest></ns:Message></ns:SendMessageRequest>',
    token,
  );

  const id = tag(xml, 'MessageId');
  if (!id) throw new Error(`ФНС не вернула MessageId: ${xml.slice(0, 300)}`);
  return id;
}

/**
 * Забор ответа. PROCESSING значит «ещё считается», COMPLETED — готово:
 * внутри либо чек в Ticket (JSON строкой), либо описание ошибки.
 */
export async function fetchTicket(db, messageId) {
  const token = await fnsSession(db);
  const { kktUrl } = fnsConfig();

  const xml = await call(
    db,
    kktUrl,
    'urn:GetMessageRequest',
    `<ns:GetMessageRequest xmlns:ns="${NS.async}"><ns:MessageId>${esc(messageId)}</ns:MessageId></ns:GetMessageRequest>`,
    token,
  );

  const status = tag(xml, 'ProcessingStatus');
  if (status !== 'COMPLETED') return { status: status ?? 'PROCESSING' };

  const code = tag(xml, 'Code');
  const raw = tag(xml, 'Ticket');
  if (!raw) {
    const message = tag(xml, 'Message') ?? tag(xml, 'Text') ?? xml.slice(0, 300);
    return { status, code, error: `чек не получен: ${String(message).slice(0, 300)}` };
  }

  // Ticket приходит JSON-строкой внутри XML, поэтому сущности уже развёрнуты
  const json = raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  try {
    return { status, code, ticket: JSON.parse(json) };
  } catch {
    return { status, code, error: 'ответ ФНС не разобрался как JSON' };
  }
}
