package ru.checkeris.app;

import android.content.Context;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Итог каждого обращения к банку или магазину — серверу Чекера. Иначе о том, что банк просит
 * войти заново или что телефон давно не будит фоновое обновление, знает только сам телефон, а
 * сервер считает подключение живым.
 *
 * Состояния: ok — загрузили; expired — просит войти заново; offline — не отвечает; error —
 * что-то другое; off — человек вышел. background — обращение из фонового задания (по нему
 * видно, будит ли система приложение).
 *
 * Сбой отчёта ничего не ломает: это сведения, а не данные.
 */
final class LinkReport {

    private static final String URL_REPORT = "https://checkeris.fun/api/bank/report";

    private LinkReport() {}

    /** Отчёт об обновлении. expired — подключение после попытки помечено «войти заново». */
    static void send(String token, String bank, BankSync.Result result, boolean expired, boolean background) {
        String state = result.ok ? "ok"
                : expired ? "expired"
                : result.error != null && result.error.contains("не отвечает") ? "offline"
                : "error";
        post(token, bank, state, result.ok ? null : result.error, result.added, background);
    }

    /** Человек вышел из банка или магазина на телефоне. */
    static void off(Context context, String bank) {
        String token = new Secrets(context).get(BankSync.TOKEN);
        if (token == null) return;
        new Thread(() -> post(token, bank, "off", null, 0, false)).start();
    }

    private static void post(String token, String bank, String state, String detail, int added, boolean background) {
        if (token == null) return;
        try {
            JSONObject body = new JSONObject()
                    .put("bank", bank)
                    .put("state", state)
                    .put("detail", detail == null ? JSONObject.NULL : detail)
                    .put("added", added)
                    .put("background", background);
            HttpURLConnection http = (HttpURLConnection) new URL(URL_REPORT).openConnection();
            http.setRequestMethod("POST");
            http.setRequestProperty("Content-Type", "application/json");
            http.setRequestProperty("Authorization", "Bearer " + token);
            http.setDoOutput(true);
            http.setConnectTimeout(15000);
            http.setReadTimeout(15000);
            try (OutputStream out = http.getOutputStream()) {
                out.write(body.toString().getBytes("UTF-8"));
            }
            http.getResponseCode();
            http.disconnect();
        } catch (Exception e) {
            Trace.log("отчёт " + bank + " не ушёл: " + e.getMessage());
        }
    }
}
