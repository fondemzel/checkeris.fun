package ru.checkeris.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Вся история Озона для мастера. «Электронные чеки» Озона — только последние недели, поэтому
 * историю берём из заказов: «Завершённые» по годам → каждый заказ → его чеки → PDF.
 *
 * Шаг «что нашли» показывает годы с числом заказов (вместо счетов у банков), человек выбирает
 * годы, дальше грузим заказ за заказом. План (номера заказов) и позиция хранятся на телефоне:
 * после обрыва продолжаем с того же заказа. Чеки, которые Чекер уже знает, не скачиваются.
 */
final class OzonHistory {

    private static final String PREFS = "ozon.history";
    private static final long PAUSE = 400; // между заказами — не частим
    private static final int MAX_PAGES = 200;
    private static final Pattern ORDER = Pattern.compile("orderdetails/[?]order=([0-9]+-[0-9]+)");
    private static final Pattern CHEQUE = Pattern.compile("downloadCheque[?]id=([A-Za-z0-9-]+)");

    private static volatile boolean running;
    private static volatile boolean stopRequested;

    private OzonHistory() {}

    static boolean running() {
        return running;
    }

    static void stop() {
        stopRequested = true;
    }

    /**
     * Годы и заказы в них — для шага «что нашли». Номера заказов запоминаем: по ним потом
     * и пойдёт загрузка, второй раз листать список не нужно.
     */
    static JSONObject years(Context context) throws Exception {
        String archive = "/my/orderlist?selectedTab=archive";
        TreeMap<String, List<String>> byYear = new TreeMap<>((a, b) -> b.compareTo(a));
        Set<String> years = new LinkedHashSet<>();
        Matcher y = Pattern.compile("selectedYear=([0-9]{4})").matcher(text(OzonApi.page(archive)));
        while (y.find()) years.add(y.group(1));
        for (String year : years) byYear.put(year, orders(archive + "&selectedYear=" + year));

        JSONObject plan = new JSONObject();
        JSONArray out = new JSONArray();
        for (String year : byYear.keySet()) {
            List<String> list = byYear.get(year);
            if (list.isEmpty()) continue;
            plan.put(year, new JSONArray(list));
            out.put(new JSONObject().put("id", year).put("name", year).put("type", "shopYear").put("count", list.size()));
        }
        prefs(context).edit().putString("byYear", plan.toString()).apply();
        Trace.log("ozon история: годы " + byYear.keySet());
        return new JSONObject().put("bank", "ozon").put("accounts", out);
    }

    /** Номера заказов списка — со всех его страниц. */
    private static List<String> orders(String url) throws Exception {
        LinkedHashSet<String> found = new LinkedHashSet<>();
        Set<String> visited = new java.util.HashSet<>();
        int idle = 0;
        for (int i = 0; url != null && i < MAX_PAGES && visited.add(url); i++) {
            JSONObject page = OzonApi.page(url);
            int before = found.size();
            Matcher m = ORDER.matcher(text(page));
            while (m.find()) found.add(m.group(1));
            idle = found.size() > before ? 0 : idle + 1;
            String next = null;
            JSONObject states = page.optJSONObject("widgetStates");
            Iterator<String> keys = states == null ? null : states.keys();
            while (keys != null && keys.hasNext()) {
                String key = keys.next();
                if (!key.startsWith("paginator")) continue;
                String candidate = new JSONObject(states.optString(key)).optString("nextPage", "");
                if (candidate.startsWith("/my/orderlist")) next = candidate;
            }
            Trace.log("ozon заказы " + url + ": +" + (found.size() - before) + ", дальше " + next);
            url = idle >= 2 ? null : next;
            Thread.sleep(PAUSE);
        }
        return new ArrayList<>(found);
    }

