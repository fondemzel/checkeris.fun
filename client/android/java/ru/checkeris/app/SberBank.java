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
    // Веб-версия обращается к узлу web-standinN, и номер у разных сессий разный. Куки общие
    // для *.online.sberbank.ru, поэтому просто перебираем узлы и запоминаем ответивший.
    private static final String[] NODES = {
            "web-standin2", "web-standin1", "web-standin3", "web-standin4",
            "web-node2", "web-node1", "web-node3",
    };
    private static final String PATH = ".online.sberbank.ru/uoh-bh/v1/operations/list";
    private static volatile String node; // узел, который ответил в прошлый раз

    /** Почему не вышло — для окна входа: иначе отказ выглядит как зависание. */
    static volatile String lastError;

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
        String trouble = "Сбер не отвечает";
        for (String candidate : order()) {
            String answer;
            try {
                answer = post(cookies, "https://" + candidate + PATH, body);
            } catch (Exception e) {
                trouble = "нет связи со Сбером";
                continue; // до узла не достучались — пробуем следующий
            }
            JSONObject json;
            try {
                json = new JSONObject(answer);
            } catch (Exception e) {
                trouble = "чужой узел Сбера";
                continue; // не тот узел: вернул не JSON, а страницу или переадресацию
            }
            if (!json.has("success")) {
                trouble = "чужой узел Сбера";
                continue;
            }
            node = candidate; // этот узел наш — с него и начнём в следующий раз
            if (!json.optBoolean("success")) {
                throw new IllegalStateException(json.optString("errorMessage", "Сбер отказал"));
            }
            lastError = null;
            JSONObject payload = json.optJSONObject("body");
            JSONArray ops = payload == null ? null : payload.optJSONArray("operations");
            return ops == null ? new JSONArray() : ops;
        }
        lastError = trouble;
        throw new IllegalStateException(trouble);
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

    /** Порядок обхода: сперва узел, отвечавший в прошлый раз. */
    private static String[] order() {
        if (node == null) return NODES;
        String[] list = new String[NODES.length];
        list[0] = node;
        int i = 1;
        for (String n : NODES) if (!n.equals(node)) list[i++] = n;
        return list;
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
            // Банк ответил и отказал — сессия не годится. А если не ответил ни один узел
            // (lastError), сессию хоронить рано: это связь, а не отказ
            return lastError == null ? EXPIRED : OFFLINE;
        } catch (Exception e) {
            lastError = "сбой связи";
            return OFFLINE;
        }
    }
}
