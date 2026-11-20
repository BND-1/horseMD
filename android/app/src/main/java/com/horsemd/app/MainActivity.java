package com.horsemd.app;

import android.content.pm.PackageInfo;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
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
        // PDF export on phones: off-screen WebView print to PDF bytes.
        registerPlugin(HorsePdfPlugin.class);
        // A re-created activity (process restore, "don't keep activities") gets its
        // launch intent again: the file in it was already delivered once.
        if (savedInstanceState != null) HorseFilesPlugin.markHandled(getIntent());
        super.onCreate(savedInstanceState);
        installKeyboardResize();
    }

    // The keyboard must shrink the WebView, or it covers the caret line, the
    // status bar and the sync unlock box (Huawei nova 5 Pro, 2026-11-20). The
    // status bar overlays the WebView (capacitor-api.js setupStatusBar:
    // SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN), and in that mode Android does not
    // resize the window for adjustResize (AndroidBug5497). Capacitor's
    // SystemBars pads the WebView's parent by the IME inset itself on Android
    // 15+ and on WebView 140+ (viewport-fit=cover); below both it does nothing.
    // There, the same padding comes from the visible frame (the
    // AndroidBug5497 workaround; @capacitor/keyboard's resizeOnFullScreen).
    private void installKeyboardResize() {
        if (Build.VERSION.SDK_INT >= 35 || webViewMajorVersion() >= 140) return;
        if (getBridge() == null || getBridge().getWebView() == null) return;
        final View parent = (View) getBridge().getWebView().getParent();
        if (parent == null) return;
        final Rect visible = new Rect();
        final int[] location = new int[2];
        parent.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
            parent.getWindowVisibleDisplayFrame(visible);
            parent.getLocationOnScreen(location);
            int covered = location[1] + parent.getHeight() - visible.bottom;
            // Only a keyboard: a navigation bar under the parent is not one.
            int screen = parent.getRootView().getHeight();
            int bottom = covered > screen * 0.15 ? covered : 0;
            if (parent.getPaddingBottom() != bottom) {
                parent.setPadding(parent.getPaddingLeft(), parent.getPaddingTop(), parent.getPaddingRight(), bottom);
            }
        });
    }

    private int webViewMajorVersion() {
        if (Build.VERSION.SDK_INT < 26) return 0;
        PackageInfo info = WebView.getCurrentWebViewPackage();
        if (info == null || info.versionName == null) return 0;
        try {
            return Integer.parseInt(info.versionName.split("\\.")[0]);
        } catch (NumberFormatException error) {
            return 0;
        }
    }
}
