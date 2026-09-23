package ru.checkeris.app;

import android.content.Context;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;

import java.io.InputStream;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;

/**
 * Сертификат Т-Банка выдан НУЦ Минцифры, которому Android по умолчанию не доверяет.
 *
 * Запросы к API банка проверяются настройкой сети (res/xml/network_security_config.xml),
 * а встроенный браузер её не читает — поэтому для окна входа проверяем сами: страницу
 * пропускаем, только если это домен tbank.ru и его сертификат подписан промежуточным
 * центром Минцифры, который, в свою очередь, подписан официальным корневым.
 * Любая другая ошибка сертификата — отказ, как у обычного браузера.
 */
final class MincifryTrust {

    private static final int[] SUBS = {R.raw.mincifry_sub_2024, R.raw.mincifry_sub_2022};

    private MincifryTrust() {}

    static boolean accept(Context context, SslError error) {
        // Сертификат целиком нужен для проверки подписи — достаётся начиная с Android 10
        if (Build.VERSION.SDK_INT < 29) return false;
        if (error.getPrimaryError() != SslError.SSL_UNTRUSTED) return false; // истёкший или чужой — не спасаем

        String host = Uri.parse(error.getUrl()).getHost();
        if (host == null || !(host.equals("tbank.ru") || host.endsWith(".tbank.ru"))) return false;

        try {
            X509Certificate leaf = error.getCertificate().getX509Certificate();
            if (leaf == null) return false;
            leaf.checkValidity();

            CertificateFactory factory = CertificateFactory.getInstance("X.509");
            X509Certificate root = load(context, factory, R.raw.mincifry_root);
            for (int id : SUBS) {
                X509Certificate sub = load(context, factory, id);
                try {
                    sub.checkValidity();
                    sub.verify(root.getPublicKey());
                    leaf.verify(sub.getPublicKey());
                    return true;
                } catch (Exception wrongSub) {
                    // этот промежуточный не подписывал — пробуем следующий
                }
            }
        } catch (Exception e) {
            return false;
        }
        return false;
    }

    private static X509Certificate load(Context context, CertificateFactory factory, int id) throws Exception {
        try (InputStream in = context.getResources().openRawResource(id)) {
            return (X509Certificate) factory.generateCertificate(in);
        }
    }
}
