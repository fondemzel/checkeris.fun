// Отправка писем — через почтовый сервер хостинга REG.RU с ящика на нашем домене
// (noreply@checkeris.fun). Подпись DKIM ставит сам хостинг: для этого домен заведён там как
// почтовый, с DKIM и DMARC. Сами письма — короткие, без картинок: код входа и пара строк.
//
// Без сторонних библиотек: SMTP — это несколько строк диалога. Порт 465 — сразу TLS, 587 —
// обычное соединение и STARTTLS. Вход — AUTH PLAIN.
//
// Настройки — в api/.env:
//   SMTP_HOST   — почтовый сервер хостинга
//   SMTP_PORT   — 465 (по умолчанию) или 587
//   SMTP_USER   — ящик, с которого шлём (он же адрес отправителя, если MAIL_FROM не задан)
//   SMTP_PASS   — пароль ящика
//   MAIL_FROM   — «Чекер <noreply@checkeris.fun>», необязательно
//   MAIL_DEV=1  — не отправлять, а печатать письмо в журнал сервера (локальная отладка)
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { loadEnv } from './llm.mjs';

export function mailConfig() {
  loadEnv();
  const user = process.env.SMTP_USER ?? '';
  return {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT || 465),
    user,
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.MAIL_FROM || (user ? `Чекер <${user}>` : ''),
    dev: process.env.MAIL_DEV === '1',
  };
}

/** Можно ли слать письма: почта настроена или включена отладка. Иначе вход по почте не показываем. */
export const mailReady = () => {
  const c = mailConfig();
  return c.dev || Boolean(c.host && c.user && c.pass);
};

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
// Заголовок с кириллицей — словом в кодировке base64 (RFC 2047)
const word = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const fromHeader = (from) => {
  const m = /^(.*)<(.+)>$/.exec(from.trim());
  return m ? `${word(m[1].trim())} <${m[2]}>` : from;
};
const address = (from) => (/<(.+)>/.exec(from)?.[1] ?? from).trim();

/** Письмо целиком: заголовки и две части — текст и HTML. Строки — не длиннее 76 знаков. */
function compose({ from, to, subject, text, html }) {
  const boundary = `b_${randomBytes(12).toString('hex')}`;
  const wrap = (s) => b64(s).replace(/.{1,76}/g, '$&\r\n');
  const domain = address(from).split('@')[1] ?? 'localhost';
  return [
    `From: ${fromHeader(from)}`,
    `To: ${to}`,
    `Subject: ${word(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/**
 * Диалог с почтовым сервером. Ответ сервера — строки «код-текст», последняя — «код текст»;
 * ждём её и проверяем код. Любой неожиданный — ошибка с текстом сервера.
 */
function smtp(cfg, envelope, data) {
  return new Promise((resolve, reject) => {
    let socket;
    let buffer = '';
    let waiter = null;
    const timer = setTimeout(() => fail(new Error('почтовый сервер не отвечает')), 30_000);
    const fail = (err) => {
      clearTimeout(timer);
      socket?.destroy();
      reject(err);
    };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\r\n');
      const last = lines.findLast((l) => /^\d{3} /.test(l));
      if (!last || !waiter) return;
      buffer = '';
      const w = waiter;
      waiter = null;
      w(Number(last.slice(0, 3)), lines.filter(Boolean).join(' | '));
    };
    const expect = (codes) =>
      new Promise((ok) => {
        waiter = (code, text) => (codes.includes(code) ? ok(text) : fail(new Error(`SMTP ${code}: ${text}`)));
        onData(Buffer.alloc(0)); // ответ мог прийти раньше, чем его стали ждать
      });
    const send = (line, codes) => {
      socket.write(`${line}\r\n`);
      return expect(codes);
    };
    const attach = (s) => {
      socket = s;
      socket.on('data', onData);
      socket.on('error', fail);
    };

    (async () => {
      const opts = { host: cfg.host, port: cfg.port, servername: cfg.host };
      attach(cfg.port === 465 ? tls.connect(opts) : net.connect(opts));
      await expect([220]);
      const ehlo = await send(`EHLO ${address(cfg.from).split('@')[1] ?? 'localhost'}`, [250]);
      if (cfg.port !== 465 && /STARTTLS/i.test(ehlo)) {
        await send('STARTTLS', [220]);
        socket.removeListener('data', onData);
        attach(tls.connect({ socket, servername: cfg.host }));
        await send(`EHLO ${address(cfg.from).split('@')[1] ?? 'localhost'}`, [250]);
      }
      await send(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass}`)}`, [235]);
      await send(`MAIL FROM:<${envelope.from}>`, [250]);
      await send(`RCPT TO:<${envelope.to}>`, [250, 251]);
      await send('DATA', [354]);
      // Строка, начинающаяся с точки, удваивается: одна точка — конец письма
      await send(`${data.replace(/\r\n\./g, '\r\n..')}\r\n.`, [250]);
      socket.write('QUIT\r\n');
      clearTimeout(timer);
      socket.end();
      resolve();
    })().catch(fail);
  });
}

/** Отправить письмо. В отладке — только в журнал. */
export async function sendMail({ to, subject, text, html }) {
  const cfg = mailConfig();
  if (cfg.dev) {
    console.log(`почта (отладка) → ${to}: ${subject}\n${text}`);
    return;
  }
  if (!mailReady()) throw new Error('почта не настроена');
  await smtp(cfg, { from: address(cfg.from), to }, compose({ from: cfg.from, to, subject, text, html }));
}
