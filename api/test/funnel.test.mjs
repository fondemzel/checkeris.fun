import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { migrate, SCHEMA_PATH } from '../src/db.mjs';
import { initFunnel, funnelOverview, ensureFunnelVisitor, funnelVisitor, recordDemo } from '../src/funnel.mjs';
import { loginByCode } from '../src/emailauth.mjs';
import { startLogin, prepareLogin, confirmLink } from '../src/telegram.mjs';

function database(t, legacy = false) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  if (legacy) db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  else migrate(db);
  t.after(() => db.close());
  person(db, 'admin', '2026-01-01T00:00:00Z', 'admin');
  return db;
}

function person(db, login = 'mail:person@example.test', created = new Date().toISOString(), role = 'user', demo = 0) {
  const id = Number(db.prepare('INSERT INTO users(login, password, created_at, role) VALUES (?, ?, ?, ?)').run(login, '!', created, role).lastInsertRowid);
  const budget = Number(db.prepare('INSERT INTO budgets(name, owner_id, created_at, demo) VALUES (?, ?, ?, ?)').run('Test', id, created, demo).lastInsertRowid);
  db.prepare('UPDATE users SET budget_id = ?, home_budget_id = ? WHERE id = ?').run(budget, budget, id);
  return { id, budget };
}

function receipt(db, u, number, drive = '123') {
  db.prepare(`INSERT INTO receipts(budget_id, added_by, fiscal_drive, fiscal_doc, fiscal_sign, purchased_at, purchased_date, created_at)
    VALUES (?, ?, ?, ?, 1, '2020-01-01T12:00:00', '2020-01-01', '2020-01-01T12:00:00Z')`).run(u.budget, u.id, drive, number);
}

