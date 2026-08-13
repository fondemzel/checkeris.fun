// Клиент LLM. Интерфейс намеренно узкий: completeJson() принимает промпт и
// JSON-схему, возвращает разобранный объект и расход токенов. Чтобы добавить
// GigaChat или Claude, достаточно написать ещё один provider с той же сигнатурой —
// вызывающий код про провайдера ничего не знает.
//
// Доступы читаются из api/.env (в репозиторий не попадает).
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { API_ROOT } from './db.mjs';

const ENV_PATH = resolve(API_ROOT, '.env');

/** Простой .env без зависимостей. Переменные окружения имеют приоритет над файлом. */
export function loadEnv(file = ENV_PATH) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

/** Накопленный расход за прогон — чтобы скрипты могли показать, во что обошлось. */
export const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };

export function usageLine() {
  const total = usage.inputTokens + usage.outputTokens;
  return `запросов ${usage.requests}, токенов ${total} (вход ${usage.inputTokens}, выход ${usage.outputTokens})`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * YandexGPT. Доступен с российского сервера, что и определило выбор:
 * api.anthropic.com отдаёт с VPS 403 по региону.
 */
async function yandexComplete({ system, user, schema, model = 'lite', maxTokens = 4000, temperature = 0 }) {
  const key = process.env.YANDEX_API_KEY;
  const folder = process.env.YANDEX_FOLDER_ID;
  if (!key || !folder) throw new Error('нет YANDEX_API_KEY или YANDEX_FOLDER_ID (см. api/.env)');

  const body = {
    modelUri: `gpt://${folder}/${model === 'pro' ? 'yandexgpt' : 'yandexgpt-lite'}/latest`,
    completionOptions: { stream: false, temperature, maxTokens },
    messages: [
      ...(system ? [{ role: 'system', text: system }] : []),
      { role: 'user', text: user },
    ],
    ...(schema ? { jsonSchema: { schema } } : {}),
  };

  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(1000 * 2 ** attempt);

    const res = await fetch('https://llm.api.cloud.yandex.net/foundationModels/v1/completion', {
      method: 'POST',
      headers: { Authorization: `Api-Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      continue; // лимит или сбой на стороне сервиса — повторяем
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const json = await res.json();
    const u = json.result?.usage ?? {};
    usage.requests += 1;
    usage.inputTokens += Number(u.inputTextTokens ?? 0);
    usage.outputTokens += Number(u.completionTokens ?? 0);

    const text = json.result?.alternatives?.[0]?.message?.text ?? '';
    return { data: parseJson(text), raw: text };
  }
  throw lastError;
}

/**
 * Разбор ответа. Со строгой схемой модель отдаёт корректный объект, но в
 * свободном режиме Яндекс кладёт массив под пустой ключ "" — терпим и это.
 */
function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error(`ответ не JSON: ${cleaned.slice(0, 200)}`);
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.items === undefined) {
    const array = Object.values(parsed).find((v) => Array.isArray(v));
    if (array) return { items: array };
  }
  return parsed;
}

const providers = { yandex: yandexComplete };

/** Провайдер выбирается переменной LLM_PROVIDER; по умолчанию yandex. */
export async function completeJson(options) {
  loadEnv();
  const name = options.provider ?? process.env.LLM_PROVIDER ?? 'yandex';
  const provider = providers[name];
  if (!provider) throw new Error(`неизвестный провайдер LLM: ${name} (есть: ${Object.keys(providers).join(', ')})`);
  return provider(options);
}
