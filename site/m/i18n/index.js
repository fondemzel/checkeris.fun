// Языки приложения. Правится только ru.js — en.js собирает скрипт scripts/i18n_sync.mjs.
//
// Язык берётся из настройки в браузере, а если её нет — из языка устройства. Непереведённые
// надписи подставляются по-русски: лучше показать русский текст, чем пустое место.
import { ru } from './ru.js';
import { en } from './en.js';

const LOCALES = { ru, en };
const KEY = 'checker.lang';

function pick() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && LOCALES[saved]) return saved;
  } catch {
    // приватный режим — обойдёмся языком устройства
  }
  const device = String(navigator.language ?? 'ru').slice(0, 2).toLowerCase();
  return LOCALES[device] ? device : 'ru';
}

export const lang = pick();

/** Переключить язык: перезагрузка подхватит новые тексты. */
export function setLang(next) {
  if (!LOCALES[next]) return false;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    return false;
  }
  return true;
}

/** Выбранный язык поверх русского: чего нет в переводе, берётся из ru. */
function merge(base, over) {
  if (!over) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value == null || value === '') continue; // не переведено — оставляем русский
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(base[key] ?? {}, value) : value;
  }
  return out;
}

export const T = merge(ru, LOCALES[lang]);

/** Подстановка: f('Операции удалены: {n}', { n: 12 }). Нет значения — пустая строка. */
export const f = (text, params) =>
  String(text ?? '').replace(/\{(\w+)\}/g, (_, key) => (params?.[key] ?? ''));

/**
 * Склонение по числу: pl(5, ['операция', 'операции', 'операций']) → «операций».
 * У русского три формы, у английского две — вторая и третья совпадают.
 */
export function pl(n, forms) {
  if (!Array.isArray(forms)) return '';
  if (lang !== 'ru') return Math.abs(n) === 1 ? forms[0] : forms[1];
  const ten = Math.abs(n) % 10;
  const hundred = Math.abs(n) % 100;
  if (ten === 1 && hundred !== 11) return forms[0];
  if (ten >= 2 && ten <= 4 && (hundred < 10 || hundred >= 20)) return forms[1];
  return forms[2];
}
