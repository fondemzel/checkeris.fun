package ru.checkeris.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * Окно входа в интернет-банк. Это обычный браузер: страницу открывает банк, телефон,
 * код из СМС и пароль вводит человек. Приложение ничего не заполняет и не обходит —
 * оно лишь ждёт, когда вход состоится, и забирает сессию (куку psid).
 *
 * Сессия сохраняется в защищённом хранилище телефона (Secrets) и никуда не уходит:
 * на сервер Чекера отправляются только готовые операции.
 */
public class BankLoginActivity extends Activity {

    static final String SESSION = "tbank.session";

    private WebView web;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean done;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setTitle("Вход в Т-Банк");
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportMultipleWindows(false);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                check();
            }
        });
        web.loadUrl(TBank.LOGIN_URL);
    }

    /** После каждой страницы смотрим: не появилась ли рабочая сессия. */
    private void check() {
        if (done) return;
        String cookies = CookieManager.getInstance().getCookie("https://" + TBank.HOST);
        final String session = value(cookies, "psid");
        if (session == null) return;
        new Thread(() -> {
            if (!TBank.alive(session)) return; // кука есть и у гостя — ждём настоящего входа
            handler.post(() -> {
                if (done) return;
                done = true;
                Secrets secrets = new Secrets(this);
                secrets.put(SESSION, session);
                secrets.put(BankSync.EXPIRED, null);
                Toast.makeText(this, "Т-Банк подключён", Toast.LENGTH_SHORT).show();
                setResult(RESULT_OK);
                finish();
            });
        }).start();
    }

    private static String value(String cookies, String name) {
        if (cookies == null) return null;
        for (String part : cookies.split(";")) {
            String[] kv = part.trim().split("=", 2);
            if (kv.length == 2 && kv[0].equals(name) && !kv[1].isEmpty()) return kv[1];
        }
        return null;
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.setVisibility(View.GONE);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
