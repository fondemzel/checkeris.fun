package ru.checkeris.app;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * Фоновая работа: телефон сам поддерживает сессии банков и магазинов живыми и забирает новые
 * операции и чеки. Итог каждого обращения уходит на сервер (LinkReport): так видно, что банк
 * просит войти заново или что система давно не будила приложение.
 *
 * Сессия интернет-банка живёт, пока к банку обращаются. Пока приложение закрыто, обращаться
 * некому — поэтому система будит нас примерно раз в 15 минут (чаще она не разрешает).
 *
 * Молча: если сессия истекла, человек увидит это в настройках, когда сам зайдёт. Дёргать
 * уведомлением из-за того, что подождёт, незачем.
 *
 * Библиотек нет: JobScheduler штатный, WorkManager тянул бы AndroidX.
 */
public class BankJobService extends JobService {

    private static final int JOB_ID = 1001;
    private static final long PERIOD = 15 * 60 * 1000L; // короче система всё равно не разбудит

    /** Поставить или обновить задание. Вызывается при запуске приложения и после входа в банк. */
    static void schedule(Context context) {
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(context, BankJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(PERIOD)
                .setPersisted(true) // переживает перезагрузку телефона
                .build();
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler != null) scheduler.schedule(job);
    }

    /** Подключено ли хоть что-то: без подключений будить телефон незачем. */
    static boolean anyConnected(Context context) {
        return BankSync.connected(context) || SberSync.connected(context) || WbSync.connected(context) || OzonSync.connected(context);
    }

    static void cancel(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler != null) scheduler.cancel(JOB_ID);
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            String token = new Secrets(this).get(BankSync.TOKEN);
            LinkReport.perms = Perms.summary(this);
            if (token != null) {
                // Каждый — когда подошёл его срок и сеть подходящая (SyncPrefs: как часто, только Wi-Fi)
                if (BankSync.connected(this) && SyncPrefs.due(this, "tbank")) {
                    SyncPrefs.ran(this, "tbank");
                    LinkReport.send(token, "tbank", BankSync.run(this, token), BankSync.expired(this), true);
                }
                if (SberSync.connected(this) && SyncPrefs.due(this, "sber")) {
                    SyncPrefs.ran(this, "sber");
                    LinkReport.send(token, "sber", SberSync.run(this, token), SberSync.expired(this), true);
                }
                // Магазины — тем же заданием: иначе они обновлялись, только пока открыто приложение
                if (WbSync.connected(this) && SyncPrefs.due(this, "wb")) {
                    SyncPrefs.ran(this, "wb");
                    LinkReport.send(token, "wb", WbSync.run(this, token), WbSync.expired(this), true);
                }
                if (OzonSync.connected(this) && SyncPrefs.due(this, "ozon")) {
                    SyncPrefs.ran(this, "ozon");
                    LinkReport.send(token, "ozon", OzonSync.run(this, token), OzonSync.expired(this), true);
                }
            }
            jobFinished(params, false);
        }).start();
        return true; // работа продолжается в потоке
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true; // система прервала — попробуем в следующий раз
    }
}
