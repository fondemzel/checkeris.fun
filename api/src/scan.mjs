// Очередь сканирования чеков.
//
// Пользователь наводит камеру, мы получаем строку QR — этого мало: в ней нет позиций,
// только реквизиты. Позиции запрашиваются у ФНС, а обмен там асинхронный, поэтому
// сканирование не может быть мгновенным. Задание кладётся в scan_jobs и живёт в базе:
// перезапуск сервиса ничего не теряет.
//
// Состояния: new → sent → done | failed.
//
// Опрос идёт с нарастающей паузой, потому что суточный лимит обращений к ФНС — 1000
// на всё приложение, и цикл «спрашивать раз в секунду» съел бы его за час.
import { parseQr, requestTicket, fetchTicket, fnsReady, fnsUsage } from './fns.mjs';
import { saveReceipt, importStatements } from './import.mjs';
import { classifyItems } from './classify.mjs';

// Через сколько секунд после отправки спрашивать ответ: сначала часто, дальше реже
const BACKOFF = [3, 5, 10, 20, 40, 60, 120, 300];
const MAX_ATTEMPTS = BACKOFF.length;

const now = () => new Date().toISOString();
const later = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();

/**
 * Приём скана. Возвращает задание — существующее, если этот чек уже приносили:
 * ключ тот же, что у импорта выгрузок, поэтому повтор не создаёт вторую запись.
 */
export function addScan(db, qrText) {
  const qr = parseQr(qrText);
  if (!qr) return { error: 'не похоже на QR чека', status: 400 };

  const existing = db
    .prepare('SELECT * FROM scan_jobs WHERE fiscal_drive = ? AND fiscal_doc = ? AND fiscal_sign = ?')
    .get(qr.fn, qr.fd, qr.fp);
  if (existing) return { job: existing, repeat: true };

  // Чек мог приехать раньше выгрузкой — тогда запрашивать его у ФНС незачем
  const known = db
    .prepare('SELECT id FROM receipts WHERE fiscal_drive = ? AND fiscal_doc = ? AND fiscal_sign = ?')
    .get(qr.fn, qr.fd, qr.fp);

  const stamp = now();
  const info = db
    .prepare(
      `INSERT INTO scan_jobs (qr, fiscal_drive, fiscal_doc, fiscal_sign, total_sum, purchased_at,
                              operation, status, receipt_id, next_at, created_at, updated_at)
       VALUES (:qr, :fn, :fd, :fp, :sum, :date, :type, :status, :receipt, :next, :stamp, :stamp)`,
    )
    .run({
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

export const getScan = (db, id) => db.prepare('SELECT * FROM scan_jobs WHERE id = ?').get(id) ?? null;

export const recentScans = (db, limit = 20) =>
  db.prepare('SELECT * FROM scan_jobs ORDER BY id DESC LIMIT ?').all(Math.min(100, Math.max(1, limit)));

const fail = (db, job, message) =>
  db
    .prepare("UPDATE scan_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
    .run(String(message).slice(0, 400), now(), job.id);

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
    fail(db, job, answer.error ?? 'ФНС вернула пустой ответ');
    return true;
  }

  // ФНС кладёт разобранный чек в content, выгрузка приложения — в document.receipt.
  // Приводим к одному виду и дальше идём общим путём импорта.
  const { rawData, ...content } = answer.ticket.content ?? {};
  const saved = saveReceipt(db, { _id: String(answer.ticket.id ?? ''), receipt: content }, importStatements(db));
  if (!saved?.id) {
    fail(db, job, 'чек получен, но не разобрался');
    return true;
  }

  classifyItems(db, saved.itemIds);
  db.prepare("UPDATE scan_jobs SET status = 'done', receipt_id = ?, error = NULL, next_at = NULL, updated_at = ? WHERE id = ?")
    .run(saved.id, now(), job.id);
  return true;
}

let running = false;

/** Проход по заданиям, которым пришло время. Вызывается по таймеру из server.mjs. */
export async function runScanQueue(db) {
  if (running || !fnsReady()) return;
  if (fnsUsage(db).left <= 0) return; // лимит на сегодня выбран, ждём следующих суток

  running = true;
  try {
    const due = db
      .prepare("SELECT * FROM scan_jobs WHERE status IN ('new', 'sent') AND (next_at IS NULL OR next_at <= ?) ORDER BY id LIMIT 5")
      .all(now());

    for (const job of due) {
      try {
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
