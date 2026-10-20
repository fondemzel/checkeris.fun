package ru.checkeris.app;

import android.annotation.SuppressLint;
import android.content.Context;
import android.net.http.SslError;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Новая сессия Т-Банка без пароля — тем же путём, каким её получает сама страница банка.
 *
 * Сессия (кука psid) живёт около 10 минут, и продлить её нельзя: страница банка её тоже не
 * держит. Когда она истекает, страница сама уходит на вход и по долгоживущему входу в куках
 * (session/authorize) за пару секунд получает новую — человек ничего не вводит (записано
 * 20.10.2026 в окне входа). Мы делаем то же: открываем страницу банка в скрытом окне и ждём,
 * пока она уведёт со входа в кабинет с рабочей сессией.
 *
 * Долгоживущий вход истёк — страница остановится на входе и попросит пин или пароль: тогда
 * без человека никак, run вернёт null.
 */
final class TBankRefresh {

    private static final long WAIT_MS = 30_000;
    private static final long STEP_MS = 1500;
    private static final long MIN_GAP_MS = 60_000; // не чаще раза в минуту: «назад» и фон могут прийти разом

    private static volatile long lastAt;

    private TBankRefresh() {}

    /** Новая рабочая сессия или null. Только в фоновом потоке: ждёт до 30 с. */
    @SuppressLint("SetJavaScriptEnabled")
    static String run(Context context) {
        long now = System.currentTimeMillis();
        if (now - lastAt < MIN_GAP_MS) return null;
        lastAt = now;

        Handler main = new Handler(Looper.getMainLooper());
        WebView[] holder = new WebView[1];
        String[] path = new String[1];
        Context app = context.getApplicationContext();
        main.post(() -> {
            WebView web = new WebView(app);
            web.getSettings().setJavaScriptEnabled(true);
            web.getSettings().setDomStorageEnabled(true);
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
            web.setWebViewClient(new WebViewClient() {
                // Кабинет — одностраничное приложение: переход в него виден по истории, а не по загрузке
                @Override
                public void doUpdateVisitedHistory(WebView view, String url, boolean reload) {
                    path[0] = android.net.Uri.parse(url).getPath();
                }

                @Override
                public void onPageFinished(WebView view, String url) {
                    path[0] = android.net.Uri.parse(url).getPath();
                }

                // Уходы в приложение банка (intent://, tinkoff://) — мимо: мы браузер
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    String scheme = request.getUrl().getScheme();
                    return !"https".equals(scheme) && !"http".equals(scheme);
                }

                @Override
                public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                    if (MincifryTrust.accept(app, error)) handler.proceed();
                    else handler.cancel();
                }
            });
            web.loadUrl(TBank.LOGIN_URL);
            holder[0] = web;
        });

        String fresh = null;
        long until = now + WAIT_MS;
        try {
            while (System.currentTimeMillis() < until) {
                Thread.sleep(STEP_MS);
                // Пока страница на входе, сессия в куке ещё не рабочая (см. окно входа)
                String p = path[0];
                if (p == null || p.startsWith("/auth") || p.startsWith("/login")) continue;
                String psid = value(CookieManager.getInstance().getCookie("https://" + TBank.HOST), "psid");
                if (psid != null && TBank.check(psid) == TBank.ALIVE) {
                    fresh = psid;
                    break;
                }
            }
        } catch (InterruptedException ignored) {
            // прервали — что есть
        } finally {
            main.post(() -> {
                if (holder[0] != null) {
                    holder[0].stopLoading();
                    holder[0].destroy();
                }
                CookieManager.getInstance().flush();
            });
        }
        Trace.log("tbank тихий вход: страница " + path[0] + " → " + (fresh == null ? "нужен человек" : "сессия " + Trace.mark(fresh)));
        return fresh;
    }

    private static String value(String cookies, String name) {
        if (cookies == null) return null;
        for (String part : cookies.split(";")) {
            String[] kv = part.trim().split("=", 2);
            if (kv.length == 2 && kv[0].equals(name) && !kv[1].isEmpty()) return kv[1];
        }
        return null;
    }
}
