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
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
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
    private final java.util.Set<String> seenHosts = java.util.Collections.synchronizedSet(new java.util.HashSet<>());

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        String asked = getIntent().getStringExtra("bank");
        if ("sber".equals(asked) || "ozon".equals(asked) || "wb".equals(asked)) bank = asked;
        boolean sber = bank.equals("sber");
        boolean ozon = bank.equals("ozon");
        boolean wb = bank.equals("wb");
        setTitle(sber ? "Вход в Сбербанк Онлайн" : ozon ? "Вход в Озон" : wb ? "Вход в Wildberries" : "Вход в Т-Банк");
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
                android.net.Uri u = android.net.Uri.parse(url);
                Trace.log(bank + " страница: " + u.getHost() + u.getPath());
                check();
            }

            /**
             * Вход идёт здесь и никуда не уходит. Страница банка норовит перебросить человека
             * в своё приложение — ссылкой вида sberbankonline:// или intent://, — и тогда он
             * входит там, а наше окно остаётся пустым и ждёт вечно. Мы — браузер: открываем
             * страницы, а всё остальное пропускаем мимо.
             */
            /**
             * Сбер: куда за выпиской ходит сама страница. Узел у каждой сессии свой, и на
             * чужом Сбер отвечает 403 — поэтому берём адрес у страницы, а не угадываем.
             * Ничего не подменяем: только смотрим адрес и пропускаем запрос как есть.
             */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String host = request.getUrl().getHost();
                if (bank.equals("sber") && host != null && host.endsWith("sberbank.ru") && seenHosts.add(host)) {
                    Trace.log("sber узел страницы: " + host + request.getUrl().getPath());
                }
                if (bank.equals("sber") && SberBank.noticeRequest(request.getUrl())) {
                    Trace.log("sber страница ходит на " + request.getUrl().getHost() + request.getUrl().getPath());
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                Trace.log(bank + " переход: " + scheme + "://" + request.getUrl().getHost() + request.getUrl().getPath());
                return !"https".equals(scheme) && !"http".equals(scheme);
            }

            // Сертификат банка — от Минцифры: пропускаем только если он проверен (MincifryTrust)
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                if (MincifryTrust.accept(BankLoginActivity.this, error)) handler.proceed();
                else handler.cancel();
            }
        });
        web.loadUrl(sber ? SberBank.LOGIN_URL : ozon ? OzonApi.LOGIN_URL : wb ? WbApi.LOGIN_URL : TBank.LOGIN_URL);

        // Сбербанк Онлайн — одностраничное приложение: после входа целая страница не
        // перезагружается, и onPageFinished больше не срабатывает. Поэтому опрашиваем сами
        // Т-Банк тоже может увести в кабинет без перезагрузки — опрашиваем обоих
        handler.postDelayed(poll, POLL_MS);
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
        if (bank.equals("ozon")) {
            checkOzon();
            return;
        }
        if (bank.equals("wb")) {
            checkWb();
            return;
        }
        String cookies = CookieManager.getInstance().getCookie("https://" + TBank.HOST);
        final String session = value(cookies, "psid");
        if (session == null) {
            Trace.log("tbank окно: psid нет");
            return;
        }
        // Пока человек на странице входа, сессия ещё не его: открывая /auth/login/, Т-Банк
        // выдаёт новую куку, которая доли секунды отвечает, а потом просит пин
        // («Недостаточно привилегий»). Окно ловило её и закрывалось раньше, чем человек
        // успевал ввести пин. Вход — это когда банк увёл со страницы входа в кабинет
        String url = web == null ? null : web.getUrl();
        String path = url == null ? null : android.net.Uri.parse(url).getPath();
        if (path == null || path.startsWith("/auth") || path.startsWith("/login")) return;
        if (checking) return;
        checking = true;
        new Thread(() -> {
            int state = TBank.check(session);
            // И сессия должна держаться, а не отвечать мгновение
            if (state == TBank.ALIVE) {
                try {
                    Thread.sleep(1500);
                } catch (InterruptedException ignored) {
                    // проверим сразу
                }
                state = TBank.check(session);
            }
            Trace.log("tbank окно: " + path + " psid " + Trace.mark(session) + " → " + state);
            final boolean alive = state == TBank.ALIVE;
            handler.post(() -> {
                checking = false;
                if (alive) connected(SESSION, session, "Т-Банк подключён");
            });
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
            Trace.log("sber окно: куки " + Trace.mark(cookies) + " → " + state + " " + SberBank.lastDetail);
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

    /**
     * Озон — как Сбер: страница одностраничная, вход узнаём опросом. Вошёл — значит, Озон
     * сам пишет в ответе своей страницы «isLoggedIn». Сессия живёт в куках окна; в хранилище
     * кладём только признак подключения.
     */
    private boolean checkingOzon;

    private void checkOzon() {
        String cookies = OzonApi.cookies();
        if (cookies == null || !cookies.contains("__Secure-access-token") || checkingOzon) return;
        checkingOzon = true;
        new Thread(() -> {
            int state = OzonApi.check();
            Trace.log("ozon окно: вход → " + state);
            handler.post(() -> {
                checkingOzon = false;
                if (state == OzonApi.ALIVE) connected(OzonSync.SESSION, "1", "Озон подключён");
            });
        }).start();
    }

    /**
     * WB: сессия — токен в localStorage страницы, появляется после входа. Нашёлся — проверяем
     * его запросом списка чеков; ответил — вход состоялся, токен в хранилище.
     */
    private String lastWbToken;

    private void checkWb() {
        if (web == null || checking) return;
        web.evaluateJavascript("localStorage.getItem('" + WbApi.TOKEN_KEY + "')", raw -> {
            if (done || checking || raw == null || raw.equals("null") || raw.length() < 100) return;
            String token = raw.replace("\"", "");
            if (token.equals(lastWbToken)) return;
            lastWbToken = token;
            checking = true;
            WbApi.useAgent(web.getSettings().getUserAgentString());
            new Thread(() -> {
                int state = WbApi.check(token);
                Trace.log("wb окно: токен " + Trace.mark(token) + " → " + state);
                handler.post(() -> {
                    checking = false;
                    if (state == WbApi.ALIVE) connected(WbSync.SESSION, token, "Wildberries подключён");
                    else lastWbToken = null; // проверим ещё раз
                });
            }).start();
        });
    }

    private void connected(String key, String session, String toast) {
        if (done) return;
        done = true;
        Secrets secrets = new Secrets(this);
        boolean sber = bank.equals("sber");
        Trace.log(bank + " вход принят, сохраняем " + key + " " + Trace.mark(session));
        secrets.put(key, session);
        // Свой признак у каждого банка: общий стирал чужой отказ, и Сбер после входа
        // так и оставался «просит войти заново»
        secrets.put(sber ? SberSync.EXPIRED : bank.equals("ozon") ? OzonSync.EXPIRED
                : bank.equals("wb") ? WbSync.EXPIRED : BankSync.EXPIRED, null);
        // Первые секунды после входа Сбер выписку ещё не отдаёт — это не повод хоронить сессию
        if (sber) secrets.putLong(SberSync.SINCE, System.currentTimeMillis());
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
