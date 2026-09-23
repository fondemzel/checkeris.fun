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
    static final String RATE_LIMIT = "Превышен лимит запросов";
    private static final String API = "https://www.tbank.ru/api/common/v1/";

    /** Ответ банка: { resultCode, payload }. Payload возвращаем как есть. */
    private static Object call(String session, String method, String query) throws Exception {
        JSONObject body = new JSONObject(body(session, method, query));
        if ("REQUEST_RATE_LIMIT_EXCEEDED".equals(body.optString("resultCode"))) throw new IllegalStateException(RATE_LIMIT);
        if (!"OK".equals(body.optString("resultCode"))) {
            throw new IllegalStateException(body.optString("errorMessage", body.optString("resultCode")));
        }
        return body.opt("payload");
    }

    /** Ответ банка текстом, без разбора: для разведки нужен и размер, и отказ целиком. */
    static String body(String session, String method, String query) throws Exception {
        String url = API + method + "?origin=web,ib5,platform" + (query == null ? "" : query)
                + "&sessionid=" + URLEncoder.encode(session, "UTF-8");
        HttpURLConnection http = (HttpURLConnection) new URL(url).openConnection();
        http.setRequestProperty("Accept", "application/json");
        http.setConnectTimeout(15000);
        http.setReadTimeout(30000);
        try {
            int code = http.getResponseCode();
            InputStream stream = code >= 400 ? http.getErrorStream() : http.getInputStream();
            return read(stream);
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

    static final int ALIVE = 1;
    static final int EXPIRED = 0;
    static final int OFFLINE = -1;

    /**
     * Жива ли сессия. Три ответа, а не два: «банк не пустил» и «до банка не достучались» —
     * разные вещи. Из-за отсутствия сети сессию терять нельзя.
     */
    static int check(String session) {
        try {
            return "CLIENT".equals(((JSONObject) call(session, "ping", null)).optString("accessLevel"))
                    ? ALIVE : EXPIRED;
        } catch (IllegalStateException e) {
            if (RATE_LIMIT.equals(e.getMessage())) return OFFLINE; // «подождите» — не повод просить вход
            return EXPIRED; // банк ответил, но отказал
        } catch (Exception e) {
            return OFFLINE; // сеть, таймаут, сбой на стороне банка
        }
    }

    static boolean alive(String session) {
        return check(session) == ALIVE;
    }

    static JSONArray accounts(String session) throws Exception {
        return (JSONArray) call(session, "accounts_light_ib", null);
    }

    static JSONArray operations(String session, String account, long since) throws Exception {
        return operations(session, account, since, System.currentTimeMillis());
    }

    static JSONArray operations(String session, String account, long from, long to) throws Exception {
        String query = "&account=" + URLEncoder.encode(account, "UTF-8") + "&start=" + from + "&end=" + to;
        return (JSONArray) call(session, "operations", query);
    }
}
