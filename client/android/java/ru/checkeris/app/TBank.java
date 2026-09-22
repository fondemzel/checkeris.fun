package ru.checkeris.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/**
 * Веб-API интернет-банка Т-Банка — с телефона, а не с сервера.
 *
 * Вход человек проходит сам, в окне банка внутри приложения (BankLoginActivity): телефон,
 * код из СМС и пароль он вводит своими руками, как в браузере. Приложение забирает
 * из окна только сессию (куку psid) и дальше обычными запросами получает счета и операции.
 * Сессия остаётся на устройстве: на сервер Чекера уходят лишь готовые операции.
 */
final class TBank {

    static final String LOGIN_URL = "https://www.tbank.ru/login/";
    static final String HOST = "www.tbank.ru";
    private static final String API = "https://www.tbank.ru/api/common/v1/";

    /** Ответ банка: { resultCode, payload }. Payload возвращаем как есть. */
    private static Object call(String session, String method, String query) throws Exception {
        String url = API + method + "?origin=web,ib5,platform" + (query == null ? "" : query)
                + "&sessionid=" + URLEncoder.encode(session, "UTF-8");
        HttpURLConnection http = (HttpURLConnection) new URL(url).openConnection();
        http.setRequestProperty("Accept", "application/json");
        http.setConnectTimeout(15000);
        http.setReadTimeout(30000);
        try {
            int code = http.getResponseCode();
            InputStream stream = code >= 400 ? http.getErrorStream() : http.getInputStream();
            JSONObject body = new JSONObject(read(stream));
            if (!"OK".equals(body.optString("resultCode"))) {
                throw new IllegalStateException(body.optString("errorMessage", body.optString("resultCode")));
            }
            return body.opt("payload");
        } finally {
            http.disconnect();
        }
    }

    static String read(InputStream stream) throws Exception {
        if (stream == null) return "{}";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = stream.read(buffer)) > 0) out.write(buffer, 0, n);
        return out.toString("UTF-8");
    }

    /** Жива ли сессия: у вошедшего клиента уровень доступа CLIENT. */
    static boolean alive(String session) {
        try {
            return "CLIENT".equals(((JSONObject) call(session, "ping", null)).optString("accessLevel"));
        } catch (Exception e) {
            return false;
        }
    }

    static JSONArray accounts(String session) throws Exception {
        return (JSONArray) call(session, "accounts_light_ib", null);
    }

    static JSONArray operations(String session, String account, long since) throws Exception {
        String query = "&account=" + URLEncoder.encode(account, "UTF-8")
                + "&start=" + since + "&end=" + System.currentTimeMillis();
        return (JSONArray) call(session, "operations", query);
    }
}
