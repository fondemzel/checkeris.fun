// Админка: сколько людей, откуда пришли и как пользуются приложением (site/admin).
//
// Только служебное. Банковские данные людей не показываются: ни операций, ни сумм, ни
// покупок — только числа («чеков 120») и состояние подключений (подключён ли банк, когда
// синхронизировался, ошибка). Так в админке нечего подсмотреть о чужих деньгах.
//
// Откуда пришёл — метка ссылки ?from=… (users.source, запоминается при регистрации через
// Telegram), либо приглашение в общий бюджет, либо «напрямую». Активность — отметки «был
// сегодня» (usage_daily, kind = 'active'), которые ставит каждый запрос с токеном (auth.mjs).
//
// В подсчётах нет служебных пользователей демо-режима (логины «__…», войти под ними нельзя)
// и администратора: это владелец проекта, а не бета-пользователь.
import { sourceSlug } from './telegram.mjs';
import { supportWaiting, supportOfUser } from './support.mjs';
import { planOf, setPlan, PLANS, LABELS } from './plans.mjs';

const DAY = 86_400_000;
const dayAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const FNS_LIMIT = Number(process.env.FNS_DAILY_LIMIT ?? 1000); // как в fns.mjs

// Люди беты: без служебных и без администратора — для подсчётов
const REAL = "u.login NOT LIKE '\\_\\_%' ESCAPE '\\' AND u.role <> 'admin'";
// В списке людей администратор есть (с пометкой) — в подсчётах его нет
const LISTED = "u.login NOT LIKE '\\_\\_%' ESCAPE '\\'";
// Свой бюджет человека: в демо-режиме текущий — общий тестовый, а свой ждёт в demo_return
const OWN = 'COALESCE(u.demo_return, u.budget_id)';

/** Откуда пришёл: метка, приглашение (вступил в чужой бюджет в первые сутки) или напрямую. */
function channelOf(u) {
  if (u.source) return u.source;
  if (u.invited_at && Date.parse(u.invited_at) - Date.parse(u.created_at) < DAY) return 'invite';
  return 'direct';
}

/** Все люди беты с тем, что о них нужно админке. Новые — сверху. */
const STALE_MS = 24 * 3_600_000; // операции не приходили дольше — что-то не так

/**
 * Живо ли подключение на деле. Большинство — «с телефона» (status = device): сессия на
 * телефоне, и что с ней, знает только он — его отчёт (dev_state: ok, expired, offline, error,
 * off, banks.mjs reportLink). Сбер, например, живёт час и потом просит войти заново: отчёт
 * говорит об этом сразу. И просто давно не было операций — тоже повод посмотреть.
 */
function health(l) {
  if (l.status === 'demo') return { state: 'idle', text: 'демо' };
  if (l.status === 'off' || l.dev_state === 'off') return { state: 'idle', text: 'вышли' };
  if (l.status === 'expired' || l.dev_state === 'expired') return { state: 'bad', text: 'нужен вход заново' };
  if (l.dev_state === 'offline') return { state: 'warn', text: 'банк не отвечает' };
  if (l.dev_state === 'error') return { state: 'warn', text: 'ошибка' };
  if (!l.synced_at || Date.now() - Date.parse(l.synced_at) > STALE_MS) return { state: 'warn', text: 'давно не обновлялся' };
  return { state: 'ok', text: 'работает' };
}

