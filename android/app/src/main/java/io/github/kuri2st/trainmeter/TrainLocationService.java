package io.github.kuri2st.trainmeter;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;

/**
 * 画面を消したり別のアプリに切り替えたりしても GPS を取り続けるフォアグラウンドサービス。
 * 測位と 1 秒ごとの合図を TrainLocationPlugin 経由で JS に渡し、通知に次駅などを表示する。
 */
public class TrainLocationService extends Service {

    interface Listener {
        void onLocation(Location loc);

        void onHeartbeat();
    }

    static final String CHANNEL_ID = "train_meter_status";
    static final int NOTIFICATION_ID = 1;
    static final long INTERVAL_MS = 1000;

    static volatile Listener listener;
    private static TrainLocationService instance;
    private static String title = "train-meter";
    private static String text = "測位を開始しています";

    private LocationManager locationManager;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private final Runnable heartbeat = new Runnable() {
        @Override
        public void run() {
            Listener l = listener;
            if (l != null) l.onHeartbeat();
            handler.postDelayed(this, INTERVAL_MS);
        }
    };

    // API 29 以前では onStatusChanged などが抽象メソッドなので全部実装する
    private final LocationListener locationListener = new LocationListener() {
        @Override
        public void onLocationChanged(Location loc) {
            Listener l = listener;
            if (l != null) l.onLocation(loc);
        }

        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) {}

        @Override
        public void onProviderEnabled(String provider) {}

        @Override
        public void onProviderDisabled(String provider) {}
    };

    /** 通知の表示内容を変える (サービスが動いていなければ次の起動時に使う) */
    @SuppressLint("MissingPermission")
    static void update(Context context, String newTitle, String newText) {
        title = newTitle;
        text = newText;
        TrainLocationService s = instance;
        if (s == null) return;
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return;
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, s.buildNotification());
        } catch (SecurityException e) {
            // 通知の権限が無い (Android 13 以降で拒否された) ときは表示しない
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
    }

    @SuppressLint("MissingPermission")
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0;
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);
        if (locationManager == null) {
            locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            try {
                locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER,
                    INTERVAL_MS,
                    0f,
                    locationListener,
                    Looper.getMainLooper()
                );
            } catch (SecurityException | IllegalArgumentException e) {
                stopSelf();
                return START_NOT_STICKY;
            }
            handler.postDelayed(heartbeat, INTERVAL_MS);
        }
        // アプリが終了させられたら作り直さない (JS 側が居ないと意味が無いため)
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(heartbeat);
        if (locationManager != null) locationManager.removeUpdates(locationListener);
        locationManager = null;
        instance = null;
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 最近使ったアプリの一覧から消されたら止める
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "走行中の表示", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("速度と次駅を表示します");
        ch.setShowBadge(false);
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(ch);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_train)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(pi)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }
}
