package ru.checkeris.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Разовая проверка связи со Сбером перед тем, как строить полноценный адаптер.
 *
 * Вопрос, на который отвечает: пускает ли Сбер повтор запроса из кода приложения нашими
 * куками (у него метки антибота), и та ли нода web-standinN. Берём пару свежих операций
 * и отправляем как есть на сервер человека — там их видно только ему, как и все операции
 * банка. По ответу станет ясно, состоятельна ли схема веб-повтора для Сбера.
 */
final class SberProbe {

    private static final String CHECKER = "https://checkeris.fun/api/bank/probe";

    static String run(Context context, String checkerToken) throws Exception {
        String cookies = new Secrets(context).get(BankLoginActivity.SBER_SESSION);
        if (cookies == null) return "{\"ok\":false,\"error\":\"Сбер не подключён\"}";

        JSONObject report = new JSONObject().put("bank", "sber").put("app", BuildInfo.VERSION);
        try {
            JSONArray ops = SberBank.operations(cookies, 0, 10, System.currentTimeMillis());
            report.put("ok", true).put("count", ops.length()).put("operations", ops);
        } catch (IllegalStateException e) {
            report.put("ok", false).put("error", "Сбер отказал: " + e.getMessage());
        } catch (Exception e) {
            report.put("ok", false).put("error", "не достучались: " + e.getMessage());
        }

        try {
            send(checkerToken, report);
        } catch (Exception e) {
            report.put("sendError", String.valueOf(e.getMessage()));
        }
        return new JSONObject()
                .put("ok", report.optBoolean("ok"))
                .put("count", report.optInt("count", 0))
                .put("error", report.opt("error"))
                .toString();
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
