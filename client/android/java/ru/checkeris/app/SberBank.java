package ru.checkeris.app;

import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Веб-API Сбербанк Онлайн — той же сессией, что и у человека в окне входа, как с Т-Банком.
 *
 * Приложение ничего не подделывает: вход человек проходит сам в окне банка
 * (BankLoginActivity), а дальше повторяется тот же запрос, что делает сама веб-версия.
 * Отличий от Т-Банка два:
 *   — сессию Сбер узнаёт по всему набору кук окна, а не по одной куке;
 *   — операции отдаёт POST-запросом единым списком по всем счетам (uoh — объединённая
 *     история операций), страницами по offset, без перебора счетов.
 */
final class SberBank {

    static final String LOGIN_URL = "https://online.sberbank.ru/";
    static final String HOST = "https://online.sberbank.ru";
    // Веб-версия обращается к узлу web-standinN; куки общие для *.online.sberbank.ru.
    // Номер узла может отличаться у другой сессии — проверим на живом входе.
    private static final String OPERATIONS = "https://web-standin2.online.sberbank.ru/uoh-bh/v1/operations/list";

    static final int ALIVE = 1;
    static final int EXPIRED = 0;
    static final int OFFLINE = -1;

    /** Время в формате Сбера: 31.05.2026T16:15:16, местное московское. */
    private static String stamp(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("dd.MM.yyyy'T'HH:mm:ss", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("Europe/Moscow"));
        return f.format(new Date(ms));
    }

    /** Куки окна входа — ими Сбер узнаёт сессию. Пусто — человек не вошёл. */
    static String cookies() {
        return CookieManager.getInstance().getCookie(HOST);
    }

    /**
     * Пачка операций: offset — сдвиг от самой свежей, size — сколько, to — правая граница.
     * Историю берём, увеличивая offset при том же to = сейчас, пока список не кончится.
     */
    static JSONArray operations(String cookies, int offset, int size, long to) throws Exception {
        JSONObject body = new JSONObject()
                .put("to", stamp(to))
                .put("paginationOffset", offset)
                .put("paginationSize", size)
                .put("showHidden", false)
                .put("showNotTransactionBonuses", true)
                // Только счета Сбера: операции других банков, которые Сбер собирает по
                // открытому банкингу, иначе задвоятся с их прямым подключением
                .put("showOpenBanking", false);
        JSONObject answer = new JSONObject(post(cookies, OPERATIONS, body.toString()));
        if (!answer.optBoolean("success")) {
            throw new IllegalStateException(answer.optString("errorMessage", "Сбер отказал"));
        }
        JSONObject payload = answer.optJSONObject("body");
        JSONArray ops = payload == null ? null : payload.optJSONArray("operations");
        return ops == null ? new JSONArray() : ops;
    }

    private static String post(String cookies, String url, String body) throws Exception {
        HttpURLConnection http = (HttpURLConnection) new URL(url).openConnection();
        http.setRequestMethod("POST");
        http.setRequestProperty("Content-Type", "application/json");
        http.setRequestProperty("Accept", "application/json");
        http.setRequestProperty("X-Requested-With", "XMLHttpRequest");
        if (cookies != null) http.setRequestProperty("Cookie", cookies);
        http.setRequestProperty("Origin", HOST);
        http.setRequestProperty("Referer", HOST + "/");
        http.setDoOutput(true);
        http.setConnectTimeout(15000);
        http.setReadTimeout(30000);
        try (OutputStream out = http.getOutputStream()) {
            out.write(body.getBytes("UTF-8"));
        }
        int code = http.getResponseCode();
        return TBank.read(code >= 400 ? http.getErrorStream() : http.getInputStream());
    }

    /**
     * Жива ли сессия. Три ответа, как у Т-Банка: пустила, не пустила, не достучались.
     * Проверяем самой лёгкой операцией — одной строкой истории.
     */
    static int check(String cookies) {
        if (cookies == null || cookies.isEmpty()) return EXPIRED;
        try {
            operations(cookies, 0, 1, System.currentTimeMillis());
            return ALIVE;
        } catch (IllegalStateException e) {
            return EXPIRED; // банк ответил, но отказал
        } catch (Exception e) {
            return OFFLINE; // сеть, таймаут, чужой узел
        }
    }
}
