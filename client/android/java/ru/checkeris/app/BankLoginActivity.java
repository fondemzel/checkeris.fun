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
import android.widget.Toast;

import java.util.HashSet;
import java.util.Set;

/**
 * Окно входа в интернет-банк. Это обычный браузер: страницу открывает банк, телефон,
 * код из СМС и пароль вводит человек. Приложение ничего не заполняет и не обходит —
 * оно лишь ждёт, когда вход состоится, и забирает сессию.
 *
 * Сессия сохраняется в защищённом хранилище телефона (Secrets) и никуда не уходит:
 * на сервер Чекера отправляются только готовые операции.
 *
 * Как только вход замечен, окно закрывается — главную страницу банка человек не видит.
 * Рабочей сессия становится не в тот же миг, поэтому первые запросы за выпиской могут
 * получить отказ; выжидает их уже приложение (SberSync), где крутится стрелка обновления.
 */
public class BankLoginActivity extends Activity {

    static final String SESSION = "tbank.session";
    static final String SBER_SESSION = "sber.session";

    private WebView web;
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
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportMultipleWindows(false);

        SberBank.useAgent(WebSettings.getDefaultUserAgent(this));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                check();
            }

            // Самый ранний признак входа в Сбер: адрес ушёл со страницы входа
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                leftLoginPage(url);
            }

            // Сбербанк Онлайн — одностраничное приложение: после входа адрес меняется
            // без новой загрузки, и onPageStarted уже не срабатывает
            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean reload) {
                leftLoginPage(url);
            }

            // Смотрим, к какому узлу банк ходит за выпиской: у каждой сессии он свой.
            // Ничего не подменяем — возвращаем null, запрос идёт как шёл
            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(
                    WebView view, android.webkit.WebResourceRequest request) {
                if (bank.equals("sber") && SberBank.noticeRequest(request.getUrl())) {
                    handler.post(() -> signedIn()); // банк сам полез за выпиской — вход есть
                }
                return null;
            }

            // Сертификат банка — от Минцифры: пропускаем только если он проверен (MincifryTrust)
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                if (MincifryTrust.accept(BankLoginActivity.this, error)) handler.proceed();
                else handler.cancel();
            }
        });
        web.loadUrl(sber ? SberBank.LOGIN_URL : TBank.LOGIN_URL);

        if (sber) {
            handler.postDelayed(watch, WATCH_MS);
            handler.postDelayed(poll, POLL_MS);
        }
    }

    // ── Сбер: ловим вход ──────────────────────────────────────

    // Куки, по которым видно вошедшего. Читать их дёшево — это не запрос в сеть, поэтому
    // смотрим часто и ловим вход в тот же миг, когда банк отвечает на него
    private static final long WATCH_MS = 200;
    private static final String[] MARKERS = {"SBTSBOL_SESSION", "sb-sid", "TOKEN"};
    private Set<String> baseline; // что было до входа: гостю тоже кое-что выдают

    private final Runnable watch = new Runnable() {
        @Override
        public void run() {
            if (done) return;
            Set<String> now = markers(SberBank.cookies());
            if (baseline == null) baseline = now; // с чем пришли, то и не считаем входом
            else if (!baseline.containsAll(now)) signedIn(); // появилась новая — вошли
            handler.postDelayed(this, WATCH_MS);
        }
    };

    private static Set<String> markers(String cookies) {
        Set<String> found = new HashSet<>();
        if (cookies == null) return found;
        for (String name : MARKERS) if (cookies.contains(name + "=")) found.add(name);
        return found;
    }

    private static final String LOGIN_PAGE = "CSAFront"; // адрес страницы входа Сбера
    private boolean sawLoginPage; // до неё адреса ещё ничего не значат

    private void leftLoginPage(String url) {
        if (done || !bank.equals("sber") || url == null) return;
        if (url.contains(LOGIN_PAGE)) {
            sawLoginPage = true;
            return;
        }
        if (sawLoginPage && url.contains("online.sberbank.ru")) signedIn();
    }

    private boolean handedOff; // окно уже убрано с экрана
    private long handedOffAt;
    private static final long SETUP_MS = 60_000; // сколько ждём, пока вход дозавершится

    /**
     * Вход замечен. Окно уходит с экрана — человек сразу возвращается в приложение, — но
     * не закрывается: банк ещё досылает запросы, и если убить браузер, вход не завершится
     * и сессия останется негодной. Закроемся, когда банк отдаст выписку.
     */
    private void signedIn() {
        if (done || handedOff) return;
        if (markers(SberBank.cookies()).isEmpty()) return; // куки входа ещё нет — рано
        handedOff = true;
        handedOffAt = System.currentTimeMillis();
        moveTaskToBack(true); // окно живёт дальше, но его не видно
        handler.post(finishWhenReady);
    }

    /** Ждём за кулисами, пока сессия заработает, и только тогда закрываем окно. */
    private final Runnable finishWhenReady = new Runnable() {
        @Override
        public void run() {
            if (done) return;
            if (System.currentTimeMillis() - handedOffAt > SETUP_MS) {
                MainActivity.bankReady(bank, false); // не дождались — страница снимет стрелку
                finish();
                return;
            }
            check();
            handler.postDelayed(this, 2000);
        }
    };

    // ── запасной путь: спросить у банка ──────────────────────
    // Если куки почему-то не поменяются, вход заметит обычный запрос за выпиской

    private static final long POLL_MS = 3000;
    private boolean checking; // одна проверка за раз, чтобы запросы не наслаивались

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            if (done) return;
            check();
            handler.postDelayed(this, POLL_MS);
        }
    };

    private void check() {
        if (done || checking) return;
        if (bank.equals("sber")) {
            final String cookies = SberBank.cookies();
            if (cookies == null || markers(cookies).isEmpty()) return;
            checking = true;
            new Thread(() -> {
                boolean alive = SberBank.check(cookies) == SberBank.ALIVE;
                handler.post(() -> {
                    checking = false;
                    if (alive) connected(SBER_SESSION, SberBank.cookies(), "Сбербанк Онлайн подключён");
                });
            }).start();
            return;
        }
        String cookies = CookieManager.getInstance().getCookie("https://" + TBank.HOST);
        final String session = value(cookies, "psid");
        if (session == null) return;
        checking = true;
        new Thread(() -> {
            boolean alive = TBank.alive(session); // кука есть и у гостя — ждём настоящего входа
            handler.post(() -> {
                checking = false;
                if (alive) connected(SESSION, session, "Т-Банк подключён");
            });
        }).start();
    }

    /** Назад — последний шанс заметить вход: он мог случиться только что. */
    @Override
    public void onBackPressed() {
        if (!done && bank.equals("sber") && !markers(SberBank.cookies()).isEmpty()) {
            signedIn();
            return;
        }
        super.onBackPressed();
    }

    private void connected(String key, String session, String toast) {
        if (done) return;
        done = true;
        Secrets secrets = new Secrets(this);
        secrets.put(key, session);
        // Снимаем пометку «нужен вход» у того банка, в который вошли
        secrets.put(bank.equals("sber") ? SberSync.EXPIRED : BankSync.EXPIRED, null);
        // Запоминаем время входа: первые секунды банк ещё дозаводит сессию, и приложению
        // надо это переждать, а не объявлять её негодной
        if (bank.equals("sber")) secrets.putLong(SberSync.SINCE, System.currentTimeMillis());
        Toast.makeText(this, toast, Toast.LENGTH_SHORT).show();
        setResult(RESULT_OK);
        // Окно могло уже уйти с экрана — тогда странице надо сказать, что можно обновляться
        if (handedOff) MainActivity.bankReady(bank, true);
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
        handler.removeCallbacks(watch);
        handler.removeCallbacks(finishWhenReady);
        if (web != null) {
            web.setVisibility(View.GONE);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