    /** Текст ответа со всеми состояниями виджетов — в них ссылки на заказы и чеки. */
    private static String text(JSONObject page) {
        StringBuilder out = new StringBuilder();
        JSONObject states = page.optJSONObject("widgetStates");
        Iterator<String> keys = states == null ? null : states.keys();
        while (keys != null && keys.hasNext()) out.append(states.optString(keys.next())).append('\n');
        return out.toString();
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

    /** Запуск. selected — годы: начать сначала по ним; пусто — продолжить с прежнего заказа. */
    static void start(Context context, String checkerToken, String selected, SberHistory.Listener listener) {
        if (running) return;
        running = true;
        stopRequested = false;
        new Thread(() -> {
            try {
                if (selected != null && !selected.isEmpty()) plan(context, new JSONArray(selected));
                load(context, checkerToken, listener);
            } catch (Exception e) {
                emit(listener, event("error", String.valueOf(e.getMessage())));
            } finally {
                running = false;
            }
        }).start();
    }

    /** План загрузки: заказы выбранных лет по порядку, от свежих к старым. */
    private static void plan(Context context, JSONArray years) throws Exception {
        SharedPreferences prefs = prefs(context);
        JSONObject byYear = new JSONObject(prefs.getString("byYear", "{}"));
        JSONArray plan = new JSONArray();
        for (int i = 0; i < years.length(); i++) {
            String year = years.getString(i);
            JSONArray orders = byYear.optJSONArray(year);
            for (int j = 0; orders != null && j < orders.length(); j++) {
                plan.put(new JSONObject().put("order", orders.getString(j)).put("year", year));
            }
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
        Set<String> seen = OzonSync.known(token);
        long started = System.currentTimeMillis();

        while (!stopRequested && offset < plan.length()) {
            JSONObject step = plan.getJSONObject(offset);
            String order = step.getString("order");
            emit(listener, progress("load", added, offset, plan.length(), order, step.optString("year"), started));
            List<String> ids = cheques(order);
            Trace.log("ozon история: заказ " + order + " → чеков " + ids.size());
            for (String id : ids) {
                if (!seen.add(id)) {
                    known++;
                    continue;
                }
                try {
                    JSONObject res = OzonSync.send(token, id, OzonApi.download(id));
                    if (res.optBoolean("created")) added++;
                    else known++;
                } catch (Exception e) {
                    Trace.log("ozon история: чек " + id + " не принят: " + e.getMessage());
                }
            }
            offset++;
            prefs.edit().putInt("offset", offset).putLong("added", added).putLong("known", known).apply();
            Thread.sleep(PAUSE);
        }
        if (stopRequested) {
            emit(listener, progress("stopped", added, offset, plan.length(), null, null, started));
            return;
        }
        prefs.edit().putBoolean("finished", true).apply();
        JSONObject done = progress("loaded", added, offset, plan.length(), null, null, started);
        emit(listener, done.put("known", known).put("orders", plan.length()));
    }

    /**
     * Чеки заказа. Страница «Чеки по заказу» открывается по номеру заказа; если Озону нужен
     * ещё и внутренний номер, берём ссылку на неё из «Подробнее о заказе».
     */
    private static List<String> cheques(String order) throws Exception {
        List<String> ids = find(text(OzonApi.page("/my/orderReceipts/?order=" + order)), CHEQUE);
        if (!ids.isEmpty()) return ids;
        String more = first(text(OzonApi.page("/my/orderdetails/?order=" + order)), "/my/orderDetailsMore[?][^\"]+");
        if (more == null) return ids;
        String receipts = first(text(OzonApi.page(more)), "/my/orderReceipts/[?][^\"]+");
        return receipts == null ? ids : find(text(OzonApi.page(receipts)), CHEQUE);
    }

    private static List<String> find(String text, Pattern pattern) {
        LinkedHashSet<String> out = new LinkedHashSet<>();
        Matcher m = pattern.matcher(text);
        while (m.find()) out.add(m.group(1));
        return new ArrayList<>(out);
    }

    private static String first(String text, String regex) {
        Matcher m = Pattern.compile(regex).matcher(text.replace("\\u0026", "&"));
        return m.find() ? m.group() : null;
    }

    /** Ход загрузки: done/total — в заказах; ops — сколько чеков добавилось. */
    private static JSONObject progress(String stage, long added, int done, int total, String order, String year, long started)
            throws Exception {
        JSONObject p = new JSONObject()
                .put("stage", stage)
                .put("ops", added)
                .put("added", added)
                .put("done", done)
                .put("total", total)
                .put("runStart", started);
        if (order != null) p.put("account", "заказ " + order).put("year", year);
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
