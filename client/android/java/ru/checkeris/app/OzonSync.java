package ru.checkeris.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Загрузка чеков Озона: телефон берёт список «Электронные чеки», скачивает новые PDF и
 * отправляет их в Чекер — там они разбираются и становятся обычными чеками.
 *
 * Чек, который Чекер уже знает, не скачивается второй раз: сервер отдаёт список известных.
 * Поэтому первый запуск забирает всю историю, а дальше — только новое.
 */
final class OzonSync {

    static final String SESSION = "ozon.session"; // признак подключения; сама сессия — в куках окна
    static final String EXPIRED = "ozon.expired";
    private static final String CHECKER = "https://checkeris.fun/api/ozon";

    static boolean connected(Context context) {
        return new Secrets(context).get(SESSION) != null;
    }

    static boolean expired(Context context) {
        return "1".equals(new Secrets(context).get(EXPIRED));
    }

    static void forget(Context context) {
        Secrets secrets = new Secrets(context);
        secrets.put(SESSION, null);
        secrets.put(EXPIRED, null);
    }

    /** Забрать новые чеки и отдать Чекеру. Только в фоновом потоке. */
    static BankSync.Result run(Context context, String checkerToken) {
        Secrets secrets = new Secrets(context);
        if (!connected(context)) return new BankSync.Result(false, 0, 0, "Озон не подключён");

        int state = OzonApi.check();
        Trace.log("ozon обновление: вход → " + state);
        if (state == OzonApi.OFFLINE) return new BankSync.Result(false, 0, 0, "Озон не отвечает — попробуйте позже");
        if (state == OzonApi.EXPIRED) {
            secrets.put(EXPIRED, "1");
            return new BankSync.Result(false, 0, 0, "Озон просит войти заново");
        }
        secrets.put(EXPIRED, null);

        try {
            Set<String> known = known(checkerToken);
            List<String> all = OzonApi.cheques();
            int added = 0;
            int failed = 0;
            for (String id : all) {
                if (known.contains(id)) continue;
                try {
                    JSONObject res = send(checkerToken, id, OzonApi.download(id));
                    if (res.optBoolean("created")) added++;
                } catch (Exception e) {
                    // Один нечитаемый чек не должен останавливать остальные — попробуем в следующий раз
                    failed++;
                    Trace.log("ozon чек " + id + " не принят: " + e.getMessage());
                }
            }
            post(checkerToken, "/done", new JSONObject());
            Trace.log("ozon: всего " + all.size() + ", новых " + added + ", не принято " + failed);
            return new BankSync.Result(true, added, all.size(), failed > 0 ? "не приняты чеки: " + failed : null);
        } catch (IllegalStateException e) {
            secrets.put(EXPIRED, "1");
            return new BankSync.Result(false, 0, 0, e.getMessage());
        } catch (Exception e) {
            return new BankSync.Result(false, 0, 0, String.valueOf(e.getMessage()));
        }
    }

    private static Set<String> known(String token) throws Exception {
        HttpURLConnection http = (HttpURLConnection) new URL(CHECKER + "/known").openConnection();
        http.setRequestProperty("Authorization", "Bearer " + token);
        http.setConnectTimeout(15000);
        http.setReadTimeout(30000);
        int code = http.getResponseCode();
        String body = TBank.read(code >= 400 ? http.getErrorStream() : http.getInputStream());
        http.disconnect();
        if (code >= 400) throw new java.io.IOException("Чекер ответил " + code);
        Set<String> out = new HashSet<>();
        JSONArray ids = new JSONObject(body).optJSONArray("ids");
        for (int i = 0; ids != null && i < ids.length(); i++) out.add(ids.getString(i));
        return out;
    }

    private static JSONObject send(String token, String id, byte[] pdf) throws Exception {
        return post(token, "/receipts", new JSONObject()
                .put("id", id)
                .put("pdf", android.util.Base64.encodeToString(pdf, android.util.Base64.NO_WRAP)));
    }

    private static JSONObject post(String token, String path, JSONObject body) throws Exception {
        HttpURLConnection http = (HttpURLConnection) new URL(CHECKER + path).openConnection();
        http.setRequestMethod("POST");
        http.setRequestProperty("Content-Type", "application/json");
        http.setRequestProperty("Authorization", "Bearer " + token);
        http.setDoOutput(true);
        http.setConnectTimeout(15000);
        http.setReadTimeout(60000);
        try (OutputStream out = http.getOutputStream()) {
            out.write(body.toString().getBytes("UTF-8"));
        }
        int code = http.getResponseCode();
        String answer = TBank.read(code >= 400 ? http.getErrorStream() : http.getInputStream());
        http.disconnect();
        if (code >= 400) throw new java.io.IOException("Чекер ответил " + code + ": " + answer);
        return new JSONObject(answer);
    }
}
