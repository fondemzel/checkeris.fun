// Очередь сканирования чеков.
//
// Пользователь наводит камеру, мы получаем строку QR — этого мало: в ней нет позиций,
// только реквизиты. Позиции запрашиваются у ФНС, а обмен там асинхронный, поэтому
// сканирование не может быть мгновенным. Задание кладётся в scan_jobs и живёт в базе:
// перезапуск сервиса ничего не теряет.
//
// Состояния: new → sent → done | failed.
//
// Очередь одна на всё приложение, но у каждого задания есть бюджет: чек ложится
// в него, а список, повтор и удаление видят только задания этого бюджета.
// Кто сканировал (user_id) — отдельно: по нему считаются личные квоты.
//
// Опрос идёт с нарастающей паузой, потому что суточный лимит обращений к ФНС — 1000
// на всё приложение, и цикл «спрашивать раз в секунду» съел бы его за час.
import { parseQr, requestTicket, fetchTicket, fnsReady, fnsUsage } from './fns.mjs';
import { saveReceipt, importStatements } from './import.mjs';
import { classifyItems, fillNames } from './classify.mjs';
import { takeModelQuota } from './quota.mjs';

// Через сколько секунд после отправки спрашивать ответ: сначала часто, дальше реже
const BACKOFF = [3, 5, 10, 20, 40, 60, 120, 300];
const MAX_ATTEMPTS = BACKOFF.length;

// Отказы, которые значат «у ФНС ещё нет этого чека», а не «чек плохой»:
// касса передаёт данные с задержкой, иногда в сутки и больше.
//   455 — не найдены данные в сервисе поиска чека
//   544 — не прошла проверка пары ККТ+ФН (свежая регистрация кассы ещё не доехала)
// Такие задания не хороним, а переспрашиваем через нарастающие паузы.
const SYNC_CODES = new Set(['455', '544']);
const RETRY_HOURS = [1, 6, 24, 72];

const now = () => new Date().toISOString();
const later = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();

/**
 * Приём скана. Возвращает задание — существующее, если этот чек уже приносили:
 * ключ тот же, что у импорта выгрузок, поэтому повтор не создаёт вторую запись.
 * Ключ в пределах бюджета: тот же чек, отсканированный в другом бюджете, — отдельный скан.
 */
export function addScan(db, budgetId, userId, qrText) {
  const qr = parseQr(qrText);
  if (!qr) return { error: 'не похоже на QR чека', status: 400 };

  const existing = db
    .prepare('SELECT * FROM scan_jobs WHERE budget_id = ? AND fiscal_drive = ? AND fiscal_doc = ? AND fiscal_sign = ?')
    .get(budgetId, qr.fn, qr.fd, qr.fp);
  // Повторный скан чека, на который ФНС отказала, — это просьба спросить ещё раз
  if (existing?.status === 'failed') return { job: retryScan(db, budgetId, existing.id).job, repeat: true };
  if (existing) return { job: existing, repeat: true };

  // Чек мог приехать раньше выгрузкой — тогда запрашивать его у ФНС незачем
  const known = db
    .prepare('SELECT id FROM receipts WHERE budget_id = ? AND fiscal_drive = ? AND fiscal_doc = ? AND fiscal_sign = ?')
    .get(budgetId, qr.fn, qr.fd, qr.fp);

  const stamp = now();
  const info = db
    .prepare(
      `INSERT INTO scan_jobs (budget_id, user_id, qr, fiscal_drive, fiscal_doc, fiscal_sign, total_sum, purchased_at,
                              operation, status, receipt_id, next_at, created_at, updated_at)
       VALUES (:budget_id, :user_id, :qr, :fn, :fd, :fp, :sum, :date, :type, :status, :receipt, :next, :stamp, :stamp)`,
    )
    .run({
      budget_id: budgetId,
      user_id: userId,
      qr: String(qrText),
      fn: qr.fn,
      fd: qr.fd,
      fp: qr.fp,
      sum: qr.sum,
      date: qr.date,
      type: qr.type,
      status: known ? 'done' : 'new',
      receipt: known?.id ?? null,
      next: known ? null : stamp,
      stamp,
    });

  const job = db.prepare('SELECT * FROM scan_jobs WHERE id = ?').get(info.lastInsertRowid);
  return { job, known: Boolean(known) };
}

export const getScan = (db, budgetId, id) =>
  db.prepare('SELECT * FROM scan_jobs WHERE id = ? AND budget_id = ?').get(id, budgetId) ?? null;

