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
    // Веб-версия обращается к узлу web-standinN, и номер у разных сессий разный —
    // перебираем и запоминаем ответивший.
    private static final String[] NODES = {
            "web-standin2", "web-standin1", "web-standin3", "web-standin4",
            "web-node2", "web-node1", "web-node3",
    };
    private static final String DOMAIN = ".online.sberbank.ru";
    private static final String API_PATH = "/uoh-bh/v1/operations/list";
    private static volatile String node; // узел, который ответил в прошлый раз
    private static volatile String apiPath = API_PATH; // путь, если банк его поменяет

    /** Почему не вышло — для окна входа: иначе отказ выглядит как зависание. */
    static volatile String lastError;

    /** Подробности последнего отказа: какой узел и что ответил. Для окна входа. */
    static volatile String lastDetail;

    /**
     * Чем представляется окно банка на этом телефоне. Запросы за выпиской идут из кода,
     * а не из окна, но это то же устройство и та же сессия — и защита банка ждёт обычный
     * браузер. Без этого Сбер отвечает 403.
     */
    private static volatile String agent;

    static void useAgent(String value) {
        if (value != null && !value.isEmpty()) agent = value;
    }

    /**
     * Куда ходит за выпиской сама веб-версия в окне входа. Узел у каждой сессии свой, и
     * угадать его перебором выходит не всегда — а окно банка показывает нужный адрес само.
     * Ничего не подменяем и в страницу не лезем: смотрим только адреса запросов.
     */
    static boolean noticeRequest(android.net.Uri url) {
        if (url == null) return false;
        String host = url.getHost();
        String path = url.getPath();
        if (host == null || path == null || !host.endsWith(DOMAIN) || !path.contains("/uoh-")) return false;
        node = host.substring(0, host.length() - DOMAIN.length());
        if (path.endsWith("/operations/list")) apiPath = path;
        // Банк запрашивает выписку — значит человек уже вошёл: ждать опроса незачем
        return true;
    }

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
     * Куки для узла. Часть кук Сбер выдаёт не на общий домен, а на сам узел, и без них
     * он показывает страницу входа вместо выписки. Берём их живьём из хранилища окна:
     * оно у приложения одно и переживает перезапуск. Пусто — идём с тем, что сохраняли.
     */
    private static String cookiesFor(String host, String fallback) {
        try {
            String own = CookieManager.getInstance().getCookie("https://" + host);
            if (own != null && !own.isEmpty()) return own;
        } catch (Exception ignored) {
            // хранилище недоступно — обойдёмся сохранёнными
        }
        return fallback;
    }

    /**
     * Пачка операций: offset — сдвиг от самой свежей, size — сколько, to — правая граница.
     * Историю берём, увеличивая offset при том же to = сейчас, пока список не кончится.
     */
    static JSONArray operations(String cookies, int offset, int size, long to) throws Exception {
        String body = new JSONObject()
                .put("to", stamp(to))
                .put("paginationOffset", offset)
                .put("paginationSize", size)
                .put("showHidden", false)
                .put("showNotTransactionBonuses", true)
                // Только счета Сбера: операции других банков, которые Сбер собирает по
                // открытому банкингу, иначе задвоятся с их прямым подключением
                .put("showOpenBanking", false)
                .toString();

        lastError = null;
        String trouble = "нет связи со Сбером";
        boolean answered = false; // хоть один узел отозвался по сети
        for (String candidate : order()) {
            String host = candidate + DOMAIN;
            Answer a;
            try {
                a = post(cookiesFor(host, cookies), "https://" + host + apiPath, body);
            } catch (Exception e) {
                continue; // до узла не достучались — пробуем следующий
            }
            answered = true;
            // При отказе оставляем начало ответа: по нему видно, кто отбил — банк или защита
            lastDetail = candidate + ": " + a.code
                    + (a.code >= 400 && a.body != null ? " " + a.body.replaceAll("\s+", " ").trim() : "");
            if (lastDetail.length() > 160) lastDetail = lastDetail.substring(0, 160) + "…";
            // Сессия кончилась — банк так и говорит; перебирать остальные узлы незачем
            if (a.code == 401 || a.code == 403) throw needLogin();
            if (a.code >= 500) {
                trouble = "Сбер не отвечает";
                continue;
            }
            JSONObject json;
            try {
                json = new JSONObject(a.body);
            } catch (Exception e) {
                continue; // не наш узел: вернул страницу, а не данные
            }
            if (!json.has("success")) continue;
            node = candidate; // этот узел наш — с него и начнём в следующий раз
            if (!json.optBoolean("success")) {
                throw new IllegalStateException(json.optString("errorMessage", "Сбер отказал"));
            }
            lastDetail = null;
            JSONObject payload = json.optJSONObject("body");
            JSONArray ops = payload == null ? null : payload.optJSONArray("operations");
            return ops == null ? new JSONArray() : ops;
        }
        // Узлы отвечали, но данных не дал ни один — это не связь, а сессия: вместо выписки
        // Сбер подсовывает страницу входа. Раньше это принимали за «банк не отвечает»,
        // и подключение так и висело зелёным, хотя входить надо было заново
        if (answered) throw needLogin();
        lastError = trouble;
        throw new IllegalStateException(trouble);
    }

    /** Сессия больше не годится. lastError не ставим: для check() это отказ, а не обрыв связи. */
    private static IllegalStateException needLogin() {
        lastError = null;
        return new IllegalStateException("Сбер просит войти заново");
    }

    /**
     * Сколько всего операций до момента `to`. Сбер этого не сообщает — в ответе только сами
     * операции. Зато есть сдвиг, поэтому нащупываем край истории пробами по одной операции:
     * сначала удваиваем сдвиг, пока не упрёмся в пустоту, потом делим отрезок пополам.
     * Останавливаемся, когда точности хватает для полосы загрузки (около 2%), — это полтора
     * десятка лёгких запросов вместо точного перебора.
     */
    static int count(String cookies, long to) throws Exception {
        int low = 0; // столько операций точно есть
        int high = -1; // а столько — точно нет
        int step = 512;
        while (high < 0) {
            if (has(cookies, step - 1, to)) low = step;
            else high = step;
            if (high < 0) {
                if (step >= 1 << 20) { // разумный предел: дальше не ищем
                    high = step;
                    break;
                }
                step *= 2;
            }
            Thread.sleep(600);
        }
        while (high - low > Math.max(50, low / 50)) {
            int mid = low + (high - low) / 2;
            if (has(cookies, mid - 1, to)) low = mid;
            else high = mid;
            Thread.sleep(600);
        }
        return (low + high) / 2;
    }

    private static boolean has(String cookies, int offset, long to) throws Exception {
        return operations(cookies, offset, 1, to).length() > 0;
    }

    /** Порядок обхода: сперва узел, который подсмотрели в окне банка или нашли в прошлый раз. */
    private static String[] order() {
        java.util.LinkedHashSet<String> list = new java.util.LinkedHashSet<>();
        if (node != null) list.add(node);
        list.addAll(java.util.Arrays.asList(NODES));
        return list.toArray(new String[0]);
    }

    /** Ответ узла: код нужен, чтобы отличить «сессия кончилась» от «не тот узел». */
    private static final class Answer {
        final int code;
        final String body;

        Answer(int code, String body) {
            this.code = code;
            this.body = body;
        }
    }

    private static Answer post(String cookies, String url, String body) throws Exception {
        HttpURLConnection http = (HttpURLConnection) new URL(url).openConnection();
        http.setRequestMethod("POST");
        http.setRequestProperty("Content-Type", "application/json");
        http.setRequestProperty("Accept", "application/json");
        http.setRequestProperty("Accept-Language", "ru,en;q=0.9");
        http.setRequestProperty("X-Requested-With", "XMLHttpRequest");
        if (agent != null) http.setRequestProperty("User-Agent", agent);
        // Те же пометки, что ставит браузер запросу со страницы банка
        http.setRequestProperty("Sec-Fetch-Dest", "empty");
        http.setRequestProperty("Sec-Fetch-Mode", "cors");
        http.setRequestProperty("Sec-Fetch-Site", "same-site");
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
        return new Answer(code, TBank.read(code >= 400 ? http.getErrorStream() : http.getInputStream()));
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
            // Банк ответил и отказал — сессия не годится. А если не ответил ни один узел
            // (lastError), сессию хоронить рано: это связь, а не отказ
            return lastError == null ? EXPIRED : OFFLINE;
        } catch (Exception e) {
            lastError = "сбой связи";
            return OFFLINE;
        }
    }
}
