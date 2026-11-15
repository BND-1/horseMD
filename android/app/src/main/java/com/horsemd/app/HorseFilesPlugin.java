package com.horsemd.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import android.graphics.Color;
import android.view.View;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * HorseFiles: open and edit Markdown files / folders that live outside the app,
 * in place, through the Storage Access Framework (Markor-style).
 *
 * A "root" is one grant: a single document uri (kind "file") or a tree uri
 * (kind "folder"). Persistent roots hold a persisted uri permission and are
 * stored in SharedPreferences("horsefiles"); transient roots (a temporary
 * "open with" grant that cannot be persisted) live in memory only.
 *
 * Threading: Capacitor runs every @PluginMethod on its "CapacitorPlugins"
 * handler thread, so blocking provider IO is fine there. Activity callbacks
 * and handleOnNewIntent arrive on the main thread; they hop back to the plugin
 * thread with execute(), which also serializes all access to the state below.
 */
@CapacitorPlugin(name = "HorseFiles")
public class HorseFilesPlugin extends Plugin {

    private static final String PREFS = "horsefiles";
    private static final String PREFS_KEY = "roots";
    private static final String EVENT_INCOMING = "incoming";
    /** Marks an Intent whose file was already queued (load() and handleOnNewIntent both see the launch intent). */
    static final String EXTRA_HANDLED = "com.horsemd.horsefiles.handled";
    /** Shared plain text (SEND without a stream) is written here and handed over as a file:// copy. */
    private static final String INCOMING_TEXT_DIR = "horsefiles-incoming";
    /** Keep the old bytes for a rollback when a write fails half way (SAF has no atomic replace). */
    private static final long MAX_ROLLBACK_BYTES = 8L * 1024 * 1024;

    private static final String[] DOC_COLS = {
        Document.COLUMN_DOCUMENT_ID,
        Document.COLUMN_DISPLAY_NAME,
        Document.COLUMN_MIME_TYPE,
        Document.COLUMN_LAST_MODIFIED,
        Document.COLUMN_SIZE,
        Document.COLUMN_FLAGS
    };

    private static final String[] PICK_MIME_TYPES = { "text/markdown", "text/x-markdown", "text/plain", "application/octet-stream" };

    private static final int RW = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;

    private final SecureRandom random = new SecureRandom();
    private final Object lock = new Object();
    /** id → persistent root, insertion ordered. Loaded lazily from SharedPreferences. */
    private LinkedHashMap<String, RootRec> persistent;
    /** id → transient root (process lifetime only). */
    private final LinkedHashMap<String, RootRec> transientRoots = new LinkedHashMap<>();
    /** (root id, rel) → documentId for folder roots. */
    private final HashMap<String, String> docIdCache = new HashMap<>();
    /** Incoming items not yet delivered (no listener yet). Plugin thread only. */
    private final ArrayList<JSObject> pendingIncoming = new ArrayList<>();

    // ---------------------------------------------------------------------
    // Model
    // ---------------------------------------------------------------------

    private static final class RootRec {

        String id;
        String kind; // "file" | "folder"
        String name;
        String uri;
        boolean writable;
        boolean persistent;

        boolean isFolder() {
            return "folder".equals(kind);
        }
    }

    /** One document as a provider describes it. size / flags are -1 when unknown. */
    private static final class DocInfo {

        String docId;
        Uri uri;
        String name;
        String mime;
        long mtime;
        long size = -1;
        int flags = -1;

        boolean isDir() {
            return Document.MIME_TYPE_DIR.equals(mime);
        }

        boolean hasFlag(int f) {
            return flags != -1 && (flags & f) != 0;
        }
    }

    private static final class HFException extends Exception {

        final String code;

        HFException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    // ---------------------------------------------------------------------
    // Lifecycle + incoming files
    // ---------------------------------------------------------------------