function people(db) {
  const since30 = dayAgo(29);
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.role, u.tg_username, u.email, u.created_at, u.source, u.telegram_id IS NOT NULL AS telegram,
              ${OWN} AS budget_id,
              u.demo_return IS NOT NULL AS in_demo,
              (SELECT MAX(t.used_at) FROM tokens t WHERE t.user_id = u.id) AS last_seen,
              (SELECT COUNT(*) FROM usage_daily a WHERE a.user_id = u.id AND a.kind = 'active' AND a.day >= :since30) AS active_days,
              (SELECT i.used_at FROM invites i WHERE i.used_by = u.id ORDER BY i.used_at LIMIT 1) AS invited_at,
              (SELECT COALESCE(w.name, w.login) FROM invites i JOIN users w ON w.id = i.created_by
                WHERE i.used_by = u.id ORDER BY i.used_at LIMIT 1) AS invited_by,
              (SELECT COUNT(*) FROM users m WHERE m.budget_id = ${OWN}) AS members,
              (SELECT COUNT(*) FROM receipts r WHERE r.added_by = u.id AND r.fiscal_drive <> 'manual') AS receipts,
              (SELECT COUNT(*) FROM receipts r WHERE r.added_by = u.id AND r.fiscal_drive = 'manual') AS manual,
              (SELECT MIN(COALESCE(r.created_at, r.purchased_at)) FROM receipts r WHERE r.added_by = u.id) AS first_receipt,
              (SELECT COUNT(*) FROM scan_jobs s WHERE s.user_id = u.id) AS scans,
              (SELECT COUNT(*) FROM scan_jobs s WHERE s.user_id = u.id AND s.status = 'failed') AS scans_failed,
              (SELECT COUNT(*) FROM bank_ops o JOIN bank_links l ON l.id = o.link_id WHERE l.user_id = u.id) AS bank_ops,
              (SELECT COUNT(*) FROM budget_limits b WHERE b.budget_id = ${OWN}) AS limits
         FROM users u
        WHERE ${LISTED}
        ORDER BY u.created_at DESC`,
    )
    .all({ since30 });

  const links = db
    .prepare(
      `SELECT l.user_id, l.bank, l.status, l.login_at, l.synced_at, l.last_error, l.fails, l.dev_state, l.dev_detail, l.dev_at
         FROM bank_links l JOIN users u ON u.id = l.user_id
        WHERE ${LISTED} AND l.bank <> 'manual'
        ORDER BY l.login_at`,
    )
    .all();
  const byUser = new Map();
  for (const l of links) {
    if (!byUser.has(l.user_id)) byUser.set(l.user_id, []);
    const h = health(l);
    byUser.get(l.user_id).push({
      bank: l.bank,
      status: l.status,
      health: h.state, // ok | warn | bad | idle — по нему цвет точки и счётчик отвалившихся
      health_text: h.text,
      since: l.login_at,
      synced_at: l.synced_at,
      reported_at: l.dev_at,
      error: h.state === 'ok' ? null : l.dev_detail || l.last_error,
    });
  }

  return rows.map((u) => ({
    id: u.id,
    name: u.name ?? `#${u.id}`,
    admin: u.role === 'admin', // в списке — с пометкой, в подсчёты не входит
    budget_id: u.budget_id,
    tg_username: u.tg_username,
    email: u.email,
    telegram: Boolean(u.telegram),
    created_at: u.created_at,
    channel: channelOf(u),
    invited_by: u.invited_by,
    last_seen: u.last_seen,
    active_days: u.active_days,
    in_demo: Boolean(u.in_demo),
    shared: u.members > 1,
    members: u.members,
    receipts: u.receipts,
    manual: u.manual,
    first_receipt: u.first_receipt,
    scans: u.scans,
    scans_failed: u.scans_failed,
    bank_ops: u.bank_ops,
    limits: u.limits > 0,
    banks: byUser.get(u.id) ?? [],
  }));
}

/** Метки ссылок: заведённые администратором и встреченные у людей (вторые — без названия). */
function sourceList(db, list) {
  const named = db.prepare('SELECT slug, name, created_at FROM sources ORDER BY created_at').all();
  const out = new Map(named.map((s) => [s.slug, { ...s, people: 0, active7: 0, used: 0 }]));
  const since7 = dayAgo(6);
  for (const u of list) {
    const key = u.channel;
    if (!out.has(key)) out.set(key, { slug: key, name: null, created_at: null, people: 0, active7: 0, used: 0 });
    const s = out.get(key);
    s.people += 1;
    if (u.last_seen && u.last_seen.slice(0, 10) >= since7) s.active7 += 1;
    // «Пользуется» — внёс хоть что-то: чек, запись или банк
    if (u.receipts || u.manual || u.banks.length) s.used += 1;
  }
  return [...out.values()].sort((a, b) => b.people - a.people || String(a.slug).localeCompare(String(b.slug)));
}

