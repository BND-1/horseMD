package com.horsemd.app;

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.print.HorsePdfWriter;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * HorsePdf: renders an export HTML document to PDF bytes on the phone (the
 * desktop uses Electron's printToPDF; this is its Android counterpart).
 *
 * render({ html, pageWidthPt, pageHeightPt, margins: { top, right, bottom, left } (pt),
 *          resourceScript, timeoutMs, resourceWaitMs? })
 *   → { data: <base64 PDF>, pageCount, resources: <object the resourceScript
 *       resolved to, or null> }
 * Rejects with code BUSY (a render is already running: one at a time),
 * TIMEOUT (the whole render took longer than timeoutMs, default 90 s) or
 * RENDER (bad arguments, load / print failure, PDF over 200 MB).
 *
 * How: on the UI thread a WebView is created, attached to the activity's decor
 * view far off-screen (translated −100 000 px, behind the content, hidden from
 * accessibility and focus: attached so Chromium treats the page as visible and
 * does not throttle its timers) and measured / laid out to the printable width
 * × 1000 px. It is never shown and is destroyed after every render, also on
 * timeout / error. JavaScript is on only so the app can evaluate
 * `resourceScript`: the export page carries a CSP without script-src, so none
 * of its own scripts run. No file or content access, no cache, every
 * navigation refused, requests other than http(s) answered empty; the page may
 * load what its own HTML references (https images).
 *
 * Layout width: (pageWidthPt − left − right) × 96 / 72 CSS px (× the screen
 * density in device px; text zoom fixed at 100 %), so the resource script's
 * display math measurement matches the page.
 *
 * Resources: evaluateJavascript does not await promises, so the script's
 * result is stored in window.__hmPdfRes (as JSON) and polled every 100 ms
 * until it is set or resourceWaitMs (default 12 000, the script's own wait)
 * + 2 s have passed; then resources = null.
 *
 * Printing: webView.createPrintDocumentAdapter driven by
 * {@link HorsePdfWriter} (no print dialog) with a custom media size of the page
 * (mils = pt × 1000 / 72), 300 dpi and Margins.NO_MARGINS: Chromium applies
 * the page's CSS {@code @page} margin itself, so the PDF margins come from the
 * document. (iOS passes them as the print renderer's printableRect instead.)
 * The PDF goes to a cache file; its page count is read with PdfRenderer, the
 * bytes are returned as base64 and the file is deleted. PDFs over 200 MB are
 * refused.
 */
@CapacitorPlugin(name = "HorsePdf")
public class HorsePdfPlugin extends Plugin {

    private static final long MAX_PDF_BYTES = 200L * 1024 * 1024;
    private static final long DEFAULT_TIMEOUT_MS = 90_000;
    private static final long DEFAULT_RESOURCE_WAIT_MS = 12_000;
    private static final long RESOURCE_GRACE_MS = 2_000;
    private static final long POLL_MS = 100;
    private static final int LAYOUT_HEIGHT_PX = 1000;
    /** 200 inches: larger pages are not a real document. */
    private static final double MAX_PAGE_PT = 14_400;

    private final AtomicBoolean busy = new AtomicBoolean(false);
    private final Handler main = new Handler(Looper.getMainLooper());
    private ExecutorService io;
    /** The running render; touched on the main thread only. */
    private Job job;

    @Override
    public void load() {
        io = Executors.newSingleThreadExecutor();
    }

    @Override
    protected void handleOnDestroy() {
        main.post(() -> {
            if (job != null) job.fail("RENDER", "The app closed while the PDF was rendering");
        });
    }

    private static double number(JSONObject object, String key, double fallback) {
        if (object == null) return fallback;
        Object value = object.opt(key);
        return value instanceof Number ? ((Number) value).doubleValue() : fallback;
    }

    @PluginMethod
    public void render(PluginCall call) {
        final String html = call.getString("html", "");
        final JSONObject data = call.getData();
        final double width = number(data, "pageWidthPt", 0);
        final double height = number(data, "pageHeightPt", 0);
        final JSONObject margins = data.optJSONObject("margins");
        final double top = Math.max(0, number(margins, "top", 0));
        final double right = Math.max(0, number(margins, "right", 0));
        final double bottom = Math.max(0, number(margins, "bottom", 0));
        final double left = Math.max(0, number(margins, "left", 0));
        final String script = call.getString("resourceScript", null);
        long timeoutMs = Math.round(number(data, "timeoutMs", DEFAULT_TIMEOUT_MS));
        if (timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
        long resourceWaitMs = Math.round(number(data, "resourceWaitMs", DEFAULT_RESOURCE_WAIT_MS));
        if (resourceWaitMs < 0) resourceWaitMs = DEFAULT_RESOURCE_WAIT_MS;

        if (html == null || html.isEmpty()) {
            call.reject("No HTML to render", "RENDER");
            return;
        }
        if (
            !(width > 0) ||
            !(height > 0) ||
            Double.isInfinite(width) ||
            Double.isInfinite(height) ||
            width > MAX_PAGE_PT ||
            height > MAX_PAGE_PT ||
            left + right >= width - 1 ||
            top + bottom >= height - 1
        ) {
            call.reject("Bad page size or margins", "RENDER");
            return;
        }
        if (!busy.compareAndSet(false, true)) {
            call.reject("Another PDF is being rendered", "BUSY");
            return;
        }
        final Job next = new Job(call, html, width, height, left, right, script, timeoutMs, resourceWaitMs);
        main.post(() -> {
            job = next;
            next.start();
        });
    }

    /** One render: owns the off-screen web view and the temp file until it ends. */
    private final class Job {

        private final PluginCall call;
        private final String html;
        private final double pageWidthPt;
        private final double pageHeightPt;
        private final double marginLeftPt;
        private final double marginRightPt;
        private final String script;
        private final long timeoutMs;
        private final long resourceWaitMs;

        private final AtomicBoolean done = new AtomicBoolean(false);
        private final CancellationSignal cancel = new CancellationSignal();
        private WebView webView;
        private ParcelFileDescriptor output;
        private File file;
        private boolean loaded = false;
        private boolean printing = false;
        private long resourceDeadline;
        private final Runnable timeout = () -> fail("TIMEOUT", "PDF rendering timed out");

        Job(
            PluginCall call,
            String html,
            double pageWidthPt,
            double pageHeightPt,
            double marginLeftPt,
            double marginRightPt,
            String script,
            long timeoutMs,
            long resourceWaitMs
        ) {
            this.call = call;
            this.html = html;
            this.pageWidthPt = pageWidthPt;
            this.pageHeightPt = pageHeightPt;
            this.marginLeftPt = marginLeftPt;
            this.marginRightPt = marginRightPt;
            this.script = script;
            this.timeoutMs = timeoutMs;
            this.resourceWaitMs = resourceWaitMs;
        }

        @SuppressLint("SetJavaScriptEnabled")
        void start() {
            Activity activity = getActivity();
            if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
                fail("RENDER", "No activity to render the PDF in");
                return;
            }
            main.postDelayed(timeout, timeoutMs);
            try {
                WebView view = new WebView(activity);
                webView = view;
                WebSettings s = view.getSettings();
                s.setJavaScriptEnabled(true);
                s.setJavaScriptCanOpenWindowsAutomatically(false);
                s.setSupportMultipleWindows(false);
                s.setAllowFileAccess(false);
                s.setAllowContentAccess(false);
                s.setDomStorageEnabled(false);
                s.setGeolocationEnabled(false);
                s.setCacheMode(WebSettings.LOAD_NO_CACHE);
                s.setMediaPlaybackRequiresUserGesture(true);
                s.setTextZoom(100);
                s.setMinimumFontSize(1);
                s.setMinimumLogicalFontSize(1);
                s.setUseWideViewPort(false);
                s.setLoadWithOverviewMode(false);
                s.setSupportZoom(false);
                s.setBlockNetworkImage(false);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) s.setSafeBrowsingEnabled(false);
                if (Build.VERSION.SDK_INT >= 33) {
                    s.setAlgorithmicDarkeningAllowed(false);
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    s.setForceDark(WebSettings.FORCE_DARK_OFF);
                }
                view.setBackgroundColor(Color.WHITE);
                view.setVerticalScrollBarEnabled(false);
                view.setHorizontalScrollBarEnabled(false);
                view.setFocusable(false);
                view.setFocusableInTouchMode(false);
                view.setClickable(false);
                view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
                view.setWebViewClient(new PdfClient());

                float density = activity.getResources().getDisplayMetrics().density;
                double cssWidth = Math.floor((pageWidthPt - marginLeftPt - marginRightPt) * 96.0 / 72.0);
                int widthPx = Math.max(1, (int) Math.round(cssWidth * density));
                int heightPx = Math.round(LAYOUT_HEIGHT_PX * density);

                view.setTranslationX(-100_000f);
                View decor = activity.getWindow().getDecorView();
                if (decor instanceof ViewGroup) {
                    ((ViewGroup) decor).addView(view, 0, new FrameLayout.LayoutParams(widthPx, heightPx));
                }
                view.measure(
                    View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY)
                );
                view.layout(0, 0, widthPx, heightPx);

                view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
            } catch (RuntimeException e) {
                // e.g. the WebView package is missing or being updated.
                fail("RENDER", "Could not create the PDF web view: " + e.getClass().getSimpleName());
            }
        }

        private final class PdfClient extends WebViewClient {

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true; // links, meta refresh, location changes: never navigate
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl() != null ? request.getUrl().getScheme() : null;
                scheme = scheme != null ? scheme.toLowerCase(Locale.ROOT) : "";
                if (scheme.equals("https") || scheme.equals("http") || scheme.equals("data") || scheme.equals("blob")) {
                    return null; // the network as usual (the page's own images)
                }
                return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (done.get() || loaded || view != webView) return;
                loaded = true;
                collectResources();
            }

            @Override
            @TargetApi(Build.VERSION_CODES.O)
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                if (view == webView) {
                    webView = null; // gone: only detach, destroy() below still runs
                    detachAndDestroy(view);
                    fail("RENDER", "The PDF page's renderer ended");
                } else {
                    view.destroy();
                }
                return true; // handled: the app itself keeps running
            }
        }

        private void collectResources() {
            if (done.get() || webView == null) return;
            String body = script != null ? script.trim() : "";
            if (body.isEmpty()) {
                print(null);
                return;
            }
            String setup =
                "(function(){window.__hmPdfRes=null;try{Promise.resolve((" +
                body +
                ")).then(function(r){window.__hmPdfRes=JSON.stringify(r===undefined?null:r)}," +
                "function(){window.__hmPdfRes='null'})}catch(e){window.__hmPdfRes='null'}})();void 0";
            resourceDeadline = SystemClock.uptimeMillis() + resourceWaitMs + RESOURCE_GRACE_MS;
            webView.evaluateJavascript(setup, ignored -> main.postDelayed(this::poll, POLL_MS));
        }

        private void poll() {
            if (done.get() || webView == null || printing) return;
            webView.evaluateJavascript("window.__hmPdfRes", value -> {
                if (done.get() || printing) return;
                // value is the JSON encoding of the variable: "null" until set,
                // then a JSON string literal holding the result's JSON.
                if (value != null && !value.equals("null")) {
                    JSONObject resources = null;
                    try {
                        Object outer = new JSONTokener(value).nextValue();
                        if (outer instanceof String) {
                            Object inner = new JSONTokener((String) outer).nextValue();
                            if (inner instanceof JSONObject) resources = (JSONObject) inner;
                        }
                    } catch (Exception ignored) {
                        // not JSON: resources unknown
                    }
                    print(resources);
                    return;
                }
                if (SystemClock.uptimeMillis() >= resourceDeadline) {
                    print(null);
                    return;
                }
                main.postDelayed(this::poll, POLL_MS);
            });
        }

        private void print(final JSONObject resources) {
            if (done.get() || webView == null || printing) return;
            printing = true;
            try {
                File dir = new File(getContext().getCacheDir(), "horsepdf");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cache folder");
                // Leftovers of a render the process did not live to finish.
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
                file = new File(dir, "render-" + UUID.randomUUID() + ".pdf");
                output = ParcelFileDescriptor.open(
                    file,
                    ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE
                );
            } catch (IOException | RuntimeException e) {
                fail("RENDER", "Could not create the PDF file");
                return;
            }

            int widthMils = (int) Math.max(1, Math.round(pageWidthPt * 1000.0 / 72.0));
            int heightMils = (int) Math.max(1, Math.round(pageHeightPt * 1000.0 / 72.0));
            PrintAttributes attributes = new PrintAttributes.Builder()
                .setMediaSize(new PrintAttributes.MediaSize("hm", "HorseMD", widthMils, heightMils))
                .setResolution(new PrintAttributes.Resolution("hm300", "300 dpi", 300, 300))
                .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                .build();

            PrintDocumentAdapter adapter;
            try {
                adapter = webView.createPrintDocumentAdapter("HorseMD");
            } catch (RuntimeException e) {
                fail("RENDER", "Could not start printing: " + e.getClass().getSimpleName());
                return;
            }
            HorsePdfWriter.write(adapter, attributes, output, cancel, new HorsePdfWriter.Callback() {
                @Override
                public void onSuccess() {
                    if (done.get()) return;
                    closeOutput();
                    // The web view is no longer needed; free it before the file work.
                    WebView view = webView;
                    webView = null;
                    detachAndDestroy(view);
                    final File written = file;
                    io.execute(() -> deliver(written, resources));
                }

                @Override
                public void onFailure(String message) {
                    fail("RENDER", "PDF printing failed: " + message);
                }
            });
        }

        /** IO thread: page count, bytes, base64, resolve. */
        private void deliver(File written, JSONObject resources) {
            try {
                long length = written.length();
                if (length <= 0) {
                    main.post(() -> fail("RENDER", "The PDF is empty"));
                    return;
                }
                if (length > MAX_PDF_BYTES) {
                    main.post(() -> fail("RENDER", "The PDF is larger than 200 MB"));
                    return;
                }
                int pageCount;
                try (
                    ParcelFileDescriptor read = ParcelFileDescriptor.open(written, ParcelFileDescriptor.MODE_READ_ONLY);
                    PdfRenderer renderer = new PdfRenderer(read)
                ) {
                    pageCount = renderer.getPageCount();
                }
                if (pageCount <= 0) {
                    main.post(() -> fail("RENDER", "The PDF has no pages"));
                    return;
                }
                byte[] bytes = new byte[(int) length];
                try (InputStream in = new FileInputStream(written)) {
                    int off = 0;
                    while (off < bytes.length) {
                        int n = in.read(bytes, off, bytes.length - off);
                        if (n < 0) break;
                        off += n;
                    }
                    if (off != bytes.length) throw new IOException("short read");
                }
                String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                bytes = null;
                final JSObject out = new JSObject();
                out.put("data", base64);
                out.put("pageCount", pageCount);
                out.put("resources", resources != null ? resources : JSONObject.NULL);
                main.post(() -> succeed(out));
            } catch (IOException | RuntimeException | OutOfMemoryError e) {
                main.post(() -> fail("RENDER", "Could not read the PDF: " + e.getClass().getSimpleName()));
            }
        }

        private void succeed(JSObject out) {
            if (!done.compareAndSet(false, true)) return;
            cleanup();
            call.resolve(out);
        }

        /** Main thread. Ends the job once: tears everything down, then rejects. */
        void fail(String code, String message) {
            if (!done.compareAndSet(false, true)) return;
            cleanup();
            call.reject(message, code);
        }

        private void cleanup() {
            main.removeCallbacks(timeout);
            if (!cancel.isCanceled()) cancel.cancel();
            WebView view = webView;
            webView = null;
            detachAndDestroy(view);
            closeOutput();
            final File temp = file;
            file = null;
            if (temp != null) {
                // After a timeout the IO thread may still be reading it: delete there, in order.
                io.execute(() -> {
                    //noinspection ResultOfMethodCallIgnored
                    temp.delete();
                });
            }
            if (job == this) job = null;
            busy.set(false);
        }

        private void closeOutput() {
            if (output == null) return;
            try {
                output.close();
            } catch (IOException ignored) {
                // nothing to do
            }
            output = null;
        }
    }

    private static void detachAndDestroy(WebView view) {
        if (view == null) return;
        try {
            view.stopLoading();
            if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
            view.setWebViewClient(new WebViewClient());
            view.destroy();
        } catch (RuntimeException ignored) {
            // already gone
        }
    }
}
