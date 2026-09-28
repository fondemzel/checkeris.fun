package ru.checkeris.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Загрузка всей истории Сбера для мастера. У Т-Банка история грузится по счёт×год
 * (BankHistory), а Сбер отдаёт единую историю по всем счетам, поэтому здесь проще: идём
 * страницами по offset при том же to = сейчас, пока операции не кончатся.
 *
 * Общее число операций заранее неизвестно, поэтому в мастере полоса «бежит», а не по
 * процентам. Позиция (offset) хранится на телефоне: после обрыва продолжаем с неё.
 * Выбор счетов сохраняет страница (PUT /api/bank/accounts) — здесь только качаем.
 */
final class SberHistory {

    interface Listener {
        void event(JSONObject event);
    }

    private static final String PREFS = "sber.history";
    private static final int PAGE = 50;
    private static final long PAUSE = 800; // между страницами — не частим

    private static volatile boolean running;
    private static volatile boolean stopRequested;

    private SberHistory() {}

    static boolean running() {
        return running;
    }

    static void stop() {
        stopRequested = true;
    }

    /** Счета для шага «что нашли»: из свежей страницы истории — какие вообще встречаются. */
    static JSONObject accounts(Context context) throws Exception {
        String cookies = new Secrets(context).get(BankLoginActivity.SBER_SESSION);
        if (cookies == null) throw new IllegalStateException("Сбер не подключён");
        JSONArray ops = SberBank.operations(cookies, 0, 50, System.currentTimeMillis());
        Map<String, JSONObject> found = new LinkedHashMap<>();
        for (int i = 0; i < ops.length(); i++) {
            JSONObject op = ops.getJSONObject(i);
            JSONObject billing = op.optJSONObject("billingAmount");
            JSONObject from = op.optJSONObject("fromResource");
            String id = billing != null ? billing.optString("id") : null;
            if (id == null || id.isEmpty()) continue;
            if (found.containsKey(id)) continue;
            String name = billing.optString("name", id);
            String card = from != null ? from.optString("displayedValue", "") : "";
            found.put(id, new JSONObject()
                    .put("id", id)
                    .put("name", name.isEmpty() ? card : name)
                    .put("type", "")
                    .put("currency", "RUB"));
        }
        JSONArray accounts = new JSONArray();
        for (JSONObject a : found.values()) accounts.put(a);
        return new JSONObject().put("bank", "sber").put("accounts", accounts);
    }

    /** Где мы: для страницы, открытой посреди загрузки или после перерыва. */
    static JSONObject status(Context context) {
        SharedPreferences prefs = prefs(context);
        try {
            return new JSONObject()
                    .put("running", running)
                    .put("ops", prefs.getLong("ops", 0))
                    .put("added", prefs.getLong("added", 0))
                    .put("done", prefs.getInt("offset", 0))
                    .put("total", prefs.getInt("total", 0))
                    .put("byOps", true)
                    .put("finished", prefs.getBoolean("finished", false));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /** Запуск. selected не пуст — начать сначала; иначе продолжить с прежнего offset. */
    static void start(Context context, String checkerToken, String selected, Listener listener) {
        if (running) return;
        running = true;
        stopRequested = false;
        new Thread(() -> {
            try {
                if (selected != null && !selected.isEmpty()) reset(context);
                load(context, checkerToken, listener);
            } catch (Exception e) {
                emit(listener, event("error", "error", String.valueOf(e.getMessage())));
            } finally {
                running = false;
            }
        }).start();
    }

    private static void load(Context context, String token, Listener listener) throws Exception {
        SharedPreferences prefs = prefs(context);
        String cookies = new Secrets(context).get(BankLoginActivity.SBER_SESSION);
        if (cookies == null) throw new IllegalStateException("Сбер не подключён");
        // Докуда история уже загружена: повторную выгрузку начинаем оттуда, а не с сегодня —
        // иначе заново качаются тысячи операций, которые сервер всё равно отбросит.
        // В базе пусто (банк отключали и стирали операции) — качаем всё, как в первый раз
        long now = oldestLoaded(token);
        int offset = prefs.getInt("offset", 0);
        long ops = prefs.getLong("ops", 0);
        long added = prefs.getLong("added", 0);

        // Сколько всего операций — нащупываем один раз перед загрузкой, ради честной полосы.
        // Не получилось (банк отказал на пробах) — грузим без процентов, как раньше
        int total = prefs.getInt("total", 0);
        if (total == 0) {
            emit(listener, event("count", "stage", "count"));
            try {
                total = SberBank.count(cookies, now);
                prefs.edit().putInt("total", total).apply();
            } catch (Exception e) {
                total = 0;
            }
        }

        while (!stopRequested) {
            JSONArray page = SberBank.operations(cookies, offset, PAGE, now);
            if (page.length() == 0) break;
            added += BankSync.send(token, "sber", page, true);
            offset += page.length();
            ops += page.length();
            prefs.edit().putInt("offset", offset).putLong("ops", ops).putLong("added", added).apply();
            emit(listener, progress("load", ops, added, offset, total));
            if (page.length() < PAGE) break; // история кончилась
            Thread.sleep(PAUSE);
        }
        if (stopRequested) {
            emit(listener, progress("stopped", ops, added, offset, total));
            return;
        }
        prefs.edit().putBoolean("finished", true).apply();
        emit(listener, progress("loaded", ops, added, offset, total));
    }

    /**
     * Правая граница выгрузки: самая старая уже загруженная операция минус секунда.
     * Операции в Чекер приходят от свежих к старым, поэтому загруженное — это всегда
     * «хвост от сегодня», и продолжать надо ровно с его конца. Пусто — берём с сегодня.
     */
    private static long oldestLoaded(String token) {
        long oldest = 0;
        JSONArray accounts = BankSync.accounts(token, "sber");
        for (int i = 0; i < accounts.length(); i++) {
            JSONObject a = accounts.optJSONObject(i);
            if (a == null || !a.optBoolean("enabled", true)) continue;
            long at = BankSync.millis(a.optString("first", null));
            if (at > 0 && (oldest == 0 || at < oldest)) oldest = at;
        }
        return oldest > 0 ? oldest - 1000 : System.currentTimeMillis();
    }

    private static void reset(Context context) {
        prefs(context).edit()
                .putInt("offset", 0).putLong("ops", 0).putLong("added", 0)
                .putInt("total", 0).putBoolean("finished", false)
                .apply();
    }

    /** byOps — считаем в операциях, а не в кусках плана: у Сбера плана нет. */
    private static JSONObject progress(String stage, long ops, long added, int done, int total) throws Exception {
        return new JSONObject()
                .put("stage", stage)
                .put("ops", ops)
                .put("added", added)
                .put("done", done)
                .put("total", total)
                .put("byOps", true);
    }

    private static JSONObject event(String stage, String key, String value) {
        try {
            return new JSONObject().put("stage", stage).put(key, value);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static void emit(Listener listener, JSONObject event) {
        try {
            listener.event(event);
        } catch (Exception ignored) {
            // страница закрыта — загрузка идёт дальше
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
