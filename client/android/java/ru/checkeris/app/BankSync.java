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

    static final String TOKEN = "checker.token"; // токен Чекера: фоновой работе он нужен без открытой страницы
    static final String EXPIRED = "tbank.expired"; // банк отказал: нужен новый вход руками

    private static final String CHECKER = "https://checkeris.fun/api/bank/ops";
    private static final String LAST_SYNC = "tbank.lastSync";
    private static final long FIRST_DAYS = 90L * 24 * 3600 * 1000;
    private static final long OVERLAP = 3L * 24 * 3600 * 1000; // операции «в обработке» меняются задним числом
    private static final BankAdapter ADAPTER = new TBankAdapter();
    private static final int BATCH = 150; // операция с полным ответом банка весит килобайты — шлём пачками

    /** Итог для показа человеку: сколько операций новых и сколько всего проверили. */
    static final class Result {
        final boolean ok;
        final int added;
        final int seen;
        final String error;

        Result(boolean ok, int added, int seen, String error) {
            this.ok = ok;
            this.added = added;
            this.seen = seen;
            this.error = error;
        }

        JSONObject json() throws Exception {
            return new JSONObject()
                    .put("ok", ok)
                    .put("ops", added)
                    .put("seen", seen)
                    .put("error", error == null ? JSONObject.NULL : error);
        }
    }

    static boolean connected(Context context) {
        return new Secrets(context).get(BankLoginActivity.SESSION) != null;
    }

    /** Банк подключён, но просит войти заново: сессию не выбрасываем, чтобы не пугать «не подключён». */
    static boolean expired(Context context) {
        return "1".equals(new Secrets(context).get(EXPIRED));
    }

    static void forget(Context context) {
        Secrets secrets = new Secrets(context);
        secrets.put(BankLoginActivity.SESSION, null);
        secrets.put(EXPIRED, null);
    }

    /** Короткое обращение к банку: держит сессию живой. Только в фоновом потоке. */
    static void ping(Context context) {
        Secrets secrets = new Secrets(context);
        String session = secrets.get(BankLoginActivity.SESSION);
        if (session == null) return;
        int state = TBank.check(session);
        if (state == TBank.ALIVE) secrets.put(EXPIRED, null);
        else if (state == TBank.EXPIRED) secrets.put(EXPIRED, "1");
    }

    /** Забрать новые операции и отдать их Чекеру. Вызывать только в фоновом потоке. */
    static Result run(Context context, String checkerToken) {
        Secrets secrets = new Secrets(context);
        String session = secrets.get(BankLoginActivity.SESSION);
        if (session == null) return new Result(false, 0, 0, "Т-Банк не подключён");

        int state = TBank.check(session);
        Trace.log("tbank обновление: сессия " + Trace.mark(session) + " → " + state);
        if (state == TBank.OFFLINE) return new Result(false, 0, 0, "Банк не отвечает — попробуйте позже");
        if (state == TBank.EXPIRED) {
            // Подключение остаётся, но нужен новый вход: стирать сессию и показывать
            // «не подключён» нечестно — человек-то банк подключал
            secrets.put(EXPIRED, "1");
            return new Result(false, 0, 0, "Банк просит войти заново");
        }
        secrets.put(EXPIRED, null);

        // История грузится тем же банком: лишние запросы рядом с ней упрутся в лимит
        if (BankHistory.running()) return new Result(false, 0, 0, "Идёт загрузка истории — обновим после неё");

        long last = secrets.getLong(LAST_SYNC, 0);
        long since = last > 0 ? last - OVERLAP : System.currentTimeMillis() - FIRST_DAYS;

        try {
            JSONArray accounts = TBank.accounts(session);
            java.util.Set<String> off = disabledAccounts(checkerToken);
            JSONArray all = new JSONArray();
            for (int i = 0; i < accounts.length(); i++) {
                JSONObject account = accounts.getJSONObject(i);
                String id = account.optString("id");
                if (id.isEmpty() || off.contains(id)) continue; // счёт, который человек выключил
                JSONArray ops = TBank.operations(session, id, since);
                for (int j = 0; j < ops.length(); j++) {
                    // Только нужные поля: полный ответ банка в пять раз тяжелее. Имя счёта — чтобы
                    // в Чекере было видно, по какой карте
                    all.put(ADAPTER.trim(ops.getJSONObject(j), account.optString("name")));
                }
            }
            int added = 0;
            for (int from = 0; from < all.length(); from += BATCH) {
                JSONArray batch = new JSONArray();
                for (int i = from; i < Math.min(from + BATCH, all.length()); i++) batch.put(all.get(i));
                added += send(checkerToken, "tbank", batch, false);
            }
            secrets.putLong(LAST_SYNC, System.currentTimeMillis());
            return new Result(true, added, all.length(), null);
        } catch (Exception e) {
            return new Result(false, 0, 0, String.valueOf(e.getMessage()));
        }
    }

    /**
     * Счета, которые человек выключил в Чекере: их операции не качаем. Не ответил сервер —
     * качаем всё: лишнее он всё равно не примет.
     */
    static java.util.Set<String> disabledAccounts(String token) {
        java.util.Set<String> off = new java.util.HashSet<>();
        JSONArray list = accounts(token, "tbank");
        for (int i = 0; i < list.length(); i++) {
            JSONObject a = list.optJSONObject(i);
            if (a != null && !a.optBoolean("enabled", true)) off.add(a.optString("id"));
        }
        return off;
    }

    /**
     * Что Чекер знает о счетах банка: выбор человека и докуда история уже загружена
     * (поле first). Нужно, чтобы повторная выгрузка не качала заново то, что уже есть.
     * Сервер не ответил — вернём пусто, и выгрузка пойдёт как в первый раз.
     */
    static JSONArray accounts(String token, String bank) {
        try {
            String url = "https://checkeris.fun/api/bank/accounts?bank=" + java.net.URLEncoder.encode(bank, "UTF-8");
            HttpURLConnection http = (HttpURLConnection) new URL(url).openConnection();
            http.setRequestProperty("Authorization", "Bearer " + token);
            http.setConnectTimeout(15000);
            http.setReadTimeout(30000);
            int code = http.getResponseCode();
            String answer = TBank.read(code >= 400 ? http.getErrorStream() : http.getInputStream());
            http.disconnect();
            if (code >= 400) return new JSONArray();
            JSONArray list = new JSONObject(answer).optJSONArray("accounts");
            return list == null ? new JSONArray() : list;
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /** Время из Чекера («2026-09-28T19:37:33», московское) в миллисекунды. 0 — пусто. */
    static long millis(String at) {
        if (at == null || at.length() < 19) return 0;
        try {
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US);
            f.setTimeZone(java.util.TimeZone.getTimeZone("Europe/Moscow"));
            return f.parse(at.substring(0, 19)).getTime();
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * Отправить пачку в Чекер и узнать, сколько операций там оказались новыми.
     * defer — не размечать после пачки: при загрузке истории разметка одна, в конце.
     */
    static int send(String token, String bank, JSONArray ops, boolean defer) throws Exception {
        JSONObject body = new JSONObject().put("bank", bank).put("ops", ops).put("defer", defer);
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
        return new JSONObject(answer).optInt("added");
    }
}
