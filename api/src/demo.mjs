// Тестовая база: год трат вымышленного человека — посмотреть, как приложение выглядит
// с данными, ещё не подключив свои банки и не отсканировав ни одного чека.
//
// Одна на всех: отдельный бюджет (budgets.demo = 1), сгенерированный один раз. Включение
// переключает человека на него — так же, как вход в общий бюджет, — а свои данные остаются
// нетронутыми в прежнем бюджете (users.demo_return). Выключение возвращает обратно.
//
// Раз база общая, она только для чтения: правка одного была бы видна всем (запрет — в
// server.mjs, isDemo). Заодно не принимаются загрузки из банков и магазинов и сканы:
// настоящие операции попали бы в тестовую базу. База — год до дня генерации и дальше до
// 31 декабря: так в ней есть и Новый год. Пересоздаётся, когда расписана не на текущий год.
//
// Семья живая: молодые Артём и Катя — двое в бюджете, чеки подписаны тем, кто добавил. Прошлой
// осенью взяли квартиру в ипотеку и обустраивают её: мебель и техника в первые месяцы, дальше
// мелочи. Этой осенью родится первый ребёнок: до этого врачи, курсы, детская, декрет и
// декретные, после — подгузники, педиатр, пособия. Летом — поездка вдвоём в Калининград, в
// декабре — подарки и ёлка. Дома кошка Маркиза и корги Бублик; во дворе — Киа Рио: бензин,
// ОСАГО, переобувка, ТО. «Дети» и «Путешествия» — свои
// группы этой семьи: в общем справочнике их нет, заодно видно, как выглядят созданные человеком.
//
// Операции банка тестовой базы держатся за подключения служебного пользователя
// (DEMO_LOGIN): так они показываются как операции Т-Банка и Сбера, но не смешиваются с
// настоящими подключениями людей. Статус этих подключений — demo: фоновая проверка
// сессий их не видит.
import { provisionTaxonomy, createGroup, createCategory } from './taxonomy.mjs';
import { provisionIncome, createIncomeCat } from './incomecats.mjs';
import { normalizeName } from './import.mjs';
import { setLimits, suggestLimits } from './limits.mjs';

const DEMO_LOGIN = '__demo__';
const DEMO_NAME = 'Демо-режим';
// Версия генератора: поправили его — поднять, и база пересоздастся при следующем включении
const DEMO_VERSION = 6;
const now = () => new Date().toISOString();

/** Бюджет — тестовый? */
export const isDemo = (db, budgetId) =>
  Boolean(budgetId && db.prepare('SELECT demo FROM budgets WHERE id = ?').get(budgetId)?.demo);

/** Тестовая база: есть и свежая — та же; устарела — пересоздаётся на месте; нет — создаётся. */
function demoBudget(db) {
  let id = db.prepare('SELECT id FROM budgets WHERE demo = 1 ORDER BY id LIMIT 1').get()?.id;
  const last = id && db.prepare('SELECT MAX(purchased_date) AS d FROM receipts WHERE budget_id = ?').get(id).d;
  // Расписана до конца этого года — свежая (последние траты — под Новый год)
  const version = id && db.prepare('SELECT demo_version FROM budgets WHERE id = ?').get(id).demo_version;
  const fresh = last && last >= `${new Date().getFullYear()}-12-20` && version === DEMO_VERSION;
  if (fresh) {
    db.prepare('UPDATE budgets SET name = ? WHERE id = ?').run(DEMO_NAME, id); // название могло смениться
    return id;
  }
  db.exec('BEGIN');
  try {
    if (id) clearBudget(db, id);
    else {
      id = Number(db.prepare('INSERT INTO budgets (name, owner_id, created_at, demo) VALUES (?, NULL, ?, 1)').run(DEMO_NAME, now()).lastInsertRowid);
    }
    provisionTaxonomy(db, id);
    provisionIncome(db, id);
    generate(db, id);
    db.prepare('UPDATE budgets SET demo_version = ? WHERE id = ?').run(DEMO_VERSION, id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  // Лимиты — по обычным тратам этого же человека: «Аналитике» сразу есть что показать.
  // После COMMIT: setLimits открывает свою транзакцию, а вложенных SQLite не умеет
  setLimits(db, id, suggestLimits(db, id));
  // «Дети» — по летним месяцам с коляской лимит выходит завышенным, и перерасхода не видно. После
  // рождения пара держит 15 000 ₽ в месяц — и превышает: «Аналитике» есть что показать
  const kids = db.prepare("SELECT slug FROM groups WHERE budget_id = ? AND name = 'Дети'").get(id)?.slug;
  if (kids) setLimits(db, id, { [kids]: 1500000 });
  return id;
}

/** Включить тестовую базу: человек переходит в неё, свой бюджет запоминается. */
export function enableDemo(db, user) {
  if (isDemo(db, user.budget_id)) return { demo: true };
  const id = demoBudget(db);
  db.prepare('UPDATE users SET demo_return = budget_id, budget_id = ? WHERE id = ?').run(id, user.id);
  return { demo: true };
}

/** Выключить: вернуться в свой бюджет. Сама тестовая база остаётся для следующих. */
export function disableDemo(db, user) {
  if (!isDemo(db, user.budget_id)) return { demo: false };
  const row = db.prepare('SELECT demo_return, home_budget_id FROM users WHERE id = ?').get(user.id);
  const back = row.demo_return && !isDemo(db, row.demo_return) && db.prepare('SELECT 1 FROM budgets WHERE id = ?').get(row.demo_return)
    ? row.demo_return
    : row.home_budget_id;
  db.prepare('UPDATE users SET budget_id = ?, demo_return = NULL WHERE id = ?').run(back, user.id);
  return { demo: false };
}

/** Содержимое тестовой базы — перед новой генерацией. Сам бюджет и люди в нём остаются. */
function clearBudget(db, budgetId) {
  // Разметка и справочник держатся за бюджет без каскада от него — чистим явно
  for (const table of ['budget_limits', 'item_labels', 'item_notes', 'budget_dictionary', 'budget_seller_rules', 'bank_rules', 'bank_kind_marks',
    'category_links', 'categories', 'groups', 'income_cats', 'income_groups']) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
      const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((c) => c.name);
      if (cols.includes('budget_id')) db.prepare(`DELETE FROM ${table} WHERE budget_id = ?`).run(budgetId);
    }
  }
  db.prepare('DELETE FROM bank_ops WHERE budget_id = ?').run(budgetId);
  db.prepare('DELETE FROM receipts WHERE budget_id = ?').run(budgetId);
}

/** Подключение банка служебного пользователя: к нему привязаны операции всех тестовых баз. */
function demoLink(db, bank) {
  let owner = db.prepare('SELECT id FROM users WHERE login = ?').get(DEMO_LOGIN)?.id;
  if (!owner) {
    // Пароль — не хеш scrypt: войти под этим пользователем нельзя
    owner = Number(db.prepare("INSERT INTO users (login, password, created_at, name) VALUES (?, '!', ?, ?)")
      .run(DEMO_LOGIN, now(), DEMO_NAME).lastInsertRowid);
  }
  const link = db.prepare('SELECT id FROM bank_links WHERE user_id = ? AND bank = ?').get(owner, bank);
  if (link) return link.id;
  return Number(db.prepare("INSERT INTO bank_links (user_id, bank, status, login_at) VALUES (?, ?, 'demo', ?)")
    .run(owner, bank, now()).lastInsertRowid);
}