    @Override
    public void load() {
        Activity activity = getActivity();
        if (activity != null) handleIntent(activity.getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleIntent(intent);
    }

    /** Called by MainActivity for a re-created activity: its launch intent was already delivered. */
    static void markHandled(Intent intent) {
        if (intent == null) return;
        try {
            intent.putExtra(EXTRA_HANDLED, true);
        } catch (RuntimeException ignored) {}
    }

    private static boolean isHandled(Intent intent) {
        try {
            return intent.getBooleanExtra(EXTRA_HANDLED, false);
        } catch (RuntimeException e) {
            // A sender's extras that cannot be unparcelled: treat as handled, never crash.
            return true;
        }
    }

    @SuppressWarnings("deprecation")
    private void handleIntent(Intent intent) {
        if (intent == null || isHandled(intent)) return;
        String action = intent.getAction();
        boolean view = Intent.ACTION_VIEW.equals(action) || Intent.ACTION_EDIT.equals(action);
        boolean send = Intent.ACTION_SEND.equals(action);
        if (!view && !send) return;
        markHandled(intent);
        // Re-launched from Recents: the system replays the original intent, whose file was handled long ago.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;

        if (view) {
            Uri uri = intent.getData();
            if (isFileOrContent(uri)) enqueueIncoming(uri.toString(), true);
            return;
        }
        Uri stream = null;
        try {
            Object extra = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (extra instanceof Uri) stream = (Uri) extra;
        } catch (RuntimeException ignored) {}
        if (isFileOrContent(stream)) {
            enqueueIncoming(stream.toString(), true);
            return;
        }
        CharSequence text = null;
        String subject = null;
        try {
            text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        } catch (RuntimeException ignored) {}
        if (text == null || text.length() == 0) return;
        final String body = text.toString();
        final String title = subject;
        // Plain shared text (a SEND text/plain without a file): hand it over as a copy.
        execute(() -> {
            try {
                File file = writeSharedText(title, body);
                deliverIncoming(Uri.fromFile(file).toString(), false);
            } catch (IOException e) {
                Logger.error(getLogTag(), "Could not keep shared text", e);
            }
        });
    }

    private static boolean isFileOrContent(Uri uri) {
        if (uri == null) return false;
        String s = uri.getScheme();
        return ContentResolver.SCHEME_CONTENT.equals(s) || ContentResolver.SCHEME_FILE.equals(s);
    }

    private File writeSharedText(String subject, String body) throws IOException {
        File dir = new File(getContext().getCacheDir(), INCOMING_TEXT_DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create " + dir);
        String base = subject == null ? "" : subject.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", " ").trim();
        if (base.length() > 60) base = base.substring(0, 60).trim();
        if (base.isEmpty() || base.startsWith(".")) base = "Shared text";
        // A private sub-folder per item keeps the exact display name while avoiding clashes.
        File itemDir = new File(dir, newId());
        if (!itemDir.mkdirs()) throw new IOException("Cannot create " + itemDir);
        File file = new File(itemDir, base + ".md");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(body.getBytes(StandardCharsets.UTF_8));
        }
        return file;
    }

    private void enqueueIncoming(String url, boolean inPlace) {
        execute(() -> deliverIncoming(url, inPlace));
    }

    /**
     * Plugin thread only. One item goes ONE way: straight to a listener when JS
     * listens, else into the pendingIncoming queue (flushed by pendingIncoming()
     * or by the first addListener). Never both, so nothing arrives twice.
     */
    private void deliverIncoming(String url, boolean inPlace) {
        JSObject item = new JSObject();
        item.put("url", url);
        item.put("inPlace", inPlace);
        if (hasListeners(EVENT_INCOMING)) {
            notifyListeners(EVENT_INCOMING, item, true);
        } else {
            pendingIncoming.add(item);
        }
    }

    /**
     * Not a file method, but the one native hook the app needs besides files:
     * on Android 15+ (edge to edge) Capacitor pads the WebView below the status
     * bar and above the navigation bar, and those strips show the window's own
     * background — fixed at capacitor.config's light colour, so a dark theme
     * had a white status bar with white icons. JS passes the top bar colour.
     */
    @PluginMethod
    public void setSystemBarColor(PluginCall call) {
        String value = call.getString("color");
        getActivity().runOnUiThread(() -> {
            try {
                int color = Color.parseColor(value);
                View parent = (View) getBridge().getWebView().getParent();
                if (parent != null) parent.setBackgroundColor(color);
                getActivity().getWindow().getDecorView().setBackgroundColor(color);
                call.resolve();
            } catch (Exception e) {
                call.reject("Bad colour: " + value, "EINVAL");
            }
        });
    }

    @Override
    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void addListener(PluginCall call) {
        super.addListener(call);
        // Items that came in between pendingIncoming() and this listener.
        if (EVENT_INCOMING.equals(call.getString("eventName")) && !pendingIncoming.isEmpty()) {
            ArrayList<JSObject> items = new ArrayList<>(pendingIncoming);
            pendingIncoming.clear();
            for (JSObject item : items) notifyListeners(EVENT_INCOMING, item, true);
        }
    }

    @PluginMethod
    public void pendingIncoming(PluginCall call) {
        JSArray items = new JSArray();
        for (JSObject item : pendingIncoming) items.put(item);
        pendingIncoming.clear();
        JSObject ret = new JSObject();
        ret.put("items", items);
        call.resolve(ret);
    }

    // ---------------------------------------------------------------------
    // Pickers
    // ---------------------------------------------------------------------

    @PluginMethod
    public void pickFiles(PluginCall call) {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, PICK_MIME_TYPES);
            if (call.getBoolean("multiple", false)) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            intent.addFlags(RW | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(call, intent, "pickFilesResult");
        } catch (Exception e) {
            fail(call, e);
        }
    }

    @ActivityCallback
    private void pickFilesResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        final Intent data = result.getData();
        final boolean ok = result.getResultCode() == Activity.RESULT_OK && data != null;
        execute(() -> {
            try {
                JSArray roots = new JSArray();
                if (ok) {
                    List<Uri> uris = new ArrayList<>();
                    ClipData clip = data.getClipData();
                    if (clip != null) {
                        for (int i = 0; i < clip.getItemCount(); i++) {
                            Uri u = clip.getItemAt(i).getUri();
                            if (u != null) uris.add(u);
                        }
                    } else if (data.getData() != null) {
                        uris.add(data.getData());
                    }
                    for (Uri uri : uris) {
                        // Accept whatever the user picked (no extension filter).
                        RootRec rec = adoptContentUri(uri, "file");
                        if (rec != null) roots.put(rootJson(rec));
                    }
                }
                JSObject ret = new JSObject();
                ret.put("roots", roots);
                call.resolve(ret);
            } catch (Exception e) {
                fail(call, e);
            } finally {
                getBridge().releaseCall(call);
            }
        });
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(RW | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            startActivityForResult(call, intent, "pickFolderResult");
        } catch (Exception e) {
            fail(call, e);
        }
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        final Intent data = result.getData();
        final Uri tree = result.getResultCode() == Activity.RESULT_OK && data != null ? data.getData() : null;
        execute(() -> {
            try {
                JSObject ret = new JSObject();
                if (tree != null) {
                    RootRec rec = adoptContentUri(tree, "folder");
                    if (rec != null) ret.put("root", rootJson(rec));
                }
                call.resolve(ret);
            } catch (Exception e) {
                fail(call, e);
            } finally {
                getBridge().releaseCall(call);
            }
        });
    }

    /**
     * Take a persistable grant on a picked uri and store it as a root. Returns the
     * existing root when the same uri was granted before (no duplicates).
     */
    private RootRec adoptContentUri(Uri uri, String kind) throws HFException {
        Boolean write = takePersistable(uri);
        if (write == null) {
            // A picker always returns persistable grants; if not, keep it for this run only.
            RootRec rec = newRoot(kind, uri, displayName(uri, kind), canWriteNow(uri), false);
            return rec;
        }
        String name = displayName(uri, kind);
        boolean writable = write && providerAllowsWrite(uri, kind);
        return upsertPersistent(kind, uri, name, writable);
    }

    /** true = read+write persisted, false = read only persisted, null = not persistable. */
    private Boolean takePersistable(Uri uri) {
        ContentResolver cr = getContext().getContentResolver();
        try {
            cr.takePersistableUriPermission(uri, RW);
            return true;
        } catch (SecurityException e) {
            try {
                cr.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                return false;
            } catch (SecurityException e2) {
                return null;
            }
        }
    }

