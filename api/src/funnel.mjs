// Первые этапы воронки. Финансовые поля сюда не копируются.
// Время событий — UTC, как usage_daily; старые неизвестные даты остаются NULL.
import { randomBytes, createHash } from 'node:crypto';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const real = "u.role <> 'admin' AND substr(u.login, 1, 2) <> '__'";
const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const banks = "'tbank', 'sber'";

/** После миграции: один раз обозначаем старые данные, затем фиксируем новые INSERT. */
export function initFunnel(db) {
  if (!db.prepare("SELECT 1 FROM funnel_meta WHERE key = 'started_at'").get()) {
    db.exec('BEGIN');
    try {
      db.prepare("INSERT INTO funnel_meta VALUES ('started_at', ?)").run(new Date().toISOString());
      db.exec(`
        INSERT OR IGNORE INTO funnel_milestones(user_id, kind, occurred_at, origin, method)
          SELECT u.id, 'registered', u.created_at, 'historical',
            CASE WHEN u.login LIKE 'tg:%' THEN 'telegram' WHEN u.login LIKE 'mail:%' THEN 'email' ELSE 'password' END
          FROM users u WHERE ${real};
        INSERT OR IGNORE INTO funnel_milestones(user_id, kind, occurred_at, origin)
          SELECT u.id, CASE WHEN r.fiscal_drive = 'manual' THEN 'first_manual' ELSE 'first_receipt' END, NULL, 'legacy'
          FROM receipts r JOIN users u ON u.id = r.added_by JOIN budgets b ON b.id = r.budget_id
          WHERE ${real} AND b.demo = 0;
        INSERT OR IGNORE INTO funnel_milestones(user_id, kind, occurred_at, origin)
          SELECT u.id, 'first_scan', MIN(s.created_at), 'historical'
          FROM scan_jobs s JOIN users u ON u.id = s.user_id JOIN budgets b ON b.id = s.budget_id
          WHERE ${real} AND b.demo = 0 GROUP BY u.id;
        INSERT OR IGNORE INTO funnel_milestones(user_id, kind, occurred_at, origin)
          SELECT u.id, 'first_bank_connected', NULL, 'legacy' FROM bank_links l JOIN users u ON u.id = l.user_id
          WHERE ${real} AND l.bank IN (${banks}) AND l.status <> 'demo'
            AND (l.last_ok_at IS NOT NULL OR l.synced_at IS NOT NULL OR EXISTS (SELECT 1 FROM bank_ops o WHERE o.link_id = l.id));
        INSERT OR IGNORE INTO funnel_milestones(user_id, kind, occurred_at, origin)
          SELECT u.id, CASE WHEN l.bank = 'manual' THEN 'first_manual' ELSE 'first_bank_data' END, NULL, 'legacy'
          FROM bank_ops o JOIN bank_links l ON l.id = o.link_id JOIN users u ON u.id = l.user_id
          JOIN budgets b ON b.id = o.budget_id
          WHERE ${real} AND b.demo = 0 AND (l.bank = 'manual' OR l.bank IN (${banks}));
      `);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  const trigger = (name, action, table, select) => db.exec(`
    CREATE TRIGGER IF NOT EXISTS funnel_${name} AFTER ${action} ON ${table} BEGIN
      INSERT OR IGNORE INTO funnel_milestones(user_id, kind, occurred_at, origin, method)
      ${select};
    END;
  `);
  trigger('registered', 'INSERT', 'users', `SELECT NEW.id, 'registered', NEW.created_at, 'observed',
    CASE WHEN NEW.login LIKE 'tg:%' THEN 'telegram' WHEN NEW.login LIKE 'mail:%' THEN 'email' ELSE 'password' END
    WHERE NEW.role <> 'admin' AND substr(NEW.login, 1, 2) <> '__'`);
  trigger('receipt', 'INSERT', 'receipts', `SELECT u.id,
    CASE WHEN NEW.fiscal_drive = 'manual' THEN 'first_manual' ELSE 'first_receipt' END,
    ${nowSql}, 'observed', NULL FROM users u JOIN budgets b ON b.id = NEW.budget_id
    WHERE u.id = NEW.added_by AND ${real} AND b.demo = 0`);
  trigger('scan', 'INSERT', 'scan_jobs', `SELECT u.id, 'first_scan', ${nowSql}, 'observed', NULL
    FROM users u JOIN budgets b ON b.id = NEW.budget_id WHERE u.id = NEW.user_id AND ${real} AND b.demo = 0`);
  const connected = `SELECT u.id, 'first_bank_connected', ${nowSql}, 'observed', NULL FROM users u
    JOIN budgets b ON b.id = COALESCE(u.demo_return, u.budget_id)
    WHERE u.id = NEW.user_id AND ${real} AND b.demo = 0 AND NEW.bank IN (${banks}) AND NEW.status IN ('active', 'device')
      AND (NEW.last_ok_at IS NOT NULL OR NEW.synced_at IS NOT NULL)`;
  trigger('bank_insert', 'INSERT', 'bank_links', connected);
  trigger('bank_update', 'UPDATE OF status, last_ok_at, synced_at', 'bank_links', connected);
  trigger('bank_data', 'INSERT', 'bank_ops', `SELECT u.id,
    CASE WHEN l.bank = 'manual' THEN 'first_manual' ELSE 'first_bank_data' END,
    ${nowSql}, 'observed', NULL FROM bank_links l JOIN users u ON u.id = l.user_id
    JOIN budgets b ON b.id = NEW.budget_id WHERE l.id = NEW.link_id AND ${real} AND b.demo = 0
      AND (l.bank = 'manual' OR l.bank IN (${banks}))`);
}

const cookieName = 'checker.funnel';
export function funnelVisitor(db, req) {
  const value = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value ?? '')) return null;
  const hash = sha(value);
  return db.prepare('SELECT 1 FROM funnel_visitors WHERE hash = ?').get(hash) ? hash : null;
}

