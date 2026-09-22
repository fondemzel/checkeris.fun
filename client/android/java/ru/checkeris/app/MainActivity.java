package ru.checkeris.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * Весь интерфейс — сайт checkeris.fun/m во встроенном браузере: выкладка сайта обновляет
 * приложение, переустанавливать его не нужно. Родной код делает только то, чего браузер
 * не умеет: даёт камеру, открывает мессенджеры и (дальше) работает с банком.
 *
 * Библиотек нет намеренно — ни AndroidX, ни Gradle: приложение из одного экрана собирается
 * инструментами SDK (scripts/build_apk.sh), как и весь остальной проект живёт без зависимостей.
 */
public class MainActivity extends android.app.Activity {

    private static final String SITE = "https://checkeris.fun/m/";
    private static final String HOST = "checkeris.fun";
    private static final int CAMERA_REQUEST = 1;

    private WebView web;
    private PermissionRequest pendingCamera;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // в localStorage лежит токен входа
        s.setMediaPlaybackRequiresUserGesture(false); // камера сканера включается сама
        s.setSupportMultipleWindows(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) return false; // свой сайт — внутри приложения
                return openOutside(url); // tg://, whatsapp://, mailto: и чужие сайты — наружу
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Камеру у телефона просит приложение, у приложения — страница сканера
                runOnUiThread(() -> {
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(request.getResources());
                        return;
                    }
                    pendingCamera = request;
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_REQUEST);
                });
            }
        });

        web.loadUrl(startUrl(getIntent()));
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code != CAMERA_REQUEST || pendingCamera == null) return;
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) pendingCamera.grant(pendingCamera.getResources());
        else pendingCamera.deny();
        pendingCamera = null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        web.loadUrl(startUrl(intent)); // приглашение открыли, когда приложение уже работало
    }

    /** Ссылка-приглашение открывает нужную страницу, обычный запуск — главную. */
    private String startUrl(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        return data != null && HOST.equals(data.getHost()) ? data.toString() : SITE;
    }

    /** Кнопка «назад» листает историю сайта, а не закрывает приложение. */
    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private boolean openOutside(Uri url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            Toast.makeText(this, "Нет приложения, которое это откроет", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.setVisibility(View.GONE);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