/** Сколько отметок «был» по дням: 30 дней, по возрастанию. */
function activeByDay(db) {
  const from = dayAgo(29);
  const active = new Map(
    db
      .prepare(
        `SELECT a.day, COUNT(*) AS n FROM usage_daily a JOIN users u ON u.id = a.user_id
          WHERE a.kind = 'active' AND a.day >= ? AND ${REAL} GROUP BY a.day`,
      )
      .all(from)
      .map((r) => [r.day, r.n]),
  );
  const joined = new Map(
    db
      .prepare(`SELECT substr(u.created_at, 1, 10) AS day, COUNT(*) AS n FROM users u WHERE u.created_at >= ? AND ${REAL} GROUP BY day`)
      .all(from)
      .map((r) => [r.day, r.n]),
  );
  const days = [];
  for (let i = 29; i >= 0; i -= 1) {
    const day = dayAgo(i);
    days.push({ day, active: active.get(day) ?? 0, joined: joined.get(day) ?? 0 });
  }
  return days;
}

/** Общие ресурсы: ФНС, модель, DaData, сканы, подключения — заранее видно, во что упрёмся. */
function load(db) {
  const today = dayAgo(0);
  const since7 = dayAgo(6);
  const fns = db.prepare('SELECT day, calls FROM fns_usage WHERE day >= ? ORDER BY day').all(since7);
  return {
    fns: { limit: FNS_LIMIT, today: fns.find((r) => r.day === today)?.calls ?? 0, days: fns },
    model_names: db.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM usage_daily WHERE kind = 'llm_names' AND day = ?").get(today).n,
    dadata: db.prepare('SELECT service, calls FROM api_usage WHERE day = ?').all(today),
    scans_today: db.prepare('SELECT COUNT(*) AS n FROM scan_jobs WHERE created_at >= ?').get(today).n,
    scan_errors: db
      .prepare(
        `SELECT COALESCE(error_code, '—') AS code, COUNT(*) AS n, MAX(error) AS sample
           FROM scan_jobs WHERE status = 'failed' AND updated_at >= ? GROUP BY code ORDER BY n DESC`,
      )
      .all(since7),
    links: db
      .prepare(
        `SELECT l.bank, l.status, COUNT(*) AS n FROM bank_links l JOIN users u ON u.id = l.user_id
          WHERE ${REAL} GROUP BY l.bank, l.status ORDER BY l.bank, l.status`,
      )
      .all(),
  };
}

/** Тариф бюджета для админки: действующий и как записан (срок, пометка). */
const planInfo = (db, b) => {
  const p = planOf(db, b.id);
  return { id: p.id, title: p.title, until: b.plan_until, label: b.plan_label, label_title: LABELS[b.plan_label] ?? null, expired: p.expired, was: p.was };
};

/**
 * «Пользователи» — бюджеты, которыми пользуются: строка — по владельцу, внутри — участники.
 * Участник чужого бюджета виден в нём, а не отдельной строкой; свой пустой бюджет, из которого
 * человек ушёл в семейный, не показываем. Числа — по бюджету целиком, без сумм.
 */
