package ru.checkeris.app;

import android.app.AppOpsManager;
import android.content.Context;
import android.os.PowerManager;

import java.lang.reflect.Method;

/**
 * Разрешения, без которых система будит фоновое задание редко и сессии банков истекают:
 * работа в фоне без ограничений батареи и «Автозапуск» Xiaomi.
 *
 * Автозапуск — разрешение самой Xiaomi (MIUI/HyperOS) под номером 10008 в общем списке
 * разрешений Android. Спросить о нём можно только скрытым методом checkOpNoThrow: открытого
 * способа нет. Проверено 20.10.2026 на HyperOS: отметка меняется сразу, как человек включает
 * переключатель. На других телефонах и если Xiaomi это сломает — ответ «неизвестно» (null).
 */
final class Perms {

    private static final int OP_AUTOSTART = 10008;

    private Perms() {}

    static boolean unrestricted(Context context) {
        PowerManager pm = context.getSystemService(PowerManager.class);
        return pm != null && pm.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    /** Включён ли автозапуск Xiaomi; null — не Xiaomi или узнать не вышло. */
    static Boolean autostart(Context context) {
        String maker = String.valueOf(android.os.Build.MANUFACTURER).toLowerCase();
        if (!maker.equals("xiaomi") && !maker.equals("redmi") && !maker.equals("poco")) return null;
        try {
            AppOpsManager ops = context.getSystemService(AppOpsManager.class);
            Method check = AppOpsManager.class.getMethod("checkOpNoThrow", int.class, int.class, String.class);
            int mode = (Integer) check.invoke(ops, OP_AUTOSTART, android.os.Process.myUid(), context.getPackageName());
            if (mode == AppOpsManager.MODE_ALLOWED) return true;
            if (mode == AppOpsManager.MODE_IGNORED || mode == AppOpsManager.MODE_ERRORED) return false;
            return null;
        } catch (Throwable e) {
            return null;
        }
    }

    /** Коротко для отчёта серверу: по нему видно, почему фон не приходил. */
    static String summary(Context context) {
        Boolean auto = autostart(context);
        return "фон " + (unrestricted(context) ? "да" : "нет")
                + ", автозапуск " + (auto == null ? "?" : auto ? "да" : "нет");
    }
}