const STATES = {
  failed: "status = 'failed'",
  pending: "status IN ('new', 'sent')",
};

/**
 * Сканы, у которых ещё нет чека: с ошибкой и в работе. Готовые здесь не нужны —
 * они уже чеки и показываются списком чеков. Счётчики — для чипсов фильтра.
 */
export function listScans(db, budgetId, state = '') {
  const where = STATES[state] ?? `(${STATES.failed} OR ${STATES.pending})`;
  const jobs = db
    .prepare(`SELECT * FROM scan_jobs WHERE budget_id = ? AND ${where} ORDER BY purchased_at DESC, id DESC LIMIT 200`)
    .all(budgetId);
  const counts = db
    .prepare(
      `SELECT COALESCE(SUM(${STATES.failed}), 0) AS failed, COALESCE(SUM(${STATES.pending}), 0) AS pending
         FROM scan_jobs WHERE budget_id = ?`,
    )
    .get(budgetId);
  return { jobs, counts };
}

/** Спросить ФНС заново прямо сейчас. Счётчик автоповторов не сбрасываем: он про расход лимита. */
export function retryScan(db, budgetId, id) {
  const job = getScan(db, budgetId, id);
  if (!job) return { error: 'скан не найден', status: 404 };
  if (job.status !== 'failed') return { error: 'повторять можно только скан с ошибкой', status: 409 };
  db.prepare(
    "UPDATE scan_jobs SET status = 'new', attempts = 0, message_id = NULL, next_at = ?, updated_at = ? WHERE id = ?",
  ).run(now(), now(), id);
  return { job: getScan(db, budgetId, id) };
}

/** Удаляется только неудачный скан: у готового есть чек, у ждущего — запрос в ФНС. */
export function deleteScan(db, budgetId, id) {
  const job = getScan(db, budgetId, id);
  if (!job) return { error: 'скан не найден', status: 404 };
  if (job.status !== 'failed') return { error: 'удалить можно только скан с ошибкой', status: 409 };
  db.prepare('DELETE FROM scan_jobs WHERE id = ?').run(id);
  return { ok: true };
}

/**
 * Отказ. Если это «у ФНС ещё нет данных», назначаем следующий повтор — задание
 * остаётся в ошибках, но с датой, когда очередь спросит снова. next_at у окончательного
 * отказа обязательно пустой: очередь берёт ошибки с наступившим next_at.
 */