    private boolean canWriteNow(Uri uri) {
        return (
            getContext().checkCallingOrSelfUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION) ==
            PackageManager.PERMISSION_GRANTED
        );
    }

    private boolean canReadNow(Uri uri) {
        return (
            getContext().checkCallingOrSelfUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) ==
            PackageManager.PERMISSION_GRANTED
        );
    }

    private boolean providerAllowsWrite(Uri uri, String kind) {
        try {
            DocInfo info = "folder".equals(kind) ? queryTreeRoot(uri) : querySingle(uri);
            if (info == null || info.flags == -1) return true; // unknown: let the write itself decide
            return "folder".equals(kind) ? info.hasFlag(Document.FLAG_DIR_SUPPORTS_CREATE) : info.hasFlag(Document.FLAG_SUPPORTS_WRITE);
        } catch (Exception e) {
            return true;
        }
    }

    private String displayName(Uri uri, String kind) {
        try {
            DocInfo info = "folder".equals(kind) ? queryTreeRoot(uri) : querySingle(uri);
            if (info != null && info.name != null && !info.name.isEmpty()) return info.name;
        } catch (Exception ignored) {}
        String last = uri.getLastPathSegment();
        if (last != null) {
            // Document ids look like "primary:Notes/todo.md"; show the last part.
            int slash = Math.max(last.lastIndexOf('/'), last.lastIndexOf(':'));
            String tail = slash >= 0 ? last.substring(slash + 1) : last;
            if (!tail.isEmpty()) return tail;
        }
        return "folder".equals(kind) ? "Folder" : "untitled.md";
    }

    // ---------------------------------------------------------------------
    // Incoming file adoption
    // ---------------------------------------------------------------------

    @PluginMethod
    public void adopt(PluginCall call) {
        try {
            String url = call.getString("url");
            if (url == null || url.isEmpty()) throw new HFException("EINVAL", "Missing url");
            Uri uri = Uri.parse(url);
            String scheme = uri.getScheme();
            JSObject ret = new JSObject();
            if (ContentResolver.SCHEME_CONTENT.equals(scheme)) {
                // A document inside a folder the user already added is that folder's
                // file (JS focuses the tab it may already have open). Works for
                // providers whose document ids are paths (external storage).
                JSObject inside = folderContaining(uri);
                if (inside != null) {
                    call.resolve(inside);
                    return;
                }
                Boolean write = takePersistable(uri);
                if (write != null) {
                    ret.put("root", rootJson(upsertPersistent("file", uri, displayName(uri, "file"), write && providerAllowsWrite(uri, "file"))));
                } else if (canWriteNow(uri)) {
                    // Not persistable (WeChat and most "open with" senders), but writable for
                    // as long as this activity lives: a transient root.
                    ret.put("root", rootJson(newRoot("file", uri, displayName(uri, "file"), true, false)));
                } else {
                    ret.put("copy", copyOf(uri));
                }
            } else if (ContentResolver.SCHEME_FILE.equals(scheme)) {
                ret.put("copy", copyOf(uri));
                deleteIfOwnSharedText(uri);
            } else {
                throw new HFException("EINVAL", "Unsupported url: " + url);
            }
            call.resolve(ret);
        } catch (Exception e) {
            fail(call, e);
        }
    }

    private JSObject folderContaining(Uri uri) {
        try {
            if (!DocumentsContract.isDocumentUri(getContext(), uri)) return null;
            String docId = DocumentsContract.getDocumentId(uri);
            java.util.List<RootRec> all = new java.util.ArrayList<>(persistentRoots().values());
            all.addAll(transientRoots.values());
            for (RootRec rec : all) {
                if (!"folder".equals(rec.kind)) continue;
                Uri tree = Uri.parse(rec.uri);
                if (tree.getAuthority() == null || !tree.getAuthority().equals(uri.getAuthority())) continue;
                String treeId = DocumentsContract.getTreeDocumentId(tree);
                if (treeId == null || !docId.startsWith(treeId + "/")) continue;
                String rel = docId.substring(treeId.length() + 1);
                if (rel.isEmpty()) continue;
                JSObject ret = new JSObject();
                ret.put("root", rootJson(rec));
                ret.put("rel", rel);
                return ret;
            }
        } catch (Exception ignored) {
            // Not a document uri we can compare: open it as its own root.
        }
        return null;
    }

    private JSObject copyOf(Uri uri) throws IOException, HFException {
        String name = displayName(uri, "file");
        byte[] bytes = readBytes(uri);
        JSObject copy = new JSObject();
        copy.put("name", name);
        copy.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
        return copy;
    }

    private void deleteIfOwnSharedText(Uri uri) {
        try {
            String path = uri.getPath();
            if (path == null) return;
            File file = new File(path).getCanonicalFile();
            File dir = new File(getContext().getCacheDir(), INCOMING_TEXT_DIR).getCanonicalFile();
            File parent = file.getParentFile();
            if (parent != null && dir.equals(parent.getParentFile())) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                //noinspection ResultOfMethodCallIgnored
                parent.delete();
            }
        } catch (IOException ignored) {}
    }

    // ---------------------------------------------------------------------
    // Roots
    // ---------------------------------------------------------------------

    @PluginMethod
    public void roots(PluginCall call) {
        try {
            JSArray list = new JSArray();
            List<RootRec> all;
            synchronized (lock) {
                all = new ArrayList<>(persistentRoots().values());
                all.addAll(transientRoots.values());
            }
            boolean changed = false;
            for (RootRec rec : all) {
                if (isAccessible(rec)) {
                    String name = null;
                    try {
                        DocInfo info = rec.isFolder() ? queryTreeRoot(Uri.parse(rec.uri)) : querySingle(Uri.parse(rec.uri));
                        if (info != null) name = info.name;
                    } catch (Exception ignored) {}
                    if (name != null && !name.isEmpty() && !name.equals(rec.name)) {
                        rec.name = name;
                        changed |= rec.persistent;
                    }
                }
                list.put(rootJson(rec));
            }
            if (changed) savePersistent();
            JSObject ret = new JSObject();
            ret.put("roots", list);
            call.resolve(ret);
        } catch (Exception e) {
            fail(call, e);
        }
    }

    @PluginMethod
    public void forget(PluginCall call) {
        try {
            String id = call.getString("id");
            RootRec rec;
            synchronized (lock) {
                rec = persistentRoots().remove(id);
                if (rec == null) rec = transientRoots.remove(id);
            }
            if (rec != null) {
                invalidateRoot(rec.id);
                if (rec.persistent) {
                    savePersistent();
                    releaseGrant(rec.uri);
                }
            }
            call.resolve();
        } catch (Exception e) {
            fail(call, e);
        }
    }

    private void releaseGrant(String uri) {
        // Another root on the same uri keeps the grant (should not happen: uris are de-duplicated).
        synchronized (lock) {
            for (RootRec r : persistentRoots().values()) if (r.uri.equals(uri)) return;
        }
        UriPermission p = findPersisted(uri);
        if (p == null) return;
        int flags = (p.isReadPermission() ? Intent.FLAG_GRANT_READ_URI_PERMISSION : 0) |
        (p.isWritePermission() ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION : 0);
        try {
            getContext().getContentResolver().releasePersistableUriPermission(p.getUri(), flags);
        } catch (SecurityException ignored) {}
    }

    private UriPermission findPersisted(String uri) {
        for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (p.getUri().toString().equals(uri)) return p;
        }
        return null;
    }

    private boolean isAccessible(RootRec rec) {
        if (rec.persistent) {
            UriPermission p = findPersisted(rec.uri);
            return p != null && (p.isReadPermission() || p.isWritePermission());
        }
        return canReadNow(Uri.parse(rec.uri));
    }

    private JSObject rootJson(RootRec rec) {
        boolean accessible = isAccessible(rec);
        boolean writable = rec.writable;
        if (rec.persistent) {
            UriPermission p = findPersisted(rec.uri);
            writable = writable && p != null && p.isWritePermission();
        }
        JSObject o = new JSObject();
        o.put("id", rec.id);
        o.put("kind", rec.kind);
        o.put("name", rec.name);
        o.put("writable", writable);
        o.put("persistent", rec.persistent);
        o.put("accessible", accessible);
        return o;
    }

    private RootRec upsertPersistent(String kind, Uri uri, String name, boolean writable) {
        RootRec rec = null;
        synchronized (lock) {
            for (RootRec r : persistentRoots().values()) {
                if (r.uri.equals(uri.toString())) {
                    rec = r;
                    break;
                }
            }
            if (rec == null) {
                // A transient root for the same uri becomes persistent.
                Iterator<RootRec> it = transientRoots.values().iterator();
                while (it.hasNext()) {
                    RootRec r = it.next();
                    if (r.uri.equals(uri.toString())) {
                        it.remove();
                        rec = r;
                        break;
                    }
                }
                if (rec == null) {
                    rec = new RootRec();
                    rec.id = newId();
                    rec.uri = uri.toString();
                }
                rec.persistent = true;
                persistentRoots().put(rec.id, rec);
            }
            rec.kind = kind;
            rec.name = name;
            rec.writable = writable;
        }
        savePersistent();
        return rec;
    }

    private RootRec newRoot(String kind, Uri uri, String name, boolean writable, boolean persistentRoot) {
        synchronized (lock) {
            for (RootRec r : transientRoots.values()) {
                if (r.uri.equals(uri.toString())) {
                    r.name = name;
                    r.writable = writable;
                    return r;
                }
            }
            RootRec rec = new RootRec();
            rec.id = newId();
            rec.kind = kind;
            rec.uri = uri.toString();
            rec.name = name;
            rec.writable = writable;
            rec.persistent = persistentRoot;
            transientRoots.put(rec.id, rec);
            return rec;
        }
    }

    private String newId() {
        final String alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
        while (true) {
            StringBuilder sb = new StringBuilder(10);
            for (int i = 0; i < 10; i++) sb.append(alphabet.charAt(random.nextInt(alphabet.length())));
            String id = sb.toString();
            synchronized (lock) {
                if (!persistentRoots().containsKey(id) && !transientRoots.containsKey(id)) return id;
            }
        }
    }

    private LinkedHashMap<String, RootRec> persistentRoots() {
        synchronized (lock) {
            if (persistent != null) return persistent;
            persistent = new LinkedHashMap<>();
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String raw = prefs.getString(PREFS_KEY, null);
            if (raw != null) {
                try {
                    JSONObject all = new JSONObject(raw);
                    Iterator<String> keys = all.keys();
                    while (keys.hasNext()) {
                        String id = keys.next();
                        JSONObject o = all.getJSONObject(id);
                        RootRec rec = new RootRec();
                        rec.id = id;
                        rec.kind = o.optString("kind", "file");
                        rec.name = o.optString("name", "");
                        rec.uri = o.getString("uri");
                        rec.writable = o.optBoolean("writable", false);
                        rec.persistent = true;
                        persistent.put(id, rec);
                    }
                } catch (JSONException e) {
                    Logger.error(getLogTag(), "Corrupt horsefiles roots", e);
                }
            }
            return persistent;
        }
    }

    private void savePersistent() {
        JSONObject all = new JSONObject();
        synchronized (lock) {
            try {
                for (RootRec rec : persistentRoots().values()) {
                    JSONObject o = new JSONObject();
                    o.put("kind", rec.kind);
                    o.put("name", rec.name);
                    o.put("uri", rec.uri);
                    o.put("writable", rec.writable);
                    all.put(rec.id, o);
                }
            } catch (JSONException e) {
                Logger.error(getLogTag(), "Cannot save horsefiles roots", e);
                return;
            }
        }
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(PREFS_KEY, all.toString()).commit();
    }

    private RootRec requireRoot(PluginCall call) throws HFException {
        String id = call.getString("id");
        RootRec rec;
        synchronized (lock) {
            rec = id == null ? null : persistentRoots().get(id);
            if (rec == null && id != null) rec = transientRoots.get(id);
        }
        if (rec == null) throw new HFException("EACCES", "Unknown root: " + id);
        return rec;
    }

    // ---------------------------------------------------------------------
    // File operations
    // ---------------------------------------------------------------------

    @PluginMethod
    public void stat(PluginCall call) {
        try {
            RootRec rec = requireRoot(call);
            DocInfo info = rec.isFolder() ? resolve(rec, checkRel(call.getString("rel"))) : statFileRoot(rec);
            JSObject ret = new JSObject();
            ret.put("exists", info != null);
            if (info != null) {
                ret.put("type", info.isDir() ? "dir" : "file");
                ret.put("mtime", info.mtime);
                ret.put("size", Math.max(0, info.size));
            }
            call.resolve(ret);
        } catch (Exception e) {
            fail(call, e);
        }
    }

    @PluginMethod
    public void read(PluginCall call) {
        try {
            RootRec rec = requireRoot(call);
            DocInfo info = rec.isFolder() ? resolve(rec, checkRel(call.getString("rel"))) : statFileRoot(rec);
            if (info == null) throw new HFException("ENOENT", "No such file");
            if (info.isDir()) throw new HFException("EINVAL", "Is a directory");
            byte[] bytes = readBytes(info.uri);
            JSObject ret = new JSObject();
            // UTF-8 as is: a BOM stays U+FEFF, CRLF stays CRLF.
            ret.put("data", new String(bytes, StandardCharsets.UTF_8));
            ret.put("mtime", info.mtime);
            call.resolve(ret);
        } catch (Exception e) {
            fail(call, e);
        }
    }

    @PluginMethod
    public void write(PluginCall call) {
        try {
            RootRec rec = requireRoot(call);
            String rel = rec.isFolder() ? checkRel(call.getString("rel")) : "";
            String data = call.getString("data", "");
            byte[] bytes = (data == null ? "" : data).getBytes(StandardCharsets.UTF_8);
            // Read as Number: a ms timestamp arrives as a Long, which PluginCall.getDouble ignores.
            Object rawExpected = call.getData().opt("expectedMtime");
            Double expected = rawExpected instanceof Number ? ((Number) rawExpected).doubleValue() : null;

            DocInfo cur = rec.isFolder() ? resolve(rec, rel) : statFileRoot(rec);
            JSObject ret = new JSObject();
            if (expected != null) {
                if (cur == null) {
                    ret.put("conflict", "missing");
                    call.resolve(ret);
                    return;
                }
                // mtime 0 = the provider gives none: cannot tell, so do not block the save.
                if (cur.mtime > 0 && cur.mtime > expected.longValue()) {
                    ret.put("conflict", "modified");
                    ret.put("mtime", cur.mtime);
                    call.resolve(ret);
                    return;
                }
            }
            if (cur == null) {
                if (!rec.isFolder()) throw new HFException("ENOENT", "The file is gone");
                if (rel.isEmpty()) throw new HFException("EINVAL", "Is a directory");
                DocInfo created = createChild(rec, rel, false, bytes);
                ret.put("mtime", created.mtime);
                call.resolve(ret);
                return;
            }
            if (cur.isDir()) throw new HFException("EINVAL", "Is a directory");
            writeBytes(cur.uri, bytes, cur.size);
            DocInfo after = rec.isFolder() ? queryDoc(cur.uri) : statFileRoot(rec);
            ret.put("mtime", after != null ? after.mtime : 0);
            call.resolve(ret);
        } catch (Exception e) {
            fail(call, e);
        }
    }

    @PluginMethod
    public void list(PluginCall call) {
        try {
            RootRec rec = requireRoot(call);
            if (!rec.isFolder()) throw new HFException("EINVAL", "Not a folder root");
            String rel = checkRel(call.getString("rel"));
            DocInfo dir = resolve(rec, rel);
            if (dir == null) throw new HFException("ENOENT", "No such folder");
            if (!dir.isDir()) throw new HFException("EINVAL", "Not a directory");
            List<DocInfo> children = queryChildren(rec, dir.docId);
            if (children == null) throw new HFException("ENOENT", "No such folder");
            JSArray entries = new JSArray();
            for (DocInfo c : children) {
                if (c.name == null || c.name.isEmpty() || c.name.startsWith(".")) continue;
                cachePut(rec.id, join(rel, c.name), c.docId);
                JSObject e = new JSObject();
                e.put("name", c.name);
                e.put("type", c.isDir() ? "dir" : "file");
                e.put("mtime", c.mtime);
                e.put("size", Math.max(0, c.size));
                entries.put(e);
            }
            JSObject ret = new JSObject();
            ret.put("entries", entries);
            call.resolve(ret);
        } catch (Exception e) {
            fail(call, e);
        }
    }

    @PluginMethod
    public void create(PluginCall call) {
        try {
            RootRec rec = requireRoot(call);
            if (!rec.isFolder()) throw new HFException("EINVAL", "Not a folder root");
            String rel = checkRel(call.getString("rel"));
            if (rel.isEmpty()) throw new HFException("EINVAL", "Missing name");
            String data = call.getString("data", "");
            DocInfo created = createChild(rec, rel, false, (data == null ? "" : data).getBytes(StandardCharsets.UTF_8));
            JSObject ret = new JSObject();
            ret.put("mtime", created.mtime);
            call.resolve(ret);
        } catch (Exception e) {
            fail(call, e);
        }
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        try {
            RootRec rec = requireRoot(call);
            if (!rec.isFolder()) throw new HFException("EINVAL", "Not a folder root");
            String rel = checkRel(call.getString("rel"));
            if (rel.isEmpty()) throw new HFException("EEXIST", "The folder exists");
            createChild(rec, rel, true, null);
            call.resolve();
        } catch (Exception e) {
            fail(call, e);
        }
    }

    @PluginMethod
    public void move(PluginCall call) {
        try {
            RootRec rec = requireRoot(call);
            if (!rec.isFolder()) throw new HFException("EINVAL", "Not a folder root");
            String from = checkRel(call.getString("from"));
            String to = checkRel(call.getString("to"));
            if (from.isEmpty() || to.isEmpty()) throw new HFException("EINVAL", "Cannot move the root");
            if (to.startsWith(from + "/")) throw new HFException("EINVAL", "Cannot move a folder into itself");
            if (from.equals(to)) {
                call.resolve();
                return;
            }
            ContentResolver cr = getContext().getContentResolver();

            DocInfo src = resolve(rec, from);
            if (src == null) throw new HFException("ENOENT", "No such file: " + from);
            String fromParentRel = parentOf(from);
            String toParentRel = parentOf(to);
            String newName = lastOf(to);
            DocInfo dst = resolve(rec, to);
            // A case-only rename finds the item itself on a case-insensitive provider.
            if (dst != null && !dst.docId.equals(src.docId)) throw new HFException("EEXIST", "Already exists: " + to);
            DocInfo toParent = resolve(rec, toParentRel);
            if (toParent == null || !toParent.isDir()) throw new HFException("ENOENT", "No such folder: " + toParentRel);

            Uri current = src.uri;
            if (!fromParentRel.equals(toParentRel)) {
                DocInfo fromParent = resolve(rec, fromParentRel);
                if (fromParent == null) throw new HFException("ENOENT", "No such folder: " + fromParentRel);
                if (src.flags != -1 && !src.hasFlag(Document.FLAG_SUPPORTS_MOVE)) {
                    throw new HFException("EXDEV", "This storage cannot move files");
                }
                Uri moved;
                try {
                    moved = DocumentsContract.moveDocument(cr, src.uri, fromParent.uri, toParent.uri);
                } catch (UnsupportedOperationException e) {
                    throw new HFException("EXDEV", "This storage cannot move files");
                } catch (IllegalArgumentException | IllegalStateException e) {
                    // Providers without move support often answer "Move not supported".
                    String m = String.valueOf(e.getMessage()).toLowerCase();
                    if (m.contains("support")) throw new HFException("EXDEV", "This storage cannot move files");
                    throw e;
                }
                if (moved == null) throw new HFException("EXDEV", "This storage cannot move files");
                current = moved;
                invalidate(rec.id, from);
                if (!newName.equals(src.name)) {
                    try {
                        renameTo(current, src.name, newName);
                    } catch (Exception e) {
                        // Put it back where it was so the move is all or nothing.
                        try {
                            DocumentsContract.moveDocument(cr, current, toParent.uri, fromParent.uri);
                        } catch (Exception ignored) {}
                        invalidateRoot(rec.id);
                        throw e;
                    }
                }
            } else {
                renameTo(current, src.name, newName);
            }
            invalidate(rec.id, from);
            invalidate(rec.id, to);
            call.resolve();
        } catch (Exception e) {
            fail(call, e);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            RootRec rec = requireRoot(call);
            ContentResolver cr = getContext().getContentResolver();
            if (!rec.isFolder()) {
                Uri uri = Uri.parse(rec.uri);
                if (!DocumentsContract.isDocumentUri(getContext(), uri)) throw new HFException("EINVAL", "This file cannot be deleted here");
                if (!DocumentsContract.deleteDocument(cr, uri)) throw new HFException("EIO", "Delete failed");
                call.resolve();
                return;
            }
            String rel = checkRel(call.getString("rel"));
            if (rel.isEmpty()) throw new HFException("EINVAL", "Cannot remove the root");
            DocInfo info = resolve(rec, rel);
            if (info == null) throw new HFException("ENOENT", "No such file: " + rel);
            // deleteDocument removes a directory with its contents (provider side).
            boolean ok = DocumentsContract.deleteDocument(cr, info.uri);
            invalidate(rec.id, rel);
            if (!ok) throw new HFException("EIO", "Delete failed");
            call.resolve();
        } catch (Exception e) {
            fail(call, e);
        }
    }

    // ---------------------------------------------------------------------
    // Provider helpers
    // ---------------------------------------------------------------------

    /**
     * Rename keeping the exact name. Some providers (the external-storage one)
     * make a name unique against the existing file on a case-insensitive disk,
     * so a case-only rename ("a.md" → "A.md") would become "A (1).md": go
     * through a temporary name first.
     */
    private Uri renameTo(Uri uri, String oldName, String newName) throws HFException, FileNotFoundException {
        if (newName.equals(oldName)) return uri;
        ContentResolver cr = getContext().getContentResolver();
        Uri current = uri;
        try {
            if (newName.equalsIgnoreCase(oldName)) {
                Uri tmp = DocumentsContract.renameDocument(cr, current, newName + ".hm-rename-" + newId());
                if (tmp == null) throw new HFException("EIO", "Rename failed");
                current = tmp;
            }
            Uri renamed = DocumentsContract.renameDocument(cr, current, newName);
            if (renamed == null) throw new HFException("EIO", "Rename failed");
            current = renamed;
        } catch (UnsupportedOperationException e) {
            throw new HFException("EXDEV", "This storage cannot rename files");
        }
        DocInfo after = queryDoc(current);
        if (after != null && after.name != null && !after.name.equals(newName)) {
            // The provider changed the name (e.g. made it unique): undo and report.
            try {
                DocumentsContract.renameDocument(cr, current, oldName);
            } catch (Exception ignored) {}
            throw new HFException("EIO", "The storage renamed it to \"" + after.name + "\"");
        }
        return current;
    }

    /** Create a file (with bytes) or a folder at rel. The created name is exactly the last segment. */
    private DocInfo createChild(RootRec rec, String rel, boolean dir, byte[] bytes) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        String name = lastOf(rel);
        DocInfo parent = resolve(rec, parentOf(rel));
        if (parent == null || !parent.isDir()) throw new HFException("ENOENT", "No such folder: " + parentOf(rel));
        if (resolve(rec, rel) != null) throw new HFException("EEXIST", "Already exists: " + rel);
        // octet-stream keeps the exact name; a text mime makes some providers append ".txt".
        String mime = dir ? Document.MIME_TYPE_DIR : "application/octet-stream";
        Uri created = DocumentsContract.createDocument(cr, parent.uri, mime, name);
        if (created == null) throw new HFException("EIO", "Create failed");
        try {
            DocInfo info = queryDoc(created);
            if (info != null && info.name != null && !info.name.equals(name)) {
                Uri renamed = null;
                try {
                    renamed = DocumentsContract.renameDocument(cr, created, name);
                } catch (Exception ignored) {}
                if (renamed != null) created = renamed;
                info = queryDoc(created);
                if (info == null || info.name == null || !info.name.equals(name)) {
                    throw new HFException("EIO", "The storage named it \"" + (info != null ? info.name : "?") + "\"");
                }
            }
            if (!dir && bytes != null && bytes.length > 0) writeBytes(created, bytes, 0);
            DocInfo done = queryDoc(created);
            if (done == null) throw new HFException("EIO", "Create failed");
            cachePut(rec.id, rel, done.docId);
            return done;
        } catch (Exception e) {
            try {
                DocumentsContract.deleteDocument(cr, created);
            } catch (Exception ignored) {}
            invalidate(rec.id, rel);
            throw e;
        }
    }

    /** Resolve rel inside a folder root to a document; null when it does not exist. */
    private DocInfo resolve(RootRec rec, String rel) throws HFException {
        Uri tree = Uri.parse(rec.uri);
        String rootDocId = DocumentsContract.getTreeDocumentId(tree);
        if (rel.isEmpty()) return queryDoc(DocumentsContract.buildDocumentUriUsingTree(tree, rootDocId));

        String cached = cacheGet(rec.id, rel);
        if (cached != null) {
            DocInfo d = queryDoc(DocumentsContract.buildDocumentUriUsingTree(tree, cached));
            // A document renamed by another app keeps its id: check the name too.
            if (d != null && lastOf(rel).equals(d.name)) return d;
            invalidate(rec.id, rel);
        }
        String[] stale = new String[1];
        DocInfo found = walk(rec, tree, rootDocId, rel, true, stale);
        if (found == null && stale[0] != null) {
            // A cached folder id that no longer answers (moved / deleted by another app):
            // forget it and walk once more from the root. A plain miss costs one query.
            invalidate(rec.id, stale[0]);
            found = walk(rec, tree, rootDocId, rel, false, stale);
        }
        return found;
    }

    private DocInfo walk(RootRec rec, Uri tree, String rootDocId, String rel, boolean useCache, String[] stale)
        throws HFException {
        String[] segs = rel.split("/");
        String parentId = rootDocId;
        String parentFromCache = null; // rel of the cached folder id parentId came from
        String prefix = "";
        DocInfo found = null;
        for (int i = 0; i < segs.length; i++) {
            prefix = join(prefix, segs[i]);
            boolean last = i == segs.length - 1;
            String cachedId = useCache && !last ? cacheGet(rec.id, prefix) : null;
            if (cachedId != null) {
                parentId = cachedId;
                parentFromCache = prefix;
                continue;
            }
            List<DocInfo> children = queryChildren(rec, parentId);
            if (children == null) {
                stale[0] = parentFromCache;
                return null;
            }
            parentFromCache = null;
            found = null;
            String parentPrefix = parentOf(prefix);
            for (DocInfo c : children) {
                if (c.name == null) continue;
                cachePut(rec.id, join(parentPrefix, c.name), c.docId);
                if (c.name.equals(segs[i])) found = c;
            }
            if (found == null) return null;
            if (!last && !found.isDir()) return null;
            parentId = found.docId;
        }
        return found;
    }

    /** Children of a folder document, or null when the folder is gone. */
    private List<DocInfo> queryChildren(RootRec rec, String parentDocId) throws HFException {
        Uri tree = Uri.parse(rec.uri);
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentDocId);
        Cursor c;
        try {
            c = getContext().getContentResolver().query(childrenUri, DOC_COLS, null, null, null);
        } catch (SecurityException e) {
            throw new HFException("EACCES", String.valueOf(e.getMessage()));
        } catch (IllegalArgumentException e) {
            // DocumentsProvider reports a missing / non-folder document this way on some versions.
            return null;
        }
        if (c == null) return null;
        List<DocInfo> out = new ArrayList<>();
        try {
            while (c.moveToNext()) {
                DocInfo d = fromCursor(c);
                if (d.docId == null) continue;
                d.uri = DocumentsContract.buildDocumentUriUsingTree(tree, d.docId);
                out.add(d);
            }
        } finally {
            c.close();
        }
        return out;
    }

    /** One document of a tree (a tree document uri). null when missing. */
    private DocInfo queryDoc(Uri docUri) throws HFException {
        Cursor c;
        try {
            c = getContext().getContentResolver().query(docUri, DOC_COLS, null, null, null);
        } catch (SecurityException e) {
            throw new HFException("EACCES", String.valueOf(e.getMessage()));
        } catch (IllegalArgumentException | UnsupportedOperationException e) {
            return null;
        }
        if (c == null) return null;
        try {
            if (!c.moveToFirst()) return null;
            DocInfo d = fromCursor(c);
            d.uri = docUri;
            if (d.docId == null) {
                try {
                    d.docId = DocumentsContract.getDocumentId(docUri);
                } catch (IllegalArgumentException ignored) {}
            }
            return d;
        } finally {
            c.close();
        }
    }

    private DocInfo queryTreeRoot(Uri tree) throws HFException {
        return queryDoc(DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)));
    }

    /**
     * Any single content uri (a picked document, or an "open with" uri from a
     * FileProvider that knows only name and size). Null projection: providers
     * that are not DocumentsProviders may reject unknown columns.
     */
    private DocInfo querySingle(Uri uri) throws HFException {
        if (ContentResolver.SCHEME_FILE.equals(uri.getScheme())) {
            String path = uri.getPath();
            if (path == null) return null;
            File f = new File(path);
            if (!f.exists()) return null;
            DocInfo d = new DocInfo();
            d.uri = uri;
            d.name = f.getName();
            d.mime = f.isDirectory() ? Document.MIME_TYPE_DIR : "application/octet-stream";
            d.mtime = f.lastModified();
            d.size = f.length();
            return d;
        }
        Cursor c;
        try {
            c = getContext().getContentResolver().query(uri, null, null, null, null);
        } catch (SecurityException e) {
            throw new HFException("EACCES", String.valueOf(e.getMessage()));
        } catch (IllegalArgumentException | UnsupportedOperationException e) {
            return null;
        }
        if (c == null) return null;
        try {
            if (!c.moveToFirst()) return null;
            DocInfo d = fromCursor(c);
            d.uri = uri;
            return d;
        } finally {
            c.close();
        }
    }

    /** stat of a file root: the query, else (provider without query support) an open of the uri. */
    private DocInfo statFileRoot(RootRec rec) throws HFException {
        Uri uri = Uri.parse(rec.uri);
        DocInfo d = querySingle(uri);
        if (d != null) return d;
        try (ParcelFileDescriptor pfd = getContext().getContentResolver().openFileDescriptor(uri, "r")) {
            if (pfd == null) return null;
            DocInfo info = new DocInfo();
            info.uri = uri;
            info.name = rec.name;
            info.size = pfd.getStatSize();
            info.mtime = 0;
            return info;
        } catch (FileNotFoundException e) {
            if (looksLikePermission(e)) throw new HFException("EACCES", String.valueOf(e.getMessage()));
            return null;
        } catch (SecurityException e) {
            throw new HFException("EACCES", String.valueOf(e.getMessage()));
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    private static DocInfo fromCursor(Cursor c) {
        DocInfo d = new DocInfo();
        int i;
        if ((i = c.getColumnIndex(Document.COLUMN_DOCUMENT_ID)) >= 0 && !c.isNull(i)) d.docId = c.getString(i);
        if ((i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)) >= 0 && !c.isNull(i)) d.name = c.getString(i);
        if ((i = c.getColumnIndex(Document.COLUMN_MIME_TYPE)) >= 0 && !c.isNull(i)) d.mime = c.getString(i);
        if ((i = c.getColumnIndex(Document.COLUMN_LAST_MODIFIED)) >= 0 && !c.isNull(i)) d.mtime = c.getLong(i);
        if ((i = c.getColumnIndex(OpenableColumns.SIZE)) >= 0 && !c.isNull(i)) d.size = c.getLong(i);
        if ((i = c.getColumnIndex(Document.COLUMN_FLAGS)) >= 0 && !c.isNull(i)) d.flags = c.getInt(i);
        return d;
    }

    private byte[] readBytes(Uri uri) throws IOException, HFException {
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) throw new HFException("EIO", "Cannot open the file");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    /**
     * Replace a document's content. SAF has no atomic replace, so: keep the old
     * bytes (small files), write with "wt", verify the size, and put the old
     * bytes back when the write fails half way or leaves the wrong length.
     */
    private void writeBytes(Uri uri, byte[] bytes, long knownSize) throws Exception {
        byte[] original = null;
        if (knownSize > 0 && knownSize <= MAX_ROLLBACK_BYTES) {
            try {
                original = readBytes(uri);
            } catch (Exception ignored) {}
        }
        try {
            rawWrite(uri, bytes);
        } catch (Exception e) {
            restore(uri, original);
            throw e;
        }
        long size = currentSize(uri);
        if (size >= 0 && size != bytes.length) {
            // "w" on some providers does not truncate (old tail left behind): cut it with a real fd.
            try (ParcelFileDescriptor pfd = getContext().getContentResolver().openFileDescriptor(uri, "rw")) {
                if (pfd != null) {
                    try (FileOutputStream fos = new FileOutputStream(pfd.getFileDescriptor())) {
                        fos.getChannel().truncate(bytes.length);
                    }
                }
            } catch (Exception ignored) {}
            size = currentSize(uri);
            if (size >= 0 && size != bytes.length) {
                restore(uri, original);
                throw new HFException("EIO", "Write incomplete: " + size + " of " + bytes.length + " bytes");
            }
        }
    }

    private void restore(Uri uri, byte[] original) {
        if (original == null) return;
        try {
            rawWrite(uri, original);
        } catch (Exception e) {
            Logger.error(getLogTag(), "Could not restore the previous content", e);
        }
    }

    private void rawWrite(Uri uri, byte[] bytes) throws IOException, HFException {
        ContentResolver cr = getContext().getContentResolver();
        OutputStream os;
        try {
            os = cr.openOutputStream(uri, "wt");
        } catch (IllegalArgumentException e) {
            os = cr.openOutputStream(uri, "w");
        } catch (FileNotFoundException e) {
            String m = String.valueOf(e.getMessage());
            if (!m.contains("mode") && !m.contains("wt")) throw e;
            os = cr.openOutputStream(uri, "w");
        }
        if (os == null) throw new HFException("EIO", "Cannot open the file for writing");
        try {
            os.write(bytes);
            os.flush();
            if (os instanceof FileOutputStream) {
                try {
                    ((FileOutputStream) os).getFD().sync();
                } catch (IOException ignored) {}
            }
        } finally {
            // close() can be where a cloud provider uploads: let its error propagate.
            os.close();
        }
    }

    /** Current size, -1 when the provider does not say. */
    private long currentSize(Uri uri) {
        try {
            DocInfo d = DocumentsContract.isDocumentUri(getContext(), uri) ? queryDoc(uri) : querySingle(uri);
            return d == null ? -1 : d.size;
        } catch (Exception e) {
            return -1;
        }
    }

    // ---------------------------------------------------------------------
    // Paths + cache
    // ---------------------------------------------------------------------

    private static String checkRel(String rel) throws HFException {
        if (rel == null || rel.isEmpty()) return "";
        if (rel.startsWith("/")) throw new HFException("EINVAL", "Invalid path: " + rel);
        for (String seg : rel.split("/", -1)) {
            if (seg.isEmpty() || seg.equals("..") || seg.equals(".")) throw new HFException("EINVAL", "Invalid path: " + rel);
        }
        return rel;
    }

    private static String join(String parent, String name) {
        return parent.isEmpty() ? name : parent + "/" + name;
    }

    private static String parentOf(String rel) {
        int i = rel.lastIndexOf('/');
        return i < 0 ? "" : rel.substring(0, i);
    }

    private static String lastOf(String rel) {
        int i = rel.lastIndexOf('/');
        return i < 0 ? rel : rel.substring(i + 1);
    }

    private static String cacheKey(String id, String rel) {
        return id + "\u0000" + rel;
    }

    private String cacheGet(String id, String rel) {
        synchronized (lock) {
            return docIdCache.get(cacheKey(id, rel));
        }
    }

    private void cachePut(String id, String rel, String docId) {
        synchronized (lock) {
            docIdCache.put(cacheKey(id, rel), docId);
        }
    }

    /** Drop rel and everything below it ("" = the whole root). */
    private void invalidate(String id, String rel) {
        synchronized (lock) {
            if (rel.isEmpty()) {
                invalidateRoot(id);
                return;
            }
            String exact = cacheKey(id, rel);
            String below = exact + "/";
            Iterator<String> it = docIdCache.keySet().iterator();
            while (it.hasNext()) {
                String k = it.next();
                if (k.equals(exact) || k.startsWith(below)) it.remove();
            }
        }
    }

    private void invalidateRoot(String id) {
        synchronized (lock) {
            String prefix = id + "\u0000";
            Iterator<String> it = docIdCache.keySet().iterator();
            while (it.hasNext()) if (it.next().startsWith(prefix)) it.remove();
        }
    }

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    private static boolean looksLikePermission(Throwable t) {
        String m = String.valueOf(t.getMessage());
        return m.contains("EACCES") || m.contains("Permission denied") || m.contains("EROFS") || m.contains("Read-only");
    }

    private void fail(PluginCall call, Throwable t) {
        String message = t.getMessage() != null ? t.getMessage() : t.toString();
        String code;
        if (t instanceof HFException) {
            code = ((HFException) t).code;
        } else if (t instanceof SecurityException || looksLikePermission(t)) {
            code = "EACCES";
        } else if (t instanceof FileNotFoundException) {
            code = "ENOENT";
        } else {
            code = "EIO";
        }
        if (!(t instanceof HFException)) Logger.error(getLogTag(), "HorseFiles " + call.getMethodName() + " failed", t);
        call.reject(message, code);
    }
}
