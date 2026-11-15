package com.horsemd.app;

import android.text.TextUtils;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.SocketTimeoutException;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.Headers;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;
import okio.BufferedSource;

/**
 * HorseHttp: the phone's HTTP client for cloud sync (WebDAV / S3). The WebView's
 * fetch cannot be used: CORS, PROPFIND / MKCOL, a User-Agent of our choosing
 * (数据胶囊 requires "rclone").
 *
 * request({ method, url, headers, bodyBase64, timeoutMs })
 *   → { status, headers: { lower-case name: value }, bodyBase64 }
 * Rejects with code BAD_URL (not http/https), TIMEOUT, TOO_LARGE (response over
 * 200 MB) or NETWORK; a message names the host only, never the query or
 * credentials.
 *
 * OkHttp: no cache, no cookies, redirects followed but never across schemes,
 * Authorization dropped on a redirect to another host (OkHttp's own rule).
 * A gzip response OkHttp asked for is decompressed and its Content-Encoding /
 * Content-Length removed, so the body is always the decoded bytes. Requests run
 * on OkHttp's dispatcher threads, not the plugin thread HorseFiles uses.
 */
@CapacitorPlugin(name = "HorseHttp")
public class HorseHttpPlugin extends Plugin {

    private static final long MAX_RESPONSE_BYTES = 200L * 1024 * 1024;
    private static final long DEFAULT_TIMEOUT_MS = 60_000;

    private OkHttpClient baseClient;

    @Override
    public void load() {
        baseClient = new OkHttpClient.Builder()
            .cache(null)
            .followRedirects(true)
            .followSslRedirects(false)
            .build();
    }

    private static final class HttpError extends Exception {
        final String code;

        HttpError(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    @PluginMethod
    public void request(PluginCall call) {
        final String method = call.getString("method", "GET").trim();
        final String urlString = call.getString("url", "");
        final JSObject headers = call.getObject("headers", new JSObject());
        final String bodyBase64 = call.getString("bodyBase64", null);
        Object timeoutValue = call.getData().opt("timeoutMs");
        long timeoutMs = timeoutValue instanceof Number ? Math.round(((Number) timeoutValue).doubleValue()) : 0;
        if (timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;

        HttpUrl url = HttpUrl.parse(urlString);
        if (url == null || !(url.scheme().equals("http") || url.scheme().equals("https"))) {
            call.reject("Only http and https URLs are allowed", "BAD_URL");
            return;
        }
        if (method.isEmpty() || !method.matches("[A-Za-z0-9!#$%&'*+.^_`|~-]+")) {
            call.reject("Bad HTTP method", "BAD_URL");
            return;
        }
        final String host = url.host();

        Request request;
        try {
            Headers.Builder hb = new Headers.Builder();
            Iterator<String> names = headers.keys();
            while (names.hasNext()) {
                String name = names.next();
                Object value = headers.opt(name);
                if (value == null || value == org.json.JSONObject.NULL) continue;
                // Values as given (no trimming / charset); non-ASCII goes out as UTF-8.
                hb.addUnsafeNonAscii(name, String.valueOf(value));
            }
            RequestBody body = null;
            String upper = method.toUpperCase(Locale.ROOT);
            if (permitsBody(upper)) {
                byte[] bytes = null;
                if (bodyBase64 != null) bytes = Base64.decode(bodyBase64, Base64.DEFAULT);
                if (bytes != null) {
                    // No MediaType: the caller's Content-Type header is sent unchanged.
                    body = RequestBody.create(bytes, (okhttp3.MediaType) null);
                } else if (requiresBody(upper)) {
                    body = RequestBody.create(new byte[0], (okhttp3.MediaType) null);
                }
            }
            request = new Request.Builder().url(url).headers(hb.build()).method(method, body).build();
        } catch (IllegalArgumentException e) {
            call.reject("Bad request to " + host + ": " + e.getClass().getSimpleName(), "BAD_URL");
            return;
        }

        OkHttpClient client = baseClient.newBuilder()
            .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            // The whole exchange (connect + upload + download) ends by the deadline.
            .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .build();

        client.newCall(request).enqueue(new Callback() {
            @Override
            public void onFailure(Call c, IOException e) {
                rejectWith(call, classify(e, host, urlString));
            }

            @Override
            public void onResponse(Call c, Response response) {
                try (Response r = response) {
                    JSObject out = new JSObject();
                    out.put("status", r.code());
                    JSObject outHeaders = new JSObject();
                    Headers h = r.headers();
                    for (String name : h.names()) {
                        outHeaders.put(name.toLowerCase(Locale.ROOT), TextUtils.join(", ", h.values(name)));
                    }
                    out.put("headers", outHeaders);
                    out.put("bodyBase64", Base64.encodeToString(readCapped(r.body(), host), Base64.NO_WRAP));
                    call.resolve(out);
                } catch (HttpError e) {
                    rejectWith(call, e);
                } catch (IOException e) {
                    rejectWith(call, classify(e, host, urlString));
                } catch (OutOfMemoryError e) {
                    rejectWith(call, new HttpError("TOO_LARGE", "Response from " + host + " is too large for memory"));
                }
            }
        });
    }

    /** GET / HEAD never carry a body (OkHttp refuses one); PROPFIND etc. may. */
    private static boolean permitsBody(String method) {
        return !(method.equals("GET") || method.equals("HEAD"));
    }

    /** OkHttp requires a (possibly empty) body for these. */
    private static boolean requiresBody(String method) {
        return method.equals("POST") || method.equals("PUT") || method.equals("PATCH")
            || method.equals("PROPPATCH") || method.equals("REPORT");
    }

    private static byte[] readCapped(ResponseBody body, String host) throws IOException, HttpError {
        if (body == null) return new byte[0];
        long declared = body.contentLength();
        if (declared > MAX_RESPONSE_BYTES) throw tooLarge(host);
        BufferedSource source = body.source();
        Buffer buffer = new Buffer();
        while (true) {
            long n = source.read(buffer, 64 * 1024);
            if (n == -1) break;
            if (buffer.size() > MAX_RESPONSE_BYTES) throw tooLarge(host);
        }
        return buffer.readByteArray();
    }

    private static HttpError tooLarge(String host) {
        return new HttpError("TOO_LARGE", "Response from " + host + " is larger than 200 MB");
    }

    private static HttpError classify(IOException e, String host, String url) {
        boolean timeout = e instanceof SocketTimeoutException
            || (e instanceof InterruptedIOException && "timeout".equals(e.getMessage()))
            || (e.getMessage() != null && e.getMessage().toLowerCase(Locale.ROOT).contains("timeout"));
        if (timeout) return new HttpError("TIMEOUT", "Request to " + host + " timed out");
        return new HttpError("NETWORK", "Request to " + host + " failed: " + e.getClass().getSimpleName() + scrub(e.getMessage(), url));
    }

    /** An exception message without the URL (query, user info) in it. */
    private static String scrub(String message, String url) {
        if (message == null || message.isEmpty()) return "";
        String m = message;
        if (url != null && !url.isEmpty()) m = m.replace(url, "<url>");
        // Anything that still looks like a URL loses everything after its host.
        m = m.replaceAll("(?i)(https?://)(?:[^/@\\s]*@)?([^/?#\\s]*)[^\\s]*", "$1$2");
        if (m.length() > 300) m = m.substring(0, 300);
        return ": " + m;
    }

    private static void rejectWith(PluginCall call, HttpError e) {
        call.reject(e.getMessage(), e.code);
    }
}
