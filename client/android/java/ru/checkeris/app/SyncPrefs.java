package ru.checkeris.app;

import android.content.Context;
import android.net.ConnectivityManager;

import org.json.JSONObject;

/**
 * Настройки синхронизации: как часто фоновое задание обходит банк или магазин и только ли по
 * Wi-Fi. Живут на телефоне — синхронизация идёт отсюда же. Правит их страница (Настройки →
 * Банки и карточка банка) через мост: syncPrefs / setSyncPrefs.
 *
 * { all: true, every: 15, wifi: false, banks: { sber: { every: 60, wifi: true }, … } }
 * all — общие настройки на все подключения; иначе у каждого свои (чего нет — берётся общее).
 * every — минуты между обращениями; 0 — только вручную, фон этот банк не трогает.
 *
 * Задание система будит не чаще раза в 15 минут: каждый банк — когда подошёл его срок.
 */
final class SyncPrefs {

    private static final String KEY = "sync.prefs";
    private static final String LAST = "sync.last.";
    private static final long SLACK = 3 * 60 * 1000L; // система будит не минута в минуту

    private SyncPrefs() {}

    static JSONObject read(Context context) {
        try {
            String raw = new Secrets(context).get(KEY);
            if (raw != null) return new JSONObject(raw);
        } catch (Exception ignored) {
            // испорчены — как по умолчанию
        }
        try {
            return new JSONObject().put("all", true).put("every", 15).put("wifi", false).put("banks", new JSONObject());
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /** Сохранить то, что прислала страница; разбираем, чтобы не сохранить мусор. */
    static boolean write(Context context, String json) {
        try {
            JSONObject p = new JSONObject(json);
            new Secrets(context).put(KEY, p.toString());
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static JSONObject own(JSONObject p, String bank) {
        JSONObject banks = p.optJSONObject("banks");
        return p.optBoolean("all", true) || banks == null ? null : banks.optJSONObject(bank);
    }

    static int every(JSONObject p, String bank) {
        JSONObject own = own(p, bank);
        return own != null && own.has("every") ? own.optInt("every", 15) : p.optInt("every", 15);
    }

    static boolean wifi(JSONObject p, String bank) {
        JSONObject own = own(p, bank);
        return own != null && own.has("wifi") ? own.optBoolean("wifi") : p.optBoolean("wifi", false);
    }

    /** Пора ли фоновому заданию обратиться к банку: срок подошёл, и сеть подходящая. */
    static boolean due(Context context, String bank) {
        JSONObject p = read(context);
        int every = every(p, bank);
        if (every <= 0) return false; // только вручную
        if (wifi(p, bank)) {
            ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
            if (cm == null || cm.isActiveNetworkMetered()) return false; // мобильный интернет
        }
        long last = new Secrets(context).getLong(LAST + bank, 0);
        return System.currentTimeMillis() - last >= every * 60_000L - SLACK;
    }

    static void ran(Context context, String bank) {
        new Secrets(context).putLong(LAST + bank, System.currentTimeMillis());
    }
}
