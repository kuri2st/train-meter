package io.github.kuri2st.trainmeter;

import android.Manifest;
import android.content.Intent;
import android.location.Location;
import android.os.Build;
import android.view.WindowManager;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * JS (docs/app.js) から使う位置取得。window.Capacitor.Plugins.TrainLocation
 *   start()                       権限を確認してサービスを開始。以後 "location" と "tick" イベントを送る
 *   stop()                        サービスを止める
 *   setNotification({title, text}) 通知の表示を変える
 */
@CapacitorPlugin(
    name = "TrainLocation",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class TrainLocationPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        boolean needLoc = getPermissionState("location") != PermissionState.GRANTED;
        boolean needNotif = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState("notifications") == PermissionState.PROMPT;
        if (needLoc && needNotif) requestPermissionForAliases(new String[] { "location", "notifications" }, call, "permCallback");
        else if (needLoc) requestPermissionForAlias("location", call, "permCallback");
        else if (needNotif) requestPermissionForAlias("notifications", call, "permCallback");
        else startService(call);
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) startService(call);
        else call.reject("位置情報の権限がありません");
    }

    private void startService(PluginCall call) {
        TrainLocationService.listener = new TrainLocationService.Listener() {
            @Override
            public void onLocation(Location loc) {
                JSObject o = new JSObject();
                o.put("lat", loc.getLatitude());
                o.put("lon", loc.getLongitude());
                o.put("accuracy", loc.hasAccuracy() ? loc.getAccuracy() : 9999);
                if (loc.hasSpeed()) o.put("speed", loc.getSpeed());
                if (loc.hasBearing()) o.put("heading", loc.getBearing());
                o.put("time", loc.getTime());
                notifyListeners("location", o);
            }

            @Override
            public void onHeartbeat() {
                notifyListeners("tick", new JSObject());
            }
        };
        ContextCompat.startForegroundService(getContext(), new Intent(getContext(), TrainLocationService.class));
        setKeepScreenOn(true);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopService();
        setKeepScreenOn(false);
        call.resolve();
    }

    @PluginMethod
    public void setNotification(PluginCall call) {
        TrainLocationService.update(getContext(), call.getString("title", "train-meter"), call.getString("text", ""));
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopService();
    }

    private void stopService() {
        TrainLocationService.listener = null;
        getContext().stopService(new Intent(getContext(), TrainLocationService.class));
    }

    /** アプリを開いている間は画面を点けたままにする (ブラウザ版の Wake Lock の代わり) */
    private void setKeepScreenOn(boolean on) {
        if (getActivity() == null) return;
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }
}