/**
 * Участник тестовой базы — вымышленный: от его имени добавлены чеки. Войти под ним нельзя
 * (пароль — не хеш scrypt); бюджет — тестовый, чтобы при запуске сервера ему не выдавали свой.
 */
function demoPerson(db, login, name, budgetId) {
  const id = db.prepare('SELECT id FROM users WHERE login = ?').get(login)?.id;
  if (id) {
    db.prepare('UPDATE users SET name = ?, budget_id = ? WHERE id = ?').run(name, budgetId, id);
    return id;
  }
  return Number(db.prepare("INSERT INTO users (login, password, created_at, name, budget_id) VALUES (?, '!', ?, ?, ?)")
    .run(login, now(), name, budgetId).lastInsertRowid);
}

/** Участники тестовой базы — вымышленная пара (их чеки — по added_by). */
export function demoMembers(db, budgetId) {
  return db
    .prepare(
      `SELECT u.id, u.name, (SELECT COUNT(*) FROM receipts r WHERE r.budget_id = :b AND r.added_by = u.id) AS receipts
         FROM users u WHERE u.login IN ('__demo_artem__', '__demo_katya__') ORDER BY u.id`,
    )
    .all({ b: budgetId })
    .map((m, i) => ({ id: m.id, name: m.name, is_me: false, is_owner: i === 0, receipts: m.receipts }));
}

// ── генератор ─────────────────────────────────────────────────────────────────

