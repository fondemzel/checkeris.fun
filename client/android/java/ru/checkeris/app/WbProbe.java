package ru.checkeris.app;

import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;

import java.util.Collections;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Разведка Wildberries: открытого API для покупателя нет, поэтому сначала смотрим, куда
 * ходит сама страница чеков и где у неё сессия. Только журнал (Trace) на телефоне: ничего
 * не подменяем и никуда не отправляем. Значения токенов в журнал не пишутся — только метки.
 */
final class WbProbe {

    static final String LOGIN_URL = "https://www.wildberries.ru/lk/receipts";

    private static final Set<String> seen = Collections.synchronizedSet(new HashSet<>());
    private static String lastStorage;

    private WbProbe() {}

    /** Запрос страницы: адрес без статики, имена заголовков, метка авторизации. */
    static void request(WebResourceRequest request) {
        android.net.Uri u = request.getUrl();
        String host = u.getHost();
        String path = u.getPath() == null ? "" : u.getPath();
        if (host == null || !(host.contains("wildberries") || host.contains("wb.ru") || host.contains("wbbasket"))) return;
        if (path.matches(".*[.](js|css|png|jpe?g|svg|webp|woff2?|ico|gif|avif|mp4)$")) return;
        if (!seen.add(request.getMethod() + host + path)) return;
        StringBuilder h = new StringBuilder();
        for (Map.Entry<String, String> e : request.getRequestHeaders().entrySet()) {
            String name = e.getKey();
            h.append(name);
            if (name.equalsIgnoreCase("authorization") || name.toLowerCase().contains("token")) {
                h.append('=').append(Trace.mark(e.getValue()));
            }
            h.append(' ');
        }
        String query = u.getQuery() == null ? "" : "?" + u.getQuery();
        if (query.length() > 300) query = query.substring(0, 300) + "…";
        Trace.log("wb запрос " + request.getMethod() + " " + host + path + query + " [" + h.toString().trim() + "]");
    }

    /** Что страница хранит у себя: ключи localStorage с длинами и имена кук — без значений. */
    static void storage(WebView web) {
        String js = "(function(){var o=[];for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);"
                + "o.push(k+':'+String(localStorage.getItem(k)).length)}return location.pathname+' | '+o.join(', ')})()";
        web.evaluateJavascript(js, value -> {
            String cookies = CookieManager.getInstance().getCookie("https://www.wildberries.ru");
            StringBuilder names = new StringBuilder();
            if (cookies != null) {
                for (String part : cookies.split(";")) names.append(part.trim().split("=", 2)[0]).append(' ');
            }
            String line = value + " | куки: " + names.toString().trim();
            if (line.equals(lastStorage)) return;
            lastStorage = line;
            Trace.log("wb хранилище: " + line);
        });
    }
}
