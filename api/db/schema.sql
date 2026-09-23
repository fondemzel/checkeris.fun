-- Схема кабинета: чеки ФНС и позиции в них.
-- Все денежные поля хранятся в копейках (целые), как приходят из ФНС.
--
-- Данные делятся на два вида:
--   бюджетные — чеки, позиции, их разметка, сканы, справочник категорий и ручные правки;
--            хозяин у них — бюджет, а не человек. У человека один текущий бюджет:
--            свой или общий семейный, куда его пригласили. Чужие бюджеты не видны;
--   общие  — знание о товарах: словарь названий, штрихкоды, правила продавцов.
--            Оно пишется в кодах системного справочника (sys_*) и через связи
--            (category_links) попадает в личные категории каждого.
--
-- Файл выполняется при каждом старте. Старые базы доводит до этой схемы migrate()
-- в db.mjs — CREATE TABLE IF NOT EXISTS существующую таблицу не перестраивает.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── доступ ──────────────────────────────────────────────────────────────────
-- Проверка входа живёт в приложении, а не в nginx: телефону нужен токен, а не
-- basic auth. Пароль хранится хешем scrypt с солью, сам пароль нигде не лежит.
-- Пользователь входит паролем или через Telegram. У пришедшего из Telegram логин
-- служебный («tg:<id>»), а пароль — «!»: такой хеш не совпадёт ни с одним паролем.
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  login       TEXT NOT NULL UNIQUE,
  password    TEXT NOT NULL,           -- scrypt: <соль в hex>:<хеш в hex>
  created_at  TEXT NOT NULL,
  telegram_id INTEGER,                 -- id в Telegram; уникален (индекс заводит migrate)
  tg_username TEXT,
  name        TEXT,                    -- как обращаться: имя из Telegram или заданное в настройках
  name_set    INTEGER NOT NULL DEFAULT 0, -- 1 — имя задал сам человек: вход через Telegram его не трогает
  role        TEXT NOT NULL DEFAULT 'user', -- user | admin: админ без квот, правит системный справочник
  budget_id      INTEGER REFERENCES budgets (id), -- текущий бюджет: его данные человек видит и правит
  home_budget_id INTEGER REFERENCES budgets (id)  -- свой бюджет: в него человек вернётся, выйдя из общего
);

