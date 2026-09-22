package ru.checkeris.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Выгрузка операций: телефон спрашивает банк и отправляет готовые операции в Чекер.
 *
 * Почему на телефоне, а не на сервере: сессия банка живёт здесь и никуда не уходит,
 * а страница в браузере обратиться к банку не может — это запрещает сам браузер.
 */
final class BankSync {

    private static final String CHECKER = "https://checkeris.fun/api/bank/ops";
    private static final String LAST_SYNC = "tbank.lastSync";
    private static final long FIRST_DAYS = 90L * 24 * 3600 * 1000;
    private static final long OVERLAP = 3L * 24 * 3600 * 1000; // операции «в обработке» меняются задним числом
    private static final int BATCH = 150; // операция с полным ответом банка весит килобайты — шлём пачками

    /** Итог для показа человеку. */
    static final class Result {
        final boolean ok;
        final int ops;
        final String error;

        Result(boolean ok, int ops, String error) {
            this.ok = ok;
            this.ops = ops;
            this.error = error;
        }

        JSONObject json() throws Exception {
            return new JSONObject().put("ok", ok).put("ops", ops).put("error", error == null ? JSONObject.NULL : error);
        }
    }

    static boolean connected(Context context) {
        return new Secrets(context).get(BankLoginActivity.SESSION) != null;
    }

    static void forget(Context context) {
        new Secrets(context).put(BankLoginActivity.SESSION, null);
    }

    /** Забрать новые операции и отдать их Чекеру. Вызывать только в фоновом потоке. */
    static Result run(Context context, String checkerToken) {
        Secrets secrets = new Secrets(context);
        String session = secrets.get(BankLoginActivity.SESSION);
        if (session == null) return new Result(false, 0, "Т-Банк не подключён");
        if (!TBank.alive(session)) {
            secrets.put(BankLoginActivity.SESSION, null);
            return new Result(false, 0, "Сессия Т-Банка истекла — войдите заново");
        }

        long last = secrets.getLong(LAST_SYNC, 0);
        long since = last > 0 ? last - OVERLAP : System.currentTimeMillis() - FIRST_DAYS;

        try {
            JSONArray accounts = TBank.accounts(session);
            JSONArray all = new JSONArray();
            for (int i = 0; i < accounts.length(); i++) {
                JSONObject account = accounts.getJSONObject(i);
                String id = account.optString("id");
                if (id.isEmpty()) continue;
                JSONArray ops = TBank.operations(session, id, since);
                for (int j = 0; j < ops.length(); j++) {
                    JSONObject op = ops.getJSONObject(j);
                    op.put("accountName", account.optString("name")); // чтобы в Чекере было видно, по какой карте
                    all.put(op);
                }
            }
            for (int from = 0; from < all.length(); from += BATCH) {
                JSONArray batch = new JSONArray();
                for (int i = from; i < Math.min(from + BATCH, all.length()); i++) batch.put(all.get(i));
                send(checkerToken, batch);
            }
            secrets.putLong(LAST_SYNC, System.currentTimeMillis());
            return new Result(true, all.length(), null);
        } catch (Exception e) {
            return new Result(false, 0, String.valueOf(e.getMessage()));
        }
    }

    private static void send(String token, JSONArray ops) throws Exception {
        JSONObject body = new JSONObject().put("bank", "tbank").put("ops", ops);
        HttpURLConnection http = (HttpURLConnection) new URL(CHECKER).openConnection();
        http.setRequestMethod("POST");
        http.setRequestProperty("Content-Type", "application/json");
        http.setRequestProperty("Authorization", "Bearer " + token);
        http.setDoOutput(true);
        http.setConnectTimeout(15000);
        http.setReadTimeout(60000);
        try (OutputStream out = http.getOutputStream()) {
            out.write(body.toString().getBytes("UTF-8"));
        }
        int code = http.getResponseCode();
        String answer = TBank.read(code >= 400 ? http.getErrorStream() : http.getInputStream());
        http.disconnect();
        if (code >= 400) throw new IllegalStateException("Чекер: " + answer);
    }
}
