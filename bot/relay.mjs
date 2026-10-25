// Бот входа в Чекер (@checker_costs_bot).
//
// Живёт на зарубежном сервере: с основного сервера Telegram недоступен, хостинг режет
// соединения. Бот сам забирает сообщения (long polling), поэтому ему не нужны ни домен,
// ни сертификат, ни открытые порты — только исходящие соединения к Telegram и к Чекеру.
//
// Что он делает: подтверждает вход, доставляет сообщения Чекера (например, «Т-Банк
// отключился — войдите заново»): у основного сервера доступа к Telegram нет, — и ведёт
// поддержку меню: «🆘 Поддержка» → обращения → переписка, «Новое обращение», «Ответить».
// Администраторам приходит уведомление со ссылкой в админку, отвечают там (support.mjs).
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

const TROUBLE = 'Не получилось связаться с Чекером. Попробуйте ещё раз через минуту.';
const MEDIA = ['photo', 'document', 'voice', 'video', 'video_note', 'audio', 'sticker'];
const NONCE = /^[A-Za-z0-9_-]{20,64}$/;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const when = (iso) =>
  new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
const day = (iso) => new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short' });

/** Что за сообщение: текст или вложение. */
const kindOf = (msg) => (msg.text != null ? 'text' : MEDIA.find((k) => msg[k]) ?? 'other');

const IMAGE_MAX = 5 * 1024 * 1024; // больше Чекер не примет — останется копией в Telegram

/**
 * Картинку (фото или файл-картинку) скачиваем у Telegram и отдаём Чекеру: там она хранится и
 * видна в админке. Фото Telegram держит в нескольких размерах — берём самый крупный, что
 * влезает в предел. Не вышло — null: администратор получит копию в Telegram.
 */
async function imageOf(msg) {
  const doc = msg.document?.mime_type?.startsWith('image/') ? msg.document : null;
  const photo = msg.photo ? [...msg.photo].reverse().find((p) => !p.file_size || p.file_size <= IMAGE_MAX) : null;
  const pick = doc && (!doc.file_size || doc.file_size <= IMAGE_MAX) ? doc : photo;
  if (!pick) return null;
  try {
    const file = await tg('getFile', { file_id: pick.file_id });
    const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > IMAGE_MAX) return null;
    const type = doc?.mime_type ?? 'image/jpeg'; // фото Telegram всегда отдаёт в JPEG
    return { type, data: data.toString('base64') };
  } catch (err) {
    console.error('поддержка: картинка', err.message);
    return null;
  }
}

// ── меню ──────────────────────────────────────────────────────────────────────
// Бот — одна «панель»: сообщение с кнопками, которое меняется на месте. Главное меню →
// «🆘 Поддержка» → обращения → переписка. Писать в поддержку можно только после «Новое
// обращение» или «Ответить»: просто так текст в обращение не уходит, иначе непонятно, куда он.
// Что человек сейчас пишет и где его панель — в памяти: после перезапуска бота он просто
// начнёт с меню.

const BTN_BACK = '← Назад';
const STATUS = {
  new: ['🔴', 'ждёт ответа'],
  answered: ['🟡', 'есть ответ'],
  closed: ['🟢', 'закрыто'],
};
const PER_PAGE = 5;
const SHOWN = 15; // сообщений в переписке: Telegram не примет больше 4096 знаков

const chats = new Map(); // chat_id → { panel: номер сообщения-панели, mode: 'new' | 'reply', thread }
const chatState = (id) => {
  if (!chats.has(id)) chats.set(id, {});
  return chats.get(id);
};

/**
 * Показать панель: по нажатию кнопки — на месте того же сообщения; после текста человека —
 * новым сообщением внизу, а прежнюю панель убрать, чтобы кнопки не висели выше переписки.
 */
async function panel(chat_id, text, keyboard, { edit = null } = {}) {
  const st = chatState(chat_id);
  const body = { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } };
  if (edit) {
    try {
      await tg('editMessageText', { ...body, message_id: edit });
      st.panel = edit;
      return;
    } catch (err) {
      if (/not modified/.test(err.message)) return; // нажали ту же кнопку — всё и так на месте
      // сообщение слишком старое или удалено — покажем новым
    }
  }
  if (st.panel && st.panel !== edit) await tg('deleteMessage', { chat_id, message_id: st.panel }).catch(() => {});
  const sent = await tg('sendMessage', body);
  st.panel = sent.message_id;
}

