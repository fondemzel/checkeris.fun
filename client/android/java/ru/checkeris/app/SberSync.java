package ru.checkeris.app;

import android.content.Context;

import org.json.JSONArray;

/**
 * Обновление операций Сбера: телефон берёт свежую историю той же сессией и отдаёт Чекеру.
 * Аналог BankSync для Т-Банка, но проще: Сбер отдаёт единую историю по всем счетам
 * страницами по offset, перебирать счета не нужно.
 *
 * Обычное обновление берёт последние страницы (недавние операции); всю историю грузит
 * мастер отдельно. Повторы не плодят строк: на сервере ключ — uohId операции.
 */
final class SberSync {

    static final String EXPIRED = "sber.expired"; // Сбер отказал: нужен новый вход руками

    private static final int PAGE = 50;
    private static final int PAGES = 6; // ~300 недавних операций за обычное обновление

    static boolean connected(Context context) {
        return new Secrets(context).get(BankLoginActivity.SBER_SESSION) != null;
    }

    static boolean expired(Context context) {
        return "1".equals(new Secrets(context).get(EXPIRED));
    }

    static void forget(Context context) {
        Secrets secrets = new Secrets(context);
        secrets.put(BankLoginActivity.SBER_SESSION, null);
        secrets.put(EXPIRED, null);
    }

    /** Короткое обращение — держит сессию живой; только в фоновом потоке. */
    static void ping(Context context) {
        Secrets secrets = new Secrets(context);
        String cookies = secrets.get(BankLoginActivity.SBER_SESSION);
        if (cookies == null) return;
        int state = SberBank.check(cookies);
        if (state == SberBank.ALIVE) secrets.put(EXPIRED, null);
        else if (state == SberBank.EXPIRED) secrets.put(EXPIRED, "1");
    }

    /** Забрать недавние операции и отдать Чекеру. Только в фоновом потоке. */
    static BankSync.Result run(Context context, String checkerToken) {
        Secrets secrets = new Secrets(context);
        String cookies = secrets.get(BankLoginActivity.SBER_SESSION);
        if (cookies == null) return new BankSync.Result(false, 0, 0, "Сбер не подключён");

        int state = SberBank.check(cookies);
        if (state == SberBank.OFFLINE) return new BankSync.Result(false, 0, 0, "Сбер не отвечает — попробуйте позже");
        if (state == SberBank.EXPIRED) {
            secrets.put(EXPIRED, "1");
            return new BankSync.Result(false, 0, 0, "Сбер просит войти заново");
        }
        secrets.put(EXPIRED, null);

        long now = System.currentTimeMillis();
        try {
            int added = 0;
            int seen = 0;
            for (int page = 0; page < PAGES; page++) {
                JSONArray ops = SberBank.operations(cookies, page * PAGE, PAGE, now);
                if (ops.length() == 0) break;
                seen += ops.length();
                added += BankSync.send(checkerToken, "sber", ops, false);
                if (ops.length() < PAGE) break; // история кончилась
            }
            return new BankSync.Result(true, added, seen, null);
        } catch (Exception e) {
            return new BankSync.Result(false, 0, 0, String.valueOf(e.getMessage()));
        }
    }
}