-- Бюджет — хозяин данных. Обычно в нём один человек; семья — несколько человек
-- в одном бюджете. Владелец приглашает и исключает, участники добавляют траты
-- и правят категории. Удаление аккаунта участника общие траты не трогает:
-- данные держатся за бюджет, а не за человека.
CREATE TABLE IF NOT EXISTS budgets (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

-- Приглашение в бюджет: одноразовая ссылка со сроком жизни, в базе — хеш кода.
CREATE TABLE IF NOT EXISTS invites (
  id         INTEGER PRIMARY KEY,
  code_hash  TEXT NOT NULL UNIQUE,
  budget_id  INTEGER NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  used_at    TEXT,
  revoked    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invites_budget ON invites (budget_id);

-- Вход через Telegram. Браузер получает одноразовый код, человек подтверждает его
-- в боте, браузер забирает токен. Код хранится хешем, живёт 10 минут и гасится
-- при первой выдаче токена. link_user_id — не вход, а привязка Telegram к уже
-- вошедшему аккаунту.
CREATE TABLE IF NOT EXISTS tg_logins (
  nonce_hash   TEXT PRIMARY KEY,
  status       TEXT NOT NULL,          -- pending | confirmed | rejected | used
  device       TEXT,                   -- «iPhone · Safari»: показывается в боте перед подтверждением
  ip           TEXT,
  link_user_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users (id) ON DELETE CASCADE,
  created      INTEGER NOT NULL DEFAULT 0, -- этим входом аккаунт был создан
  client       TEXT,                   -- m | cabinet: куда вернуть после подтверждения
  confirm_hash TEXT,                   -- код из ссылки «Войти» в сообщении бота (хеш)
  tg_identity  TEXT,                   -- кому бот показал запрос: id и имя из Telegram, JSON
  bot_chat     INTEGER,                -- чат и сообщение бота с кнопками: после входа бот их удаляет,
  bot_msg      INTEGER,                -- чтобы в переписке не копился мусор
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  confirmed_at TEXT
);

-- Личные суточные квоты: лимит ФНС и модель общие на всё приложение, и один активный
-- пользователь не должен выбрать их за всех.
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day     TEXT NOT NULL,
  kind    TEXT NOT NULL,                -- llm_names
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);

-- Токен хранится хешем: если база утечёт, войти по ней будет нельзя.
CREATE TABLE IF NOT EXISTS tokens (
  hash       TEXT PRIMARY KEY,         -- sha256 от выданного токена
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label      TEXT,                     -- откуда вошли: кабинет, телефон
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens (user_id);

-- ── чеки ────────────────────────────────────────────────────────────────────
-- Чек принадлежит бюджету. Один и тот же чек (общий ужин) могут принести в разные
-- бюджеты, поэтому тройка ФН/ФД/ФП уникальна в пределах бюджета, а не на всю базу.
-- added_by — кто добавил: в семейном бюджете видно, чья это трата.
CREATE TABLE IF NOT EXISTS receipts (
  id              INTEGER PRIMARY KEY,
  budget_id       INTEGER NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  added_by        INTEGER REFERENCES users (id) ON DELETE SET NULL,
  source_id       TEXT,                     -- _id из выгрузки
  fiscal_drive    TEXT NOT NULL,            -- fiscalDriveNumber (ФН)
  fiscal_doc      INTEGER NOT NULL,         -- fiscalDocumentNumber (ФД)
  fiscal_sign     INTEGER NOT NULL,         -- fiscalSign (ФП)
  created_at      TEXT,                     -- когда чек попал в выгрузку
  purchased_at    TEXT NOT NULL,            -- dateTime чека, ISO без таймзоны
  purchased_date  TEXT NOT NULL,            -- YYYY-MM-DD, для фильтров и группировок
  seller          TEXT,                     -- user: наименование организации
  seller_inn      TEXT,                     -- userInn
  retail_place    TEXT,                     -- название точки / сайт
  retail_address  TEXT,
  kkt_reg_id      TEXT,
  operation_type  INTEGER,                  -- 1 приход, 2 возврат прихода, 3 расход, 4 возврат расхода
  taxation_type   INTEGER,
  total_sum       INTEGER NOT NULL DEFAULT 0,
  cash_sum        INTEGER NOT NULL DEFAULT 0,
  ecash_sum       INTEGER NOT NULL DEFAULT 0,
  prepaid_sum     INTEGER NOT NULL DEFAULT 0,
  credit_sum      INTEGER NOT NULL DEFAULT 0,
  provision_sum   INTEGER NOT NULL DEFAULT 0,
  nds_18          INTEGER NOT NULL DEFAULT 0,
  nds_10          INTEGER NOT NULL DEFAULT 0,
  nds_0           INTEGER NOT NULL DEFAULT 0,
  nds_no          INTEGER NOT NULL DEFAULT 0,
  shift_number    INTEGER,
  request_number  INTEGER,
  operator        TEXT,
  buyer           TEXT,                     -- buyerPhoneOrAddress
  internet_sign   INTEGER NOT NULL DEFAULT 0,
  item_count      INTEGER NOT NULL DEFAULT 0,
  items_sum       INTEGER NOT NULL DEFAULT 0, -- сумма позиций, для сверки с total_sum
  raw             TEXT,                     -- исходный receipt целиком
  place_key       TEXT,                     -- адрес расчётов, приведённый к ключу places (geo.mjs)
  UNIQUE (budget_id, fiscal_drive, fiscal_doc, fiscal_sign)
);

CREATE INDEX IF NOT EXISTS idx_receipts_budget_date ON receipts (budget_id, purchased_date);
CREATE INDEX IF NOT EXISTS idx_receipts_at        ON receipts (purchased_at);
CREATE INDEX IF NOT EXISTS idx_receipts_inn       ON receipts (seller_inn);
CREATE INDEX IF NOT EXISTS idx_receipts_source    ON receipts (source_id);

-- Позиция принадлежит тому же, кому её чек: своего владельца ей не нужно.
CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY,
  receipt_id    INTEGER NOT NULL REFERENCES receipts (id) ON DELETE CASCADE,
  pos           INTEGER NOT NULL,           -- порядковый номер позиции в чеке
  name          TEXT NOT NULL,
  name_norm     TEXT NOT NULL,              -- нижний регистр, схлопнутые пробелы, ё→е
  quantity      REAL NOT NULL DEFAULT 1,
  unit          TEXT,
  price         INTEGER NOT NULL DEFAULT 0,
  sum           INTEGER NOT NULL DEFAULT 0,
  nds           INTEGER,
  nds_sum       INTEGER,
  product_type  INTEGER,
  payment_type  INTEGER,
  gtin          TEXT,
  provider_inn  TEXT
);

CREATE INDEX IF NOT EXISTS idx_items_receipt ON items (receipt_id);
CREATE INDEX IF NOT EXISTS idx_items_name    ON items (name_norm);
CREATE INDEX IF NOT EXISTS idx_items_sum     ON items (sum);

-- ── системный справочник ────────────────────────────────────────────────────
-- Язык общего знания: словарь, штрихкоды и правила продавцов ссылаются на эти коды,
-- модель размечает в них же. Он же — шаблон, который копируется новому пользователю.
-- Правит его администратор (categories.mjs), не пользователи.
--
-- Цвет группы задаётся один, а её категории получают оттенки этого же цвета:
-- shade_from и shade_to — доли (0–100) на переходе от белого к color.
CREATE TABLE IF NOT EXISTS sys_groups (
  slug       TEXT PRIMARY KEY,           -- food
  name       TEXT NOT NULL,              -- Питание
  icon       TEXT,                       -- имя фигуры из site/shared/icons.js
  color      TEXT,                       -- #rrggbb
  shade_from INTEGER NOT NULL DEFAULT 25,
  shade_to   INTEGER NOT NULL DEFAULT 85,
  sort       INTEGER NOT NULL DEFAULT 0
);

-- fallback_slug — из какой категории выделилась эта. Новая системная категория
-- («Корм для рыбок») не должна ничего менять у тех, кто её себе не взял: для них
-- её товары идут туда же, куда идёт запасная («Корм и уход»).
CREATE TABLE IF NOT EXISTS sys_categories (
  slug          TEXT PRIMARY KEY,        -- food.groceries
  group_slug    TEXT NOT NULL REFERENCES sys_groups (slug),
  name          TEXT NOT NULL,           -- Еда
  hint          TEXT,                    -- подсказка модели: из неё собирается промпт
  sort          INTEGER NOT NULL DEFAULT 0,
  fallback_slug TEXT REFERENCES sys_categories (slug)
);

CREATE INDEX IF NOT EXISTS idx_sys_categories_group ON sys_categories (group_slug, sort);

-- ── общее знание о товарах ──────────────────────────────────────────────────
-- Ключ — нормализованное название, оно стабильно между импортами (в отличие от items.id).
CREATE TABLE IF NOT EXISTS dictionary (
  name_norm     TEXT PRIMARY KEY,
  category_slug TEXT NOT NULL REFERENCES sys_categories (slug),
  source        TEXT NOT NULL,           -- manual (выверено человеком) | llm | seed
  confidence    REAL,
  votes         INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dictionary_category ON dictionary (category_slug);

-- Штрихкод → категория. Самый надёжный ключ: ошибок быть не может.
CREATE TABLE IF NOT EXISTS gtin_map (
  gtin          TEXT PRIMARY KEY,
  category_slug TEXT NOT NULL REFERENCES sys_categories (slug),
  source        TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Правила по продавцу: для услуг и платежей категорию задаёт чек, а не название
-- позиции («Тариф по билету KUP7XEZL6K-1» опознаётся только по ИНН перевозчика).
CREATE TABLE IF NOT EXISTS seller_rules (
  seller_inn    TEXT PRIMARY KEY,
  category_slug TEXT NOT NULL REFERENCES sys_categories (slug),
  mode          TEXT NOT NULL DEFAULT 'fallback', -- always: перекрывает словарь; fallback: только если иначе не определилось
  note          TEXT,
  updated_at    TEXT NOT NULL
);

-- ── справочник бюджета ──────────────────────────────────────────────────────
-- Копия системного при создании бюджета, дальше участники правят его как хотят.
-- slug уникален в пределах бюджета и неизменен: переименование и перенос между
-- группами — правка name и group_slug, разметку они не трогают.
CREATE TABLE IF NOT EXISTS groups (
  budget_id  INTEGER NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  name       TEXT NOT NULL,
  icon       TEXT,
  color      TEXT,
  shade_from INTEGER NOT NULL DEFAULT 25,
  shade_to   INTEGER NOT NULL DEFAULT 85,
  sort       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (budget_id, slug)
);

CREATE TABLE IF NOT EXISTS categories (
  budget_id  INTEGER NOT NULL,
  slug       TEXT NOT NULL,
  group_slug TEXT NOT NULL,
  name       TEXT NOT NULL,
  hint       TEXT,
  sort       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (budget_id, slug),
  FOREIGN KEY (budget_id, group_slug) REFERENCES groups (budget_id, slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_categories_group ON categories (budget_id, group_slug, sort);

-- Куда в этом бюджете ведёт каждая системная категория. Сразу после создания —
-- в свою копию; удалил «Доставку еды» с переносом в «Рестораны» — связь переезжает туда же,
-- и общее знание продолжает раскладывать доставку правильно. Категории, созданные самим
-- пользователем, ни с чем системным не связаны: туда ведут только его ручные правки.
CREATE TABLE IF NOT EXISTS category_links (
  budget_id INTEGER NOT NULL,
  sys_slug  TEXT NOT NULL REFERENCES sys_categories (slug) ON DELETE CASCADE,
  slug      TEXT NOT NULL,
  PRIMARY KEY (budget_id, sys_slug),
  FOREIGN KEY (budget_id, slug) REFERENCES categories (budget_id, slug) ON DELETE CASCADE
);

-- Ручная правка категории — решение участников бюджета о названии товара. Верхняя
-- ступень лестницы разметки этого бюджета; на другие бюджеты не влияет.
CREATE TABLE IF NOT EXISTS budget_dictionary (
  budget_id     INTEGER NOT NULL,
  name_norm     TEXT NOT NULL,
  category_slug TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (budget_id, name_norm),
  FOREIGN KEY (budget_id, category_slug) REFERENCES categories (budget_id, slug) ON DELETE CASCADE
);

-- Результат классификации позиции, в кодах справочника её бюджета.
-- Производная таблица: пересчитывается, знания живут в словарях и правилах.
-- budget_id здесь ради внешнего ключа: метка не может сослаться на чужую категорию.
CREATE TABLE IF NOT EXISTS item_labels (
  item_id       INTEGER PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
  budget_id     INTEGER NOT NULL,
  category_slug TEXT,
  source        TEXT NOT NULL,           -- manual | pinned | gtin | rule | dictionary | ngram | rule-fallback | unknown
  confidence    REAL,
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (budget_id, category_slug) REFERENCES categories (budget_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_item_labels_category ON item_labels (budget_id, category_slug);
CREATE INDEX IF NOT EXISTS idx_item_labels_source   ON item_labels (source);

-- ── представления ───────────────────────────────────────────────────────────
-- Пересоздаются при каждом запуске — так изменения схемы доезжают без ручной миграции.
-- Категория и группа берутся из справочника бюджета, которому принадлежит чек.

-- Позиции вместе с контекстом чека и категорией: на этом представлении строится
-- вкладка «Товары», сводка и мобильная версия.
-- Позиции, которые человек убрал из расходов: задвоенные, учтённые где-то ещё.
-- Удалять строку из чека нельзя — повторный импорт выгрузки вернёт её. Поэтому помечаем,
-- и держится пометка за чек и номер позиции: они постоянны, id позиции — нет.
CREATE TABLE IF NOT EXISTS item_hidden (
  receipt_id INTEGER NOT NULL REFERENCES receipts (id) ON DELETE CASCADE,
  pos        INTEGER NOT NULL,
  hidden_at  TEXT NOT NULL,
  PRIMARY KEY (receipt_id, pos)
);

DROP VIEW IF EXISTS v_items;
CREATE VIEW v_items AS
SELECT
  i.id,
  i.receipt_id,
  r.budget_id,
  r.added_by,
  i.pos,
  i.name,
  i.name_norm,
  i.quantity,
  i.unit,
  i.price,
  i.sum,
  i.nds,
  i.nds_sum,
  i.product_type,
  i.payment_type,
  i.gtin,
  i.provider_inn,
  r.purchased_at,
  r.purchased_date,
  r.seller,
  r.seller_inn,
  r.retail_place,
  r.retail_address,
  r.operation_type,
  r.prepaid_sum,
  r.total_sum AS receipt_total,
  CASE WHEN r.fiscal_drive = 'manual' THEN 1 ELSE 0 END AS manual, -- вбито руками, чека нет
  -- Деньги считаем один раз: возврат — не трата, а чек, закрытый зачётом аванса,
  -- повторяет более ранний чек предоплаты, по которому деньги уже ушли.
  CASE WHEN r.operation_type = 2 OR r.prepaid_sum > 0 THEN 0 ELSE 1 END AS counted,
  l.category_slug,
  l.source AS category_source,
  l.confidence AS category_confidence,
  c.name AS category_name,
  c.group_slug,
  g.name AS group_name
FROM items i
JOIN receipts r ON r.id = i.receipt_id
LEFT JOIN item_labels l ON l.item_id = i.id
LEFT JOIN categories c ON c.budget_id = r.budget_id AND c.slug = l.category_slug
LEFT JOIN groups g ON g.budget_id = c.budget_id AND g.slug = c.group_slug
-- Убранное из расходов не видно нигде: ни в ленте, ни в суммах
WHERE NOT EXISTS (SELECT 1 FROM item_hidden h WHERE h.receipt_id = i.receipt_id AND h.pos = i.pos);

-- Позиция с категорией: на ней работает классификатор.
DROP VIEW IF EXISTS v_item_categories;
CREATE VIEW v_item_categories AS
SELECT
  i.id,
  i.receipt_id,
  r.budget_id,
  r.added_by,
  i.name,
  i.name_norm,
  i.sum,
  i.gtin,
  r.purchased_date,
  r.seller_inn,
  l.category_slug,
  l.source AS category_source,
  l.confidence,
  c.name       AS category_name,
  c.group_slug,
  g.name AS group_name
FROM items i
JOIN receipts r      ON r.id = i.receipt_id
LEFT JOIN item_labels l ON l.item_id = i.id
LEFT JOIN categories c  ON c.budget_id = r.budget_id AND c.slug = l.category_slug
LEFT JOIN groups g      ON g.budget_id = c.budget_id AND g.slug = c.group_slug;

-- ── сканирование чеков ──────────────────────────────────────────────────────
-- Обмен с ФНС асинхронный: запрос кладётся в очередь, воркер отправляет его,
-- опрашивает ответ и передаёт готовый чек обычному импорту. Состояние задания
-- живёт здесь, чтобы перезапуск сервиса ничего не терял.
-- budget_id — куда ляжет чек, user_id — кто сканировал: по нему считается личная квота.
CREATE TABLE IF NOT EXISTS scan_jobs (
  id           INTEGER PRIMARY KEY,
  budget_id    INTEGER NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  qr           TEXT NOT NULL,           -- строка из QR как есть, для разбора и разбора ошибок
  fiscal_drive TEXT NOT NULL,           -- ФН/ФД/ФП: тот же ключ, что у импорта выгрузок
  fiscal_doc   INTEGER NOT NULL,
  fiscal_sign  INTEGER NOT NULL,
  total_sum    INTEGER NOT NULL,
  purchased_at TEXT NOT NULL,
  operation    INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL,           -- new | sent | done | failed
  message_id   TEXT,                    -- идентификатор запроса в ФНС
  receipt_id   INTEGER REFERENCES receipts (id) ON DELETE SET NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  error_code   TEXT,                    -- код отказа ФНС: 455/544 значат «данных ещё нет»
  retries      INTEGER NOT NULL DEFAULT 0, -- сколько отложенных повторов уже потрачено
  next_at      TEXT,                    -- когда воркеру можно взяться снова (и у ошибки — повтор)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (budget_id, fiscal_drive, fiscal_doc, fiscal_sign)
);

CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs (status, next_at);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_budget ON scan_jobs (budget_id, status);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_user   ON scan_jobs (user_id, created_at);

-- Расход суточного лимита обращений к ФНС (1000 в сутки на всё приложение).
CREATE TABLE IF NOT EXISTS fns_usage (
  day   TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);

-- ── места покупок ───────────────────────────────────────────────────────────
-- Адрес из чека → координаты. Общая таблица: адрес кассы магазина — не личные данные,
-- и один «Магнит» незачем искать дважды. Ключ — адрес, приведённый к общему виду
-- (geo.mjs, placeKey), поэтому «пом. 2н» и «помещение 2н» — разные ключи, но
-- «Москва, ул. Бутлерова, 17Б» с разными пробелами и запятыми — один.
CREATE TABLE IF NOT EXISTS places (
  key        TEXT PRIMARY KEY,
  address    TEXT NOT NULL,           -- как написано в чеке (первое встреченное)
  result     TEXT,                    -- как понял геокодер: «г Москва, ул Андерсена, д 2»
  lat        REAL,
  lon        REAL,
  qc_geo     INTEGER,                 -- точность DaData: 0–1 дом, 2 улица, 3 посёлок, 4 город, 5 нет
  source     TEXT,                    -- suggest | clean — какой метод DaData нашёл
  status     TEXT NOT NULL,           -- pending | ok | miss | wait: ждёт суточной квоты
  tries      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_places_status ON places (status);

-- Расход бесплатных суточных квот внешних сервисов (кроме ФНС — у неё своя таблица).
CREATE TABLE IF NOT EXISTS api_usage (
  day     TEXT NOT NULL,
  service TEXT NOT NULL,              -- dadata_suggest | dadata_clean
  calls   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, service)
);

-- Журнал импортов: видно, какие выгрузки уже залиты.
CREATE TABLE IF NOT EXISTS imports (
  id            INTEGER PRIMARY KEY,
  file          TEXT NOT NULL,
  imported_at   TEXT NOT NULL,
  receipts_seen INTEGER NOT NULL DEFAULT 0,
  receipts_new  INTEGER NOT NULL DEFAULT 0,
  receipts_upd  INTEGER NOT NULL DEFAULT 0,
  items_total   INTEGER NOT NULL DEFAULT 0
);

-- Подключения к банкам. Сессия интернет-банка — это доступ к счетам, поэтому хранится
-- только зашифрованной (AES-256-GCM, ключ BANK_KEY в api/.env, не в базе). Пароль от
-- банка не хранится нигде: он нужен лишь во время входа. Сессию держит живой пинг
-- (banks.mjs); умерла — status = expired, человеку уходит сообщение в Telegram.
CREATE TABLE IF NOT EXISTS bank_links (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  bank         TEXT NOT NULL,           -- tbank
  session_enc  TEXT,                    -- iv.tag.шифротекст в base64; null — вышли
  status       TEXT NOT NULL,           -- active | expired
  login_at     TEXT NOT NULL,           -- когда вошли: от него считаем, сколько живёт сессия
  last_ok_at   TEXT,                    -- последний удачный пинг
  fails        INTEGER NOT NULL DEFAULT 0, -- неудачных пингов подряд
  expired_at   TEXT,
  synced_at    TEXT,                    -- последняя загрузка операций
  last_error   TEXT,
  UNIQUE (user_id, bank)
);

-- Операции из банка как есть: сопоставление с чеками и траты без чеков строятся поверх.
-- Суммы — в копейках, как у чеков. Время — московское, как purchased_at у чеков.
CREATE TABLE IF NOT EXISTS bank_ops (
  id             INTEGER PRIMARY KEY,
  link_id        INTEGER NOT NULL REFERENCES bank_links (id) ON DELETE CASCADE,
  budget_id      INTEGER NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  ext_id         TEXT NOT NULL,         -- id операции в банке
  account        TEXT NOT NULL,         -- id счёта в банке
  account_name   TEXT,
  at             TEXT NOT NULL,         -- время операции, московское: 2026-09-22T14:05:31
  debited_at     TEXT,                  -- время списания
  direction      TEXT NOT NULL,         -- debit — расход, credit — поступление
  amount         INTEGER NOT NULL,      -- в валюте операции, копейки, без знака
  currency       TEXT NOT NULL,
  account_amount INTEGER,               -- в валюте счёта
  status         TEXT,                  -- OK | WAIT | FAILED — как у банка
  op_group       TEXT,                  -- PAY | TRANSFER | CASH | INCOME …
  mcc            INTEGER,
  description    TEXT,
  merchant       TEXT,
  bank_category  TEXT,
  card           TEXT,                  -- последние цифры карты
  has_receipt    INTEGER NOT NULL DEFAULT 0, -- у банка есть кассовый чек
  kind           TEXT,                  -- covered (есть чек) | expense | income | transfer
  category_slug  TEXT,                  -- категория траты без чека: у покупок с чеком она у позиций
  category_source TEXT,                 -- manual (выбрал человек) | rule (по прошлому выбору)
  note           TEXT,                  -- комментарий человека: у операций банка id постоянный
  receipt_id     INTEGER REFERENCES receipts (id) ON DELETE SET NULL, -- чек этой же покупки
  pair_id        INTEGER,               -- вторая половина перевода между своими счетами
  raw            TEXT NOT NULL,         -- ответ банка целиком: разбор можно улучшать задним числом
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (link_id, ext_id)
);

CREATE INDEX IF NOT EXISTS idx_bank_ops_budget_at ON bank_ops (budget_id, at);

-- Комментарии к товарам. Позиции чека при повторном импорте выгрузки пересоздаются
-- с новыми id, поэтому комментарий держится за чек и номер позиции в нём: они постоянны.
CREATE TABLE IF NOT EXISTS item_notes (
  receipt_id INTEGER NOT NULL REFERENCES receipts (id) ON DELETE CASCADE,
  pos        INTEGER NOT NULL,
  note       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (receipt_id, pos)
);

-- Выбор категории для трат без чека запоминается по продавцу: выбрав «ЖКХ» для
-- «Мосэнергосбыт» однажды, человек не выбирает её снова. Правило живёт в бюджете:
-- у каждого свои категории и свои привычки.
CREATE TABLE IF NOT EXISTS bank_rules (
  budget_id     INTEGER NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  key           TEXT NOT NULL,          -- продавец или описание, приведённые к общему виду
  category_slug TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (budget_id, key)
);

-- Сообщения человеку в Telegram. С основного сервера Telegram недоступен, поэтому их
-- забирает бот на зарубежном сервере (bot/relay.mjs) подписанным запросом и отправляет.
CREATE TABLE IF NOT EXISTS tg_outbox (
  id         INTEGER PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  text       TEXT NOT NULL,            -- что отправить; пусто — вместо отправки удалить сообщение
  delete_msg INTEGER,                  -- номер сообщения, которое надо убрать
  created_at TEXT NOT NULL,
  sent_at    TEXT
);
