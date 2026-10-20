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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Личный кабинет Озона — той же сессией, что у человека в окне входа, как у банков.
 *
 * Вход человек проходит сам в окне Озона (BankLoginActivity). Дальше повторяем запросы веб-
 * версии: страницы кабинета Озон отдаёт данными через «композер» (entrypoint-api), а чеки —
 * PDF-файлами. Нам нужен список «Электронные чеки» и сами файлы: разбирает их сервер.
 *
 * Куки берём живьём из хранилища окна. Обратно не пишем: новые куки из ответа легли бы рядом
 * со старыми без домена, и Озон, увидев два разных токена, отвечал бы 403. Токен обновляет
 * сама страница Озона, когда человек открывает окно входа.
 */
final class OzonApi {

    static final String LOGIN_URL = "https://www.ozon.ru/my/orderlist";
    static final String HOST = "https://www.ozon.ru";
    private static final String PAGE = "/api/entrypoint-api.bx/page/json/v2?url=";
    private static final int MAX_PAGES = 300; // предел листания: на случай, если Озон зациклит страницы

    static final int ALIVE = 1;
    static final int EXPIRED = 0;
    static final int OFFLINE = -1;
    static volatile String lastDetail; // последний отказ Озона: код и начало ответа

    private static volatile String agent;

    static void useAgent(String value) {
        if (value != null && !value.isEmpty()) agent = value;
    }

    /** Куки окна входа: ими Озон узнаёт человека. Пусто — не входил. */
    static String cookies() {
        return CookieManager.getInstance().getCookie(HOST);
    }

    /** Названия кук Озона, без значений: для журнала — какие куки входа остались. */
    static String cookieNames() {
        String cookies = cookies();
        if (cookies == null) return "нет";
        StringBuilder out = new StringBuilder();
        for (String part : cookies.split(";")) out.append(part.trim().split("=", 2)[0]).append(' ');
        return out.toString().trim();
    }

