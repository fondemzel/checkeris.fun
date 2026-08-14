-- Схема кабинета: чеки ФНС и позиции в них.
-- Все денежные поля хранятся в копейках (целые), как приходят из ФНС.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS receipts (
  id              INTEGER PRIMARY KEY,
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
  UNIQUE (fiscal_drive, fiscal_doc, fiscal_sign)
);

CREATE INDEX IF NOT EXISTS idx_receipts_date    ON receipts (purchased_date);
CREATE INDEX IF NOT EXISTS idx_receipts_at      ON receipts (purchased_at);
CREATE INDEX IF NOT EXISTS idx_receipts_inn     ON receipts (seller_inn);
CREATE INDEX IF NOT EXISTS idx_receipts_source  ON receipts (source_id);

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

-- Позиции вместе с контекстом чека и категорией: на этом представлении строится
-- вкладка «Товары». Представление пересоздаётся при каждом запуске — так изменения
-- схемы доезжают без ручной миграции.
DROP VIEW IF EXISTS v_items;
CREATE VIEW v_items AS
SELECT
  i.id,
  i.receipt_id,
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
  r.purchased_at,
  r.purchased_date,
  r.seller,
  r.seller_inn,
  r.retail_place,
  r.retail_address,
  r.operation_type,
  r.prepaid_sum,
  r.total_sum AS receipt_total,
  -- Деньги считаем один раз: возврат — не трата, а чек, закрытый зачётом аванса,
  -- повторяет более ранний чек предоплаты, по которому деньги уже ушли.
  CASE WHEN r.operation_type = 2 OR r.prepaid_sum > 0 THEN 0 ELSE 1 END AS counted,
  l.category_slug,
  l.source AS category_source,
  l.confidence AS category_confidence,
  c.name AS category_name,
  c.group_slug,
  c.group_name
FROM items i
JOIN receipts r ON r.id = i.receipt_id
LEFT JOIN item_labels l ON l.item_id = i.id
LEFT JOIN categories c ON c.slug = l.category_slug;

-- ── категории ───────────────────────────────────────────────────────────────
-- Канонический справочник. Пользовательские деревья (когда появятся личные
-- кабинеты) будут маппиться на эти slug'и: словарь, правила и модель всегда
-- работают в каноне, пользователь видит свои названия.

CREATE TABLE IF NOT EXISTS categories (
  slug        TEXT PRIMARY KEY,          -- food.groceries
  group_slug  TEXT NOT NULL,             -- food
  group_name  TEXT NOT NULL,             -- Питание
  name        TEXT NOT NULL,             -- Еда
  hint        TEXT,                      -- подсказка для промпта и подсказок в интерфейсе
  color       TEXT,
  icon        TEXT,                      -- имя фигуры из site/cabinet/icons.js
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_categories_group ON categories (group_slug, sort);

-- Общий словарь названий — главный актив: наполняется от всех пользователей.
-- Ключ — нормализованное название, оно стабильно между импортами (в отличие от items.id).
CREATE TABLE IF NOT EXISTS dictionary (
  name_norm     TEXT PRIMARY KEY,
  category_slug TEXT NOT NULL REFERENCES categories (slug),
  source        TEXT NOT NULL,           -- manual | llm | model | rule | seed
  confidence    REAL,
  votes         INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dictionary_category ON dictionary (category_slug);

-- Штрихкод → категория. Самый надёжный ключ: ошибок быть не может.
CREATE TABLE IF NOT EXISTS gtin_map (
  gtin          TEXT PRIMARY KEY,
  category_slug TEXT NOT NULL REFERENCES categories (slug),
  source        TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Правила по продавцу: для услуг и платежей категорию задаёт чек, а не название
-- позиции («Тариф по билету KUP7XEZL6K-1» опознаётся только по ИНН перевозчика).
CREATE TABLE IF NOT EXISTS seller_rules (
  seller_inn    TEXT PRIMARY KEY,
  category_slug TEXT NOT NULL REFERENCES categories (slug),
  mode          TEXT NOT NULL DEFAULT 'fallback', -- always: перекрывает словарь; fallback: только если иначе не определилось
  note          TEXT,
  updated_at    TEXT NOT NULL
);

-- Результат классификации позиции. Производная таблица: пересчитывается после
-- импорта и перезаписывается целиком, знания живут в словаре и правилах.
CREATE TABLE IF NOT EXISTS item_labels (
  item_id       INTEGER PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
  category_slug TEXT REFERENCES categories (slug),
  source        TEXT NOT NULL,           -- gtin | dictionary | rule | ngram | llm | manual
  confidence    REAL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_item_labels_category ON item_labels (category_slug);
CREATE INDEX IF NOT EXISTS idx_item_labels_source   ON item_labels (source);

-- Позиция с категорией: на этом представлении строится колонка и фильтр в кабинете.
CREATE VIEW IF NOT EXISTS v_item_categories AS
SELECT
  i.id,
  i.receipt_id,
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
  c.group_name
FROM items i
JOIN receipts r      ON r.id = i.receipt_id
LEFT JOIN item_labels l ON l.item_id = i.id
LEFT JOIN categories c  ON c.slug = l.category_slug;

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
