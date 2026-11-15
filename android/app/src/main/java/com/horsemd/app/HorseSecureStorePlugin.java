package com.horsemd.app;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * HorseSecureStore: cloud-sync credentials (WebDAV passwords, S3 secret keys).
 *
 * get({ key }) → { value: string | null }, set({ key, value }), remove({ key }),
 * keys({ prefix }) → { keys: [] }.
 *
 * EncryptedSharedPreferences in the file "horsemd_sync_secure" (keys and values
 * encrypted with a Tink keyset that is itself wrapped by an Android Keystore
 * AES256_GCM master key). The file is excluded from auto-backup and device
 * transfer (res/xml/backup_rules.xml, data_extraction_rules.xml): restored on
 * another phone it could not be decrypted (the Keystore key never leaves the
 * device), and EncryptedSharedPreferences would throw on every open.
 */
@CapacitorPlugin(name = "HorseSecureStore")
public class HorseSecureStorePlugin extends Plugin {

    /** Keep in sync with res/xml/backup_rules.xml and data_extraction_rules.xml. */
    static final String PREFS_FILE = "horsemd_sync_secure";

    private SharedPreferences prefs;

    private synchronized SharedPreferences prefs() throws Exception {
        if (prefs != null) return prefs;
        Context context = getContext().getApplicationContext();
        try {
            prefs = open(context);
        } catch (Exception first) {
            // A keyset the Keystore can no longer unwrap (restored from somewhere,
            // Keystore reset): the stored secrets are unreadable anyway. Start
            // over rather than failing forever; sync then asks for the password.
            Logger.error("HorseSecureStore", "Cannot open secure store, recreating it", first);
            context.deleteSharedPreferences(PREFS_FILE);
            prefs = open(context);
        }
        return prefs;
    }

    @SuppressWarnings("deprecation")
    private static SharedPreferences open(Context context) throws Exception {
        MasterKey masterKey = new MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
        return EncryptedSharedPreferences.create(
            context,
            PREFS_FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        );
    }

    private static String requireKey(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.isEmpty()) {
            call.reject("A key is required", "EINVAL");
            return null;
        }
        return key;
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = requireKey(call);
        if (key == null) return;
        try {
            String value = prefs().getString(key, null);
            JSObject out = new JSObject();
            out.put("value", value == null ? JSObject.NULL : value);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Secure store unavailable: " + e.getClass().getSimpleName(), "SECURE_STORE");
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = requireKey(call);
        if (key == null) return;
        String value = call.getString("value");
        if (value == null) {
            call.reject("A string value is required", "EINVAL");
            return;
        }
        try {
            // commit (not apply): the caller treats a resolved set as stored.
            if (!prefs().edit().putString(key, value).commit()) {
                call.reject("Secure store write failed", "SECURE_STORE");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Secure store unavailable: " + e.getClass().getSimpleName(), "SECURE_STORE");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = requireKey(call);
        if (key == null) return;
        try {
            if (!prefs().edit().remove(key).commit()) {
                call.reject("Secure store write failed", "SECURE_STORE");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Secure store unavailable: " + e.getClass().getSimpleName(), "SECURE_STORE");
        }
    }

    @PluginMethod
    public void keys(PluginCall call) {
        String prefix = call.getString("prefix", "");
        if (prefix == null) prefix = "";
        try {
            List<String> found = new ArrayList<>();
            for (String key : prefs().getAll().keySet()) {
                if (key.startsWith(prefix)) found.add(key);
            }
            Collections.sort(found);
            JSArray arr = new JSArray();
            for (String key : found) arr.put(key);
            JSObject out = new JSObject();
            out.put("keys", arr);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Secure store unavailable: " + e.getClass().getSimpleName(), "SECURE_STORE");
        }
    }
}
