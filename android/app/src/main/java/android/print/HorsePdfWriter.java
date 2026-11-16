package android.print;

import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;

/**
 * Drives a {@link PrintDocumentAdapter} (a WebView's) straight into a file,
 * without the system print dialog. Used by com.horsemd.app.HorsePdfPlugin.
 *
 * It lives in the android.print package because the SDK stubs declare the
 * constructors of {@link PrintDocumentAdapter.LayoutResultCallback} and
 * {@link PrintDocumentAdapter.WriteResultCallback} package-private (they are
 * public at runtime but hidden from apps): subclassing them from here is the
 * standard workaround.
 *
 * Sequence: onStart → onLayout(attributes) → onWrite(ALL_PAGES, output) →
 * onFinish. The callback is called exactly once, on the thread the adapter
 * calls back on (the main thread for a WebView). The caller owns and closes
 * the output descriptor.
 */
public final class HorsePdfWriter {

    public interface Callback {
        void onSuccess();

        void onFailure(String message);
    }

    private HorsePdfWriter() {}

    public static void write(
        final PrintDocumentAdapter adapter,
        final PrintAttributes attributes,
        final ParcelFileDescriptor output,
        final CancellationSignal cancel,
        final Callback callback
    ) {
        final boolean[] reported = { false };
        final Callback once = new Callback() {
            @Override
            public void onSuccess() {
                if (reported[0]) return;
                reported[0] = true;
                finishAdapter(adapter);
                callback.onSuccess();
            }

            @Override
            public void onFailure(String message) {
                if (reported[0]) return;
                reported[0] = true;
                finishAdapter(adapter);
                callback.onFailure(message);
            }
        };

        try {
            adapter.onStart();
            adapter.onLayout(
                null,
                attributes,
                cancel,
                new PrintDocumentAdapter.LayoutResultCallback() {
                    @Override
                    public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                        try {
                            adapter.onWrite(
                                new PageRange[] { PageRange.ALL_PAGES },
                                output,
                                cancel,
                                new PrintDocumentAdapter.WriteResultCallback() {
                                    @Override
                                    public void onWriteFinished(PageRange[] pages) {
                                        if (pages == null || pages.length == 0) {
                                            once.onFailure("No pages were written");
                                        } else {
                                            once.onSuccess();
                                        }
                                    }

                                    @Override
                                    public void onWriteFailed(CharSequence error) {
                                        once.onFailure("Write failed" + (error != null ? ": " + error : ""));
                                    }

                                    @Override
                                    public void onWriteCancelled() {
                                        once.onFailure("Write cancelled");
                                    }
                                }
                            );
                        } catch (RuntimeException e) {
                            once.onFailure("Write failed: " + e.getClass().getSimpleName());
                        }
                    }

                    @Override
                    public void onLayoutFailed(CharSequence error) {
                        once.onFailure("Layout failed" + (error != null ? ": " + error : ""));
                    }

                    @Override
                    public void onLayoutCancelled() {
                        once.onFailure("Layout cancelled");
                    }
                },
                new Bundle()
            );
        } catch (RuntimeException e) {
            once.onFailure("Print failed: " + e.getClass().getSimpleName());
        }
    }

    private static void finishAdapter(PrintDocumentAdapter adapter) {
        try {
            adapter.onFinish();
        } catch (RuntimeException ignored) {
            // The adapter is done either way.
        }
    }
}
