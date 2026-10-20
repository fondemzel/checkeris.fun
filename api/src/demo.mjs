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
// Семья живая: осенью отпуск, в декабре подарки и ёлка, пять месяцев назад родился ребёнок —
// до этого траты на беременность, после — подгузники, педиатр, пособия. «Дети» и
// «Путешествия» — свои группы этой семьи: в общем справочнике их нет, заодно видно, как
// выглядят созданные человеком категории.
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
const DEMO_VERSION = 2;
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
  ['Когтеточка напольная', 690, 1290, 'pets.supplies'],
];

// Вещи, которые покупают один раз: случайный выбор иначе возвращал бы их снова и снова
// (семья, купившая «Каркассон» пять раз за год). Повторно такая позиция из чека выпадает
const ONCE = new Set([
  'Наушники беспроводные JBL Tune 520BT', 'Постельное бельё евро сатин', 'Кроссовки беговые', 'Рюкзак городской',
  'Настольная игра Каркассон', 'Учебник English File Intermediate', 'Кроссовки', 'Краска интерьерная 2,5 л', 'Полка настенная',
  'Чайник электрический Polaris', 'Пылесос вертикальный', 'Внешний аккумулятор 10000 мА·ч', 'Книга «Атлант расправил плечи»',
  'Пазл 1000 элементов', 'Когтеточка напольная', 'Развивающий коврик', 'Погремушка-грызунок',
  'Парфюмерная вода Lanvin Éclat 50 мл', 'Умная колонка Яндекс Станция Лайт', 'Конструктор LEGO DUPLO «Мой первый поезд»',
  'Новогодний костюм для малыша «Мишка»', 'Плед флисовый 150×200',
]);

