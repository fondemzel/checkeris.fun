package ru.checkeris.app;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Один банк для приложения: как спросить у него счета и операции и что из ответа оставить.
 *
 * Всё остальное — загрузка истории по кускам, паузы, отправка в Чекер, мастер на странице —
 * общее для всех банков. Разбор операции в общий вид — на сервере (api/src/bankformat.mjs):
 * его можно улучшать, не переустанавливая приложение.
 */
interface BankAdapter {

    /** Код банка — тот же, что на сервере: tbank. */
    String id();

    /** Счета в общем виде: id, name, type, currency, created (мс, дата открытия), balance. */
    JSONArray accounts(String session) throws Exception;

    /** Операции счёта за период [from, to] в мс — как их отдал банк. */
    JSONArray operations(String session, String account, long from, long to) throws Exception;

    /** Оставить только нужные поля: тот же список, что у сервера. */
    JSONObject trim(JSONObject op, String accountName) throws Exception;

    /** Банк просит подождать: слишком часто спрашиваем. */
    final class RateLimited extends Exception {
        RateLimited(String message) {
            super(message);
        }
    }

    /** Сокращение по списку путей вида «a.b.c». Общее для адаптеров. */
    static JSONObject pick(JSONObject op, String[] fields) throws Exception {
        JSONObject out = new JSONObject();
        for (String path : fields) {
            String[] parts = path.split("\\.");
            Object value = op;
            for (String p : parts) {
                value = value instanceof JSONObject ? ((JSONObject) value).opt(p) : null;
                if (value == null) break;
            }
            if (value == null || value == JSONObject.NULL || "".equals(value)) continue;
            JSONObject target = out;
            for (int i = 0; i < parts.length - 1; i++) {
                JSONObject next = target.optJSONObject(parts[i]);
                if (next == null) {
                    next = new JSONObject();
                    target.put(parts[i], next);
                }
                target = next;
            }
            target.put(parts[parts.length - 1], value);
        }
        return out;
    }
}
