package ru.checkeris.app;

import android.webkit.CookieManager;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Личный кабинет Озона — той же сессией, что у человека в окне входа, как у банков.
 *
 * Вход человек проходит сам в окне Озона (BankLoginActivity). Дальше повторяем запросы веб-
 * версии: страницы кабинета Озон отдаёт данными через «композер» (entrypoint-api), а чеки —
 * PDF-файлами. Нам нужен список «Электронные чеки» и сами файлы: разбирает их сервер.
 *
 * Куки берём живьём из хранилища окна и туда же кладём новые, которые Озон присылает в ответ:
 * так короткоживущий токен доступа обновляется сам, без нового входа.
 */
final class OzonApi {

    static final String LOGIN_URL = "https://www.ozon.ru/my/orderlist";
    static final String HOST = "https://www.ozon.ru";
    private static final String PAGE = "/api/entrypoint-api.bx/page/json/v2?url=";
    private static final int MAX_PAGES = 300; // предел листания: на случай, если Озон зациклит страницы

    static final int ALIVE = 1;
    static final int EXPIRED = 0;
    static final int OFFLINE = -1;

    private static volatile String agent;

    static void useAgent(String value) {
        if (value != null && !value.isEmpty()) agent = value;
    }

    /** Куки окна входа: ими Озон узнаёт человека. Пусто — не входил. */
    static String cookies() {
        return CookieManager.getInstance().getCookie(HOST);
    }

    /** Страница кабинета данными: как её запрашивает сама веб-версия. */
    static JSONObject page(String url) throws Exception {
        HttpURLConnection http = open(PAGE + URLEncoder.encode(url, "UTF-8"));
        http.setRequestProperty("Accept", "application/json");
        int code = http.getResponseCode();
        keepCookies(http);
        String body = TBank.read(code >= 400 ? http.getErrorStream() : http.getInputStream());
        http.disconnect();
        if (code == 401 || code == 403) throw new IllegalStateException("Озон просит войти заново");
        if (code >= 400) throw new java.io.IOException("Озон ответил " + code);
        return new JSONObject(body);
    }

    /** Вошёл ли человек: Озон сам пишет это в ответе каждой страницы. */
    static int check() {
        try {
            JSONObject user = page("/my/orderlist").optJSONObject("userInfo");
            JSONObject u = user == null ? null : user.optJSONObject("user");
            return u != null && u.optBoolean("isLoggedIn") ? ALIVE : EXPIRED;
        } catch (IllegalStateException e) {
            return EXPIRED;
        } catch (Exception e) {
            return OFFLINE;
        }
    }

    /**
     * Все чеки из «Электронных чеков»: недавние и архив, со всеми страницами. На выходе — id
     * чеков: по ним скачиваются файлы. Порядок — от свежих к старым.
     */
    static List<String> cheques() throws Exception {
        LinkedHashSet<String> ids = new LinkedHashSet<>();
        for (String start : new String[] {"/my/e-check", "/my/e-check?archive=1"}) {
            String url = start;
            for (int i = 0; url != null && i < MAX_PAGES; i++) {
                // Страница — набор виджетов, у каждого своё состояние строкой JSON. Чеки — в
                // ссылках «Скачать», следующая страница — в состоянии листалки (paginator)
                JSONObject states = page(url).optJSONObject("widgetStates");
                int before = ids.size();
                String next = null;
                java.util.Iterator<String> keys = states == null ? null : states.keys();
                while (keys != null && keys.hasNext()) {
                    String key = keys.next();
                    String state = states.optString(key);
                    Matcher m = Pattern.compile("downloadCheque[?]id=([A-Za-z0-9-]+)").matcher(state);
                    while (m.find()) ids.add(m.group(1));
                    if (key.startsWith("paginator")) {
                        String candidate = new JSONObject(state).optString("nextPage", "");
                        if (candidate.startsWith("/my/e-check")) next = candidate;
                    }
                }
                // Страница ничего не добавила — дальше листать незачем
                url = ids.size() > before ? next : null;
            }
        }
        return new ArrayList<>(ids);
    }

    /** Файл чека — PDF как есть. */
    static byte[] download(String id) throws Exception {
        HttpURLConnection http = open("/_action/downloadCheque?id=" + URLEncoder.encode(id, "UTF-8") + "&rawdata=1&download=1&docType=ozon");
        int code = http.getResponseCode();
        keepCookies(http);
        if (code >= 400) {
            http.disconnect();
            throw new java.io.IOException("чек не скачался: " + code);
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream in = http.getInputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            http.disconnect();
        }
        return out.toByteArray();
    }

    private static HttpURLConnection open(String path) throws Exception {
        HttpURLConnection http = (HttpURLConnection) new URL(HOST + path).openConnection();
        if (agent != null) http.setRequestProperty("User-Agent", agent);
        http.setRequestProperty("Referer", LOGIN_URL);
        String cookies = cookies();
        if (cookies != null) http.setRequestProperty("Cookie", cookies);
        http.setConnectTimeout(15000);
        http.setReadTimeout(30000);
        return http;
    }

    /** Новые куки из ответа — в хранилище окна: токен доступа Озон обновляет на ходу. */
    private static void keepCookies(HttpURLConnection http) {
        Map<String, List<String>> headers = http.getHeaderFields();
        if (headers == null) return;
        CookieManager cm = CookieManager.getInstance();
        for (Map.Entry<String, List<String>> e : headers.entrySet()) {
            if (e.getKey() == null || !e.getKey().equalsIgnoreCase("Set-Cookie")) continue;
            for (String c : e.getValue()) cm.setCookie(HOST, c);
        }
        cm.flush();
    }
}