function link(db, u, bank = 'tbank', status = 'device') {
  return Number(db.prepare('INSERT INTO bank_links(user_id, bank, status, login_at, last_ok_at) VALUES (?, ?, ?, ?, ?)')
    .run(u.id, bank, status, new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
}

function operation(db, u, linkId, ext = '1') {
  db.prepare(`INSERT INTO bank_ops(link_id, budget_id, ext_id, account, at, direction, amount, currency, raw, created_at, updated_at)
    VALUES (?, ?, ?, '', '2020-01-01T12:00:00', 'credit', 100, 'RUB', '{}', '2020-01-01T12:00:00Z', '2020-01-01T12:00:00Z')`)
    .run(linkId, u.budget, ext);
}

function visitor(db) {
  let cookie;
  const req = { headers: {}, socket: { encrypted: true } };
  const hash = ensureFunnelVisitor(db, req, { setHeader: (key, value) => { cookie = value; } }, 'test');
  req.headers.cookie = cookie.split(';')[0];
  assert.match(cookie, /HttpOnly; SameSite=Lax; Secure/);
  assert.equal(funnelVisitor(db, req), hash);
  assert.equal(ensureFunnelVisitor(db, req, { setHeader: () => assert.fail('cookie repeated') }), hash);
  return hash;
}

test('migration repeats safely; milestones record arrival, deduplicate and exclude demo/admin', (t) => {
  const db = database(t);
  const u = person(db);
  const demo = person(db, '__guest__', undefined, 'user', 1);
  receipt(db, u, 1);
  const first = db.prepare("SELECT occurred_at FROM funnel_milestones WHERE user_id = ? AND kind = 'first_receipt'").get(u.id).occurred_at;
  assert.ok(first > '2020-01-01');
  receipt(db, u, 2);
  receipt(db, u, 3, 'manual');
  receipt(db, demo, 1);
  const bank = link(db, u);
  operation(db, u, bank);
  operation(db, u, bank, '2');
  const manualUser = person(db, 'manual-person');
  operation(db, manualUser, link(db, manualUser, 'manual', 'manual'));
  migrate(db);
  const result = funnelOverview(db);
  assert.equal(result.registered, 2);
  assert.equal(result.activated, 2);
  assert.equal(result.milestones.find((e) => e.kind === 'first_bank_connected').people, 1);
  assert.equal(result.milestones.find((e) => e.kind === 'first_manual').people, 2);
  assert.equal(db.prepare("SELECT occurred_at FROM funnel_milestones WHERE user_id = ? AND kind = 'first_receipt'").get(u.id).occurred_at, first);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM funnel_milestones WHERE user_id = ?').get(demo.id).n, 0);
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM funnel_milestones WHERE user_id = ?').get(u.id).n, 0);
});

test('legacy results have unknown dates and later events never fabricate first-result latency', (t) => {
  const db = database(t, true);
  const u = person(db);
  receipt(db, u, 1);
  initFunnel(db);
  receipt(db, u, 2, 'manual');
  const result = funnelOverview(db);
  assert.equal(result.milestones.find((e) => e.kind === 'first_receipt').unknown_date, 1);
  assert.equal(result.activation_time.unknown, 1);
  assert.equal(result.activation_time.median_hours, null);
  initFunnel(db);
  assert.equal(funnelOverview(db).registered, 1);
});

test('rollback removes milestones and scan attempts are not successful activation', (t) => {
  const db = database(t);
  const u = person(db);
  db.exec('BEGIN');
  receipt(db, u, 1);
  db.exec('ROLLBACK');
  db.prepare(`INSERT INTO scan_jobs(budget_id, user_id, qr, fiscal_drive, fiscal_doc, fiscal_sign,
    total_sum, purchased_at, status, created_at, updated_at) VALUES (?, ?, 'qr', '1', 1, 1, 0, ?, 'failed', ?, ?)`)
    .run(u.budget, u.id, '2020-01-01T12:00:00', new Date().toISOString(), new Date().toISOString());
  const result = funnelOverview(db);
  assert.equal(result.activated, 0);
  assert.equal(result.milestones.find((e) => e.kind === 'first_scan').people, 1);
  assert.equal(result.milestones.find((e) => e.kind === 'first_receipt').people, 0);
});

test('failed device report and shop link do not count as a successful bank connection', (t) => {
  const db = database(t);
  const u = person(db);
  db.prepare("INSERT INTO bank_links(user_id, bank, status, login_at) VALUES (?, 'sber', 'device', ?)")
    .run(u.id, new Date().toISOString());
  link(db, u, 'ozon');
  assert.equal(funnelOverview(db).milestones.find((m) => m.kind === 'first_bank_connected').people, 0);
  db.prepare("UPDATE bank_links SET last_ok_at = ? WHERE user_id = ? AND bank = 'sber'").run(new Date().toISOString(), u.id);
  assert.equal(funnelOverview(db).milestones.find((m) => m.kind === 'first_bank_connected').people, 1);
});

test('D7/D30 exclude unfinished days and compute against eligible cohort members', (t) => {
  const db = database(t);
  const a = person(db, 'a', '2026-10-23T23:59:00Z');
  const b = person(db, 'b', '2026-10-22T12:00:00Z');
  person(db, 'c', '2026-10-24T00:00:00Z');
  const old = person(db, 'old', '2026-09-30T00:00:00Z');
  person(db, 'future30', '2026-10-01T00:00:00Z');
  const active = db.prepare("INSERT INTO usage_daily VALUES (?, ?, 'active', 1)");
  active.run(b.id, '2026-10-01');
  active.run(a.id, '2026-10-30');
  active.run(old.id, '2026-10-30');
  const result = funnelOverview(db, new Date('2026-10-31T23:59:00Z'));
  const c = result.cohorts.find((x) => x.week === '2026-10-19');
  assert.deepEqual(c.d7, { eligible: 2, returned: 1 });
  assert.deepEqual(c.d30, { eligible: 0, returned: 0 });
  assert.deepEqual(result.cohorts.find((x) => x.week === '2026-09-28').d30, { eligible: 1, returned: 1 });
});

test('demo visitor is counted once and links only after successful email registration', (t) => {
  const db = database(t);
  const hash = visitor(db);
  recordDemo(db, hash);
  recordDemo(db, hash);
  const email = 'new@example.test';
  const codeHash = createHash('sha256').update(`${email}:123456`).digest('hex');
  db.prepare(`INSERT INTO email_codes(email, code_hash, purpose, created_at, expires_at) VALUES (?, ?, 'login', ?, ?)`)
    .run(email, codeHash, new Date().toISOString(), new Date(Date.now() + 600000).toISOString());
  assert.ok(loginByCode(db, { email, code: '000000', visitor: hash }).error);
  assert.equal(funnelOverview(db).demo.registered, 0);
  assert.equal(loginByCode(db, { email, code: '123456', visitor: hash }).created, true);
  assert.deepEqual(funnelOverview(db).demo, { visitors: 1, registered: 1 });
  assert.equal(funnelOverview(db).methods.find((m) => m.method === 'email').people, 1);
});

test('Telegram keeps originating browser through confirmation in another browser', (t) => {
  const db = database(t);
  const hash = visitor(db);
  recordDemo(db, hash);
  const flow = startLogin(db, { visitor: hash, client: 'm' });
  const prepared = prepareLogin(db, { nonce: flow.nonce, telegram: { id: 123456, first_name: 'Test' } });
  assert.equal(confirmLink(db, { code: prepared.code }).registration_required, true);
  assert.equal(funnelOverview(db).demo.registered, 0);
  assert.equal(confirmLink(db, { code: prepared.code, register: true }).created, true);
  assert.deepEqual(funnelOverview(db).demo, { visitors: 1, registered: 1 });
  assert.equal(funnelOverview(db).methods.find((m) => m.method === 'telegram').people, 1);
});
