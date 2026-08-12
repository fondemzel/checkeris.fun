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

-- Позиции вместе с контекстом чека: на этом представлении строится вкладка «Товары».
CREATE VIEW IF NOT EXISTS v_items AS
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
  r.operation_type
FROM items i
JOIN receipts r ON r.id = i.receipt_id;

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
