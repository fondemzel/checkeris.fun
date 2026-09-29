package ru.checkeris.app;

import android.util.Log;

/**
 * Журнал входа в банк и обновления — для разбора сбоев по adb logcat -s CheckerBank.
 * Сами сессии не пишем никогда: только отпечаток, чтобы сравнить, та же ли это сессия.
 */
final class Trace {

    private static final String TAG = "CheckerBank";

    static void log(String message) {
        Log.i(TAG, message);
    }

    /** Отпечаток секрета: длина и хеш. По нему видно «та же / другая», но не сам секрет. */
    static String mark(String secret) {
        if (secret == null) return "∅";
        return secret.length() + "#" + Integer.toHexString(secret.hashCode());
    }
}
