package ru.checkeris.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Секреты — сессия банка — хранятся зашифрованными. Ключ лежит в Keystore телефона:
 * он не покидает устройство, и достать его из скопированных файлов нельзя.
 *
 * Библиотек нет намеренно: androidx.security тянет за собой AndroidX, а здесь хватает
 * штатного Keystore и AES-GCM.
 */
final class Secrets {

    private static final String PREFS = "checker";
    private static final String KEY_ALIAS = "checker-secrets";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final int IV_LENGTH = 12;

    private final SharedPreferences prefs;

    Secrets(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        KeyStore.Entry entry = store.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build());
        return generator.generateKey();
    }

    /** Значение или null, если его нет либо расшифровать не вышло (ключ пересоздан). */
    String get(String name) {
        String packed = prefs.getString(name, null);
        if (packed == null) return null;
        try {
            byte[] blob = Base64.decode(packed, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, blob, 0, IV_LENGTH));
            byte[] plain = cipher.doFinal(blob, IV_LENGTH, blob.length - IV_LENGTH);
            return new String(plain, "UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    void put(String name, String value) {
        if (value == null) {
            prefs.edit().remove(name).apply();
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] data = cipher.doFinal(value.getBytes("UTF-8"));
            byte[] blob = new byte[iv.length + data.length];
            System.arraycopy(iv, 0, blob, 0, iv.length);
            System.arraycopy(data, 0, blob, iv.length, data.length);
            prefs.edit().putString(name, Base64.encodeToString(blob, Base64.NO_WRAP)).apply();
        } catch (Exception e) {
            throw new RuntimeException("не удалось сохранить секрет", e);
        }
    }

    /** Обычные настройки, не секреты: когда последний раз забирали операции. */
    long getLong(String name, long fallback) {
        return prefs.getLong(name, fallback);
    }

    void putLong(String name, long value) {
        prefs.edit().putLong(name, value).apply();
    }
}