function budgetsOf(db, everyone) {
  const since30 = dayAgo(29);
  const rows = db.prepare(
    `SELECT b.id, b.name, b.owner_id, b.created_at, b.plan, b.plan_until, b.plan_label,
            (SELECT COUNT(*) FROM receipts r WHERE r.budget_id = b.id AND r.fiscal_drive <> 'manual') AS receipts,
            (SELECT COUNT(*) FROM receipts r WHERE r.budget_id = b.id AND r.fiscal_drive = 'manual') AS manual,
            (SELECT COUNT(*) FROM scan_jobs s WHERE s.budget_id = b.id) AS scans,
            (SELECT COUNT(*) FROM scan_jobs s WHERE s.budget_id = b.id AND s.status = 'failed') AS scans_failed,
            (SELECT COUNT(*) FROM bank_ops o WHERE o.budget_id = b.id) AS bank_ops,
            (SELECT COUNT(DISTINCT a.day) FROM usage_daily a JOIN users u ON u.id = a.user_id
              WHERE a.kind = 'active' AND a.day >= ? AND COALESCE(u.demo_return, u.budget_id) = b.id) AS active_days
       FROM budgets b WHERE b.demo = 0`,
  ).all(since30);
  const out = [];
  for (const b of rows) {
    const members = everyone.filter((u) => u.budget_id === b.id);
    if (!members.length) continue;
    const owner = members.find((m) => m.id === b.owner_id) ?? members[0];
    const seen = members.map((m) => m.last_seen).filter(Boolean).sort().at(-1) ?? null;
    out.push({
      id: b.id,
      name: b.name,
      plan: planInfo(db, b),
      owner: { id: owner.id, name: owner.name, tg_username: owner.tg_username, email: owner.email, telegram: owner.telegram, admin: owner.admin, channel: owner.channel, invited_by: owner.invited_by, created_at: owner.created_at },
      members: members.map((m) => ({ id: m.id, name: m.name, admin: m.admin, owner: m.id === owner.id, last_seen: m.last_seen, in_demo: m.in_demo })),
      admin: owner.admin,
      created_at: owner.created_at,
      last_seen: seen,
      active_days: b.active_days,
      receipts: b.receipts,
      manual: b.manual,
      scans: b.scans,
      scans_failed: b.scans_failed,
      bank_ops: b.bank_ops,
      banks: members.flatMap((m) => m.banks.map((l) => ({ ...l, person: m.name }))),
      in_demo: members.some((m) => m.in_demo),
    });
  }
  return out.sort((a, c) => (c.created_at > a.created_at ? 1 : -1));
}

/** Бюджет подробно: участники, дни, когда кто-то заходил (90), внесено по месяцам, обращения. */
export function budgetDetail(db, id) {
  const everyone = people(db);
  const base = budgetsOf(db, everyone).find((b) => b.id === Number(id));
  if (!base) return null;
  const days = db.prepare(
    `SELECT DISTINCT a.day FROM usage_daily a JOIN users u ON u.id = a.user_id
      WHERE a.kind = 'active' AND a.day >= ? AND COALESCE(u.demo_return, u.budget_id) = ? ORDER BY a.day`,
  ).all(dayAgo(89), base.id).map((r) => r.day);
  const months = db.prepare(
    `SELECT substr(COALESCE(created_at, purchased_at), 1, 7) AS month,
            SUM(fiscal_drive <> 'manual') AS receipts, SUM(fiscal_drive = 'manual') AS manual
       FROM receipts WHERE budget_id = ? AND COALESCE(created_at, purchased_at) >= ?
      GROUP BY month ORDER BY month`,
  ).all(base.id, dayAgo(365).slice(0, 7));
  const members = everyone.filter((u) => u.budget_id === base.id);
  const support = members.flatMap((m) => supportOfUser(db, m.id)).sort((a, c) => (c.updated_at > a.updated_at ? 1 : -1));
  return { ...base, people: members, days, months, support, plans: Object.values(PLANS).map((p) => ({ id: p.id, title: p.title })), labels: LABELS };
}

/** Сменить тариф бюджета из админки. */
export const changePlan = (db, id, body) => setPlan(db, id, body ?? {});

