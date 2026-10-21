// Резервная копия бюджета: полный снимок данных одним JSON — из него бюджет можно восстановить.
// Делает её телефон (Backup.java): забирает снимок, сжимает в ZIP и кладёт в «Загрузки»;
// сервер только отдаёт. Общий бюджет — целиком.
//
// В копии — всё, что относится к бюджету: чеки с позициями и разметкой, операции банков, свой
// справочник категорий, правила, лимиты, комментарии, ошибочные сканы, счета банков (названия и
// какие выключены). Чего нет: подключений банков (там зашифрованная сессия), токенов, паролей,
// приглашений, Telegram-данных участников — это доступы, а не данные. Участники — только имена.
//
// Без полей raw (исходные ответы ФНС и банков): всё нужное из них уже разложено по колонкам, а
// весят они половину копии. Таблицы — колонками: { columns, rows } — имена полей один раз, а не
// в каждой строке. Самый большой бюджет (6,2 тыс. чеков, 23 тыс. операций): 66,6 МБ JSON и 5,6 МБ
// в ZIP — так стало 16,9 МБ и 2,5 МБ (замер 21.10.2026); обычный бюджет — около 0,1 МБ

export const BACKUP_FORMAT = 'checker-backup';
export const BACKUP_VERSION = 1;

// Таблицы бюджета: [таблица, условие выборки]. Порядок — как восстанавливать: сначала справочник,
// потом то, что на него ссылается
const BUDGET_TABLES = [
  ['groups', 'budget_id = :b'],
  ['categories', 'budget_id = :b'],
  ['category_links', 'budget_id = :b'],
  ['income_groups', 'budget_id = :b'],
  ['income_cats', 'budget_id = :b'],
  ['budget_limits', 'budget_id = :b'],
  ['budget_dictionary', 'budget_id = :b'],
  ['budget_seller_rules', 'budget_id = :b'],
  ['bank_rules', 'budget_id = :b'],
  ['bank_kind_marks', 'budget_id = :b'],
  ['receipts', 'budget_id = :b'],
  ['items', 'receipt_id IN (SELECT id FROM receipts WHERE budget_id = :b)'],
  ['item_labels', 'budget_id = :b'],
  ['item_notes', 'receipt_id IN (SELECT id FROM receipts WHERE budget_id = :b)'],
  ['item_hidden', 'receipt_id IN (SELECT id FROM receipts WHERE budget_id = :b)'],
  ['bank_ops', 'budget_id = :b'],
  ['bank_accounts', 'link_id IN (SELECT DISTINCT link_id FROM bank_ops WHERE budget_id = :b)'],
  ['scan_jobs', 'budget_id = :b'],
];

const exists = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

/** Снимок бюджета для резервной копии. */
export function backupBudget(db, budgetId, now = new Date()) {
  const budget = db.prepare(
    'SELECT id, name, created_at, limit_period, limit_total, limits_on FROM budgets WHERE id = ?',
  ).get(budgetId);
  // Участники — только кто это: без логинов, паролей и Telegram
  const members = db.prepare(
    'SELECT id, name, CASE WHEN id = (SELECT owner_id FROM budgets WHERE id = :b) THEN 1 ELSE 0 END AS owner FROM users WHERE budget_id = :b ORDER BY id',
  ).all({ b: budgetId });
  const tables = {};
  for (const [table, where] of BUDGET_TABLES) {
    if (!exists(db, table)) continue;
    const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((c) => c.name).filter((c) => c !== 'raw');
    const rows = db.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM ${table} WHERE ${where}`).all({ b: budgetId });
    tables[table] = { columns, rows: rows.map((r) => columns.map((c) => r[c])) };
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    created_at: now.toISOString(),
    budget,
    members,
    tables,
  };
}
