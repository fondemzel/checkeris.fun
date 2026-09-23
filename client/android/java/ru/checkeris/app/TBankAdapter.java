package ru.checkeris.app;

import org.json.JSONArray;
import org.json.JSONObject;

/** Т-Банк: веб-API интернет-банка (TBank.java) в общем виде адаптера. */
final class TBankAdapter implements BankAdapter {

    /** Нужные поля операции — тот же список, что в api/src/bankformat.mjs. */
    private static final String[] FIELDS = {
            "id", "account", "accountName", "type", "status", "group", "subgroup.id", "subcategory", "isInner",
            "operationTime.milliseconds", "debitingTime.milliseconds",
            "amount.value", "amount.currency.name", "accountAmount.value", "accountAmount.currency.name",
            "cardNumber", "description", "merchant.name", "brand.id", "brand.name", "merchantKey", "mcc",
            "spendingCategory.id", "spendingCategory.name", "category.name", "categoryInfo.metacategory.name",
            "senderDetails", "payment.comment", "payment.fieldsValues.message", "payment.fieldsValues.maskedFIO",
            "payment.fieldsValues.recipientShortName", "payment.fieldsValues.receiverBankName",
            "refund.type", "hasShoppingReceipt", "loyaltyBonusSummary.amount",
    };

    @Override
    public String id() {
        return "tbank";
    }

    @Override
    public JSONArray accounts(String session) throws Exception {
        JSONArray raw = TBank.accounts(session);
        JSONArray out = new JSONArray();
        for (int i = 0; i < raw.length(); i++) {
            JSONObject a = raw.getJSONObject(i);
            if (a.optString("id").isEmpty()) continue;
            JSONObject created = a.optJSONObject("creationDate");
            JSONObject currency = a.optJSONObject("currency");
            JSONObject money = a.optJSONObject("moneyAmount");
            out.put(new JSONObject()
                    .put("id", a.optString("id"))
                    .put("name", a.optString("name"))
                    .put("type", a.optString("accountType"))
                    .put("currency", currency == null ? "RUB" : currency.optString("name", "RUB"))
                    .put("created", created == null ? 0 : created.optLong("milliseconds"))
                    .put("balance", money == null ? JSONObject.NULL : money.opt("value")));
        }
        return out;
    }

    @Override
    public JSONArray operations(String session, String account, long from, long to) throws Exception {
        try {
            return TBank.operations(session, account, from, to);
        } catch (IllegalStateException e) {
            if (TBank.RATE_LIMIT.equals(e.getMessage())) throw new RateLimited(e.getMessage());
            throw e;
        }
    }

    @Override
    public JSONObject trim(JSONObject op, String accountName) throws Exception {
        if (accountName != null) op.put("accountName", accountName);
        return BankAdapter.pick(op, FIELDS);
    }
}
