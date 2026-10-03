package ru.checkeris.app;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Wildberries изнутри — так же, как его видит сама страница «Электронные чеки». Открытого API
 * для покупателя нет; страница ходит за списком чеков на astro.wildberries.ru с токеном входа
 * (Authorization: Bearer), а каждый чек — обычная страница receipt.wb.ru, открытая без входа.
 *
 * Токен живёт в localStorage страницы (wbid-oauth-sdk-access-token), действует 30 дней. Окно
 * входа забирает его после входа и кладёт в Secrets; истёк — WB отвечает 401, просим войти снова.
 */
final class WbApi {

    static final String LOGIN_URL = "https://www.wildberries.ru/lk/receipts/get";
    static final String TOKEN_KEY = "wbid-oauth-sdk-access-token";
    private static final String LIST = "https://astro.wildberries.ru/api/v1/receipt-api/v1/receipts";

    static final int ALIVE = 1;
    static final int EXPIRED = 2;
    static final int OFFLINE = 3;

    private static volatile String agent =
            "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36";

    private WbApi() {}

    static void useAgent(String userAgent) {
        if (userAgent != null && !userAgent.isEmpty()) agent = userAgent;
    }

    /** Жива ли сессия: просим один чек. */
    static int check(String token) {
        try {
            receipts(token, "", 1);
            return ALIVE;
        } catch (IllegalStateException e) {
            return EXPIRED;
        } catch (Exception e) {
            return OFFLINE;
        }
    }

    /**
     * Страница списка: { receipts: [{receiptUid, link, operationSum, operationTypeId,
     * operationDateTime}], nextReceiptUid }. Пустой курсор — первая страница, свежие сверху.
     */
    static JSONObject receipts(String token, String cursor, int perPage) throws Exception {
        String url = LIST + "?receiptsPerPage=" + perPage + "&nextReceiptUid="
                + android.net.Uri.encode(cursor == null ? "" : cursor);
        JSONObject data = new JSONObject(get(url, token)).optJSONObject("data");
        JSONObject result = data == null ? null : data.optJSONObject("result");
        JSONObject page = result == null ? null : result.optJSONObject("data");
        if (page == null) throw new java.io.IOException("WB ответил без списка чеков");
        return page;
    }

    /** Страница чека: ссылка из списка, вход не нужен. */
    static String receipt(String link) throws Exception {
        if (!link.startsWith("https://receipt.wb.ru/")) throw new java.io.IOException("чужая ссылка на чек");
        return get(link, null);
    }

    private static String get(String url, String token) throws Exception {
        HttpURLConnection http = (HttpURLConnection) new URL(url).openConnection();
        http.setRequestProperty("User-Agent", agent);
        http.setRequestProperty("Accept", "*/*");
        http.setRequestProperty("Origin", "https://www.wildberries.ru");
        http.setRequestProperty("Referer", "https://www.wildberries.ru/");
        if (token != null) http.setRequestProperty("Authorization", "Bearer " + token);
        http.setConnectTimeout(15000);
        http.setReadTimeout(30000);
        int code = http.getResponseCode();
        String body = TBank.read(code >= 400 ? http.getErrorStream() : http.getInputStream());
        http.disconnect();
        if (code == 401 || code == 403) throw new IllegalStateException("Wildberries просит войти заново");
        if (code >= 400) throw new java.io.IOException("WB ответил " + code);
        return body;
    }
}