    /** Страница кабинета данными: как её запрашивает сама веб-версия. */
    static JSONObject page(String url) throws Exception {
        HttpURLConnection http = open(PAGE + URLEncoder.encode(url, "UTF-8"), "application/json");
        int code = http.getResponseCode();
        String body = TBank.read(code >= 400 ? http.getErrorStream() : http.getInputStream());
        http.disconnect();
        if (!body.trim().startsWith("{")) {
            // Вместо данных — страница: начало её — в журнал (по ней видно, что это)
            String head = body.replaceAll("[\\s]+", " ");
            Trace.log("ozon ответ не данные: " + code + " " + (head.length() > 300 ? head.substring(0, 300) + "…" : head));
        }
        if (code >= 300) {
            // Отказ дословно — в журнал и в отчёт серверу: вход ли истёк или это защита от роботов
            String head = body == null ? "" : body.replaceAll("[\\s]+", " ");
            lastDetail = code + " " + (head.length() > 160 ? head.substring(0, 160) + "…" : head);
            Trace.log("ozon отказ: " + lastDetail);
        }
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
            // Не ошибка Озона, а что-то другое: сеть или вместо данных — страница (проверка
            // «я не робот»). Дословно — в журнал и в отчёт
            lastDetail = e.getClass().getSimpleName() + ": " + e.getMessage();
            Trace.log("ozon проверка: " + lastDetail);
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
            int idle = 0; // страниц подряд без новых чеков
            java.util.Set<String> visited = new java.util.HashSet<>();
            for (int i = 0; url != null && i < MAX_PAGES && visited.add(url); i++) {
                // Страница — набор виджетов, у каждого своё состояние строкой JSON. Чеки — в
                // ссылках «Скачать», следующая страница — в состоянии листалки (paginator)
                JSONObject states = page(url).optJSONObject("widgetStates");
                int before = ids.size();
                int onPage = 0; // чеков на странице — и новых, и уже виденных
                String next = null;
                java.util.Iterator<String> keys = states == null ? null : states.keys();
                while (keys != null && keys.hasNext()) {
                    String key = keys.next();
                    String state = states.optString(key);
                    Matcher m = Pattern.compile("downloadCheque[?]id=([A-Za-z0-9-]+)").matcher(state);
                    while (m.find()) {
                        ids.add(m.group(1));
                        onPage++;
                    }
                    if (key.startsWith("paginator")) {
                        String candidate = new JSONObject(state).optString("nextPage", "");
                        if (candidate.startsWith("/my/e-check")) next = candidate;
                    }
                }
                StringBuilder kinds = new StringBuilder();
                java.util.Iterator<String> all = states == null ? null : states.keys();
                while (all != null && all.hasNext()) kinds.append(all.next().replaceAll("-[0-9]+-default-[0-9]+", "")).append(',');
                Trace.log("ozon чеки " + url + ": +" + (ids.size() - before) + ", дальше " + next + " | " + kinds);
                if (states != null && ids.size() == before) {
                    // Ничего не нашли — покажем, что лежит в главном блоке, чтобы понять формат
                    java.util.Iterator<String> ks = states.keys();
                    while (ks.hasNext()) {
                        String k = ks.next();
                        if (k.startsWith("cheques") || k.startsWith("receipt") || k.startsWith("cellList")) {
                            String v = states.optString(k);
                            Trace.log("ozon " + k + ": " + v.substring(0, Math.min(v.length(), 1500)));
                        }
                    }
                }
                // Архив начинается с тех же свежих чеков, что «Недавние», поэтому одна страница
                // без нового — не конец. Конец — пустая страница или три подряд без нового
                idle = ids.size() > before ? 0 : idle + 1;
                url = onPage == 0 || idle >= 3 ? null : next;
            }
        }
        return new ArrayList<>(ids);
    }

    /** Файл чека — PDF как есть. */
    static byte[] download(String id) throws Exception {
        // Accept — как в разведке: так запрос проходил
        HttpURLConnection http = open("/_action/downloadCheque?id=" + URLEncoder.encode(id, "UTF-8") + "&rawdata=1&download=1&docType=ozon", "application/json");
        int code = http.getResponseCode();
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

    /**
     * Запрос как из браузера: перенаправления проходим сами и куки из каждого ответа сохраняем.
     * Короткий пропуск Озона (__Secure-access-token) живёт ~полчаса; истёк — Озон отвечает
     * перенаправлением и в нём же выдаёт новый пропуск (и новый долгий — refresh). Раньше
     * HttpURLConnection шёл по перенаправлениям сам, но новые куки не сохранял: ходил со старым
     * пропуском по кругу («Too many follow-up requests: 21», записано 20.10.2026), а долгий
     * пропуск сгорал — и вход терялся. Ответ возвращаем уже конечный.
     */
    private static HttpURLConnection open(String path, String accept) throws Exception {
        String url = HOST + path;
        for (int hop = 0; hop < 10; hop++) {
            HttpURLConnection http = (HttpURLConnection) new URL(url).openConnection();
            http.setInstanceFollowRedirects(false);
            if (agent != null) http.setRequestProperty("User-Agent", agent);
            http.setRequestProperty("Referer", LOGIN_URL);
            if (accept != null) http.setRequestProperty("Accept", accept);
            String cookies = cookies();
            if (cookies != null) http.setRequestProperty("Cookie", cookies);
            http.setConnectTimeout(15000);
            http.setReadTimeout(30000);
            int code = http.getResponseCode();
            keepCookies(http);
            String next = http.getHeaderField("Location");
            if (code >= 300 && code < 400 && next != null) {
                url = new URL(new URL(url), next).toString();
                http.disconnect();
                continue;
            }
            return http;
        }
        throw new java.io.IOException("Озон зациклил перенаправления");
    }

    /**
     * Куки из ответа — в хранилище окна, как сделал бы браузер. Без домена кука легла бы
     * отдельно от куки окна с тем же именем (так раньше появлялись дубли): ставим домен Озона.
     */
    private static void keepCookies(HttpURLConnection http) {
        CookieManager cm = CookieManager.getInstance();
        boolean any = false;
        for (java.util.Map.Entry<String, List<String>> h : http.getHeaderFields().entrySet()) {
            if (h.getKey() == null || !h.getKey().equalsIgnoreCase("Set-Cookie")) continue;
            for (String c : h.getValue()) {
                cm.setCookie(HOST, c.toLowerCase().contains("domain=") ? c : c + "; Domain=.ozon.ru");
                any = true;
            }
        }
        if (any) cm.flush();
    }

    /**
     * Прежняя версия записывала куки из ответов Озона без домена — рядом с настоящими легли
     * дубли с теми же именами. Убираем их: у дубля нет домена, поэтому стирается именно он.
     */
    static void dropDuplicateCookies() {
        String cookies = cookies();
        if (cookies == null) return;
        java.util.Set<String> seen = new java.util.HashSet<>();
        CookieManager cm = CookieManager.getInstance();
        for (String part : cookies.split(";")) {
            String name = part.trim().split("=", 2)[0];
            if (!name.isEmpty() && !seen.add(name)) {
                cm.setCookie(HOST, name + "=; Max-Age=0; Path=/");
                cm.setCookie(HOST, name + "=; Max-Age=0; Path=/; Secure");
            }
        }
        cm.flush();
    }
}
