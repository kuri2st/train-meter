package io.github.kuri2st.trainmeter;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(TrainLocationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
