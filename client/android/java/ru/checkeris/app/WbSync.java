package ru.checkeris.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Set;

/**
 * Загрузка чеков Wildberries: телефон листает «Электронные чеки» (свежие сверху), скачивает
 * страницы новых чеков и отправляет их в Чекер — там они разбираются и становятся обычными.
 *
 * Список у WB — вся история, поэтому мастер не нужен: первый запуск проходит его до конца,
 * дальше листаем, пока не встретится страница, где все чеки уже известны.
 */
final class WbSync {

    static final String SESSION = "wb.session"; // токен входа WB
    static final String EXPIRED = "wb.expired";
    private static final int PER_PAGE = 20;
    private static final int MAX_PAGES = 500;

    private WbSync() {}

    static boolean connected(Context context) {
        return new Secrets(context).has(SESSION);
    }

    static boolean expired(Context context) {
        return new Secrets(context).has(EXPIRED); // ставится только "1", снимается удалением
    }

    static void forget(Context context) {
        Secrets secrets = new Secrets(context);
        secrets.put(SESSION, null);
        secrets.put(EXPIRED, null);
    }

    /** Забрать новые чеки и отдать Чекеру. Только в фоновом потоке. */
    static BankSync.Result run(Context context, String checkerToken) {
        Secrets secrets = new Secrets(context);
        String token = secrets.get(SESSION);
        if (token == null) return new BankSync.Result(false, 0, 0, "Wildberries не подключён");

        int added = 0;
        int seen = 0;
        int failed = 0;
        try {
            Set<String> known = OzonSync.known("wb", checkerToken);
            String cursor = "";
            for (int page = 0; page < MAX_PAGES; page++) {
                JSONObject list = WbApi.receipts(token, cursor, PER_PAGE);
                JSONArray receipts = list.optJSONArray("receipts");
                int fresh = 0;
                for (int i = 0; receipts != null && i < receipts.length(); i++) {
                    JSONObject r = receipts.getJSONObject(i);
                    String id = r.optString("receiptUid");
                    seen++;
                    if (id.isEmpty() || known.contains(id)) continue;
                    fresh++;
                    try {
                        String html = WbApi.receipt(r.optString("link"));
                        JSONObject res = OzonSync.post("wb", checkerToken, "/receipts",
                                new JSONObject().put("id", id).put("html", html));
                        if (res.optBoolean("created")) added++;
                    } catch (Exception e) {
                        // Один нечитаемый чек не должен останавливать остальные
                        failed++;
                        Trace.log("wb чек " + id + " не принят: " + e.getMessage());
                    }
                }
                cursor = list.optString("nextReceiptUid", "");
                Trace.log("wb стр." + (page + 1) + ": чеков " + (receipts == null ? 0 : receipts.length()) + ", новых " + fresh);
                // Страница целиком известна — дальше только старое, уже загруженное
                if (cursor.isEmpty() || fresh == 0) break;
            }
            secrets.put(EXPIRED, null);
            OzonSync.post("wb", checkerToken, "/done", new JSONObject());
            Trace.log("wb: просмотрено " + seen + ", новых " + added + ", не принято " + failed);
            if (failed > 0 && added == 0) return new BankSync.Result(false, 0, seen, "WB не отдал чеки (" + failed + ")");
            return new BankSync.Result(true, added, seen, failed > 0 ? "не приняты чеки: " + failed : null);
        } catch (IllegalStateException e) {
            secrets.put(EXPIRED, "1");
            return new BankSync.Result(false, added, seen, e.getMessage());
        } catch (Exception e) {
            return new BankSync.Result(false, added, seen, String.valueOf(e.getMessage()));
        }
    }
}
