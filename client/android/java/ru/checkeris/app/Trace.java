package ru.checkeris.app;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Журнал входа в банк и обновления — для разбора сбоев по adb logcat -s CheckerBank.
 * Сами сессии не пишем никогда: только отпечаток, чтобы сравнить, та же ли это сессия.
 *
 * На части телефонов (Xiaomi) системный журнал недоступен, поэтому строки дублируются в файл
 * приложения: adb pull /sdcard/Android/data/ru.checkeris.app/files/trace.log. Файл не растёт
 * бесконечно — после 1 МБ начинается заново.
 */
final class Trace {

    private static final String TAG = "CheckerBank";
    private static final long MAX = 1 << 20;
    private static volatile File file;

    static void init(Context context) {
        File dir = context.getExternalFilesDir(null);
        if (dir != null) file = new File(dir, "trace.log");
    }

    static void log(String message) {
        Log.i(TAG, message);
        File f = file;
        if (f == null) return;
        synchronized (Trace.class) {
            try (FileOutputStream out = new FileOutputStream(f, f.length() < MAX)) {
                String time = new SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US).format(new Date());
                out.write((time + " " + message + "\n").getBytes(StandardCharsets.UTF_8));
            } catch (Exception ignored) {
                // журнал — не повод ронять вход
            }
        }
    }

    /** Отпечаток секрета: длина и хеш. По нему видно «та же / другая», но не сам секрет. */
    static String mark(String secret) {
        if (secret == null) return "∅";
        return secret.length() + "#" + Integer.toHexString(secret.hashCode());
    }
}