async function showMenu(chat_id, from, opts) {
  chatState(chat_id).mode = null;
  const linked = await checker('/api/telegram/known', { telegram_id: from.id }).then((r) => r.linked).catch(() => false);
  const text = linked
    ? '🧾 <b>Чекер</b> — учёт расходов по чекам\n\nВыберите раздел:'
    : '🧾 <b>Чекер</b> — учёт расходов по чекам\n\n' +
      `Чтобы войти, откройте Чекер и нажмите «Войти через Telegram». Что-то не получается — напишите в поддержку.`;
  await panel(chat_id, text, [
    [{ text: '🆘 Поддержка', callback_data: 'sup' }],
    [{ text: '📱 Открыть Чекер', url: `${CHECKER}/m` }],
  ], opts);
}

async function showList(chat_id, from, page = 0, opts) {
  chatState(chat_id).mode = null;
  const { threads = [] } = await checker('/api/telegram/support-list', { telegram_id: from.id });
  const pages = Math.max(1, Math.ceil(threads.length / PER_PAGE));
  page = Math.max(0, Math.min(page, pages - 1)); // список мог сократиться, а кнопка — старая
  const rows = [[{ text: '➕ Новое обращение', callback_data: 'new' }]];
  for (const t of threads.slice(page * PER_PAGE, (page + 1) * PER_PAGE)) {
    const mark = t.unread ? '💬' : STATUS[t.status]?.[0] ?? '•';
    rows.push([{ text: `${mark} ${t.title} · ${day(t.updated_at)}`, callback_data: `t:${t.id}` }]);
  }
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '‹', callback_data: `sp:${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: 'noop' }); // кнопка — потому что «немых» Telegram не умеет
    if (page < pages - 1) nav.push({ text: '›', callback_data: `sp:${page + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: BTN_BACK, callback_data: 'menu' }]);
  const text = threads.length
    ? '🆘 <b>Поддержка</b>\n\nВаши обращения — их видно и в приложении Чекера. 💬 — есть новый ответ.'
    : '🆘 <b>Поддержка</b>\n\nОбращений пока нет. Что-то не так или есть идея — создайте обращение, ответим здесь же, обычно в течение дня.';
  await panel(chat_id, text, rows, opts);
}

/** Переписка текстом: последние сообщения, вложения — пометкой. */
function threadText(t, top = '') {
  const [emoji, label] = STATUS[t.status] ?? ['•', t.status];
  const lines = t.messages.slice(-SHOWN).map((m) => {
    const who = m.from_admin ? '🛟 Поддержка' : '🙋 Вы';
    const att = m.kind !== 'text' ? `[${m.kind_name ?? 'вложение'}]` : '';
    const body = [att, esc(m.text ?? '')].filter(Boolean).join(' ');
    return `<b>${who}</b>, ${day(m.created_at)}:\n${body}`;
  });
  const skipped = t.messages.length > SHOWN ? `…ранние сообщения — в приложении Чекера\n\n` : '';
  let text = `${top}🆘 <b>«${esc(t.title)}»</b>\nСтатус: ${emoji} ${label}\n\n${skipped}${lines.join('\n\n')}`;
  if (text.length > 4000) text = `${top}🆘 <b>«${esc(t.title)}»</b>\n\n…${text.slice(-3800)}`;
  return text;
}

async function showThread(chat_id, from, id, opts = {}) {
  const st = chatState(chat_id);
  st.mode = null;
  const t = await checker('/api/telegram/support-thread', { telegram_id: from.id, id });
  if (t.error) return showList(chat_id, from, 0, opts);
  const rows = t.status === 'closed'
    ? []
    : [[{ text: '💬 Ответить', callback_data: `r:${t.id}` }, { text: '✅ Закрыть', callback_data: `c:${t.id}` }]];
  rows.push([{ text: '← Обращения', callback_data: 'sup' }]);
  return panel(chat_id, threadText(t, opts.top ?? ''), rows, opts);
}

