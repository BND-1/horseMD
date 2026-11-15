package com.horsemd.app;

import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * HorseDevice.name() → { name }: a label for this phone in sync conflict-copy
 * names ("HUAWEI SEA-AL10"). Build fields only — no permission, nothing the
 * user typed (the Bluetooth / user-set device name would need one).
 */
@CapacitorPlugin(name = "HorseDevice")
public class HorseDevicePlugin extends Plugin {

    @PluginMethod
    public void name(PluginCall call) {
        String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        String model = Build.MODEL == null ? "" : Build.MODEL.trim();
        String name;
        if (manufacturer.isEmpty()) name = model;
        else if (model.toLowerCase().startsWith(manufacturer.toLowerCase())) name = model;
        else name = manufacturer + " " + model;
        if (name.isEmpty()) name = "Android";
        JSObject out = new JSObject();
        out.put("name", name);
        call.resolve(out);
    }
}
