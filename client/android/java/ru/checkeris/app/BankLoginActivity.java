package ru.checkeris.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.net.http.SslError;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;
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
    static final String SBER_SESSION = "sber.session";

    private WebView web;
    private TextView status; // полоска состояния под окном банка (только у Сбера)
    private String bank = "tbank"; // какой банк подключаем: приходит в Intent
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean done;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        if ("sber".equals(getIntent().getStringExtra("bank"))) bank = "sber";
        boolean sber = bank.equals("sber");
        setTitle(sber ? "Вход в Сбербанк Онлайн" : "Вход в Т-Банк");
        web = new WebView(this);
        if (sber) {
            // Полоска состояния под окном банка: без неё неудачная проверка выглядит
            // как зависание — человек не понимает, вошёл он или нет
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.addView(web, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
            status = new TextView(this);
            status.setPadding(32, 20, 32, 20);
            status.setTextSize(13);
            status.setText("Войдите в Сбербанк Онлайн — окно закроется само");
            box.addView(status, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
            setContentView(box);
        } else {
            setContentView(web);
        }

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

            // Сертификат банка — от Минцифры: пропускаем только если он проверен (MincifryTrust)
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                if (MincifryTrust.accept(BankLoginActivity.this, error)) handler.proceed();
                else handler.cancel();
            }
        });
        web.loadUrl(sber ? SberBank.LOGIN_URL : TBank.LOGIN_URL);

        // Сбербанк Онлайн — одностраничное приложение: после входа целая страница не
        // перезагружается, и onPageFinished больше не срабатывает. Поэтому опрашиваем сами
        if (sber) handler.postDelayed(poll, POLL_MS);
    }

    private static final long POLL_MS = 1500;
    private boolean checking; // одна проверка за раз, чтобы запросы не наслаивались
    private long lastNet; // когда последний раз ходили к банку — чтобы не частить впустую
    private String lastChecked; // куки, с которыми уже спрашивали: те же — спрашивать нечего

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            if (done) return;
            check();
            handler.postDelayed(this, POLL_MS);
        }
    };

    /** После каждой страницы смотрим: не появилась ли рабочая сессия. */
    private void check() {
        if (done) return;
        if (bank.equals("sber")) {
            checkSber();
            return;
        }
        String cookies = CookieManager.getInstance().getCookie("https://" + TBank.HOST);
        final String session = value(cookies, "psid");
        if (session == null) return;
        new Thread(() -> {
            if (!TBank.alive(session)) return; // кука есть и у гостя — ждём настоящего входа
            handler.post(() -> connected(SESSION, session, "Т-Банк подключён"));
        }).start();
    }

    /**
     * Сбер узнаёт сессию не по одной куке, а по всему их набору. Кука появляется и у гостя,
     * поэтому не полагаемся на её наличие: пробуем запрос — вошёл ли человек по-настоящему.
     */
    private void checkSber() {
        final String cookies = SberBank.cookies();
        if (cookies == null || checking) return;
        long now = System.currentTimeMillis();
        // Спрашиваем банк, когда куки изменились — значит, со входом что-то произошло.
        // Не чаще раза в 3 с, иначе за время входа набегают десятки запросов и Сбер
        // начинает считать нас роботом. Раз в 10 с проверяем и без изменений — на случай,
        // если последняя кука встала ровно между проверками
        boolean changed = !cookies.equals(lastChecked);
        if (now - lastNet < 3000) return;
        if (!changed && now - lastNet < 10_000) return;
        lastChecked = cookies;
        lastNet = now;
        checking = true;
        say("Проверяем вход…");
        new Thread(() -> {
            int state = SberBank.check(cookies);
            handler.post(() -> {
                checking = false;
                if (state == SberBank.ALIVE) {
                    connected(SBER_SESSION, SberBank.cookies(), "Сбербанк Онлайн подключён");
                } else if (state == SberBank.OFFLINE) {
                    say("Сбер не отвечает: " + SberBank.lastError + ". Ждём…");
                } else {
                    say("Войдите в Сбербанк Онлайн — окно закроется само");
                }
            });
        }).start();
    }

    private void say(String text) {
        if (status != null) status.setText(text);
    }

    /**
     * Назад — последняя проверка: вход мог состояться ровно между опросами, и обиднее
     * всего потерять его на выходе.
     */
    @Override
    public void onBackPressed() {
        String cookies = done || !bank.equals("sber") ? null : SberBank.cookies();
        if (cookies == null || checking) {
            super.onBackPressed();
            return;
        }
        checking = true;
        say("Проверяем вход…");
        new Thread(() -> {
            boolean alive = SberBank.check(cookies) == SberBank.ALIVE;
            handler.post(() -> {
                checking = false;
                if (alive) connected(SBER_SESSION, SberBank.cookies(), "Сбербанк Онлайн подключён");
                else finish();
            });
        }).start();
    }

    private void connected(String key, String session, String toast) {
        if (done) return;
        done = true;
        Secrets secrets = new Secrets(this);
        secrets.put(key, session);
        secrets.put(BankSync.EXPIRED, null);
        Toast.makeText(this, toast, Toast.LENGTH_SHORT).show();
        setResult(RESULT_OK);
        finish();
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
        handler.removeCallbacks(poll);
        if (web != null) {
            web.setVisibility(View.GONE);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