/** Текст или картинка после «Новое обращение» / «Ответить» — в Чекер, потом переписка. */
async function sendToSupport(msg, st) {
  const chat_id = msg.chat.id;
  const kind = kindOf(msg);
  let res;
  try {
    res = await checker('/api/telegram/support', {
      telegram: { id: msg.from.id, first_name: msg.from.first_name, last_name: msg.from.last_name, username: msg.from.username },
      message_id: msg.message_id,
      text: msg.text ?? msg.caption ?? null,
      kind,
      image: kind === 'photo' || kind === 'document' ? await imageOf(msg) : null,
      fresh: st.mode === 'new',
      thread_id: st.mode === 'reply' ? st.thread : null,
    });
  } catch (err) {
    console.error('поддержка:', err.message);
    return tg('sendMessage', { chat_id, text: 'Не получилось отправить. Попробуйте ещё раз через минуту.' });
  }
  if (res.action === 'ignore') return tg('sendMessage', { chat_id, text: 'Слишком много сообщений подряд — попробуйте через час.' });
  if (res.action === 'closed') return showList(chat_id, msg.from);

  // Администраторам: уведомление со ссылкой в админку (там и отвечают) и копия вложения,
  // которое Чекер не сохранил (голосовое, видео, файл) — в админке его не показать
  for (const admin of res.admins ?? []) {
    try {
      if (res.text) await tg('sendMessage', { chat_id: admin, text: res.text, parse_mode: 'HTML', disable_web_page_preview: true });
      if (res.copy) await tg('copyMessage', { chat_id: admin, from_chat_id: chat_id, message_id: msg.message_id });
    } catch (err) {
      console.error('поддержка → администратору:', err.message);
    }
  }
  const top = res.created ? '✅ Обращение создано — ответим здесь же, обычно в течение дня.\n\n' : '✅ Отправлено.\n\n';
  return showThread(chat_id, msg.from, res.thread_id, { top });
}

/** /start <код> — вход; /start, /menu — меню; /support, /help, /start support — обращения; ввод — поддержка. */
async function onMessage(msg) {
  if (msg.chat?.type !== 'private') return; // в группах бот не участвует
  const chat_id = msg.chat.id;
  const text = msg.text ?? '';
  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text);
  const nonce = start?.[1];
  const st = chatState(chat_id);

  if (nonce === 'support' || /^\/(help|support)(?:@\w+)?\s*$/.test(text)) return showList(chat_id, msg.from);
  if ((start && !(nonce && NONCE.test(nonce))) || /^\/menu(?:@\w+)?\s*$/.test(text)) return showMenu(chat_id, msg.from);
  if (!start) {
    if (st.mode && !text.startsWith('/')) return sendToSupport(msg, st);
    // Просто текст — не в обращение: непонятно, куда. Меню с подсказкой
    return showMenu(chat_id, msg.from);
  }

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

  const ask = info.link
    ? `Привязать этот Telegram к аккаунту Чекера?\n\nЗапрос с устройства: ${info.device}, ${when(info.created_at)}.`
    : `Войти в Чекер?\n\nЗапрос с устройства: ${info.device}, ${when(info.created_at)}.\n` +
      'Если вход начинали не вы — нажмите «Это не я».';
  const sent = await tg('sendMessage', {
    chat_id,
    text: ask,
    reply_markup: {
      inline_keyboard: [[
        // Ссылка, а не кнопка-ответ: открывает Чекер — в приложении, если оно стоит
        { text: info.link ? 'Привязать' : 'Войти', url: `${CHECKER}/tg.html?c=${info.code}` },
        { text: 'Это не я', callback_data: `no:${nonce}` },
      ]],
    },
  });

  // Чекер запоминает это сообщение: после входа он попросит его удалить,
  // чтобы кнопки не оставались в переписке
  checker('/api/telegram/sent', { nonce, chat_id, message_id: sent.message_id }).catch(() => {});
}

