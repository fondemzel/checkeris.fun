package ru.checkeris.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Файлы, которыми делятся из Чекера (экспорт бюджета): отдаёт их приложению, выбранному в
 * «Поделиться», — только на чтение и только по разрешению из самого запроса (grantUriPermissions).
 * Свой маленький провайдер вместо FileProvider: библиотек AndroidX в сборке нет.
 *
 * Отдаёт только файлы из папки share во внутреннем кэше приложения: путь из адреса берётся
 * последним сегментом, выйти из папки им нельзя.
 */
public final class ShareProvider extends ContentProvider {

    static final String AUTHORITY = "ru.checkeris.app.share";

    static File dir(android.content.Context context) {
        File dir = new File(context.getCacheDir(), "share");
        dir.mkdirs();
        return dir;
    }

    static Uri uri(String name) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(name).build();
    }

    private File file(Uri uri) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || name.contains("/") || name.startsWith(".")) throw new FileNotFoundException();
        File f = new File(dir(getContext()), name);
        if (!f.isFile()) throw new FileNotFoundException(name);
        return f;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        String name = String.valueOf(uri.getLastPathSegment());
        return name.endsWith(".zip") ? "application/zip" : "application/octet-stream";
    }

    /** Имя и размер — их показывает приложение, которому отдали файл. */
    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        try {
            File f = file(uri);
            MatrixCursor c = new MatrixCursor(new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
            c.addRow(new Object[] {f.getName(), f.length()});
            return c;
        } catch (FileNotFoundException e) {
            return null;
        }
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        throw new UnsupportedOperationException();
    }
}
