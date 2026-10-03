package ru.checkeris.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Set;
import java.util.TreeMap;

/**
 * Вся история Wildberries для мастера. Список «Электронные чеки» у WB — вся история сразу,
 * поэтому шаг «что нашли» листает его целиком (страницы маленькие, это быстро) и показывает
 * годы с числом чеков. Человек выбирает годы, дальше грузим чек за чеком.
 *
 * План (ссылки на чеки) и позиция хранятся на телефоне: после обрыва продолжаем с того же
 * чека. Чеки, которые Чекер уже знает, не скачиваются.
 */
final class WbHistory {

    private static final String PREFS = "wb.history";
    private static final int PER_PAGE = 50;
    private static final int MAX_PAGES = 400;
    private static final long PAUSE = 250; // между чеками — не частим

    private static volatile boolean running;
    private static volatile boolean stopRequested;

    private WbHistory() {}

    static void stop() {
        stopRequested = true;
    }

    /** Годы и чеки в них — для шага «что нашли». Ссылки запоминаем: по ним пойдёт загрузка. */
    static JSONObject years(Context context) throws Exception {
        String token = new Secrets(context).get(WbSync.SESSION);
        if (token == null) throw new IllegalStateException("Wildberries не подключён");
        TreeMap<String, JSONArray> byYear = new TreeMap<>((a, b) -> b.compareTo(a));
        String cursor = "";
        for (int page = 0; page < MAX_PAGES; page++) {
            JSONObject list = WbApi.receipts(token, cursor, PER_PAGE);
            JSONArray receipts = list.optJSONArray("receipts");
            for (int i = 0; receipts != null && i < receipts.length(); i++) {
                JSONObject r = receipts.getJSONObject(i);
                String at = r.optString("operationDateTime");
                String year = at.length() >= 4 ? at.substring(0, 4) : "????";
                if (!byYear.containsKey(year)) byYear.put(year, new JSONArray());
                byYear.get(year).put(new JSONObject()
                        .put("id", r.optString("receiptUid"))
                        .put("link", r.optString("link")));
            }
            cursor = list.optString("nextReceiptUid", "");
            if (cursor.isEmpty() || receipts == null || receipts.length() == 0) break;
        }

        JSONObject plan = new JSONObject();
        JSONArray out = new JSONArray();
        for (String year : byYear.keySet()) {
            JSONArray list = byYear.get(year);
            plan.put(year, list);
            out.put(new JSONObject().put("id", year).put("name", year).put("type", "shopYear").put("count", list.length()));
        }
        prefs(context).edit().putString("byYear", plan.toString()).apply();
        Trace.log("wb история: годы " + byYear.keySet());
        return new JSONObject().put("bank", "wb").put("accounts", out);
    }

    /** Где мы: для страницы, открытой посреди загрузки или после перерыва. */
    static JSONObject status(Context context) {
        SharedPreferences prefs = prefs(context);
        try {
            return new JSONObject()
                    .put("running", running)
                    .put("ops", prefs.getLong("added", 0))
                    .put("added", prefs.getLong("added", 0))
                    .put("done", prefs.getInt("offset", 0))
                    .put("total", prefs.getInt("total", 0))
                    .put("finished", prefs.getBoolean("finished", false));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /** Запуск. selected — годы: начать сначала по ним; пусто — продолжить с прежнего чека. */
    static void start(Context context, String checkerToken, String selected, SberHistory.Listener listener) {
        if (running) return;
        running = true;
        stopRequested = false;
        new Thread(() -> {
            try {
                if (selected != null && !selected.isEmpty()) plan(context, new JSONArray(selected));
                load(context, checkerToken, listener);
            } catch (IllegalStateException e) {
                new Secrets(context).put(WbSync.EXPIRED, "1");
                emit(listener, event("error", e.getMessage()));
            } catch (Exception e) {
                emit(listener, event("error", String.valueOf(e.getMessage())));
            } finally {
                running = false;
            }
        }).start();
    }

    /** План загрузки: чеки выбранных лет по порядку, от свежих к старым. */
    private static void plan(Context context, JSONArray years) throws Exception {
        SharedPreferences prefs = prefs(context);
        JSONObject byYear = new JSONObject(prefs.getString("byYear", "{}"));
        JSONArray plan = new JSONArray();
        for (int i = 0; i < years.length(); i++) {
            String year = years.getString(i);
            JSONArray list = byYear.optJSONArray(year);
            for (int j = 0; list != null && j < list.length(); j++) plan.put(list.getJSONObject(j).put("year", year));
        }
        prefs.edit()
                .putString("plan", plan.toString()).putInt("offset", 0).putInt("total", plan.length())
                .putLong("added", 0).putLong("known", 0).putBoolean("finished", false)
                .apply();
    }

    private static void load(Context context, String token, SberHistory.Listener listener) throws Exception {
        SharedPreferences prefs = prefs(context);
        JSONArray plan = new JSONArray(prefs.getString("plan", "[]"));
        int offset = prefs.getInt("offset", 0);
        long added = prefs.getLong("added", 0);
        long known = prefs.getLong("known", 0);
        Set<String> seen = OzonSync.known("wb", token);
        long started = System.currentTimeMillis();

        while (!stopRequested && offset < plan.length()) {
            JSONObject step = plan.getJSONObject(offset);
            String id = step.getString("id");
            emit(listener, progress("load", added, offset, plan.length(), step.optString("year"), started));
            if (!seen.add(id)) {
                known++;
            } else {
                try {
                    String html = WbApi.receipt(step.getString("link"));
                    JSONObject res = OzonSync.post("wb", token, "/receipts", new JSONObject().put("id", id).put("html", html));
                    if (res.optBoolean("created")) added++;
                    else known++;
                } catch (Exception e) {
                    Trace.log("wb история: чек " + id + " не принят: " + e.getMessage());
                }
                Thread.sleep(PAUSE);
            }
            offset++;
            prefs.edit().putInt("offset", offset).putLong("added", added).putLong("known", known).apply();
        }
        if (stopRequested) {
            emit(listener, progress("stopped", added, offset, plan.length(), null, started));
            return;
        }
        prefs.edit().putBoolean("finished", true).apply();
        emit(listener, progress("loaded", added, offset, plan.length(), null, started).put("known", known));
    }

    /** Ход загрузки: done/total — в чеках; ops — сколько добавилось. */
    private static JSONObject progress(String stage, long added, int done, int total, String year, long started)
            throws Exception {
        JSONObject p = new JSONObject()
                .put("stage", stage)
                .put("ops", added)
                .put("added", added)
                .put("done", done)
                .put("total", total)
                .put("runStart", started);
        if (year != null) p.put("account", "чек " + (done + 1) + " из " + total).put("year", year);
        return p;
    }

    private static JSONObject event(String stage, String error) {
        try {
            return new JSONObject().put("stage", stage).put("error", error);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static void emit(SberHistory.Listener listener, JSONObject event) {
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
