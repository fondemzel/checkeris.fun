// Бот входа в Чекер (@checker_costs_bot).
//
// Живёт на зарубежном сервере: с основного сервера Telegram недоступен, хостинг режет
// соединения. Бот сам забирает сообщения (long polling), поэтому ему не нужны ни домен,
// ни сертификат, ни открытые порты — только исходящие соединения к Telegram и к Чекеру.
//
// Что он делает — ровно одно: подтверждает вход.
//   /start <код>  → готовит подтверждение в Чекере (prepare): тот запоминает, кому
//                   показан запрос, и отдаёт код для ссылки. Сообщение с устройством:
//                   «Войти в Чекер? Запрос с iPhone · Safari» — [Войти] [Это не я]
//   «Войти»       → ссылка на страницу Чекера: она открывается в браузере и подтверждает
//                   вход там же, откуда человек вернётся в приложение
//   «Это не я»    → кнопка: отказ уходит в Чекер (confirm)
// Запросы к Чекеру подписаны общим секретом (HMAC): без него подделать вход нельзя.
//
//   node relay.mjs           — работать
//   node relay.mjs --setup   — один раз: описание бота и меню в Telegram
//
// Настройки — в окружении (systemd EnvironmentFile) или в .env рядом:
//   TG_BOT_TOKEN     — токен от @BotFather
//   TG_RELAY_SECRET  — тот же секрет, что в api/.env Чекера
//   CHECKER_URL      — https://checkeris.fun
// Зависимостей нет: только Node 18+.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// На сервере .env читает systemd (файл доступен только root), здесь он нужен
// для запуска руками. Нет доступа — не беда, окружение уже заполнено.
const envFile = join(dirname(fileURLToPath(import.meta.url)), '.env');
try {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* файла нет или он не наш */
}

const TOKEN = process.env.TG_BOT_TOKEN ?? '';
const SECRET = process.env.TG_RELAY_SECRET ?? '';
const CHECKER = (process.env.CHECKER_URL || 'https://checkeris.fun').replace(/\/$/, '');
if (!/^\d+:[\w-]{30,}$/.test(TOKEN) || SECRET.length < 32) {
  console.error('нужны TG_BOT_TOKEN и TG_RELAY_SECRET (не короче 32 символов)');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Вызов Bot API. Ошибку Telegram поднимаем исключением, с его же текстом. */
async function tg(method, body = {}, timeoutMs = 15_000) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.description ?? `HTTP ${res.status}`}`);
  return data.result;
}

/** Запрос к Чекеру с подписью: HMAC-SHA256 от «время.тело». */
async function checker(path, payload) {
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex');
  const res = await fetch(`${CHECKER}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-checker-ts': ts, 'x-checker-signature': signature },
    body: raw,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${data.error ?? ''}`);
  return data;
}

const HELP =
  'Это бот входа в Чекер — учёт расходов по чекам.\n\n' +
  `Откройте ${CHECKER}/m и нажмите «Войти через Telegram».`;
const TROUBLE = 'Не получилось связаться с Чекером. Попробуйте ещё раз через минуту.';
const NONCE = /^[A-Za-z0-9_-]{20,64}$/;

const when = (iso) =>
  new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });

/** /start <код> — показываем, что за запрос, и ждём решения. */
async function onMessage(msg) {
  if (msg.chat?.type !== 'private') return; // в группах бот не участвует
  const chat_id = msg.chat.id;
  const nonce = /^\/start(?:@\w+)?\s+(\S+)/.exec(msg.text ?? '')?.[1];
  if (!nonce || !NONCE.test(nonce)) return tg('sendMessage', { chat_id, text: HELP, disable_web_page_preview: true });

  let info;
  try {
    info = await checker('/api/telegram/prepare', {
      nonce,
      telegram: { id: msg.from.id, first_name: msg.from.first_name, last_name: msg.from.last_name, username: msg.from.username },
    });
  } catch (err) {
    console.error(err.message);
    return tg('sendMessage', { chat_id, text: TROUBLE });
  }
  if (!info.ok) return tg('sendMessage', { chat_id, text: info.reply });

  const text = info.link
    ? `Привязать этот Telegram к аккаунту Чекера?\n\nЗапрос с устройства: ${info.device}, ${when(info.created_at)}.`
    : `Войти в Чекер?\n\nЗапрос с устройства: ${info.device}, ${when(info.created_at)}.\n` +
      'Если вход начинали не вы — нажмите «Это не я».';
  return tg('sendMessage', {
    chat_id,
    text,
    reply_markup: {
      inline_keyboard: [[
        // Ссылка, а не кнопка-ответ: сразу открывает Чекер в браузере
        { text: info.link ? 'Привязать' : 'Войти', url: `${CHECKER}/tg.html?c=${info.code}` },
        { text: 'Это не я', callback_data: `no:${nonce}` },
      ]],
    },
  });
}

/** Нажатие кнопки. Подтверждает тот, кто нажал, и только в своём личном чате с ботом. */
async function onCallback(cb) {
  const [action, nonce] = String(cb.data ?? '').split(':');
  const chat = cb.message?.chat;
  let reply;
  if (!chat || chat.type !== 'private' || chat.id !== cb.from.id || !NONCE.test(nonce ?? '')) {
    reply = 'Подтвердить вход можно только в личном чате с ботом.';
  } else {
    try {
      const res = await checker('/api/telegram/confirm', {
        nonce,
        approve: action === 'ok',
        telegram: {
          id: cb.from.id,
          first_name: cb.from.first_name,
          last_name: cb.from.last_name,
          username: cb.from.username,
        },
      });
      reply = res.reply;
    } catch (err) {
      console.error(err.message);
      reply = TROUBLE;
    }
  }

  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  if (!cb.message) return;
  // Кнопки убираем: второй раз подтвердить тот же запрос нельзя
  await tg('editMessageText', { chat_id: chat.id, message_id: cb.message.message_id, text: reply })
    .catch(() => tg('sendMessage', { chat_id: chat.id, text: reply }));
}

async function setup() {
  await tg('setMyShortDescription', { short_description: 'Вход в Чекер — учёт расходов по чекам' });
  await tg('setMyDescription', {
    description:
      'Через этого бота входят в Чекер (checkeris.fun). Нажмите «Войти через Telegram» ' +
      'на сайте — бот спросит, подтверждаете ли вы вход, и покажет, с какого устройства он запрошен.',
  });
  await tg('setMyCommands', { commands: [{ command: 'start', description: 'Как войти в Чекер' }] });
  console.log('описание и меню бота обновлены');
}

async function run() {
  const me = await tg('getMe');
  // Вебхук и long polling взаимоисключающи: снимаем вебхук, если его кто-то ставил
  await tg('deleteWebhook', { drop_pending_updates: false });
  console.log(`бот @${me.username} слушает; Чекер: ${CHECKER}`);

  let offset = 0;
  for (;;) {
    let updates;
    try {
      updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 65_000);
    } catch (err) {
      console.error(err.message);
      await sleep(5_000);
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1; // подтверждаем, даже если обработка упадёт: повтор не поможет
      try {
        if (update.message) await onMessage(update.message);
        else if (update.callback_query) await onCallback(update.callback_query);
      } catch (err) {
        console.error('обработка:', err.message);
      }
    }
  }
}

if (process.argv.includes('--setup')) await setup();
else await run();
