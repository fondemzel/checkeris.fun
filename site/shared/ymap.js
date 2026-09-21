// Карта места покупки — Яндекс Карты (JavaScript API 2.1).
//
// Координаты наши (DaData, api/src/geocoder.mjs): геокодер Яндекса в бесплатном режиме
// не разрешает хранить результаты, а карту показывать — разрешает. Поэтому точку
// ставим сами, а Яндекс только рисует.
//
// Условия бесплатного режима: логотип, копирайты и кнопку «Открыть в Картах» не прятать.
// API подгружается при первой карте, а не на каждой странице: без адреса он не нужен.

let loading = null;

function loadApi(key) {
  if (window.ymaps?.Map) return Promise.resolve(window.ymaps);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(key)}&lang=ru_RU`;
    script.onload = () => window.ymaps.ready(() => resolve(window.ymaps));
    script.onerror = () => {
      loading = null; // сеть моргнула — следующая карточка попробует снова
      reject(new Error('Яндекс Карты не загрузились'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Показать место в элементе. qc — точность координат DaData:
 * 0–1 — до дома (метка), 2 — улица, 3 — посёлок (круг «где-то здесь»).
 * Возвращает карту, чтобы её можно было уничтожить при уходе с экрана.
 */
export async function showPlace(element, { key, lat, lon, qc = 0, title = '' }) {
  const ymaps = await loadApi(key);
  const exact = qc <= 1;
  const map = new ymaps.Map(element, {
    center: [lat, lon],
    zoom: exact ? 16 : qc === 2 ? 15 : 13,
    controls: ['zoomControl'],
  });

  // Колесо мыши прокручивает страницу, а не масштаб карты: иначе, листая карточку,
  // «застреваешь» в карте. Двигать карту пальцем и мышью можно
  map.behaviors.disable('scrollZoom');

  if (exact) {
    map.geoObjects.add(new ymaps.Placemark([lat, lon], { hintContent: title }, { preset: 'islands#redDotIcon' }));
  } else {
    map.geoObjects.add(
      new ymaps.Circle([[lat, lon], qc === 2 ? 250 : 900], { hintContent: title }, {
        fillColor: '#2563eb22',
        strokeColor: '#2563eb',
        strokeWidth: 2,
      }),
    );
  }
  return map;
}

/** Показывать ли карту вообще: точность до города и хуже — только адрес текстом. */
export const mappable = (item) => item?.place_lat != null && item?.place_lon != null && (item.place_qc ?? 5) <= 3;
