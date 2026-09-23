package ru.checkeris.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * Вся история операций банка: кусками «счёт × год», от открытия счёта до сегодня.
 *
 * Что выяснила разведка у Т-Банка: год одним запросом банк отдаёт целиком (до 7 МБ),
 * а на частые запросы отвечает «превышен лимит». Поэтому между кусками пауза, а на отказ —
 * ожидание 30, 60, 120, 240 с и повтор.
 *
 * План и отметки о готовых кусках лежат на телефоне: закрыли приложение, пропала сеть,
 * банк попросил войти заново — следующий запуск продолжит с того же места.
 * Разметку (чеки, переводы, категории) делает сервер один раз в конце: страница зовёт
 * /api/bank/history/finish, когда придёт «loaded».
 */
final class BankHistory {

    interface Listener {
        void event(JSONObject event);
    }

    private static final String PREFS = "bank.history";
    private static final long PAUSE = 5000;
    private static final int[] WAITS = {30, 60, 120, 240};
    private static final int BATCH = 500; // сокращённая операция — меньше килобайта
    private static final long MONTH = 31L * 24 * 3600 * 1000;

    private static volatile boolean running;
    private static volatile boolean stopRequested;

    private BankHistory() {}

    static boolean running() {
        return running;
    }

    static void stop() {
        stopRequested = true;
    }

    /** Счета банка — для шага «что нашли»: название, тип, с какого года, сколько кусков. */
    static JSONObject accounts(Context context, BankAdapter bank) throws Exception {
        String session = new Secrets(context).get(BankLoginActivity.SESSION);
        if (session == null) throw new IllegalStateException("Банк не подключён");
        JSONArray accounts = bank.accounts(session);
        int thisYear = Calendar.getInstance().get(Calendar.YEAR);
        for (int i = 0; i < accounts.length(); i++) {
            JSONObject a = accounts.getJSONObject(i);
            a.put("years", thisYear - firstYear(a.optLong("created")) + 1);
        }
        return new JSONObject().put("bank", bank.id()).put("accounts", accounts);
    }

