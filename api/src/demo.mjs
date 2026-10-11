// Тестовая база: год трат вымышленного человека — посмотреть, как приложение выглядит
// с данными, ещё не подключив свои банки и не отсканировав ни одного чека.
//
// Одна на всех: отдельный бюджет (budgets.demo = 1), сгенерированный один раз. Включение
// переключает человека на него — так же, как вход в общий бюджет, — а свои данные остаются
// нетронутыми в прежнем бюджете (users.demo_return). Выключение возвращает обратно.
//
// Раз база общая, она только для чтения: правка одного была бы видна всем (запрет — в
// server.mjs, isDemo). Заодно не принимаются загрузки из банков и магазинов и сканы:
// настоящие операции попали бы в тестовую базу. Год заканчивается днём генерации, поэтому
// база пересоздаётся, когда последней трате больше месяца, — текущий месяц не пустеет.
//
// Операции банка тестовой базы держатся за подключения служебного пользователя
// (DEMO_LOGIN): так они показываются как операции Т-Банка и Сбера, но не смешиваются с
// настоящими подключениями людей. Статус этих подключений — demo: фоновая проверка
// сессий их не видит.
import { provisionTaxonomy } from './taxonomy.mjs';
import { provisionIncome } from './incomecats.mjs';
import { normalizeName } from './import.mjs';

const DEMO_LOGIN = '__demo__';
const DEMO_NAME = 'Тестовый режим';
const STALE_DAYS = 31;
const now = () => new Date().toISOString();

/** Бюджет — тестовый? */
export const isDemo = (db, budgetId) =>
  Boolean(budgetId && db.prepare('SELECT demo FROM budgets WHERE id = ?').get(budgetId)?.demo);

/** Тестовая база: есть и свежая — та же; устарела — пересоздаётся на месте; нет — создаётся. */
function demoBudget(db) {
  let id = db.prepare('SELECT id FROM budgets WHERE demo = 1 ORDER BY id LIMIT 1').get()?.id;
  const last = id && db.prepare('SELECT MAX(purchased_date) AS d FROM receipts WHERE budget_id = ?').get(id).d;
  const fresh = last && Date.now() - Date.parse(`${last}T00:00:00`) < STALE_DAYS * 86400000;
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
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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
  for (const table of ['item_labels', 'item_notes', 'budget_dictionary', 'budget_seller_rules', 'bank_rules', 'bank_kind_marks',
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

/** Год трат: чеки, покупки на маркетплейсах, ручные записи, операции банка без чеков, доходы. */
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
  const receipt = (when, seller, place, inn, lines, { manual = false } = {}) => {
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

  const today = new Date();
  const start = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate() + 1);
  for (let d = new Date(start); d <= today; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const dow = d.getDay(); // 0 — воскресенье
    const dom = d.getDate();
    const weekend = dow === 0 || dow === 6;

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
    const md = `${pad(d.getMonth() + 1)}-${pad(dom)}`;
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