/** Псевдослучайные числа с зерном: тестовая база каждый раз одна и та же. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Товары: [название, цена от, цена до, категория, единица (кг — вес дробный)]
const GROCERY = [
  ['Молоко Простоквашино 3,2% 930 мл', 89, 115, 'food.groceries'],
  ['Хлеб Бородинский нарезка 300 г', 49, 69, 'food.groceries'],
  ['Батон Нарезной 400 г', 45, 62, 'food.groceries'],
  ['Яйцо куриное С1 10 шт', 109, 145, 'food.groceries'],
  ['Сыр Российский 45% 200 г', 179, 249, 'food.groceries'],
  ['Масло сливочное 82,5% 180 г', 189, 239, 'food.groceries'],
  ['Филе куриное охлаждённое', 389, 469, 'food.groceries', 'кг'],
  ['Фарш говяжий 400 г', 299, 389, 'food.groceries'],
  ['Бананы', 119, 159, 'food.groceries', 'кг'],
  ['Яблоки Гала', 139, 189, 'food.groceries', 'кг'],
  ['Огурцы среднеплодные', 129, 259, 'food.groceries', 'кг'],
  ['Томаты сливовидные', 159, 299, 'food.groceries', 'кг'],
  ['Картофель мытый', 39, 69, 'food.groceries', 'кг'],
  ['Крупа гречневая 900 г', 89, 129, 'food.groceries'],
  ['Рис длиннозёрный 900 г', 99, 139, 'food.groceries'],
  ['Макароны Барилла спагетти 450 г', 129, 169, 'food.groceries'],
  ['Кофе молотый Жокей 250 г', 299, 419, 'food.groceries'],
  ['Чай Гринфилд чёрный 100 пак', 249, 329, 'food.groceries'],
  ['Йогурт Даниссимо 130 г', 59, 79, 'food.groceries'],
  ['Творог 5% 300 г', 119, 159, 'food.groceries'],
  ['Кефир 1% 900 мл', 79, 99, 'food.groceries'],
  ['Колбаса Докторская 400 г', 279, 359, 'food.groceries'],
  ['Сосиски Молочные 450 г', 219, 289, 'food.groceries'],
  ['Шоколад Алёнка 90 г', 79, 109, 'food.groceries'],
  ['Печенье Юбилейное 112 г', 49, 69, 'food.groceries'],
  ['Сок Добрый яблоко 1 л', 119, 149, 'food.groceries'],
  ['Вода Святой источник 1,5 л', 49, 69, 'food.groceries'],
  ['Пельмени Сибирская коллекция 700 г', 399, 499, 'food.groceries'],
  ['Сметана 20% 300 г', 89, 129, 'food.groceries'],
  ['Масло подсолнечное 1 л', 119, 159, 'food.groceries'],
  ['Сахар-песок 1 кг', 69, 99, 'food.groceries'],
  ['Мороженое пломбир 80 г', 69, 99, 'food.groceries'],
  ['Сёмга слабосолёная 150 г', 399, 549, 'food.groceries'],
  ['Авокадо Хасс', 99, 149, 'food.groceries'],
  ['Лимоны', 179, 239, 'food.groceries', 'кг'],
  ['Пакет-майка', 9, 12, 'home.household'],
];
const GROCERY_EXTRA = [
  ['Пиво Жигулёвское светлое 0,5 л', 79, 109, 'food.alcohol'],
  ['Вино Шато Тамань красное сухое 0,75 л', 549, 799, 'food.alcohol'],
  ['Сидр яблочный 0,5 л', 129, 169, 'food.alcohol'],
  ['Туалетная бумага Zewa 8 рулонов', 299, 399, 'home.household'],
  ['Средство для посуды Fairy 450 мл', 159, 219, 'home.household'],
  ['Губки для посуды 5 шт', 59, 99, 'home.household'],
  ['Стиральный порошок Persil 1,5 кг', 449, 599, 'home.household'],
  ['Шампунь Head & Shoulders 400 мл', 429, 549, 'health.beauty'],
  ['Зубная паста Splat 100 мл', 179, 249, 'health.beauty'],
  ['Гель для душа Palmolive 250 мл', 189, 259, 'health.beauty'],
  ['Сигареты Parliament Aqua Blue', 239, 269, 'other.smoking'],
];
const GROCERS = [
  ['ООО "Агроторг"', 'Пятёрочка'],
  ['АО "Тандер"', 'Магнит у дома'],
  ['ООО "ВкусВилл"', 'ВкусВилл'],
  ['АО "Торговый дом "Перекрёсток"', 'Перекрёсток'],
  ['ООО "Лента"', 'Лента'],
];
const CAFES = [
  ['ООО "Шоколадница"', 'Шоколадница', [['Капучино 300 мл', 229, 259], ['Сырники со сметаной', 349, 389], ['Чизкейк Нью-Йорк', 329, 369], ['Латте 300 мл', 239, 269]]],
  ['ООО "Теремок-Инвест"', 'Теремок', [['Блин с ветчиной и сыром', 289, 329], ['Борщ', 259, 289], ['Морс клюквенный 0,4 л', 129, 149]]],
  ['ООО "Вкусно — и точка"', 'Вкусно — и точка', [['Биг Спешиал', 329, 369], ['Картофель фри средний', 129, 149], ['Добрый Кола 0,4 л', 109, 129], ['Наггетсы 6 шт', 169, 199]]],
  ['ООО "Кофемания"', 'Кофемания', [['Флэт уайт', 390, 420], ['Завтрак с яйцом пашот', 690, 760], ['Круассан', 290, 320]]],
  ['ООО "Додо Франчайзинг"', 'Додо Пицца', [['Пицца Пепперони 30 см', 699, 799], ['Додстер', 249, 279], ['Пицца Маргарита 30 см', 599, 699]]],
];
const OZON = '7704217370';
const WB = '7721546864';
const MARKET = [
  ['Наушники беспроводные JBL Tune 520BT', 3290, 4490, 'home.electronics'],
  ['Кабель USB-C 1 м', 299, 590, 'home.electronics'],
  ['Контейнеры для еды 5 шт', 499, 790, 'home.goods'],
  ['Постельное бельё евро сатин', 2490, 3990, 'home.goods'],
  ['Футболка мужская хлопок', 690, 1290, 'clothing.apparel'],
  ['Носки 5 пар', 390, 690, 'clothing.apparel'],
  ['Кроссовки беговые', 3990, 6490, 'clothing.shoes'],
  ['Рюкзак городской', 1990, 3490, 'clothing.accessories'],
  ['Корм для кошек Purina One 1,5 кг', 1090, 1390, 'pets.food'],
  ['Наполнитель древесный 10 л', 390, 590, 'pets.supplies'],
  ['Настольная игра Каркассон', 1990, 2590, 'home.hobby'],
  ['Учебник English File Intermediate', 1890, 2390, 'education.materials'],
  ['Подарочный набор косметики', 1490, 2490, 'gifts.gifts'],
  ['Витамин D3 2000 МЕ 60 капсул', 490, 790, 'health.pharmacy'],
];
const PHARMACY = [
  ['Ибупрофен 200 мг 20 таб', 89, 129, 'health.pharmacy'],
  ['Називин 0,05% спрей 10 мл', 219, 279, 'health.pharmacy'],
  ['Мирамистин 150 мл', 399, 489, 'health.pharmacy'],
  ['Пластырь бактерицидный 20 шт', 119, 159, 'health.pharmacy'],
  ['Магний B6 50 таб', 449, 599, 'health.pharmacy'],
  ['Крем для рук Neutrogena 50 мл', 349, 449, 'health.beauty'],
];
const PETS_SHOP = [
  ['Корм влажный для кошек Whiskas 75 г', 35, 45, 'pets.food'],
  ['Лакомство для кошек Dreamies 60 г', 119, 149, 'pets.food'],
  ['Наполнитель комкующийся 10 л', 590, 790, 'pets.supplies'],
  ['Лакомство для собак Мнямс палочки', 249, 349, 'pets.food'],
  ['Игрушка для собак канат', 290, 490, 'pets.supplies'],
  ['Пакеты для выгула 4×20 шт', 190, 290, 'pets.supplies'],
];

// Вещи, которые покупают один раз: случайный выбор иначе возвращал бы их снова и снова
// (семья, купившая «Каркассон» пять раз за год). Повторно такая позиция из чека выпадает
const ONCE = new Set([
  'Наушники беспроводные JBL Tune 520BT', 'Постельное бельё евро сатин', 'Кроссовки беговые', 'Рюкзак городской',
  'Настольная игра Каркассон', 'Учебник English File Intermediate', 'Кроссовки', 'Краска интерьерная 2,5 л',
  'Пылесос вертикальный', 'Внешний аккумулятор 10000 мА·ч', 'Книга «Атлант расправил плечи»', 'Пазл 1000 элементов',
  'Развивающий коврик', 'Погремушка-грызунок', 'Парфюмерная вода Lanvin Éclat 50 мл', 'Умная колонка Яндекс Станция Лайт',
  'Новогодний костюм для малыша «Мишка»', 'Плед флисовый 150×200', 'Шторы блэкаут 2×140×260', 'Карниз потолочный 3 м',
  'Люстра потолочная', 'Торшер', 'Зеркало в прихожую', 'Ковёр 160×230', 'Комод детский', 'Монстера в кашпо',
  'Сушилка для белья напольная', 'Набор кастрюль 6 предметов', 'Рамки для фото 5 шт', 'Лежанка для собаки 90 см',
  'Домик для кошки', 'Сумка в роддом', 'Подушка для беременных U-образная', 'Слинг-шарф',
]);

// Обустройство новой квартиры: крупное — в первые месяцы после переезда, дальше — мелочи
const SETTLE_BIG = [
  ['ООО "Хофф"', 'Hoff', [['Диван-кровать Мадрид', 49990, 64990, 'home.furniture'], ['Шкаф-купе 180 см', 34990, 44990, 'home.furniture'],
    ['Стол обеденный раздвижной', 14990, 21990, 'home.furniture'], ['Стулья 4 шт', 11990, 15990, 'home.furniture'], ['Кровать 160×200', 29990, 39990, 'home.furniture']]],
  ['ООО "МВМ"', 'М.Видео', [['Стиральная машина LG 7 кг', 32990, 41990, 'home.appliances'], ['Холодильник Bosch', 54990, 69990, 'home.appliances'],
    ['Посудомоечная машина Midea 45 см', 27990, 34990, 'home.appliances'], ['Микроволновая печь', 6990, 9990, 'home.appliances']]],
  ['ООО "Лемана ПРО"', 'Лемана ПРО', [['Ламинат 33 класс, 18 м²', 14990, 21990, 'housing.repair'], ['Краска интерьерная 2,5 л', 1290, 2190, 'housing.repair'],
    ['Плитка настенная для ванной, 6 м²', 9990, 14990, 'housing.repair'], ['Смеситель для кухни', 3990, 6990, 'housing.repair'], ['Карниз потолочный 3 м', 1490, 2490, 'housing.repair']]],
];
const SETTLE_SMALL = [
  ['Шторы блэкаут 2×140×260', 3490, 5990, 'home.goods'], ['Люстра потолочная', 4990, 8990, 'home.goods'], ['Торшер', 3490, 5990, 'home.goods'],
  ['Зеркало в прихожую', 2990, 4990, 'home.furniture'], ['Ковёр 160×230', 6990, 11990, 'home.goods'], ['Монстера в кашпо', 2490, 3990, 'home.hobby'],
  ['Сушилка для белья напольная', 1990, 2990, 'home.goods'], ['Набор кастрюль 6 предметов', 4990, 7990, 'home.goods'], ['Рамки для фото 5 шт', 990, 1690, 'home.goods'],
  ['Крючки самоклеящиеся 10 шт', 190, 390, 'home.goods'], ['Лампа светодиодная E27 3 шт', 290, 490, 'home.goods'], ['Саморезы 200 шт', 190, 390, 'housing.repair'],
];

/** Год трат и до конца года: чеки, маркетплейсы, ручные записи, операции банка без чеков, доходы. */
function generate(db, budgetId) {
  const rnd = random(7919);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const between = (a, b) => a + (b - a) * rnd();
  const chance = (p) => rnd() < p;
  const rub = (a, b) => Math.round(between(a, b)) * 100; // в копейках, целые рубли
  const stamp = now();
  const pad = (n) => String(n).padStart(2, '0');
  const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const at = (d, h1, h2) => `${day(d)}T${pad(Math.floor(between(h1, h2)))}:${pad(Math.floor(between(0, 60)))}:${pad(Math.floor(between(0, 60)))}`;

  // Двое в бюджете: чеки подписаны тем, кто их добавил
  const he = demoPerson(db, '__demo_artem__', 'Артём', budgetId);
  const she = demoPerson(db, '__demo_katya__', 'Катя', budgetId);

  const insReceipt = db.prepare(
    `INSERT INTO receipts (budget_id, added_by, source_id, fiscal_drive, fiscal_doc, fiscal_sign, created_at, purchased_at,
       purchased_date, seller, seller_inn, retail_place, operation_type, total_sum, cash_sum, ecash_sum, item_count, items_sum)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  );
  const insItem = db.prepare(
    'INSERT INTO items (receipt_id, pos, name, name_norm, quantity, unit, price, sum) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insLabel = db.prepare(
    'INSERT INTO item_labels (item_id, budget_id, category_slug, source, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  let doc = 1;
  const bought = new Set(); // разовые вещи (ONCE), уже купленные
  const insNote = db.prepare('INSERT INTO item_notes (receipt_id, pos, note, updated_at) VALUES (?, ?, ?, ?)');
  // Чек: позиции [название, цена от, цена до, категория, единица]; notes — комментарии к позициям;
  // by — кто добавил (без него — кто-то из двоих)
  const receipt = (when, seller, place, inn, all, { manual = false, notes = {}, by = null } = {}) => {
    const lines = all.filter(([name]) => !ONCE.has(name) || (!bought.has(name) && bought.add(name)));
    if (!lines.length) return; // в чеке были только уже купленные разовые вещи — покупки не было
    const items = lines.map(([name, lo, hi, cat, unit]) => {
      const weight = unit === 'кг';
      const quantity = weight ? Math.round(between(0.4, 1.6) * 1000) / 1000 : chance(0.15) ? 2 : 1;
      const price = rub(lo, hi);
      return { name, cat, unit: weight ? 'кг' : 'шт', quantity, price, sum: Math.round(price * quantity) };
    });
    const total = items.reduce((n, i) => n + i.sum, 0);
    const n = doc++;
    const id = Number(insReceipt.run(
      budgetId, by ?? (chance(0.5) ? he : she), `demo:${budgetId}:${n}`, manual ? 'manual' : `9999078900${String(budgetId).padStart(6, '0')}`, n, 100000 + n, stamp,
      when, when.slice(0, 10), manual ? 'Ручная запись' : seller, inn, place, total, manual ? total : 0, manual ? 0 : total, items.length, total,
    ).lastInsertRowid);
    items.forEach((i, k) => {
      const itemId = Number(insItem.run(id, k + 1, i.name, normalizeName(i.name), i.quantity, i.unit, i.price, i.sum).lastInsertRowid);
      // Большую часть разложил «Чекер» (зелёная точка), ручные записи — человек
      insLabel.run(itemId, budgetId, i.cat, manual ? 'pinned' : chance(0.8) ? 'dictionary' : 'manual', 0.9, stamp);
      if (notes[i.name]) insNote.run(id, k + 1, notes[i.name], stamp);
    });
  };

  const tbank = demoLink(db, 'tbank');
  const sber = demoLink(db, 'sber');
  const insOp = db.prepare(
    `INSERT INTO bank_ops (link_id, budget_id, ext_id, account, account_name, at, debited_at, direction, amount, currency,
       account_amount, status, op_group, description, merchant, card, kind, kind_source, category_slug, category_source,
       raw, created_at, updated_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUB', ?, 'OK', ?, ?, ?, ?, ?, 'manual', ?, 'manual', '{}', ?, ?, ?)`,
  );
  let ext = 1;
  // Операция банка: у Артёма — Т-Банк, у Кати — Сбер (и ипотека в Сбере)
  const op = (when, { amount, merchant, description = merchant, cat = null, kind = 'expense', group = 'PAY', direction = 'debit', bank = 'tbank', note = null }) => {
    const link = bank === 'sber' ? sber : tbank;
    const card = bank === 'sber' ? '4417' : '9315';
    insOp.run(link, budgetId, `demo-${budgetId}-${ext++}`, bank === 'sber' ? 'demo-sber' : 'demo-tbank', bank === 'sber' ? 'СберКарта Кати' : 'Black Артёма',
      when, when, direction, amount, amount, group, description, merchant, card, kind, cat, stamp, stamp, note);
  };
  const someone = () => (chance(0.5) ? 'tbank' : 'sber');

  // Свои группы семьи: «Дети» и «Путешествия» (в общем справочнике их нет), «Пособия» в доходах
  const group = (name, icon, color) => createGroup(db, budgetId, { name, icon, color }).group.slug;
  const cat = (groupSlug, name, icon) => createCategory(db, budgetId, { name, group_slug: groupSlug, icon }).category.slug;
  const kids = group('Дети', 'baby', '#e8739e');
  const KID = {
    care: cat(kids, 'Подгузники и уход', 'baby'),
    food: cat(kids, 'Детское питание', 'milk'),
    things: cat(kids, 'Вещи и игрушки', 'blocks'),
    health: cat(kids, 'Врачи и прививки', 'stethoscope'),
  };
  const trips = group('Путешествия', 'luggage', '#1aa3a3');
  const TRIP = { tickets: cat(trips, 'Билеты', 'plane'), stay: cat(trips, 'Жильё', 'hotel'), fun: cat(trips, 'Экскурсии и развлечения', 'map') };
  const benefits = createIncomeCat(db, budgetId, { name: 'Пособия', group_slug: 'other', icon: 'baby' }).category.slug;
  const income = (when, amount, merchant, description, slug, { group = 'INCOME', note = null, bank = 'tbank' } = {}) =>
    op(when, { amount, merchant, description, cat: slug, kind: 'income', direction: 'credit', group, note, bank });
  const market = (when, lines, notes, by) => {
    const ozon = chance(0.5);
    receipt(when, ozon ? 'ООО "Интернет Решения"' : 'ООО "Вайлдберриз"', ozon ? 'Ozon' : 'Wildberries', ozon ? OZON : WB, lines, { notes, by });
  };
  // Комментарии пары — как пишут себе люди
  const NOTES = {
    'Диван-кровать Мадрид': 'Выбирали два выходных. Бублик одобрил',
    'Холодильник Bosch': 'Старый оставили бывшим хозяевам',
    'Ламинат 33 класс, 18 м²': 'В спальню и будущую детскую',
    'Шторы блэкаут 2×140×260': 'В спальню — соседний дом светит',
    'Монстера в кашпо': 'Маркиза уже погрызла один лист',
    'Подушка для беременных U-образная': 'Лучшая покупка года (Катя)',
    'Коляска 2 в 1 Happy Baby': 'Выбирали три выходных подряд',
    'Автокресло 0+ Chicco': 'Взяли по акции заранее',
    'Комод детский': 'Собирали вдвоём до ночи',
    'Фотограф на выписке': 'Фото — в семейный альбом и бабушкам',
    'Живая ёлка 1,8 м': 'Поторговались — скинули 500 ₽',
    'Тюльпаны 25 шт': 'Кате и маме',
    'Икра красная горбуши 140 г': 'Не открывать до 31-го!',
    'Парфюмерная вода Lanvin Éclat 50 мл': 'Маме на Новый год. Спрятана в шкафу за полотенцами',
    'Умная колонка Яндекс Станция Лайт': 'Папе — пусть слушает своё радио',
    'Плед флисовый 150×200': 'Тёще, она всегда мёрзнет',
    'Новогодний костюм для малыша «Мишка»': 'Для фото под ёлкой',
    'Лежанка для собаки 90 см': 'Бублику — свой угол в новой квартире',
    'Домик для кошки': 'Маркиза спит рядом, но не в нём',
    'Куршская коса, экскурсия': 'Танцующий лес — Кате понравилось больше всего',
    'Янтарь, кулон': 'Кате — на память о поездке',
  };

  // Пара: квартира в ипотеку с прошлой осени, первый ребёнок рождается этой осенью (10 октября),
  // кошка Маркиза и корги Бублик
  const today = new Date();
  const year = today.getFullYear();
  const start = new Date(year - 1, today.getMonth(), today.getDate() + 1);
  const end = new Date(year, 11, 31);
  const moved = new Date(year - 1, 8, 1); // ключи от квартиры — 1 сентября прошлого года
  const birth = new Date(year, 9, 10);
  const leave = new Date(year, 7, 1); // декрет Кати — с августа: её зарплата — по июль
  const tripFrom = new Date(year, 5, 14); // поездка вдвоём в Калининград, 14–20 июня
  const tripTo = new Date(year, 5, 20);

  let firstVisit = false; // первый приём в истории — с комментарием

  function family(d, { dom, mon, md, weekend, age, trip, settled }) {
    // ── квартира: крупное — в первые четыре месяца после переезда, дальше — мелочи ──
    if (settled < 120 && chance(weekend ? 0.16 : 0.05)) {
      const [seller, place, goods] = pick(SETTLE_BIG);
      const lines = goods.filter(() => chance(0.4)).slice(0, 3);
      if (lines.length) receipt(at(d, 11, 20), seller, place, null, lines, { notes: NOTES, by: weekend ? null : he });
    }
    if (chance(settled < 200 ? 0.04 : 0.015)) market(at(d, 10, 23), [pick(SETTLE_SMALL)], NOTES);
    if (md === '09-03' && d.getFullYear() === year - 1) {
      receipt(at(d, 12, 18), '', '', null, [['Грузчики, переезд', 6000, 9000, 'home.goods']], { manual: true, by: he, notes: { 'Грузчики, переезд': 'Переехали! Коробки разбирать до Нового года' } });
    }

    // ── беременность (с конца января) ──
    if (age > -260 && age < 0) {
      if (dom === 8) op(at(d, 10, 18), { amount: rub(3500, 6500), merchant: 'Мать и дитя', description: 'Ведение беременности', cat: 'health.services', bank: 'sber', note: firstVisit ? null : 'Первое УЗИ! Распечатали снимок для бабушек' });
      if (dom === 8) firstVisit = true;
      if (dom === 21) receipt(at(d, 10, 20), 'ООО "Аптека-А.в.е-1"', 'Аптека Ригла', null, [['Элевит Пронаталь 30 таб', 1290, 1590, 'health.pharmacy']], { by: she });
      if (age > -200 && dom === 4) op(at(d, 9, 12), { amount: 380000, merchant: 'Йога-студия Прана', description: 'Йога для беременных, абонемент', cat: 'health.fitness', bank: 'sber' });
      if (age === -150) market(at(d, 10, 22), [['Подушка для беременных U-образная', 2990, 4490, 'home.goods'], ['Джинсы для беременных', 2490, 3490, 'clothing.apparel']], NOTES, she);
      if (age === -95) op(at(d, 18, 21), { amount: rub(9000, 12000), merchant: 'Школа будущих родителей', description: 'Курс для пар, 6 занятий', cat: 'education.courses', bank: 'sber', note: 'Артём научился пеленать плюшевого медведя' });
      if (age === -60) {
        receipt(at(d, 11, 19), 'АО "Детский мир"', 'Детский мир', null, [
          ['Коляска 2 в 1 Happy Baby', 29990, 36990, KID.things], ['Кроватка-трансформер', 11990, 15990, KID.things], ['Матрас детский', 3490, 4990, KID.things],
        ], { notes: NOTES, by: he });
      }
      if (age === -45) receipt(at(d, 11, 19), 'ООО "Хофф"', 'Hoff', null, [['Комод детский', 9990, 14990, KID.things]], { notes: NOTES, by: he });
      if (age === -30) {
        market(at(d, 10, 22), [['Автокресло 0+ Chicco', 12990, 16990, KID.things], ['Боди хлопок 5 шт', 1290, 1790, KID.things],
          ['Пелёнки муслиновые 3 шт', 990, 1490, KID.care], ['Слинг-шарф', 1990, 2990, KID.things]], NOTES, she);
      }
      if (age === -12) {
        market(at(d, 12, 19), [['Подгузники Pampers Premium Care 1 (2–5 кг) 102 шт', 1890, 2290, KID.care],
          ['Детский крем под подгузник', 390, 590, KID.care], ['Сумка в роддом', 1990, 2990, KID.things]], {}, she);
      }
    }
    // Роды и выписка; пока Катя в роддоме, Бублик — у бабушки
    if (age === -1) op(at(d, 20, 23), { amount: rub(1500, 2500), merchant: 'Яндекс Go', description: 'Такси в роддом', cat: 'transport.public', note: 'В 4 утра. Бублик — к маме на неделю' });
    if (age === 3) receipt(at(d, 11, 16), '', '', null, [['Цветы на выписку', 3500, 5500, 'gifts.gifts'], ['Фотограф на выписке', 6000, 9000, 'leisure.events']], { manual: true, by: he, notes: NOTES });

    // ── деньги семьи ──
    // Зарплата Артёма — аванс и расчёт; Катина — до декрета
    if (dom === 10) income(at(d, 9, 12), 9200000, 'ООО "Северный ветер"', 'Заработная плата', 'in.salary');
    if (dom === 25) income(at(d, 9, 12), 6100000, 'ООО "Северный ветер"', 'Аванс', 'in.salary');
    if (d < leave && dom === 5) income(at(d, 9, 12), 6800000, 'АО "Медиалаб"', 'Заработная плата', 'in.salary', { bank: 'sber' });
    if (d < leave && dom === 20) income(at(d, 9, 12), 4500000, 'АО "Медиалаб"', 'Аванс', 'in.salary', { bank: 'sber' });
    if (day(d) === day(new Date(year, 7, 6))) income(at(d, 9, 12), 41380000, 'Социальный фонд России', 'Пособие по беременности и родам', benefits, { bank: 'sber', note: 'Декретные — сразу за 140 дней' });
    if (age === 12) income(at(d, 9, 12), 2698000, 'Социальный фонд России', 'Единовременное пособие при рождении ребёнка', benefits, { bank: 'sber' });
    if (age > 30 && dom === 15) income(at(d, 9, 12), 5170000, 'Социальный фонд России', 'Пособие по уходу за ребёнком', benefits, { bank: 'sber' });
    if (dom === 20 && mon % 3 === 2) income(at(d, 9, 12), rub(25000, 40000), 'ООО "Северный ветер"', 'Премия по итогам квартала', 'in.bonus');
    if (md === '12-24') income(at(d, 9, 12), rub(90000, 130000), 'ООО "Северный ветер"', 'Годовая премия', 'in.bonus', { note: 'На подушку безопасности' });
    // Весна: имущественный вычет за квартиру
    if (md === '05-22') income(at(d, 9, 12), 26000000, 'УФК по г. Москве (ИФНС)', 'Возврат НДФЛ: имущественный вычет', 'in.other', { note: 'Вычет за квартиру — первая часть. Подавали в феврале' });

    // ── ипотека и квартира ──
    if (dom === 5) op(at(d, 9, 12), { amount: 6430000, merchant: 'СберБанк', description: 'Платёж по ипотеке', cat: 'housing.rent', bank: 'sber', group: 'TRANSFER', note: dom === 5 && mon === 0 ? 'Ещё 238 платежей' : null });
    if (md === '08-28') op(at(d, 10, 14), { amount: rub(14000, 17000), merchant: 'СберСтрахование', description: 'Страхование ипотеки', cat: 'finance.credit', bank: 'sber', note: 'Продлевать каждый год в конце августа' });
    if (md === '11-25') op(at(d, 9, 12), { amount: rub(4500, 6500), merchant: 'ФНС России', description: 'Налог на имущество', cat: 'finance.taxes' });

    // ── питомцы: кошка Маркиза и корги Бублик ──
    if (dom === 3) market(at(d, 9, 22), [['Корм для собак Royal Canin Medium 12 кг', 7490, 8990, 'pets.food'], ['Корм для кошек Purina One 1,5 кг', 1090, 1390, 'pets.food']]);
    if (chance(0.05)) receipt(at(d, 10, 20), 'ООО "Четыре лапы"', 'Четыре лапы', null, [pick(PETS_SHOP), ...(chance(0.5) ? [pick(PETS_SHOP)] : [])]);
    if (dom === 17 && mon % 2 === 0) op(at(d, 11, 17), { amount: rub(2800, 3600), merchant: 'Груминг-салон Пушистик', description: 'Груминг корги', cat: 'pets.vet', bank: 'sber', note: mon === 0 ? 'Бублик вернулся в бантике' : null });
    if (md === '04-11') op(at(d, 10, 14), { amount: rub(4500, 6000), merchant: 'Ветклиника Айболит', description: 'Прививки: Маркиза и Бублик', cat: 'pets.vet' });
    if (chance(0.005)) op(at(d, 10, 19), { amount: rub(1500, 3500), merchant: 'Ветклиника Айболит', description: 'Приём ветеринара', cat: 'pets.vet' });
    if (settled === 20) market(at(d, 11, 21), [['Лежанка для собаки 90 см', 2490, 3490, 'pets.supplies'], ['Домик для кошки', 1990, 2990, 'pets.supplies']], NOTES, she);

    // ── ребёнок после рождения ──
    if (age >= 0) {
      if (chance(0.13)) {
        const size = age < 60 ? 2 : age < 150 ? 3 : 4;
        const lines = [[`Подгузники Pampers Premium Care ${size} 84 шт`, 1790, 2290, KID.care]];
        if (chance(0.6)) lines.push(['Влажные салфетки детские 3×64 шт', 390, 590, KID.care]);
        if (chance(0.3)) lines.push(pick([['Шампунь детский Johnson’s', 290, 390, KID.care], ['Масло для массажа детское', 390, 490, KID.care]]));
        if (chance(0.5)) receipt(at(d, 9, 22), 'АО "Детский мир"', 'Детский мир', null, lines);
        else market(at(d, 9, 22), lines);
      }
      if (chance(0.035)) {
        market(at(d, 10, 21), [pick([
          ['Комбинезон детский зимний', 3490, 4990, KID.things], ['Слип хлопковый 3 шт', 1190, 1690, KID.things],
          ['Погремушка-грызунок', 390, 690, KID.things], ['Развивающий коврик', 2990, 4490, KID.things], ['Шапочка трикотажная', 490, 890, KID.things],
        ])]);
      }
      if (age % 30 === 7) op(at(d, 9, 13), { amount: rub(2600, 3400), merchant: 'Медси', description: 'Приём педиатра', cat: KID.health, bank: 'sber' });
      if ([30, 60].includes(age)) op(at(d, 9, 13), { amount: rub(3900, 6900), merchant: 'Медси', description: 'Вакцинация', cat: KID.health, bank: 'sber', note: age === 60 ? 'Почти не плакал. Следующая — через месяц' : null });
      if (chance(0.025)) {
        receipt(at(d, 9, 21), 'ООО "Аптека-А.в.е-1"', 'Аптека Ригла', null, [pick([
          ['Аквамарис беби капли', 290, 390, KID.health], ['Бепантен крем 30 г', 590, 790, KID.care], ['Эспумизан бэби капли', 390, 490, KID.health],
        ])]);
      }
    }

    // ── поездка вдвоём, пока Катя беременна: билеты и жильё — заранее ──
    if (md === '04-28') op(at(d, 20, 23), { amount: rub(18000, 24000), merchant: 'Аэрофлот', description: 'Авиабилеты Москва — Калининград — Москва', cat: TRIP.tickets, note: 'Последняя поездка вдвоём. Ну, почти вдвоём' });
    if (md === '05-03') op(at(d, 20, 23), { amount: rub(42000, 52000), merchant: 'Островок', description: 'Апартаменты в Калининграде, 6 ночей', cat: TRIP.stay, note: 'Кошку и собаку берёт Катина мама' });

    // ── праздники ──
    if (mon === 11 && dom <= 22 && chance(0.18)) {
      market(at(d, 10, 23), [pick([
        ['Парфюмерная вода Lanvin Éclat 50 мл', 3990, 5490, 'gifts.gifts'], ['Умная колонка Яндекс Станция Лайт', 5990, 7490, 'gifts.gifts'],
        ['Плед флисовый 150×200', 1290, 1990, 'gifts.gifts'], ['Набор чая подарочный', 990, 1690, 'gifts.gifts'],
        ...(age >= 0 ? [['Новогодний костюм для малыша «Мишка»', 1490, 2290, KID.things]] : []),
      ])], NOTES);
    }
    if (md === '12-14') {
      receipt(at(d, 11, 19), 'ООО "Лемана ПРО"', 'Лемана ПРО', null, [
        ['Гирлянда светодиодная 10 м', 690, 1290, 'home.goods'], ['Ёлочные шары 12 шт', 590, 990, 'home.goods'], ['Мишура', 149, 249, 'home.goods'],
      ]);
    }
    if (md === '12-27') receipt(at(d, 11, 17), '', '', null, [['Живая ёлка 1,8 м', 3000, 4500, 'home.goods']], { manual: true, by: he, notes: NOTES });
    if (md === '12-30') {
      receipt(at(d, 11, 15), 'АО "Торговый дом "Перекрёсток"', 'Перекрёсток', null, [
        ['Икра красная горбуши 140 г', 1290, 1690, 'food.groceries'], ['Мандарины Абхазия', 199, 299, 'food.groceries', 'кг'],
        ['Шампанское Абрау-Дюрсо брют 0,75 л', 599, 899, 'food.alcohol'], ['Горошек зелёный Бондюэль 400 г', 129, 179, 'food.groceries'],
        ['Майонез Махеевъ 380 г', 129, 169, 'food.groceries'], ['Колбаса Докторская 400 г', 279, 359, 'food.groceries'],
        ['Торт Наполеон 1 кг', 899, 1290, 'food.groceries'], ['Буженина 300 г', 449, 599, 'food.groceries'],
      ], { notes: NOTES });
    }
    if (md === '02-14') {
      receipt(at(d, 19, 22), 'ООО "Грузинские каникулы"', 'Грузинские каникулы', null, [
        ['Хачапури по-аджарски', 590, 690, 'food.dining'], ['Хинкали 5 шт', 490, 590, 'food.dining'], ['Лимонад тархун 0,5 л', 290, 350, 'food.dining'], ['Десерт', 390, 490, 'food.dining'],
      ], { by: he });
    }
    if (md === '03-08') receipt(at(d, 9, 12), '', '', null, [['Тюльпаны 25 шт', 3000, 4500, 'gifts.gifts']], { manual: true, by: he, notes: NOTES });
    // Закупка в «Ленте»: продукты, корм, бытовая химия — по ней снят скан в ролике «Чекер за минуту»
    if (md === '05-15') {
      receipt(at(d, 11, 13), 'ООО "Лента"', 'Лента', null, [
        ['Молоко Простоквашино 3,2% 930 мл', 89, 115, 'food.groceries'], ['Филе куриное охлаждённое', 389, 469, 'food.groceries', 'кг'],
        ['Сыр Российский 45% 200 г', 179, 249, 'food.groceries'], ['Корм для кошек Purina One 1,5 кг', 1090, 1390, 'pets.food'],
        ['Стиральный порошок Persil 1,5 кг', 449, 599, 'home.household'], ['Средство для посуды Fairy 450 мл', 159, 219, 'home.household'],
      ], { by: she });
    }
    if (md === '07-09') income(at(d, 12, 20), 1500000, 'Друзья', 'Перевод: с днём рождения!', 'in.gifts', { group: 'TRANSFER', note: 'Артёму от друзей — на велосипед' });

    // ── машина: Киа Рио — ОСАГО весной, переобувка дважды в год, ТО летом, налог осенью ──
    if (md === '03-20') op(at(d, 12, 18), { amount: rub(10500, 12800), merchant: 'Ингосстрах', description: 'ОСАГО', cat: 'transport.service', note: 'Продлевать каждый март. Вписали Катю' });
    if (md === '04-12' || md === '10-25') op(at(d, 10, 17), { amount: rub(2900, 3800), merchant: 'Шиномонтаж Колесо', description: 'Сезонная замена шин', cat: 'transport.service' });
    if (md === '07-18') op(at(d, 10, 17), { amount: rub(19000, 27000), merchant: 'Kia Автомир', description: 'Плановое ТО', cat: 'transport.service', note: 'Перед роддомом — чтобы без сюрпризов' });
    if (md === '11-26') op(at(d, 9, 12), { amount: rub(2600, 3400), merchant: 'ФНС России', description: 'Транспортный налог', cat: 'finance.taxes' });
    if (chance(0.025)) op(at(d, 10, 20), { amount: rub(450, 900), merchant: 'Мойка Лайт', description: 'Автомойка', cat: 'transport.service' });
  }

  // День поездки в Калининград: кафе, продукты, такси, экскурсии
  function tripDay(d, dom) {
    if (dom === 14) op(at(d, 13, 15), { amount: rub(900, 1400), merchant: 'Яндекс Go', description: 'Такси из аэропорта Храброво', cat: 'transport.public' });
    if (dom === 20) op(at(d, 9, 11), { amount: rub(900, 1400), merchant: 'Яндекс Go', description: 'Такси в аэропорт Храброво', cat: 'transport.public' });
    const [seller, place] = pick([['ООО "Солнечный камень"', 'Ресторан «Солнечный камень»'], ['ООО "Рыбная деревня"', 'Рыбная деревня'], ['ООО "Кёнигсберг"', 'Кафе «Кёнигсберг»']]);
    receipt(at(d, 12, 21), seller, place, null, [['Уха по-балтийски', 490, 590, 'food.dining'], ['Копчёная рыба ассорти', 690, 890, 'food.dining'],
      ['Салат из овощей', 390, 490, 'food.dining'], ['Морс клюквенный 0,4 л', 190, 250, 'food.dining']]);
    if (dom === 16) receipt(at(d, 10, 12), 'ООО "Балтик-тур"', 'Балтик-тур', null, [['Куршская коса, экскурсия', 5600, 6800, TRIP.fun]], { notes: NOTES });
    if (dom === 18) receipt(at(d, 11, 13), 'ИП Янтарёва', 'Янтарная лавка', null, [['Янтарь, кулон', 2400, 3900, 'gifts.gifts']], { notes: NOTES, by: he });
    if (chance(0.4)) op(at(d, 10, 22), { amount: rub(290, 690), merchant: 'Яндекс Go', description: 'Яндекс Такси', cat: 'transport.public' });
  }

  // Обычный день дома: продукты, кафе, маркетплейсы, аптека, ручные записи
  function homeDay(d, { weekend, age }) {
    if (chance(weekend ? 0.7 : 0.35)) {
      const [seller, place] = pick(GROCERS);
      const n = weekend ? Math.floor(between(8, 16)) : Math.floor(between(3, 8));
      const lines = Array.from({ length: n }, () => pick(GROCERY));
      if (chance(0.35)) lines.push(pick(GROCERY_EXTRA.filter(([, , , c]) => age >= 0 || age < -270 || c !== 'food.alcohol')));
      receipt(at(d, weekend ? 11 : 18, weekend ? 19 : 22), seller, place, null, [...new Map(lines.map((l) => [l[0], l])).values()]);
    }
    // Кафе — пару раз в неделю; с малышом — реже, зато чаще доставка
    if (chance((weekend ? 0.35 : 0.15) * (age >= 0 ? 0.4 : 1))) {
      const [seller, place, menu] = pick(CAFES);
      const lines = Array.from({ length: Math.floor(between(1, 4)) }, () => pick(menu)).map(([n, lo, hi]) => [n, lo, hi, 'food.dining']);
      receipt(at(d, 9, 21), seller, place, null, [...new Map(lines.map((l) => [l[0], l])).values()]);
    }
    if (chance(age >= 0 ? 0.14 : 0.06)) {
      receipt(at(d, 19, 23), 'ООО "Яндекс.Еда"', 'Яндекс Еда', null,
        [['Поке с лососем', 590, 690, 'food.delivery'], ['Ролл Филадельфия', 649, 749, 'food.delivery'], ['Доставка', 99, 199, 'food.delivery']]);
    }
    if (chance(0.07)) {
      const lines = Array.from({ length: Math.floor(between(1, 3)) }, () => pick(MARKET));
      market(at(d, 8, 23), [...new Map(lines.map((l) => [l[0], l])).values()]);
    }
    if (chance(0.06)) receipt(at(d, 9, 21), 'ООО "Аптека-А.в.е-1"', 'Аптека Ригла', null, Array.from({ length: Math.floor(between(1, 3)) }, () => pick(PHARMACY)));
    // Бензин — раз в неделю-полторы: заправляет Артём
    if (chance(0.11)) {
      const litres = Math.round(between(25, 42));
      const price = between(58, 64);
      const sum = Math.round(litres * price) * 100;
      const n = doc++;
      const lukoil = chance(0.5);
      const id = Number(insReceipt.run(budgetId, he, `demo:${budgetId}:${n}`, `9999078900${String(budgetId).padStart(6, '0')}`, n, 100000 + n,
        stamp, at(d, 7, 22), day(d), lukoil ? 'ООО "Лукойл-Интер-Кард"' : 'АО "Газпромнефть-Центр"',
        null, lukoil ? 'АЗС Лукойл' : 'АЗС Газпромнефть', sum, 0, sum, 1, sum).lastInsertRowid);
      const item = Number(insItem.run(id, 1, 'Бензин АИ-95', normalizeName('Бензин АИ-95'), litres, 'л', Math.round(price * 100), sum).lastInsertRowid);
      insLabel.run(item, budgetId, 'transport.fuel', 'dictionary', 0.9, stamp);
    }
    if (chance(0.02)) {
      receipt(at(d, 11, 21), 'ООО "Спортмастер"', 'Спортмастер', null,
        [pick([['Футболка спортивная', 990, 1990, 'clothing.apparel'], ['Кроссовки', 4990, 8990, 'clothing.shoes'], ['Шапка', 790, 1490, 'clothing.accessories']])]);
    }
    if (chance(0.012)) receipt(at(d, 11, 21), 'ООО "Новый книжный центр"', 'Читай-город', null, [pick([['Книга «Атлант расправил плечи»', 990, 1390, 'home.hobby'], ['Пазл 1000 элементов', 690, 990, 'home.hobby']])]);
    if (age < 0 && chance(0.015)) {
      receipt(at(d, 12, 22), 'ООО "Каро Фильм Менеджмент"', 'Каро 11 Октябрь', null,
        [['Билет в кино', 450, 650, 'leisure.events'], ...(chance(0.6) ? [['Попкорн средний', 390, 490, 'leisure.events']] : [])]);
    }
    // Ручные записи — рынок, чаевые, мелочи наличными
    if (chance(0.04)) {
      const [name, lo, hi, cat] = pick([['Овощи на рынке', 400, 1200, 'food.groceries'], ['Чаевые', 100, 300, 'food.dining'],
        ['Стрижка', 900, 1500, 'health.beauty'], ['Цветы маме', 1500, 3000, 'gifts.gifts'], ['Ремонт обуви', 500, 1200, 'other.other']]);
      receipt(at(d, 10, 21), '', '', null, [[name, lo, hi, cat]], { manual: true });
    }
  }

  for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const dow = d.getDay(); // 0 — воскресенье
    const dom = d.getDate();
    const mon = d.getMonth(); // 0 — январь
    const weekend = dow === 0 || dow === 6;
    const md = `${pad(mon + 1)}-${pad(dom)}`;
    const age = Math.round((d - birth) / 86400000); // дней ребёнку; меньше нуля — ещё не родился
    const settled = Math.round((d - moved) / 86400000); // дней в новой квартире
    const trip = d >= tripFrom && d <= tripTo;

    family(d, { dom, mon, md, weekend, age, trip, settled });
    if (trip) tripDay(d, dom);
    else homeDay(d, { weekend, age });

    // ── банк: траты без чеков ──
    if (chance(weekend ? 0.04 : 0.07)) op(at(d, 7, 23), { amount: rub(290, 890), merchant: 'Яндекс Go', description: 'Яндекс Такси', cat: 'transport.public', bank: someone() });
    if (chance(0.05)) op(at(d, 9, 20), { amount: rub(150, 450), merchant: 'Парковки Москвы', cat: 'transport.parking' });
    if (dom === 1 || dom === 16) op(at(d, 8, 10), { amount: 100000, merchant: 'Тройка', description: 'Пополнение карты Тройка', cat: 'transport.public' });
    if (dom === 10) op(at(d, 12, 20), { amount: rub(6200, 8400), merchant: 'ЕИРЦ Москвы', description: 'Оплата ЖКУ', cat: 'housing.utilities', bank: 'sber' });
    if (dom === 12) op(at(d, 12, 20), { amount: rub(900, 1500), merchant: 'Мосэнергосбыт', cat: 'housing.utilities', bank: 'sber' });
    if (dom === 5) op(at(d, 9, 12), { amount: 65000, merchant: 'МТС', description: 'Мобильная связь МТС', cat: 'housing.telecom' });
    if (dom === 7) op(at(d, 9, 12), { amount: 75000, merchant: 'Ростелеком', description: 'Домашний интернет', cat: 'housing.telecom', bank: 'sber' });
    if (dom === 14) op(at(d, 9, 12), { amount: 39900, merchant: 'Яндекс Плюс', cat: 'leisure.media' });
    if (dom === 20) op(at(d, 9, 12), { amount: 29900, merchant: 'Кинопоиск', cat: 'leisure.media', bank: 'sber' });
    if (dom === 2) op(at(d, 9, 12), { amount: 350000, merchant: 'Фитнес-клуб Спирит', description: 'Абонемент Артёма', cat: 'health.fitness' });
    if (chance(0.012)) op(at(d, 10, 19), { amount: rub(2200, 4500), merchant: 'Медси', description: 'Приём врача', cat: 'health.services', bank: someone() });
    if (chance(0.005)) op(at(d, 10, 19), { amount: rub(4500, 12000), merchant: 'Стоматология Улыбка', cat: 'health.services' });
    if (dom === 15 && mon % 2 === 0) op(at(d, 9, 12), { amount: 590000, merchant: 'Skillbox', description: 'Онлайн-курс', cat: 'education.courses' });
    if (dom === 28) op(at(d, 9, 12), { amount: 9900, merchant: 'Т-Банк', description: 'Плата за обслуживание', cat: 'finance.fees' });
    if (chance(0.01)) op(at(d, 10, 20), { amount: rub(1000, 5000), merchant: 'Иван Петров', description: 'Иван П.', cat: 'gifts.gifts', group: 'TRANSFER' });
    if (md === '12-27' || md === '03-06' || md === '02-21') {
      receipt(at(d, 12, 20), 'ООО "Золотое яблоко"', 'Золотое Яблоко', null, [['Подарочный набор', 2490, 4990, 'gifts.gifts']]);
    }

    // ── доходы: мелкие ──
    if (dom === 1) income(at(d, 6, 9), rub(800, 1900), 'Т-Банк', 'Кешбэк за покупки', 'in.cashback');
    if (dom === 28) income(at(d, 6, 9), rub(1200, 2100), 'Т-Банк', 'Проценты на остаток', 'in.interest');
    if (chance(0.006)) income(at(d, 10, 20), rub(3000, 10000), 'Мама', 'Перевод от Мама', 'in.gifts', { group: 'TRANSFER' });
    // Переводы себе — в копилку и обратно
    if (dom === 11) op(at(d, 12, 18), { amount: 1500000, merchant: 'Между своими счетами', description: 'Перевод на накопительный счёт', kind: 'transfer', group: 'TRANSFER' });
    if (chance(0.01)) op(at(d, 12, 18), { amount: rub(3000, 8000), merchant: 'Между своими счетами', description: 'Перевод с накопительного счёта', kind: 'transfer', direction: 'credit', group: 'TRANSFER' });
  }
}
