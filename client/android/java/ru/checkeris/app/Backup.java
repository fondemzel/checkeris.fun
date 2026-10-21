package ru.checkeris.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Резервная копия бюджета — на телефоне. Сервер отдаёт снимок бюджета (/api/backup.json,
 * backup.mjs), телефон сжимает его в ZIP и кладёт в «Загрузки/Checker/backup»: эту папку человек
 * видит сам, и копии переживают удаление приложения. Старые копии не удаляются.
 *
 * Делает фоновое задание (BankJobService), когда подошёл срок: раз в день, два, три дня или
 * неделю (настройки — на странице, мост Checker.setBackupEvery). Не вышло — следующая попытка
 * не раньше чем через час, чтобы не стучаться каждые 15 минут.
 *
 * Android 8–9 общую папку «Загрузки» без разрешения на память не даёт — там копии лежат в папке
 * приложения (Android/data/ru.checkeris.app/files/Download/backup).
 */
final class Backup {

    private static final String PREFS = "checker.backup";
    private static final String URL_BACKUP = "https://checkeris.fun/api/backup.json";
    static final String FOLDER = Environment.DIRECTORY_DOWNLOADS + "/Checker/backup";
    private static final long DAY = 24 * 60 * 60 * 1000L;
    private static final long RETRY = 60 * 60 * 1000L;
    // Срок с запасом: задание будит раз в ~15 минут, и копия «раз в день» не должна уползать
    // на сутки и 15 минут каждый раз
    private static final long SLACK = 60 * 60 * 1000L;

    private Backup() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Раз в сколько дней: 1, 2, 3 или 7. */
    static int every(Context context) {
        return prefs(context).getInt("every", 1);
    }

    static void setEvery(Context context, int days) {
        if (days == 1 || days == 2 || days == 3 || days == 7) prefs(context).edit().putInt("every", days).apply();
    }

    /** Пора ли делать копию: срок вышел и после неудачи прошёл час. */
    static boolean due(Context context) {
        SharedPreferences p = prefs(context);
        long now = System.currentTimeMillis();
        if (now - p.getLong("tried", 0) < RETRY && p.getString("error", null) != null) return false;
        return now - p.getLong("last", 0) >= every(context) * DAY - SLACK;
    }

    /** Сделать копию сейчас. Итог — то же, что info(). */
    static synchronized JSONObject run(Context context, String token) {
        SharedPreferences p = prefs(context);
        long now = System.currentTimeMillis();
        try {
            if (token == null) throw new IllegalStateException("нет входа");
            byte[] json = download(token);
            String name = "checker-backup-" + new SimpleDateFormat("yyyy-MM-dd-HHmm", Locale.US).format(new Date(now)) + ".zip";
            byte[] zip = zip(json);
            String uri = save(context, name, zip);
            p.edit().putLong("last", now).putLong("tried", now).putString("name", name).putString("uri", uri)
                    .putLong("size", zip.length).remove("error").apply();
            Trace.log("копия: " + name + ", " + zip.length + " байт");
        } catch (Exception e) {
            p.edit().putLong("tried", now).putString("error", String.valueOf(e.getMessage())).apply();
            Trace.log("копия не вышла: " + e.getMessage());
        }
        return info(context);
    }

    /** Для страницы: частота, последняя копия (когда, файл, размер), последняя ошибка. */
    static JSONObject info(Context context) {
        SharedPreferences p = prefs(context);
        JSONObject o = new JSONObject();
        try {
            o.put("every", every(context));
            o.put("last", p.getLong("last", 0));
            o.put("name", p.getString("name", null));
            o.put("size", p.getLong("size", 0));
            o.put("error", p.getString("error", null));
            o.put("folder", Build.VERSION.SDK_INT >= 29 ? "Загрузки/Checker/backup" : "Android/data/ru.checkeris.app/files/Download/backup");
        } catch (Exception ignored) {
            // JSONObject.put бросает только на нечисловых double
        }
        return o;
    }

    /** «Поделиться последней копией»: обычный список приложений Android. */
    static boolean share(Context context) {
        String uri = prefs(context).getString("uri", null);
        if (uri == null) return false;
        Uri u = Uri.parse(uri);
        if ("file".equals(u.getScheme())) {
            // Android 8–9: файл в папке приложения — отдаём копией через ShareProvider
            try {
                File src = new File(u.getPath());
                File dst = new File(ShareProvider.dir(context), src.getName());
                try (InputStream in = new java.io.FileInputStream(src); OutputStream out = new FileOutputStream(dst)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                u = ShareProvider.uri(dst.getName());
            } catch (Exception e) {
                return false;
            }
        }
        Intent send = new Intent(Intent.ACTION_SEND)
                .setType("application/zip")
                .putExtra(Intent.EXTRA_STREAM, u)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(android.content.ClipData.newRawUri("backup", u));
        Intent chooser = Intent.createChooser(send, "Резервная копия").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(chooser);
        return true;
    }

    private static byte[] download(String token) throws Exception {
        HttpURLConnection http = (HttpURLConnection) new URL(URL_BACKUP).openConnection();
        http.setRequestProperty("Authorization", "Bearer " + token);
        http.setConnectTimeout(30000);
        http.setReadTimeout(120000);
        int code = http.getResponseCode();
        if (code != 200) {
            http.disconnect();
            throw new java.io.IOException("сервер ответил " + code);
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream in = http.getInputStream()) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            http.disconnect();
        }
        return out.toByteArray();
    }

    private static byte[] zip(byte[] json) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
            zip.setLevel(9);
            zip.putNextEntry(new ZipEntry("checker-backup.json"));
            zip.write(json);
            zip.closeEntry();
        }
        return bytes.toByteArray();
    }

    /** Сохранить: Android 10+ — в «Загрузки/Checker/backup» (MediaStore), раньше — в папку приложения. */
    private static String save(Context context, String name, byte[] data) throws Exception {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver cr = context.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, "application/zip");
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, FOLDER);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new java.io.IOException("не создать файл в «Загрузках»");
            try (OutputStream out = cr.openOutputStream(uri)) {
                out.write(data);
            }
            v.clear();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, v, null, null);
            return uri.toString();
        }
        File dir = new File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "backup");
        dir.mkdirs();
        File f = new File(dir, name);
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(data);
        }
        return Uri.fromFile(f).toString();
    }
}
