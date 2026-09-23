package ru.checkeris.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Calendar;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.TreeMap;

/**
 * Разведка перед загрузкой всей истории: как глубоко банк отдаёт операции, режет ли
 * длинные периоды, видны ли закрытые счета и из каких полей состоит операция.
 *
 * Ничего не импортирует: отчёт уходит на сервер отдельным файлом для разбора.
 * Запросы идут с паузой — банк не должен принять это за атаку.
 */
final class BankProbe {

    interface Progress {
        void step(String text);
    }

    private static final String CHECKER = "https://checkeris.fun/api/bank/probe";
    private static final int[] MONTHS_AGO = {0, 3, 6, 12, 18, 24, 36, 48, 60, 72, 84, 96, 120, 144, 180};
    private static final long PAUSE = 700;
    private static final int SAMPLES = 30;

    static JSONObject run(Context context, String checkerToken, Progress progress) {
        JSONObject report = new JSONObject();
        try {
            String session = new Secrets(context).get(BankLoginActivity.SESSION);
            if (session == null) return report.put("error", "Т-Банк не подключён");
            report.put("app", BuildInfo.VERSION).put("at", System.currentTimeMillis());

            progress.step("Счета…");
            JSONArray accounts = TBank.accounts(session);
            report.put("accounts", accounts);

            // Может быть, закрытые счета банк отдаёт другим методом
            JSONObject extra = new JSONObject();
            for (String method : new String[] {"accounts_flat", "grouped_requisites"}) {
                extra.put(method, attempt(session, method, null));
                Thread.sleep(PAUSE);
            }
            report.put("otherMethods", extra);

            TreeMap<String, Object[]> fields = new TreeMap<>(); // путь → {сколько раз, пример}
            JSONArray samples = new JSONArray();
            Set<String> sampleKinds = new HashSet<>();
            JSONArray probes = new JSONArray();
            String busiest = null;
            int busiestCount = -1;

            for (int a = 0; a < accounts.length(); a++) {
                JSONObject account = accounts.getJSONObject(a);
                String id = account.optString("id");
                if (id.isEmpty()) continue;
                for (int ago : MONTHS_AGO) {
                    progress.step("Счёт " + (a + 1) + " из " + accounts.length() + ": " + ago + " мес. назад");
                    long[] span = month(ago, 1);
                    JSONObject probe = fetch(session, id, span[0], span[1]);
                    probe.put("account", id).put("monthsAgo", ago).put("span", "month");
                    JSONArray ops = (JSONArray) probe.remove("ops");
                    if (ops != null) {
                        collect(ops, fields, samples, sampleKinds);
                        if (ago == 0 && ops.length() > busiestCount) {
                            busiestCount = ops.length();
                            busiest = id;
                        }
                    }
                    probes.put(probe);
                    Thread.sleep(PAUSE);
                }
            }

            // Режет ли банк длинный период: год одним запросом против того же года по месяцам
            JSONObject range = new JSONObject();
            if (busiest != null) {
                progress.step("Проверяем длинный период…");
                long[] year = month(24, 12);
                JSONObject whole = fetch(session, busiest, year[0], year[1]);
                JSONArray wholeOps = (JSONArray) whole.remove("ops");
                range.put("account", busiest).put("yearAtOnce", whole)
                        .put("yearAtOnceCount", wholeOps == null ? -1 : wholeOps.length());
                Thread.sleep(PAUSE);
                int sum = 0;
                for (int m = 0; m < 12; m++) {
                    long[] span = month(24 - m, 1);
                    JSONObject part = fetch(session, busiest, span[0], span[1]);
                    JSONArray partOps = (JSONArray) part.remove("ops");
                    sum += partOps == null ? 0 : partOps.length();
                    Thread.sleep(PAUSE);
                }
                range.put("yearByMonthsCount", sum);
            }
            report.put("range", range);
            report.put("probes", probes);

            JSONObject inventory = new JSONObject();
            for (String path : fields.keySet()) {
                Object[] f = fields.get(path);
                inventory.put(path, new JSONObject().put("n", f[0]).put("example", f[1]));
            }
            report.put("fields", inventory);
            report.put("samples", samples);
        } catch (Exception e) {
            try {
                report.put("error", String.valueOf(e));
            } catch (Exception ignored) {
                // отчёт без ошибки — тоже отчёт
            }
        }

        try {
            progress.step("Отправляем отчёт…");
            send(checkerToken, report);
        } catch (Exception e) {
            try {
                report.put("sendError", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
                // ничего
            }
        }
        return report;
    }

    /** Начало месяца `ago` назад и конец через `length` месяцев, в миллисекундах. */
    private static long[] month(int ago, int length) {
        Calendar c = Calendar.getInstance();
        c.set(Calendar.DAY_OF_MONTH, 1);
        c.set(Calendar.HOUR_OF_DAY, 0);
        c.set(Calendar.MINUTE, 0);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        c.add(Calendar.MONTH, -ago);
        long start = c.getTimeInMillis();
        c.add(Calendar.MONTH, length);
        return new long[] {start, Math.min(c.getTimeInMillis() - 1, System.currentTimeMillis())};
    }

    private static JSONObject fetch(String session, String account, long start, long end) throws Exception {
        JSONObject probe = new JSONObject().put("start", start).put("end", end);
        long t = System.currentTimeMillis();
        try {
            String body = TBank.body(session, "operations",
                    "&account=" + java.net.URLEncoder.encode(account, "UTF-8") + "&start=" + start + "&end=" + end);
            probe.put("ms", System.currentTimeMillis() - t).put("bytes", body.length());
            JSONObject json = new JSONObject(body);
            probe.put("result", json.optString("resultCode"));
            Object payload = json.opt("payload");
            if (payload instanceof JSONArray) {
                JSONArray ops = (JSONArray) payload;
                probe.put("count", ops.length());
                long min = Long.MAX_VALUE;
                long max = 0;
                for (int i = 0; i < ops.length(); i++) {
                    long at = ops.getJSONObject(i).optJSONObject("operationTime") == null
                            ? 0 : ops.getJSONObject(i).getJSONObject("operationTime").optLong("milliseconds");
                    if (at > 0) {
                        min = Math.min(min, at);
                        max = Math.max(max, at);
                    }
                }
                if (max > 0) probe.put("first", min).put("last", max);
                probe.put("ops", ops);
            } else {
                probe.put("message", json.optString("errorMessage", json.optString("plainMessage")));
            }
        } catch (Exception e) {
            probe.put("ms", System.currentTimeMillis() - t).put("error", String.valueOf(e));
        }
        return probe;
    }

    private static JSONObject attempt(String session, String method, String query) throws Exception {
        JSONObject out = new JSONObject();
        try {
            String body = TBank.body(session, method, query);
            out.put("bytes", body.length()).put("body", body.length() > 20000 ? body.substring(0, 20000) : body);
        } catch (Exception e) {
            out.put("error", String.valueOf(e));
        }
        return out;
    }

    /** Все пути полей с примером значения и примеры операций разных видов. */
    private static void collect(JSONArray ops, TreeMap<String, Object[]> fields, JSONArray samples, Set<String> kinds)
            throws Exception {
        for (int i = 0; i < ops.length(); i++) {
            JSONObject op = ops.getJSONObject(i);
            walk("", op, fields);
            String kind = op.optString("type") + "|" + op.optString("group") + "|"
                    + op.optString("subgroup", op.optJSONObject("subgroup") == null ? "" : op.getJSONObject("subgroup").optString("id"));
            if (samples.length() < SAMPLES && kinds.add(kind)) samples.put(op);
        }
    }

    private static void walk(String prefix, Object value, TreeMap<String, Object[]> fields) throws Exception {
        if (value instanceof JSONObject) {
            JSONObject obj = (JSONObject) value;
            Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                walk(prefix.isEmpty() ? key : prefix + "." + key, obj.get(key), fields);
            }
            return;
        }
        if (value instanceof JSONArray) {
            JSONArray arr = (JSONArray) value;
            if (arr.length() == 0) {
                note(prefix + "[]", "[]", fields);
                return;
            }
            for (int i = 0; i < arr.length(); i++) walk(prefix + "[]", arr.get(i), fields);
            return;
        }
        String text = String.valueOf(value);
        note(prefix, text.length() > 80 ? text.substring(0, 80) : text, fields);
    }

    private static void note(String path, String example, TreeMap<String, Object[]> fields) {
        Object[] f = fields.get(path);
        if (f == null) fields.put(path, new Object[] {1, example});
        else f[0] = (Integer) f[0] + 1;
    }

    private static void send(String token, JSONObject report) throws Exception {
        HttpURLConnection http = (HttpURLConnection) new URL(CHECKER).openConnection();
        http.setRequestMethod("POST");
        http.setRequestProperty("Content-Type", "application/json");
        http.setRequestProperty("Authorization", "Bearer " + token);
        http.setDoOutput(true);
        http.setConnectTimeout(15000);
        http.setReadTimeout(60000);
        try (OutputStream out = http.getOutputStream()) {
            out.write(report.toString().getBytes("UTF-8"));
        }
        int code = http.getResponseCode();
        http.disconnect();
        if (code >= 400) throw new IllegalStateException("Чекер ответил " + code);
    }
}
