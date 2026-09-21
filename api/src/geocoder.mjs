// Координаты мест покупок: адрес из чека → точка на карте. Работает фоном.
//
// Сервис — DaData: лучше других понимает «грязные» российские адреса, а найденные
// координаты разрешено хранить (геокодер Яндекса в бесплатном режиме хранить запрещает,
// поэтому карта у нас Яндекса, а координаты — свои).
//
// Два пути, от дешёвого к дорогому:
//   подсказки      — бесплатно ~10 000 в сутки, берут аккуратные адреса;
//   стандартизация — разбирает и «108818,, 77 - город федерального значения Москва…»,
//                    но бесплатная квота в сутки маленькая. Кончилась — адрес ждёт завтра.
// Ищем каждый адрес один раз: результат лежит в places и общий для всех.
//
// Чеки интернет-магазинов сюда не попадают: в них адрес продавца, а не место покупки.
import { loadEnv } from './llm.mjs';

const SUGGEST_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address';
const CLEAN_URL = 'https://cleaner.dadata.ru/api/v1/clean/address';
const SUGGEST_DAILY = 5000; // половина бесплатного — с запасом
const MAX_TRIES = 5;

export function geocoderConfig() {
  loadEnv();
  return { key: process.env.DADATA_API_KEY ?? '', secret: process.env.DADATA_SECRET ?? '' };
}

export const geocoderReady = () => Boolean(geocoderConfig().key);

const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

const used = (db, service) =>
  db.prepare('SELECT calls FROM api_usage WHERE day = ? AND service = ?').get(today(), service)?.calls ?? 0;

function spend(db, service) {
  db.prepare(
    `INSERT INTO api_usage (day, service, calls) VALUES (?, ?, 1)
     ON CONFLICT (day, service) DO UPDATE SET calls = calls + 1`,
  ).run(today(), service);
}

// Граница слова в JS-регулярках только латинская, поэтому вместо \b — «начало,
// пробел или запятая» перед словом
const cut = (s, re) => s.replace(new RegExp(`(^|[\\s,])(?:${re})`, 'gi'), '$1');

// Части адреса после дома: этаж, помещение, офис — поиску только мешают
const ROOM = /^(этаж|\d+\s*этаж|пом|помещ|помещение|кв|квартира|офис|оф|цокол|подвал|секция|павильон|комн|кабинет|часть|лит|литер)/i;

/**
 * Подсказкам мешает служебный мусор кассовых адресов: индекс, код региона
 * («23 - Краснодарский край»), «вн.тер.г.», «г.о. город-курорт», хвост про этаж
 * и помещение, повтор города («город Калининград, г Калининград»). Без него
 * бесплатный путь берёт большую часть адресов (на выборке — 13 из 15)
 * и не тратит маленькую квоту стандартизации.
 */
