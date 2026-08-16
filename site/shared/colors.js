// Цвета групп и оттенки категорий.
//
// У группы один цвет. Категории внутри неё получают тот же цвет разной насыщенности:
// значения раскладываются по переходу «белый → цвет группы» между границами
// shade_from и shade_to. Так группа читается пятном, а её категории различимы,
// но не спорят между собой и не превращаются в радугу.

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export const rgbToHex = ({ r, g, b }) =>
  `#${[r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;

/** HSL → hex. Пикер работает в HSL: по горизонтали тон, по вертикали светлота. */
export function hslToHex(h, s, l) {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return rgbToHex({ r: f(0), g: f(8), b: f(4) });
}

export function hexToHsl(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: s * 100, l: l * 100 };
}

/** Смешивание с белым: 0 — чистый белый, 100 — исходный цвет. */
export function tint(hex, percent) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const k = clamp(percent, 0, 100) / 100;
  return rgbToHex({
    r: 255 + (rgb.r - 255) * k,
    g: 255 + (rgb.g - 255) * k,
    b: 255 + (rgb.b - 255) * k,
  });
}

/**
 * Оттенки категорий группы: n значений между shade_from и shade_to.
 * Одна категория берёт середину диапазона — иначе она получила бы самый бледный край.
 */
export function shades(hex, n, from = 25, to = 85) {
  if (!hexToRgb(hex) || n <= 0) return Array.from({ length: Math.max(0, n) }, () => null);
  if (n === 1) return [tint(hex, (from + to) / 2)];
  return Array.from({ length: n }, (_, i) => tint(hex, from + ((to - from) * i) / (n - 1)));
}

/**
 * Цвет текста поверх фона: тёмный на светлом, белый на тёмном.
 * Считаем по воспринимаемой яркости, а не по среднему — синий темнее жёлтого при
 * одинаковой сумме каналов.
 */
export function readableText(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const luma = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  // Порог занижен против «половины»: на ярких зелёных и жёлтых белый текст расплывается
  return luma > 0.55 ? '#1f2328' : '#ffffff';
}

/** Граница чипса: тот же цвет, но заметно плотнее фона. */
export const edge = (hex) => {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHex({ r: rgb.r * 0.86, g: rgb.g * 0.86, b: rgb.b * 0.86 }) : null;
};
