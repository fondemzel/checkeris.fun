package ru.checkeris.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;

/**
 * Фоновая работа: телефон сам поддерживает сессию банка живой и забирает новые операции.
 *
 * Сессия интернет-банка живёт, пока к банку обращаются. Пока приложение закрыто, обращаться
 * некому — поэтому система будит нас примерно раз в 15 минут (чаще она не разрешает).
 * Если сессия всё-таки истекла, показываем уведомление: войти заново можно только руками.
 *
 * Библиотек нет: JobScheduler и уведомления — штатные, WorkManager тянул бы AndroidX.
 */
public class BankJobService extends JobService {

    private static final int JOB_ID = 1001;
    private static final long PERIOD = 15 * 60 * 1000L; // короче система всё равно не разбудит
    private static final String CHANNEL = "bank";
    private static final int NOTE_ID = 2001;

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
            Secrets secrets = new Secrets(this);
            String token = secrets.get(BankSync.TOKEN);
            boolean connected = BankSync.connected(this);
            if (token != null && connected) {
                BankSync.Result result = BankSync.run(this, token);
                if (!result.ok && !connected(this)) {
                    notify("Т-Банк отключился",
                            "Сессия банка истекла. Откройте Чекер и войдите в банк заново, чтобы операции снова загружались.");
                }
            }
            jobFinished(params, false);
        }).start();
        return true; // работа продолжается в потоке
    }

    private static boolean connected(Context context) {
        return BankSync.connected(context);
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true; // система прервала — попробуем в следующий раз
    }

    private void notify(String title, String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        manager.createNotificationChannel(
                new NotificationChannel(CHANNEL, "Банк", NotificationManager.IMPORTANCE_DEFAULT));
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification note = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build();
        manager.notify(NOTE_ID, note);
    }
}