    /** Где мы: для страницы, открытой посреди загрузки или после перерыва. */
    static JSONObject status(Context context) {
        SharedPreferences prefs = prefs(context);
        try {
            JSONArray plan = new JSONArray(prefs.getString("plan", "[]"));
            return new JSONObject()
                    .put("running", running)
                    .put("total", plan.length())
                    .put("done", countDone(plan))
                    .put("ops", prefs.getLong("ops", 0))
                    .put("added", prefs.getLong("added", 0))
                    .put("bytes", prefs.getLong("bytes", 0))
                    .put("startedAt", prefs.getLong("startedAt", 0));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /**
     * Запуск. selected — id счетов (JSON-массив): составить план заново; null — продолжить
     * прежний. Работает в фоновом потоке, ход сообщает событиями.
     */
    static void start(Context context, BankAdapter bank, String checkerToken, String selected, Listener listener) {
        if (running) return;
        running = true;
        stopRequested = false;
        new Thread(() -> {
            try {
                if (selected != null) makePlan(context, bank, new JSONArray(selected));
                load(context, bank, checkerToken, listener);
            } catch (Exception e) {
                try {
                    emit(listener, event("error").put("error", String.valueOf(e.getMessage())));
                } catch (Exception ignored) {
                    // событие не собралось — показать нечего
                }
            } finally {
                running = false;
            }
        }).start();
    }

    private static void makePlan(Context context, BankAdapter bank, JSONArray selected) throws Exception {
        JSONArray accounts = accounts(context, bank).getJSONArray("accounts");
        JSONArray plan = new JSONArray();
        int thisYear = Calendar.getInstance().get(Calendar.YEAR);
        long now = System.currentTimeMillis();
        for (int i = 0; i < accounts.length(); i++) {
            JSONObject a = accounts.getJSONObject(i);
            if (!contains(selected, a.getString("id"))) continue;
            long created = a.optLong("created");
            // Свежие годы — первыми: человек сразу видит знакомые операции
            for (int year = thisYear; year >= firstYear(created); year--) {
                long from = Math.max(yearStart(year), created > 0 ? created - 24L * 3600 * 1000 : 0);
                long to = Math.min(yearStart(year + 1) - 1, now);
                plan.put(new JSONObject()
                        .put("account", a.getString("id")).put("name", a.optString("name"))
                        .put("year", year).put("from", from).put("to", to).put("done", false));
            }
        }
        prefs(context).edit()
                .putString("plan", plan.toString())
                .putLong("ops", 0).putLong("added", 0).putLong("bytes", 0)
                .putLong("startedAt", now)
                .apply();
    }

    private static void load(Context context, BankAdapter bank, String token, Listener listener) throws Exception {
        SharedPreferences prefs = prefs(context);
        JSONArray plan = new JSONArray(prefs.getString("plan", "[]"));
        Secrets secrets = new Secrets(context);
        boolean first = true;

        for (int i = 0; i < plan.length(); i++) {
            JSONObject task = plan.getJSONObject(i);
            if (task.optBoolean("done")) continue;
            if (stopRequested) {
                emit(listener, progress(context, plan, task).put("stage", "stopped"));
                return;
            }
            String session = secrets.get(BankLoginActivity.SESSION);
            if (session == null) throw new IllegalStateException("Банк не подключён");
            if (!first) Thread.sleep(PAUSE);
            first = false;
            emit(listener, progress(context, plan, task));

            JSONArray ops = fetch(bank, session, task, task.getLong("from"), task.getLong("to"), listener);
            if (ops == null) {
                emit(listener, progress(context, plan, task).put("stage", "stopped"));
                return;
            }

            long bytes = 0;
            int added = 0;
            for (int from = 0; from < ops.length(); from += BATCH) {
                JSONArray batch = new JSONArray();
                for (int j = from; j < Math.min(from + BATCH, ops.length()); j++) {
                    batch.put(bank.trim(ops.getJSONObject(j), task.optString("name")));
                }
                String body = batch.toString();
                bytes += body.length();
                added += BankSync.send(token, bank.id(), batch, true);
            }
            task.put("done", true).put("ops", ops.length());
            prefs.edit()
                    .putString("plan", plan.toString())
                    .putLong("ops", prefs.getLong("ops", 0) + ops.length())
                    .putLong("added", prefs.getLong("added", 0) + added)
                    .putLong("bytes", prefs.getLong("bytes", 0) + bytes)
                    .apply();
        }
        emit(listener, progress(context, plan, null).put("stage", "loaded"));
    }

    /**
     * Кусок операций с повторами на «превышен лимит». Не хватило памяти на год —
     * делим период пополам. null — человек остановил загрузку, пока ждали.
     */
    private static JSONArray fetch(BankAdapter bank, String session, JSONObject task, long from, long to,
            Listener listener) throws Exception {
        for (int attempt = 0; ; attempt++) {
            try {
                return bank.operations(session, task.getString("account"), from, to);
            } catch (BankAdapter.RateLimited e) {
                if (attempt == WAITS.length) throw new IllegalStateException("Банк не отвечает на частые запросы — продолжим позже");
                emit(listener, event("wait").put("seconds", WAITS[attempt]));
                for (int s = 0; s < WAITS[attempt]; s++) {
                    if (stopRequested) return null;
                    Thread.sleep(1000);
                }
            } catch (OutOfMemoryError e) {
                if (to - from < MONTH) throw new IllegalStateException("Слишком много операций за месяц");
                long middle = from + (to - from) / 2;
                JSONArray first = fetch(bank, session, task, from, middle, listener);
                if (first == null) return null;
                JSONArray second = fetch(bank, session, task, middle + 1, to, listener);
                if (second == null) return null;
                for (int i = 0; i < second.length(); i++) first.put(second.get(i));
                return first;
            }
        }
    }

    private static JSONObject progress(Context context, JSONArray plan, JSONObject task) throws Exception {
        SharedPreferences prefs = prefs(context);
        JSONObject e = event("load")
                .put("total", plan.length())
                .put("done", countDone(plan))
                .put("ops", prefs.getLong("ops", 0))
                .put("added", prefs.getLong("added", 0))
                .put("bytes", prefs.getLong("bytes", 0))
                .put("startedAt", prefs.getLong("startedAt", 0));
        if (task != null) e.put("account", task.optString("name")).put("year", task.optInt("year"));
        return e;
    }

    private static JSONObject event(String stage) throws Exception {
        return new JSONObject().put("stage", stage);
    }

    private static void emit(Listener listener, JSONObject event) {
        try {
            listener.event(event);
        } catch (Exception ignored) {
            // страница закрыта — показывать некому, загрузка идёт дальше
        }
    }

    private static int countDone(JSONArray plan) {
        int n = 0;
        for (int i = 0; i < plan.length(); i++) if (plan.optJSONObject(i).optBoolean("done")) n++;
        return n;
    }

    private static boolean contains(JSONArray ids, String id) {
        for (int i = 0; i < ids.length(); i++) if (id.equals(ids.optString(i))) return true;
        return false;
    }

    private static int firstYear(long created) {
        Calendar c = Calendar.getInstance();
        if (created > 0) c.setTimeInMillis(created);
        return c.get(Calendar.YEAR);
    }

    private static long yearStart(int year) {
        Calendar c = Calendar.getInstance();
        c.clear();
        c.set(year, 0, 1, 0, 0, 0);
        return c.getTimeInMillis();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