/** Год трат и до конца года: чеки, маркетплейсы, ручные записи, операции банка без чеков, доходы. */
function generate(db, budgetId) {
  const userId = null; // чеки тестовой базы — ничьи
  const rnd = random(7919);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const between = (a, b) => a + (b - a) * rnd();
  const chance = (p) => rnd() < p;
  const rub = (a, b) => Math.round(between(a, b)) * 100; // в копейках, целые рубли
  const stamp = now();
  const pad = (n) => String(n).padStart(2, '0');
  const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const at = (d, h1, h2) => `${day(d)}T${pad(Math.floor(between(h1, h2)))}:${pad(Math.floor(between(0, 60)))}:${pad(Math.floor(between(0, 60)))}`;

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
  // Чек: позиции [название, цена от, цена до, категория, единица]
  const bought = new Set(); // разовые вещи (ONCE), уже купленные
  const receipt = (when, seller, place, inn, all, { manual = false } = {}) => {
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
      budgetId, userId, `demo:${budgetId}:${n}`, manual ? 'manual' : `9999078900${String(budgetId).padStart(6, '0')}`, n, 100000 + n, stamp,
      when, when.slice(0, 10), manual ? 'Ручная запись' : seller, inn, place, total, manual ? total : 0, manual ? 0 : total, items.length, total,
    ).lastInsertRowid);
    items.forEach((i, k) => {
      const itemId = Number(insItem.run(id, k + 1, i.name, normalizeName(i.name), i.quantity, i.unit, i.price, i.sum).lastInsertRowid);
      // Большую часть разложил «Чекер» (зелёная точка), ручные записи — человек
      insLabel.run(itemId, budgetId, i.cat, manual ? 'pinned' : chance(0.8) ? 'dictionary' : 'manual', 0.9, stamp);
    });
  };

  const tbank = demoLink(db, 'tbank');
  const sber = demoLink(db, 'sber');
  const insOp = db.prepare(
    `INSERT INTO bank_ops (link_id, budget_id, ext_id, account, account_name, at, debited_at, direction, amount, currency,
       account_amount, status, op_group, description, merchant, card, kind, kind_source, category_slug, category_source,
       raw, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUB', ?, 'OK', ?, ?, ?, ?, ?, 'manual', ?, 'manual', '{}', ?, ?)`,
  );
  let ext = 1;
  // Операция банка: траты без чека, поступления, переводы себе
  const op = (when, { amount, merchant, description = merchant, cat = null, kind = 'expense', group = 'PAY', direction = 'debit', bank = 'tbank' }) => {
    const link = bank === 'sber' ? sber : tbank;
    const card = bank === 'sber' ? '4417' : '9315';
    insOp.run(link, budgetId, `demo-${budgetId}-${ext++}`, bank === 'sber' ? 'demo-sber' : 'demo-tbank', bank === 'sber' ? 'СберКарта' : 'Black',
      when, when, direction, amount, amount, group, description, merchant, card, kind, cat, stamp, stamp);
  };

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
  const income = (when, amount, merchant, description, slug, group = 'INCOME') =>
    op(when, { amount, merchant, description, cat: slug, kind: 'income', direction: 'credit', group });
  const market = (when, lines) => {
    const ozon = chance(0.5);
    receipt(when, ozon ? 'ООО "Интернет Решения"' : 'ООО "Вайлдберриз"', ozon ? 'Ozon' : 'Wildberries', ozon ? OZON : WB, lines);
  };

  // ── то, что делает год этой семьи особенным ──
  // Ребёнок (беременность → рождение → первые месяцы), праздники, машина, дача, день рождения
  function family(d, { dom, mon, md, weekend, age, trip }) {
    // Беременность: врач раз в месяц, витамины; за месяц-полтора до родов — коляска, кроватка
    if (age < 0 && age > -270) {
      if (dom === 8) op(at(d, 10, 18), { amount: rub(3500, 6500), merchant: 'Мать и дитя', description: 'Ведение беременности', cat: 'health.services' });
      if (dom === 21) receipt(at(d, 10, 20), 'ООО "Аптека-А.в.е-1"', 'Аптека Ригла', null, [['Элевит Пронаталь 30 таб', 1290, 1590, 'health.pharmacy']]);
      if (age === -45) {
        receipt(at(d, 11, 19), 'АО "Детский мир"', 'Детский мир', null, [
          ['Коляска 2 в 1 Happy Baby', 29990, 36990, KID.things],
          ['Кроватка-трансформер', 11990, 15990, KID.things],
          ['Матрас детский', 3490, 4990, KID.things],
        ]);
      }
      if (age === -30) {
        receipt(at(d, 10, 22), 'ООО "Интернет Решения"', 'Ozon', OZON, [
          ['Автокресло 0+ Chicco', 12990, 16990, KID.things],
          ['Боди хлопок 5 шт', 1290, 1790, KID.things],
          ['Пелёнки муслиновые 3 шт', 990, 1490, KID.care],
        ]);
      }
      if (age === -12) {
        receipt(at(d, 12, 19), 'ООО "Интернет Решения"', 'Ozon', OZON, [
          ['Подгузники Pampers Premium Care 1 (2–5 кг) 102 шт', 1890, 2290, KID.care],
          ['Детский крем под подгузник', 390, 590, KID.care],
          ['Сумка в роддом', 1990, 2990, KID.things],
        ]);
      }
    }
    if (age === 3) receipt(at(d, 11, 16), '', '', null, [['Цветы на выписку', 3500, 5500, 'gifts.gifts'], ['Фотограф на выписке', 6000, 9000, 'leisure.events']], { manual: true });
    if (age === 12) income(at(d, 9, 12), 2698000, 'Социальный фонд России', 'Единовременное пособие при рождении ребёнка', benefits);
    if (age > 20 && dom === 15) income(at(d, 9, 12), 4920000, 'Социальный фонд России', 'Пособие по уходу за ребёнком', benefits);
    if (age >= 0 && !trip) {
      // Подгузники и уход — раз в неделю-полторы, то в «Детском мире», то с маркетплейса
      if (chance(0.13)) {
        const size = age < 60 ? 2 : age < 150 ? 3 : 4;
        const lines = [[`Подгузники Pampers Premium Care ${size} 84 шт`, 1790, 2290, KID.care]];
        if (chance(0.6)) lines.push(['Влажные салфетки детские 3×64 шт', 390, 590, KID.care]);
        if (chance(0.3)) lines.push(pick([['Шампунь детский Johnson’s', 290, 390, KID.care], ['Масло для массажа детское', 390, 490, KID.care]]));
        if (chance(0.5)) receipt(at(d, 9, 22), 'АО "Детский мир"', 'Детский мир', null, lines);
        else market(at(d, 9, 22), lines);
      }
      // Одежда и игрушки — растёт быстро
      if (chance(0.035)) {
        market(at(d, 10, 21), [pick([
          ['Комбинезон детский демисезонный', 2490, 3990, KID.things], ['Слип хлопковый 3 шт', 1190, 1690, KID.things],
          ['Погремушка-грызунок', 390, 690, KID.things], ['Развивающий коврик', 2990, 4490, KID.things],
          ['Шапочка трикотажная', 490, 890, KID.things],
        ])]);
      }
      // Педиатр каждый месяц, прививки по календарю
      if (age % 30 === 7) op(at(d, 9, 13), { amount: rub(2600, 3400), merchant: 'Медси', description: 'Приём педиатра', cat: KID.health });
      if ([45, 90, 135, 180].includes(age)) op(at(d, 9, 13), { amount: rub(3900, 6900), merchant: 'Медси', description: 'Вакцинация', cat: KID.health });
      if (chance(0.025)) {
        receipt(at(d, 9, 21), 'ООО "Аптека-А.в.е-1"', 'Аптека Ригла', null, [pick([
          ['Аквамарис беби капли', 290, 390, KID.health], ['Нурофен для детей суспензия', 290, 390, KID.health], ['Бепантен крем 30 г', 590, 790, KID.care],
        ])]);
      }
      // Прикорм — с полугода
      if (age > 170 && chance(0.12)) {
        receipt(at(d, 10, 20), 'АО "Тандер"', 'Магнит у дома', null, [
          ['Пюре ФрутоНяня яблоко 90 г', 49, 69, KID.food], ['Каша Nutrilon гречневая 200 г', 249, 329, KID.food], ['Пюре Агуша брокколи 80 г', 59, 79, KID.food],
        ]);
      }
    }

    // Перед отпуском: билеты и жильё бронируют заранее
    if (md === '08-03') op(at(d, 20, 23), { amount: rub(36000, 42000), merchant: 'Аэрофлот', description: 'Авиабилеты Москва — Сочи — Москва', cat: TRIP.tickets });
    if (md === '08-05') op(at(d, 20, 23), { amount: rub(68000, 79000), merchant: 'Островок', description: 'Апартаменты в Сочи, 9 ночей', cat: TRIP.stay });

    // Новый год: подарки весь декабрь, украшения, ёлка, большой стол
    if (mon === 11 && dom <= 22 && chance(0.18)) {
      market(at(d, 10, 23), [pick([
        ['Парфюмерная вода Lanvin Éclat 50 мл', 3990, 5490, 'gifts.gifts'], ['Умная колонка Яндекс Станция Лайт', 5990, 7490, 'gifts.gifts'],
        ['Плед флисовый 150×200', 1290, 1990, 'gifts.gifts'], ['Набор чая подарочный', 990, 1690, 'gifts.gifts'],
        ['Конструктор LEGO DUPLO «Мой первый поезд»', 2990, 3990, KID.things], ['Новогодний костюм для малыша «Мишка»', 1490, 2290, KID.things],
      ])]);
    }
    if (md === '12-14') {
      receipt(at(d, 11, 19), 'ООО "Лемана ПРО"', 'Лемана ПРО', null, [
        ['Гирлянда светодиодная 10 м', 690, 1290, 'home.goods'], ['Ёлочные шары 12 шт', 590, 990, 'home.goods'], ['Мишура', 149, 249, 'home.goods'],
      ]);
    }
    if (md === '12-20') op(at(d, 18, 22), { amount: rub(6000, 9000), merchant: 'Сандуны', description: 'Подарочный сертификат', cat: 'gifts.gifts' });
    if (md === '12-24') income(at(d, 9, 12), rub(90000, 130000), 'ООО "Северный ветер"', 'Годовая премия', 'in.bonus');
    if (md === '12-27') receipt(at(d, 11, 17), '', '', null, [['Живая ёлка 1,8 м', 3000, 4500, 'home.goods']], { manual: true });
    if (md === '12-30') {
      receipt(at(d, 11, 15), 'АО "Торговый дом "Перекрёсток"', 'Перекрёсток', null, [
        ['Икра красная горбуши 140 г', 1290, 1690, 'food.groceries'], ['Мандарины Абхазия', 199, 299, 'food.groceries', 'кг'],
        ['Шампанское Абрау-Дюрсо брют 0,75 л', 599, 899, 'food.alcohol'], ['Горошек зелёный Бондюэль 400 г', 129, 179, 'food.groceries'],
        ['Майонез Махеевъ 380 г', 129, 169, 'food.groceries'], ['Колбаса Докторская 400 г', 279, 359, 'food.groceries'],
        ['Торт Наполеон 1 кг', 899, 1290, 'food.groceries'], ['Буженина 300 г', 449, 599, 'food.groceries'],
        ['Ананас', 299, 449, 'food.groceries'], ['Сок вишнёвый 1 л', 169, 229, 'food.groceries'],
      ]);
    }
    if (md === '12-31') op(at(d, 21, 23), { amount: rub(1800, 3200), merchant: 'Яндекс Go', description: 'Яндекс Такси', cat: 'transport.public' });
    if (md === '01-04') op(at(d, 12, 20), { amount: rub(6500, 9500), merchant: 'Яндекс Афиша', description: 'Билеты на «Щелкунчика»', cat: 'leisure.events' });
    if (md === '01-06') {
      receipt(at(d, 13, 18), 'ГАУК «Парк Горького»', 'Каток в Парке Горького', null, [
        ['Вход на каток', 700, 900, 'leisure.events'], ['Прокат коньков', 500, 700, 'leisure.events'], ['Глинтвейн б/а', 290, 390, 'food.dining'],
      ]);
    }

    // Праздники поменьше
    if (md === '02-14') {
      receipt(at(d, 19, 22), 'ООО "Грузинские каникулы"', 'Грузинские каникулы', null, [
        ['Хачапури по-аджарски', 590, 690, 'food.dining'], ['Хинкали 5 шт', 490, 590, 'food.dining'],
        ['Вино Саперави бокал', 490, 590, 'food.alcohol'], ['Десерт', 390, 490, 'food.dining'],
      ]);
    }
    if (md === '03-08') receipt(at(d, 9, 12), '', '', null, [['Тюльпаны 25 шт', 3000, 4500, 'gifts.gifts']], { manual: true });

    // Машина: ОСАГО весной, ТО, переобувка дважды в год
    if (md === '03-20') op(at(d, 12, 18), { amount: rub(10500, 12800), merchant: 'Ингосстрах', description: 'ОСАГО', cat: 'transport.service' });
    if (md === '04-12' || md === '10-18') op(at(d, 10, 17), { amount: rub(2900, 3800), merchant: 'Шиномонтаж Колесо', description: 'Сезонная замена шин', cat: 'transport.service' });
    if (md === '05-16') op(at(d, 10, 17), { amount: rub(19000, 27000), merchant: 'Major Авто', description: 'Плановое ТО', cat: 'transport.service' });

    // Весна: возврат налога (вычет за лечение), концерт
    if (md === '05-22') income(at(d, 9, 12), rub(12000, 19500), 'УФК по г. Москве (ИФНС)', 'Возврат НДФЛ: налоговый вычет', 'in.other');
    if (md === '04-05') op(at(d, 18, 22), { amount: rub(7000, 9800), merchant: 'Яндекс Афиша', description: 'Билеты на концерт', cat: 'leisure.events' });

    // Лето: дача и шашлыки по выходным, рассада
    if (md === '05-09') {
      receipt(at(d, 10, 14), 'ООО "Лемана ПРО"', 'Лемана ПРО', null, [
        ['Рассада томатов 6 шт', 390, 590, 'home.hobby'], ['Грунт универсальный 50 л', 390, 590, 'home.hobby'], ['Шланг садовый 20 м', 990, 1590, 'home.goods'],
      ]);
    }
    if (weekend && mon >= 5 && mon <= 7 && chance(0.3)) {
      receipt(at(d, 10, 14), 'ООО "Агроторг"', 'Пятёрочка', null, [
        ['Шея свиная для шашлыка', 549, 699, 'food.groceries', 'кг'], ['Уголь берёзовый 3 кг', 249, 349, 'home.household'],
        ['Лаваш армянский', 49, 69, 'food.groceries'], ['Кетчуп Хайнц 320 г', 129, 169, 'food.groceries'], ['Квас Очаковский 1,5 л', 109, 139, 'food.groceries'],
      ]);
    }

    // День рождения: ужин с друзьями, друзья скинулись на подарок
    if (md === '07-09') {
      receipt(at(d, 19, 22), 'ООО "Пробка"', 'Пробка на Цветном', null, [
        ['Паста карбонара', 790, 890, 'food.dining'], ['Пицца Маргарита', 690, 790, 'food.dining'], ['Стейк рибай', 2490, 2990, 'food.dining'],
        ['Салат Цезарь', 690, 790, 'food.dining'], ['Тирамису', 490, 590, 'food.dining'], ['Вино Кьянти бутылка', 3490, 4490, 'food.alcohol'],
        ['Лимонад домашний 1 л', 590, 690, 'food.dining'],
      ]);
      income(at(d, 12, 20), 1500000, 'Друзья', 'Перевод: с днём рождения!', 'in.gifts', 'TRANSFER');
    }

    // Чёрная пятница: телевизор
    if (md === '11-28') {
      receipt(at(d, 0, 2), 'ООО "Интернет Решения"', 'Ozon', OZON, [
        ['Телевизор Xiaomi TV A Pro 55"', 34990, 41990, 'home.electronics'], ['Кронштейн настенный', 990, 1490, 'home.goods'],
      ]);
    }
  }

  // День отпуска в Сочи: кафе, продукты в номер, такси, развлечения, сувениры
  function tripDay(d, dom) {
    if (dom === 12) op(at(d, 13, 15), { amount: rub(1500, 2200), merchant: 'Яндекс Go', description: 'Такси из аэропорта Сочи', cat: 'transport.public' });
    if (dom === 21) op(at(d, 9, 11), { amount: rub(1500, 2200), merchant: 'Яндекс Go', description: 'Такси в аэропорт Сочи', cat: 'transport.public' });
    const [seller, place] = pick([['ООО "Хачапурия"', 'Хачапурия'], ['ООО "Белые ночи"', 'Ресторан «Белые ночи»'], ['ООО "Чайка"', 'Ресторан «Чайка»']]);
    const lines = [['Шашлык из баранины', 790, 990, 'food.dining'], ['Хачапури по-аджарски', 590, 690, 'food.dining'],
      ['Салат из овощей', 390, 490, 'food.dining'], ['Лимонад тархун 0,5 л', 290, 350, 'food.dining']];
    if (chance(0.5)) lines.push(['Вино домашнее 0,5 л', 690, 890, 'food.alcohol']);
    receipt(at(d, 12, 21), seller, place, null, lines);
    if (chance(0.6)) {
      receipt(at(d, 9, 11), 'АО "Тандер"', 'Магнит у моря', null, [
        ['Вода Святой источник 1,5 л', 59, 79, 'food.groceries'], ['Персики', 249, 349, 'food.groceries', 'кг'],
        ['Йогурт Даниссимо 130 г', 69, 89, 'food.groceries'], ['Чурчхела', 190, 290, 'food.groceries'],
      ]);
    }
    if (dom === 14) receipt(at(d, 10, 12), 'НАО "Красная поляна"', 'Роза Хутор', null, [['Подъёмник Роза Хутор, 2 взрослых', 3800, 4600, TRIP.fun]]);
    if (dom === 16) receipt(at(d, 11, 13), 'ООО "Аквапарк Маяк"', 'Аквапарк Маяк', null, [['Билеты в аквапарк, 2 взрослых', 3800, 4600, TRIP.fun]]);
    if (dom === 18) op(at(d, 9, 11), { amount: rub(5500, 7500), merchant: 'Экскурсии Сочи', description: 'Экскурсия в Абхазию', cat: TRIP.fun });
    if (dom === 20) receipt(at(d, 17, 20), '', '', null, [['Сувениры и магниты', 1200, 2500, 'gifts.gifts']], { manual: true });
    if (chance(0.4)) op(at(d, 10, 22), { amount: rub(290, 690), merchant: 'Яндекс Go', description: 'Яндекс Такси', cat: 'transport.public' });
  }

  // Обычный день дома: продукты, кафе, маркетплейсы, аптека, бензин, ручные записи
  function homeDay(d, { weekend }) {
    // Продукты — через день-два, в выходные — большая закупка
    if (chance(weekend ? 0.7 : 0.35)) {
      const [seller, place] = pick(GROCERS);
      const n = weekend ? Math.floor(between(8, 16)) : Math.floor(between(3, 8));
      const lines = Array.from({ length: n }, () => pick(GROCERY));
      if (chance(0.35)) lines.push(pick(GROCERY_EXTRA));
      receipt(at(d, weekend ? 11 : 18, weekend ? 19 : 22), seller, place, null, [...new Map(lines.map((l) => [l[0], l])).values()]);
    }
    // Кафе — пару раз в неделю
    if (chance(weekend ? 0.35 : 0.15)) {
      const [seller, place, menu] = pick(CAFES);
      const lines = Array.from({ length: Math.floor(between(1, 4)) }, () => pick(menu)).map(([n, lo, hi]) => [n, lo, hi, 'food.dining']);
      receipt(at(d, 9, 21), seller, place, null, [...new Map(lines.map((l) => [l[0], l])).values()]);
    }
    // Доставка еды — изредка вечером
    if (chance(0.06)) {
      receipt(at(d, 19, 23), 'ООО "Яндекс.Еда"', 'Яндекс Еда', null,
        [['Поке с лососем', 590, 690, 'food.delivery'], ['Ролл Филадельфия', 649, 749, 'food.delivery'], ['Доставка', 99, 199, 'food.delivery']]);
    }
    // Маркетплейсы — раз в неделю-две
    if (chance(0.09)) {
      const lines = Array.from({ length: Math.floor(between(1, 4)) }, () => pick(MARKET));
      const ozon = chance(0.5);
      receipt(at(d, 8, 23), ozon ? 'ООО "Интернет Решения"' : 'ООО "Вайлдберриз"', ozon ? 'Ozon' : 'Wildberries', ozon ? OZON : WB,
        [...new Map(lines.map((l) => [l[0], l])).values()]);
    }
    // Аптека — пару раз в месяц
    if (chance(0.07)) {
      receipt(at(d, 9, 21), 'ООО "Аптека-А.в.е-1"', 'Аптека Ригла', null, Array.from({ length: Math.floor(between(1, 3)) }, () => pick(PHARMACY)));
    }
    // Зоомагазин — раз в месяц
    if (chance(0.035)) {
      receipt(at(d, 10, 20), 'ООО "Четыре лапы"', 'Четыре лапы', null, [pick(PETS_SHOP), ...(chance(0.5) ? [pick(PETS_SHOP)] : [])]);
    }
    // Бензин — раз в неделю-полторы
    if (chance(0.09)) {
      const litres = Math.round(between(25, 45));
      const price = between(57, 63);
      const sum = Math.round(litres * price) * 100;
      const n = doc++;
      const id = Number(insReceipt.run(budgetId, userId, `demo:${budgetId}:${n}`, `9999078900${String(budgetId).padStart(6, '0')}`, n, 100000 + n,
        stamp, at(d, 7, 22), day(d), chance(0.5) ? 'ООО "Лукойл-Интер-Кард"' : 'АО "Газпромнефть-Центр"',
        chance(0.5) ? 'АЗС Лукойл' : 'АЗС Газпромнефть', null, sum, 0, sum, 1, sum).lastInsertRowid);
      const item = Number(insItem.run(id, 1, 'Бензин АИ-95', normalizeName('Бензин АИ-95'), litres, 'л', Math.round(price * 100), sum).lastInsertRowid);
      insLabel.run(item, budgetId, 'transport.fuel', 'dictionary', 0.9, stamp);
    }
    // Одежда, дом, техника — реже
    if (chance(0.025)) {
      receipt(at(d, 11, 21), 'ООО "Спортмастер"', 'Спортмастер', null,
        [pick([['Футболка спортивная', 990, 1990, 'clothing.apparel'], ['Кроссовки', 4990, 8990, 'clothing.shoes'], ['Шапка', 790, 1490, 'clothing.accessories']])]);
    }
    if (chance(0.02)) {
      receipt(at(d, 11, 20), 'ООО "Лемана ПРО"', 'Лемана ПРО', null,
        [pick([['Краска интерьерная 2,5 л', 1290, 2190, 'housing.repair'], ['Саморезы 200 шт', 190, 390, 'housing.repair'],
          ['Лампа светодиодная E27', 149, 249, 'home.goods'], ['Полка настенная', 990, 1890, 'home.furniture']])]);
    }
    if (chance(0.01)) {
      receipt(at(d, 11, 21), 'ООО "ДНС Ритейл"', 'DNS', null,
        [pick([['Чайник электрический Polaris', 1990, 2990, 'home.appliances'], ['Пылесос вертикальный', 8990, 14990, 'home.appliances'],
          ['Внешний аккумулятор 10000 мА·ч', 1490, 2490, 'home.electronics']])]);
    }
    if (chance(0.012)) {
      receipt(at(d, 11, 21), 'ООО "Новый книжный центр"', 'Читай-город', null, [pick([['Книга «Атлант расправил плечи»', 990, 1390, 'home.hobby'], ['Пазл 1000 элементов', 690, 990, 'home.hobby']])]);
    }
    if (chance(0.015)) {
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

  const today = new Date();
  const start = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate() + 1);
  const end = new Date(today.getFullYear(), 11, 31);
  const birth = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 150); // ребёнку пять месяцев
  for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const dow = d.getDay(); // 0 — воскресенье
    const dom = d.getDate();
    const mon = d.getMonth(); // 0 — январь
    const weekend = dow === 0 || dow === 6;
    const md = `${pad(mon + 1)}-${pad(dom)}`;
    const age = Math.round((d - birth) / 86400000); // дней ребёнку; меньше нуля — ещё не родился
    const trip = mon === 8 && dom >= 12 && dom <= 21; // отпуск в Сочи, 12–21 сентября

    family(d, { dom, mon, md, weekend, age, trip });
    // В отпуске дома не тратят — ни продуктов, ни бензина, ни кино; платежи по расписанию идут
    if (trip) tripDay(d, dom);
    else homeDay(d, { weekend });

    // ── банк: траты без чеков ──
    if (chance(weekend ? 0.08 : 0.14)) op(at(d, 7, 23), { amount: rub(290, 890), merchant: 'Яндекс Go', description: 'Яндекс Такси', cat: 'transport.public' });
    if (dom === 1 || dom === 16) op(at(d, 8, 10), { amount: 100000, merchant: 'Тройка', description: 'Пополнение карты Тройка', cat: 'transport.public' });
    if (chance(0.04)) op(at(d, 9, 20), { amount: rub(150, 450), merchant: 'Парковки Москвы', cat: 'transport.parking' });
    if (dom === 3) op(at(d, 10, 12), { amount: 3500000, merchant: 'Анна С.', description: 'Анна С.', cat: 'housing.rent', group: 'TRANSFER' });
    if (dom === 10) op(at(d, 12, 20), { amount: rub(5200, 7400), merchant: 'ЕИРЦ Москвы', description: 'Оплата ЖКУ', cat: 'housing.utilities' });
    if (dom === 12) op(at(d, 12, 20), { amount: rub(900, 1500), merchant: 'Мосэнергосбыт', cat: 'housing.utilities' });
    if (dom === 5) op(at(d, 9, 12), { amount: 65000, merchant: 'МТС', description: 'Мобильная связь МТС', cat: 'housing.telecom' });
    if (dom === 7) op(at(d, 9, 12), { amount: 75000, merchant: 'Ростелеком', description: 'Домашний интернет', cat: 'housing.telecom' });
    if (dom === 14) op(at(d, 9, 12), { amount: 39900, merchant: 'Яндекс Плюс', cat: 'leisure.media' });
    if (dom === 20) op(at(d, 9, 12), { amount: 29900, merchant: 'Кинопоиск', cat: 'leisure.media' });
    if (dom === 2) op(at(d, 9, 12), { amount: 350000, merchant: 'Фитнес-клуб Спирит', cat: 'health.fitness' });
    if (chance(0.015)) op(at(d, 10, 19), { amount: rub(2200, 4500), merchant: 'Медси', description: 'Приём врача', cat: 'health.services' });
    if (chance(0.006)) op(at(d, 10, 19), { amount: rub(4500, 12000), merchant: 'Стоматология Улыбка', cat: 'health.services' });
    if (chance(0.006)) op(at(d, 10, 19), { amount: rub(1500, 3500), merchant: 'Ветклиника Айболит', cat: 'pets.vet' });
    if (chance(0.01)) op(at(d, 12, 22), { amount: rub(1500, 3500), merchant: 'Яндекс Афиша', description: 'Билеты в театр', cat: 'leisure.events' });
    if (dom === 15 && d.getMonth() % 2 === 0) op(at(d, 9, 12), { amount: 590000, merchant: 'Skillbox', description: 'Онлайн-курс', cat: 'education.courses' });
    if (dom === 18) op(at(d, 9, 12), { amount: 850000, merchant: 'Сбербанк', description: 'Погашение кредита', cat: 'finance.credit', bank: 'sber' });
    if (dom === 28) op(at(d, 9, 12), { amount: 9900, merchant: 'Т-Банк', description: 'Плата за обслуживание', cat: 'finance.fees' });
    if (dom === 25 && d.getMonth() === 10) op(at(d, 9, 12), { amount: rub(3500, 6000), merchant: 'ФНС России', description: 'Налог на имущество и транспортный', cat: 'finance.taxes' });
    if (dom === 26) op(at(d, 12, 18), { amount: 500000, merchant: 'Т-Инвестиции', description: 'Пополнение брокерского счёта', cat: 'finance.investments', group: 'TRANSFER' });
    if (chance(0.01)) op(at(d, 10, 20), { amount: rub(1000, 5000), merchant: 'Иван Петров', description: 'Иван П.', cat: 'gifts.gifts', group: 'TRANSFER' });
    if (chance(0.01)) op(at(d, 10, 20), { amount: rub(300, 900), merchant: 'Почта России', cat: 'other.other' });
    // Праздники — подарки
    if (md === '12-27' || md === '03-06' || md === '02-21') {
      receipt(at(d, 12, 20), 'ООО "Золотое яблоко"', 'Золотое Яблоко', null, [['Подарочный набор', 2490, 4990, 'gifts.gifts']]);
    }

    // ── доходы ──
    if (dom === 10) op(at(d, 9, 12), { amount: 7500000, merchant: 'ООО "Северный ветер"', description: 'Заработная плата', cat: 'in.salary', kind: 'income', direction: 'credit', group: 'INCOME' });
    if (dom === 25) op(at(d, 9, 12), { amount: 5000000, merchant: 'ООО "Северный ветер"', description: 'Аванс', cat: 'in.salary', kind: 'income', direction: 'credit', group: 'INCOME' });
    if (dom === 20 && d.getMonth() % 3 === 2) op(at(d, 9, 12), { amount: rub(25000, 40000), merchant: 'ООО "Северный ветер"', description: 'Премия по итогам квартала', cat: 'in.bonus', kind: 'income', direction: 'credit', group: 'INCOME' });
    if (dom === 1) op(at(d, 6, 9), { amount: rub(800, 1900), merchant: 'Т-Банк', description: 'Кешбэк за покупки', cat: 'in.cashback', kind: 'income', direction: 'credit', group: 'INCOME' });
    if (dom === 28) op(at(d, 6, 9), { amount: rub(1200, 2100), merchant: 'Т-Банк', description: 'Проценты на остаток', cat: 'in.interest', kind: 'income', direction: 'credit', group: 'INCOME' });
    if (md === '07-15') op(at(d, 9, 12), { amount: rub(2000, 4000), merchant: 'Т-Инвестиции', description: 'Дивиденды', cat: 'in.dividends', kind: 'income', direction: 'credit', group: 'INCOME' });
    if (chance(0.006)) op(at(d, 10, 20), { amount: rub(3000, 10000), merchant: 'Мама', description: 'Перевод от Мама', cat: 'in.gifts', kind: 'income', direction: 'credit', group: 'TRANSFER' });
    // Переводы себе — в копилку и обратно
    if (dom === 11) op(at(d, 12, 18), { amount: 1000000, merchant: 'Между своими счетами', description: 'Перевод на накопительный счёт', kind: 'transfer', group: 'TRANSFER' });
    if (chance(0.01)) op(at(d, 12, 18), { amount: rub(3000, 8000), merchant: 'Между своими счетами', description: 'Перевод с накопительного счёта', kind: 'transfer', direction: 'credit', group: 'TRANSFER' });
  }
}
