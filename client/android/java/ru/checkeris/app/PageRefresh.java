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

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Обновить вход тем же путём, каким его обновляет сама страница сайта: открыть её в скрытом
 * окне и подождать. У Озона и Wildberries короткий «пропуск» (кука или токен в памяти
 * страницы), а долгоживущий вход страница при открытии сама меняет на свежий пропуск — без
 * пароля. Приложение ходит к ним запросами и пропуск само не обновляет; так он и истекал.
 *
 * probe — готово ли (в фоновом потоке; может читать страницу через js). Готовым вход считаем,
 * когда probe ответил «да» два раза подряд: первые мгновения после открытия пропуск ещё старый.
 * Как у Т-Банка (TBankRefresh), только сайт и проверка — свои.
 */
final class PageRefresh {

    interface Probe {
        boolean ready(WebView web) throws Exception;
    }

    private static final long WAIT_MS = 45_000;
    private static final long STEP_MS = 1500;
    private static final long MIN_GAP_MS = 60_000; // не чаще раза в минуту на сайт
    private static final Map<String, Long> lastAt = new ConcurrentHashMap<>();

    private PageRefresh() {}

    /** true — вход обновлён. Только в фоновом потоке: ждёт до 45 с. */
    @SuppressLint("SetJavaScriptEnabled")
    static boolean run(Context context, String tag, String url, Probe probe) {
        long now = System.currentTimeMillis();
        Long last = lastAt.get(tag);
        if (last != null && now - last < MIN_GAP_MS) return false;
        lastAt.put(tag, now);

        Handler main = new Handler(Looper.getMainLooper());
        WebView[] holder = new WebView[1];
        Context app = context.getApplicationContext();
        CountDownLatch created = new CountDownLatch(1);
        main.post(() -> {
            WebView web = new WebView(app);
            web.getSettings().setJavaScriptEnabled(true);
            web.getSettings().setDomStorageEnabled(true);
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
            web.setWebViewClient(new WebViewClient() {
                // Уходы в приложения (intent://, ozon://) — мимо: мы браузер
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
            web.loadUrl(url);
            holder[0] = web;
            created.countDown();
        });

        boolean ok = false;
        int good = 0;
        try {
            created.await(5, TimeUnit.SECONDS);
            long until = now + WAIT_MS;
            while (System.currentTimeMillis() < until) {
                Thread.sleep(STEP_MS);
                boolean ready;
                try {
                    ready = holder[0] != null && probe.ready(holder[0]);
                } catch (Exception e) {
                    ready = false;
                }
                good = ready ? good + 1 : 0;
                if (good >= 2) {
                    ok = true;
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
        Trace.log(tag + " тихий вход: " + (ok ? "вход обновлён" : "нужен человек"));
        return ok;
    }

    /** Выполнить скрипт на странице и дождаться ответа (строка JSON или null). */
    static String js(WebView web, String script) throws InterruptedException {
        String[] out = new String[1];
        CountDownLatch done = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(() -> web.evaluateJavascript(script, (value) -> {
            out[0] = value;
            done.countDown();
        }));
        done.await(5, TimeUnit.SECONDS);
        return out[0];
    }
}
