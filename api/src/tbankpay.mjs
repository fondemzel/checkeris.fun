// Интернет-эквайринг Т-Банка. Не связан с подключением личного банка пользователя.
// https://developer.tbank.ru/eacq/intro/developer/notification
import { createHash, timingSafeEqual } from 'node:crypto';
import { loadEnv } from './llm.mjs';

export function acquiringConfig() {
  loadEnv();
  return {
    terminal: process.env.TBANK_ACQUIRING_TERMINAL ?? '',
    password: process.env.TBANK_ACQUIRING_PASSWORD ?? '',
    origin: (process.env.SERVICE_PUBLIC_ORIGIN ?? '').replace(/\/$/, ''),
    enabled: process.env.SERVICE_BILLING_ENABLED === '1',
    mode: process.env.SERVICE_BILLING_MODE === 'live' ? 'live' : 'test',
  };
}

export function acquiringReady() {
  const c = acquiringConfig();
  return Boolean(c.enabled && c.terminal && c.password && /^https:\/\/[^/]+$/.test(c.origin)
    && (c.mode === 'test' ? c.terminal.endsWith('DEMO') : !c.terminal.endsWith('DEMO')));
}

export const billingMode = () => acquiringConfig().mode;

// Т-Банк подписывает корневые скалярные параметры, без вложенных Data/Receipt.
export function paymentToken(data, password) {
  const values = { ...data, Password: password };
  delete values.Token;
  return createHash('sha256').update(Object.keys(values).sort()
    .filter((key) => values[key] !== null && typeof values[key] !== 'object' && values[key] !== undefined)
    .map((key) => String(values[key])).join('')).digest('hex');
}

export function validPaymentToken(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const c = acquiringConfig();
  if (!c.terminal || !c.password || data.TerminalKey !== c.terminal || !/^[a-f0-9]{64}$/i.test(data.Token ?? '')) return false;
  return timingSafeEqual(Buffer.from(paymentToken(data, c.password), 'hex'), Buffer.from(data.Token, 'hex'));
}

export async function acquiringCall(method, fields) {
  const c = acquiringConfig();
  const data = { ...fields, TerminalKey: c.terminal };
  data.Token = paymentToken(data, c.password);
  const response = await fetch(`https://securepay.tinkoff.ru/v2/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data), signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok || result.Success !== true || String(result.ErrorCode) !== '0') {
    // Ответ банка может содержать реквизиты: не отправляем его в журнал и браузер.
    throw new Error('Не удалось получить ответ платёжного сервиса. Попробуйте позже');
  }
  return result;
}