/** Всё для страницы админки одним ответом: людей пока немного. */
export function overview(db) {
  const everyone = people(db);
  const list = everyone.filter((u) => !u.admin); // подсчёты — без администратора
  const budgets = budgetsOf(db, everyone);
  const plans = { free: 0, plus: 0, premium: 0 };
  for (const b of budgets) if (!b.admin) plans[b.plan.id] += 1;
  const since = (n) => dayAgo(n - 1);
  const seen = (n) => list.filter((u) => u.last_seen && u.last_seen.slice(0, 10) >= since(n)).length;
  const joined = (n) => list.filter((u) => u.created_at.slice(0, 10) >= since(n)).length;
  return {
    totals: {
      people: list.length,
      joined_today: joined(1),
      joined_7: joined(7),
      active_today: seen(1),
      active_7: seen(7),
      active_30: seen(30),
      with_receipts: list.filter((u) => u.receipts || u.manual).length,
      with_bank: list.filter((u) => u.banks.length).length,
      shared: list.filter((u) => u.shared).length,
    },
    days: activeByDay(db),
    support_waiting: supportWaiting(db),
    sources: sourceList(db, list),
    load: load(db),
    people: everyone,
    budgets,
    plans,
  };
}

/**
 * Один человек подробно: то же, что в списке, плюс дни, когда заходил (90 дней), устройства
 * (выданные входы, без самих токенов), участники бюджета и сколько чеков вносил по месяцам —
 * числом, без сумм.
 */
export function personDetail(db, id) {
  const base = people(db).find((u) => u.id === Number(id));
  if (!base) return null;
  const days = db
    .prepare("SELECT day FROM usage_daily WHERE user_id = ? AND kind = 'active' AND day >= ? ORDER BY day")
    .all(base.id, dayAgo(89))
    .map((r) => r.day);
  const devices = db
    .prepare('SELECT label, created_at, used_at, expires_at FROM tokens WHERE user_id = ? ORDER BY COALESCE(used_at, created_at) DESC')
    .all(base.id);
  const own = db.prepare('SELECT COALESCE(demo_return, budget_id) AS b FROM users WHERE id = ?').get(base.id).b;
  const budget = own ? db.prepare('SELECT name, owner_id FROM budgets WHERE id = ?').get(own) : null;
  const members = own
    ? db.prepare('SELECT id, COALESCE(name, login) AS name FROM users WHERE budget_id = ? ORDER BY id').all(own)
      .map((m) => ({ ...m, owner: m.id === budget?.owner_id, me: m.id === base.id }))
    : [];
  const months = db
    .prepare(
      `SELECT substr(COALESCE(created_at, purchased_at), 1, 7) AS month,
              SUM(fiscal_drive <> 'manual') AS receipts, SUM(fiscal_drive = 'manual') AS manual
         FROM receipts WHERE added_by = ? AND COALESCE(created_at, purchased_at) >= ?
        GROUP BY month ORDER BY month`,
    )
    .all(base.id, `${dayAgo(365).slice(0, 7)}`);
  const scans = db.prepare('SELECT status, COUNT(*) AS n FROM scan_jobs WHERE user_id = ? GROUP BY status').all(base.id);
  return { ...base, days, devices, budget: budget ? { name: budget.name, members } : null, months, scans, support: supportOfUser(db, base.id) };
}

/** Новая метка ссылки. Название — для себя: «Пост в канале N», «Чат соседей». */
export function addSource(db, { slug, name }) {
  const key = sourceSlug(slug);
  if (!key || key === 'invite' || key === 'direct') return { error: 'метка — латиница, цифры, «-» и «_», до 32 знаков', status: 400 };
  const title = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!title) return { error: 'нужно название', status: 400 };
  db.prepare(
    `INSERT INTO sources (slug, name, created_at) VALUES (?, ?, ?)
     ON CONFLICT (slug) DO UPDATE SET name = excluded.name`,
  ).run(key, title, new Date().toISOString());
  return { slug: key, name: title };
}

/** Убрать метку из списка. Людям, пришедшим по ней, она остаётся — покажется без названия. */
export function removeSource(db, slug) {
  return { removed: db.prepare('DELETE FROM sources WHERE slug = ?').run(String(slug ?? '')).changes };
}