export function tidyAddress(address) {
  let s = String(address)
    .replace(/\d{6}/g, ' ') // индекс где угодно
    .replace(/(^|[\s,])\d{2}\s*-\s*(?=[^\d\s])/g, '$1'); // «23 - Краснодарский край»
  s = cut(s, 'город федерального значения');
  s = cut(s, 'вн\\.?\\s*тер\\.?\\s*г\\.?');
  s = cut(s, 'г\\.\\s*о\\.');
  s = cut(s, 'городской округ|муниципальный округ|м\\.\\s*р-н');
  s = cut(s, 'город-курорт|город-герой');
  s = cut(s, 'поселение\\s+[^,]+,');
  s = cut(s, 'российская федерация|россия');
  s = s
    .replace(/(^|[\s,])МО(?=[\s,])/g, '$1Московская область')
    .replace(/(^|[\s,])дом\s+/gi, '$1д ');

  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  const cities = new Set(parts.map((p) => /^г\.?\s+(.+)$/i.exec(p)?.[1]?.toLowerCase()).filter(Boolean));
  return parts
    .filter((p) => {
      if (ROOM.test(p) || /\d+\s*этаж/i.test(p)) return false;
      const city = /^город\s+(.+)$/i.exec(p)?.[1]?.toLowerCase();
      if (city && cities.has(city)) return false; // «город Калининград» при «г Калининград»
      return !cities.has(p.toLowerCase()); // «Сочи» при «г Сочи»
    })
    .join(', ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function suggest(address) {
  const { key } = geocoderConfig();
  const res = await fetch(SUGGEST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Token ${key}` },
    body: JSON.stringify({ query: tidyAddress(address).slice(0, 300), count: 1 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw Object.assign(new Error(`подсказки DaData: HTTP ${res.status}`), { status: res.status });
  const hit = (await res.json()).suggestions?.[0];
  const d = hit?.data;
  if (!d?.geo_lat || !d?.geo_lon) return null;
  return { result: hit.value, lat: Number(d.geo_lat), lon: Number(d.geo_lon), qc_geo: Number(d.qc_geo ?? 5) };
}

async function clean(address) {
  const { key, secret } = geocoderConfig();
  const res = await fetch(CLEAN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Token ${key}`, 'X-Secret': secret },
    body: JSON.stringify([address]), // бесплатный тариф принимает по одному адресу
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw Object.assign(new Error(`стандартизация DaData: HTTP ${res.status}`), { status: res.status });
  const d = (await res.json())?.[0];
  if (!d?.geo_lat || !d?.geo_lon) return null;
  return { result: d.result, lat: Number(d.geo_lat), lon: Number(d.geo_lon), qc_geo: Number(d.qc_geo ?? 5) };
}

// Стандартизация отказала по квоте — до конца суток её не трогаем
let cleanBlockedOn = null;

/** Новые адреса из чеков — в очередь. Интернет-покупки не берём: у них адрес продавца. */
function enqueue(db) {
  db.prepare(
    `INSERT OR IGNORE INTO places (key, address, status, updated_at)
     SELECT place_key, MIN(retail_address), 'pending', ?
       FROM receipts
      WHERE place_key IS NOT NULL AND internet_sign = 0 AND fiscal_drive <> 'manual'
      GROUP BY place_key`,
  ).run(now());
}

async function locate(db, place) {
  const save = db.prepare(
    `UPDATE places SET result = ?, lat = ?, lon = ?, qc_geo = ?, source = ?, status = ?, tries = tries + 1,
            updated_at = ? WHERE key = ?`,
  );

  // Точнее улицы подсказки не нашли — пробуем стандартизацию: она разбирает грязные адреса
  let found = null;
  if (used(db, 'dadata_suggest') < SUGGEST_DAILY) {
    spend(db, 'dadata_suggest');
    found = await suggest(place.address);
    if (found && found.qc_geo <= 2) {
      return save.run(found.result, found.lat, found.lon, found.qc_geo, 'suggest', 'ok', now(), place.key);
    }
  }

  const { secret } = geocoderConfig();
  if (secret && cleanBlockedOn !== today()) {
    try {
      spend(db, 'dadata_clean');
      const cleaned = await clean(place.address);
      if (cleaned && (!found || cleaned.qc_geo < found.qc_geo)) found = cleaned;
      if (found) {
        return save.run(found.result, found.lat, found.lon, found.qc_geo, cleaned === found ? 'clean' : 'suggest', 'ok', now(), place.key);
      }
      return save.run(null, null, null, null, null, 'miss', now(), place.key);
    } catch (err) {
      if (![402, 403, 429].includes(err.status)) throw err;
      cleanBlockedOn = today(); // квота на сегодня кончилась
    }
  }

  // Стандартизация недоступна: что нашли подсказки — берём, иначе ждём завтра
  if (found) return save.run(found.result, found.lat, found.lon, found.qc_geo, 'suggest', 'ok', now(), place.key);
  return save.run(null, null, null, null, null, 'wait', now(), place.key);
}

let running = false;

/** Проход очереди мест. Вызывается по таймеру из server.mjs. */
export async function runGeocoder(db, { batch = 30 } = {}) {
  if (running || !geocoderReady()) return;
  running = true;
  try {
    enqueue(db);
    const due = db
      .prepare(
        `SELECT key, address FROM places
          WHERE status = 'pending' OR (status = 'wait' AND updated_at < ?)
          ORDER BY updated_at LIMIT ?`,
      )
      .all(today(), batch);

    for (const place of due) {
      try {
        await locate(db, place);
      } catch (err) {
        // Сеть или сбой DaData — не вина адреса: попробуем в следующий проход
        const tries = db.prepare('SELECT tries FROM places WHERE key = ?').get(place.key).tries + 1;
        db.prepare('UPDATE places SET tries = ?, status = ?, updated_at = ? WHERE key = ?')
          .run(tries, tries >= MAX_TRIES ? 'miss' : 'pending', now(), place.key);
        console.error('геокодер:', err.message);
        break;
      }
      await new Promise((r) => setTimeout(r, 150)); // не частим: у DaData ограничение по частоте
    }
  } finally {
    running = false;
  }
}
