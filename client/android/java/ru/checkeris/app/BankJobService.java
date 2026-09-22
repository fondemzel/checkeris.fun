package ru.checkeris.app;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * Фоновая работа: телефон сам поддерживает сессию банка живой и забирает новые операции.
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

    static void cancel(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler != null) scheduler.cancel(JOB_ID);
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            String token = new Secrets(this).get(BankSync.TOKEN);
            if (token != null && BankSync.connected(this)) BankSync.run(this, token);
            jobFinished(params, false);
        }).start();
        return true; // работа продолжается в потоке
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true; // система прервала — попробуем в следующий раз
    }
}