/** Cookie выдаёт сервер, в БД только хеш. В другом браузере связь не восстанавливаем. */
export function ensureFunnelVisitor(db, req, res, source = null) {
  const existing = funnelVisitor(db, req);
  if (existing) return existing;
  const value = randomBytes(32).toString('base64url');
  const hash = sha(value);
  const slug = /^[a-z0-9_-]{1,32}$/.test(String(source ?? '')) ? source : null;
  db.prepare('INSERT INTO funnel_visitors(hash, created_at, source) VALUES (?, ?, ?)').run(hash, new Date().toISOString(), slug);
  const secure = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  return hash;
}

export function recordDemo(db, visitor) {
  db.prepare('UPDATE funnel_visitors SET demo_at = COALESCE(demo_at, ?) WHERE hash = ?').run(new Date().toISOString(), visitor);
}

export function linkFunnelRegistration(db, userId, visitor) {
  if (!visitor) return;
  db.prepare(`UPDATE funnel_milestones SET visitor_hash = ? WHERE user_id = ? AND kind = 'registered'
    AND visitor_hash IS NULL AND EXISTS (SELECT 1 FROM funnel_visitors WHERE hash = ?)`).run(visitor, userId, visitor);
}

const dayMs = 86400000;
const day = (d) => d.toISOString().slice(0, 10);
const week = (iso) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return day(d);
};