/** Кнопки меню поддержки: меняют панель на месте. */
async function onMenuButton(cb) {
  const chat_id = cb.message.chat.id;
  const edit = cb.message.message_id;
  const [action, arg] = String(cb.data).split(':');
  const st = chatState(chat_id);
  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  try {
    if (action === 'menu') return await showMenu(chat_id, cb.from, { edit });
    if (action === 'sup') return await showList(chat_id, cb.from, 0, { edit });
    if (action === 'sp') return await showList(chat_id, cb.from, Number(arg) || 0, { edit });
    if (action === 't') return await showThread(chat_id, cb.from, Number(arg), { edit });
    if (action === 'new') {
      st.mode = 'new';
      return await panel(chat_id, '➕ <b>Новое обращение</b>\n\nОпишите, что случилось или что хотелось бы улучшить, одним сообщением — можно приложить скриншот:',
        [[{ text: BTN_BACK, callback_data: 'sup' }]], { edit });
    }
    if (action === 'r') {
      st.mode = 'reply';
      st.thread = Number(arg);
      return await panel(chat_id, '💬 Напишите ответ одним сообщением — можно приложить скриншот:',
        [[{ text: '← Обращение', callback_data: `t:${arg}` }]], { edit });
    }
    if (action === 'c') {
      await checker('/api/telegram/support-close', { telegram_id: cb.from.id, id: Number(arg) });
      return await showThread(chat_id, cb.from, Number(arg), { edit, top: '✅ Обращение закрыто.\n\n' });
    }
  } catch (err) {
    console.error('меню:', err.message);
    return tg('sendMessage', { chat_id, text: TROUBLE });
  }
  return null; // noop — счётчик страниц
}

/** Нажатие кнопки. Вход подтверждает тот, кто нажал, и только в своём личном чате с ботом. */
async function onCallback(cb) {
  const [action, nonce] = String(cb.data ?? '').split(':');
  const chat = cb.message?.chat;
  if (action !== 'no' && action !== 'ok') {
    if (!chat || chat.type !== 'private') return tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    return onMenuButton(cb);
  }
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

  // Ответ показываем всплывающим окном, а сообщение с кнопками убираем: оно отработало
  await tg('answerCallbackQuery', { callback_query_id: cb.id, text: reply, show_alert: true }).catch(() => {});
  if (!cb.message) return;
  await tg('deleteMessage', { chat_id: chat.id, message_id: cb.message.message_id }).catch(() => {});
}

async function setup() {
  await tg('setMyShortDescription', { short_description: 'Вход в Чекер и поддержка — учёт расходов по чекам' });
  await tg('setMyDescription', {
    description:
      'Через этого бота входят в Чекер (checkeris.fun). Нажмите «Войти через Telegram» ' +
      'на сайте — бот спросит, подтверждаете ли вы вход, и покажет, с какого устройства он запрошен.\n\n' +
      'Что-то не так или есть идея — «🆘 Поддержка» в меню бота, ответим здесь же.',
  });
  await tg('setMyCommands', {
    commands: [
      { command: 'menu', description: 'Главное меню' },
      { command: 'support', description: 'Поддержка: обращения' },
    ],
  });
  console.log('описание и меню бота обновлены');
}

/**
 * Сообщения от Чекера людям: забираем каждые несколько секунд и отправляем. Часто —
 * чтобы запись о входе появлялась сразу после подтверждения: кнопка «Войти» — это ссылка,
 * и о нажатии бот узнаёт только отсюда. Запрос короткий и идёт к нашему же серверу.
 */
async function pumpOutbox() {
  let messages = [];
  try {
    ({ messages = [] } = await checker('/api/telegram/outbox', {}));
  } catch (err) {
    return console.error('outbox:', err.message);
  }
  for (const m of messages) {
    const call = m.delete_msg
      ? tg('deleteMessage', { chat_id: m.chat_id, message_id: m.delete_msg })
      // html — уведомления с ссылкой под словом «Посмотреть»; markup — кнопки («Открыть обращение»)
      : tg('sendMessage', {
        chat_id: m.chat_id,
        text: m.text,
        disable_web_page_preview: true,
        ...(m.html ? { parse_mode: 'HTML' } : {}),
        ...(m.markup ? { reply_markup: JSON.parse(m.markup) } : {}),
      });
    await call.catch((err) => console.error('outbox:', err.message));
  }
}

async function run() {
  const me = await tg('getMe');
  setInterval(pumpOutbox, 5_000);
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