function fail(db, job, message, code = null) {
  const retries = job.retries ?? 0;
  const again = code && SYNC_CODES.has(String(code)) && retries < RETRY_HOURS.length;
  db.prepare(
    `UPDATE scan_jobs SET status = 'failed', error = ?, error_code = ?, retries = ?, next_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    String(message).slice(0, 400),
    code ? String(code) : null,
    again ? retries + 1 : retries,
    again ? later(RETRY_HOURS[retries] * 3600) : null,
    now(),
    job.id,
  );
}

/** Один шаг задания. Возвращает true, если что-то сделали (чтобы не крутить цикл вхолостую). */
async function step(db, job) {
  if (job.status === 'new') {
    const id = await requestTicket(db, {
      fn: job.fiscal_drive,
      fd: job.fiscal_doc,
      fp: job.fiscal_sign,
      sum: job.total_sum,
      date: job.purchased_at,
      type: job.operation,
    });
    db.prepare("UPDATE scan_jobs SET status = 'sent', message_id = ?, attempts = 0, next_at = ?, updated_at = ? WHERE id = ?")
      .run(id, later(BACKOFF[0]), now(), job.id);
    return true;
  }

  const answer = await fetchTicket(db, job.message_id);

  if (answer.status !== 'COMPLETED') {
    const attempts = job.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      fail(db, job, 'ФНС не ответила за отведённое время');
      return true;
    }
    db.prepare('UPDATE scan_jobs SET attempts = ?, next_at = ?, updated_at = ? WHERE id = ?')
      .run(attempts, later(BACKOFF[Math.min(attempts, BACKOFF.length - 1)]), now(), job.id);
    return true;
  }

  if (!answer.ticket) {
    fail(db, job, answer.error ?? 'ФНС вернула пустой ответ', answer.code);
    return true;
  }

  // ФНС кладёт разобранный чек в content, выгрузка приложения — в document.receipt.
  // Приводим к одному виду и дальше идём общим путём импорта.
  const { rawData, ...content } = answer.ticket.content ?? {};
  const saved = saveReceipt(db, { _id: String(answer.ticket.id ?? ''), receipt: content }, importStatements(db), job.budget_id, job.user_id);
  if (!saved?.id) {
    fail(db, job, 'чек получен, но не разобрался');
    return true;
  }

  classifyItems(db, saved.itemIds);
  await askModel(db, saved.itemIds, job.user_id);

  db.prepare(
    "UPDATE scan_jobs SET status = 'done', receipt_id = ?, error = NULL, error_code = NULL, next_at = NULL, updated_at = ? WHERE id = ?",
  )
    .run(saved.id, now(), job.id);
  return true;
}

// Больше названий в одном чеке модели не отдаём: чек на сотню незнакомых позиций
// означает, что что-то не так, и платить за это по полной незачем
const MAX_ASK = 25;

/**
 * Названия, которых не взяла лестница, спрашиваем у модели прямо здесь.
 * Иначе свежий чек с незнакомым товаром приезжал бы в разбор пустым и ждал
 * ручного прогона --fill. Ответ пишется в словарь, поэтому следующий такой чек
 * разберётся уже без модели.
 *
 * Спрашиваем и про то, что досталось запасному правилу продавца: это не решение
 * про конкретный товар, а ставка «в супермаркете скорее всего еда», с уверенностью 0,5.
 * Проверка показала цену такой ставки: вино из «Магнита» уехало в «Еду» вместо
 * «Алкогольных напитков». Пакетный --fill такие названия тоже переспрашивает.
 *
 * Ошибка модели не проваливает задание: чек уже сохранён и размечен лестницей,
 * а без категории позиция просто попросит выбрать её руками.
 */
async function askModel(db, itemIds, userId) {
  if (!itemIds.length) return;

  const placeholders = itemIds.map(() => '?').join(',');
  const names = db
    .prepare(
      `SELECT v.name_norm, MIN(v.name) AS name, MIN(v.seller) AS seller
         FROM v_items v JOIN item_labels l ON l.item_id = v.id
        WHERE v.id IN (${placeholders}) AND l.source IN ('unknown', 'rule-fallback')
        GROUP BY v.name_norm
        LIMIT ${MAX_ASK}`,
    )
    .all(...itemIds);

  if (!names.length) return;

  // Модель платная: у каждого своя суточная квота. Не хватило — позиции останутся
  // без категории, и человек выберет её сам на экране разбора
  const allowed = takeModelQuota(db, userId, names.length);
  if (!allowed) return;

  try {
    const { written } = await fillNames(db, names.slice(0, allowed));
    if (written) classifyItems(db, itemIds); // словарь пополнился — перечитываем метки
  } catch (err) {
    console.error('модель не разметила новые названия:', err.message);
  }
}

let running = false;

/** Проход по заданиям, которым пришло время. Вызывается по таймеру из server.mjs. */
export async function runScanQueue(db) {
  if (running || !fnsReady()) return;
  if (fnsUsage(db).left <= 0) return; // лимит на сегодня выбран, ждём следующих суток

  running = true;
  try {
    // Ошибки с наступившим next_at — назначенные повторы «ФНС ещё не знает этот чек»
    const due = db
      .prepare(
        `SELECT * FROM scan_jobs
          WHERE (status IN ('new', 'sent') AND (next_at IS NULL OR next_at <= :now))
             OR (status = 'failed' AND next_at IS NOT NULL AND next_at <= :now)
          ORDER BY id LIMIT 5`,
      )
      .all({ now: now() });

    for (const job of due) {
      try {
        if (job.status === 'failed') {
          db.prepare("UPDATE scan_jobs SET status = 'new', attempts = 0, message_id = NULL, next_at = NULL WHERE id = ?")
            .run(job.id);
          Object.assign(job, { status: 'new', attempts: 0, message_id: null });
        }
        await step(db, job);
      } catch (err) {
        // Лимит и сетевые сбои — не вина чека: откладываем, а не хороним задание
        const retryable = err.limited || /fetch|network|timeout|abort/i.test(err.message);
        if (retryable && job.attempts < MAX_ATTEMPTS) {
          db.prepare('UPDATE scan_jobs SET attempts = attempts + 1, next_at = ?, error = ?, updated_at = ? WHERE id = ?')
            .run(later(err.limited ? 3600 : 60), String(err.message).slice(0, 400), now(), job.id);
        } else {
          fail(db, job, err.message);
        }
      }
    }
  } finally {
    running = false;
  }
}