/** Только агрегаты: данные чеков, счетов и контактные данные не возвращаются. */
export function funnelOverview(db, at = new Date()) {
  const users = db.prepare(`SELECT u.id, u.created_at, COALESCE(u.source,
    CASE WHEN EXISTS (SELECT 1 FROM invites i WHERE i.used_by = u.id
      AND julianday(i.used_at) - julianday(u.created_at) BETWEEN 0 AND 1) THEN 'invite' ELSE 'direct' END) AS source
    FROM users u WHERE ${real}`).all();
  const events = db.prepare(`SELECT m.* FROM funnel_milestones m JOIN users u ON u.id = m.user_id WHERE ${real}`).all();
  const byUser = new Map(users.map((u) => [u.id, {}]));
  for (const e of events) byUser.get(e.user_id)[e.kind] = e;
  const kinds = ['first_receipt', 'first_manual', 'first_bank_data'];
  const milestones = ['first_scan', 'first_receipt', 'first_manual', 'first_bank_connected', 'first_bank_data'].map((kind) => {
    const matching = events.filter((e) => e.kind === kind);
    return { kind, people: matching.length, unknown_date: matching.filter((e) => !e.occurred_at).length };
  });
  const activated = users.filter((u) => kinds.some((k) => byUser.get(u.id)[k]));
  // Если уже были данные с неизвестной датой, новый вид данных не выдаём за первый результат.
  const delays = activated.flatMap((u) => {
    const first = kinds.map((k) => byUser.get(u.id)[k]).filter(Boolean);
    if (first.some((e) => !e.occurred_at)) return [];
    const ms = Math.min(...first.map((e) => Date.parse(e.occurred_at))) - Date.parse(u.created_at);
    return ms >= 0 ? [ms / 3600000] : [];
  }).sort((a, b) => a - b);
  const today = day(at);
  const coveredFrom = db.prepare("SELECT MIN(day) AS day FROM usage_daily WHERE kind = 'active'").get().day;
  const active = new Set(db.prepare("SELECT user_id, day FROM usage_daily WHERE kind = 'active'").all().map((r) => `${r.user_id}:${r.day}`));
  const cohorts = new Map();
  const channels = new Map();
  for (const u of users) {
    const key = week(u.created_at);
    if (!cohorts.has(key)) cohorts.set(key, { week: key, people: 0, activated: 0, d7: { eligible: 0, returned: 0 }, d30: { eligible: 0, returned: 0 } });
    const c = cohorts.get(key);
    c.people++;
    const used = kinds.some((k) => byUser.get(u.id)[k]);
    if (used) c.activated++;
    for (const n of [7, 30]) {
      const target = day(new Date(Date.parse(`${u.created_at.slice(0, 10)}T00:00:00Z`) + n * dayMs));
      if (coveredFrom && target >= coveredFrom && target < today) {
        c[`d${n}`].eligible++;
        if (active.has(`${u.id}:${target}`)) c[`d${n}`].returned++;
      }
    }
    if (!channels.has(u.source)) channels.set(u.source, { source: u.source, registered: 0, activated: 0 });
    const channel = channels.get(u.source);
    channel.registered++;
    if (used) channel.activated++;
  }
  const demo = db.prepare(`SELECT COUNT(*) AS visitors, SUM(EXISTS (
    SELECT 1 FROM funnel_milestones m JOIN users u ON u.id = m.user_id
    WHERE m.visitor_hash = v.hash AND m.kind = 'registered' AND ${real} AND m.occurred_at >= v.demo_at
  )) AS registered FROM funnel_visitors v WHERE v.demo_at IS NOT NULL`).get();
  const middle = Math.floor(delays.length / 2);
  return {
    started_at: db.prepare("SELECT value FROM funnel_meta WHERE key = 'started_at'").get().value,
    timezone: 'UTC', retention_covered_from: coveredFrom,
    registered: users.length, activated: activated.length,
    methods: ['email', 'telegram', 'password'].map((method) => ({ method, people: events.filter((e) => e.kind === 'registered' && e.method === method).length })),
    milestones, demo: { visitors: demo.visitors, registered: demo.registered ?? 0 },
    activation_time: { people: delays.length, unknown: activated.length - delays.length,
      median_hours: delays.length ? (delays.length % 2 ? delays[middle] : (delays[middle - 1] + delays[middle]) / 2) : null },
    cohorts: [...cohorts.values()].sort((a, b) => b.week.localeCompare(a.week)),
    channels: [...channels.values()].sort((a, b) => b.registered - a.registered),
  };
}
