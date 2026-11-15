package com.horsemd.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // App-local plugins must be registered before the bridge is created in super.onCreate.
        registerPlugin(HorseFilesPlugin.class);
        // Cloud sync on phones: HTTP client, credential store, device label.
        registerPlugin(HorseHttpPlugin.class);
        registerPlugin(HorseSecureStorePlugin.class);
        registerPlugin(HorseDevicePlugin.class);
        // A re-created activity (process restore, "don't keep activities") gets its
        // launch intent again: the file in it was already delivered once.
        if (savedInstanceState != null) HorseFilesPlugin.markHandled(getIntent());
        super.onCreate(savedInstanceState);
    }
}
