package chat.lumiverse.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.*;
import android.widget.*;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity {
    private WebView web;
    private String origin = "";
    private String pageScript;
    private boolean volumePaging;
    private boolean loaded;
    private boolean loadFailed;
    private AlertDialog connectionError;
    private ProgressBar loading;
    private final VolumePagingKeys pagingKeys = new VolumePagingKeys();

    // Lumiverse requires JavaScript; native bridges and file access stay disabled.
    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        try (var input = getAssets().open("page.js")) {
            var bytes = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
            pageScript = bytes.toString(StandardCharsets.UTF_8.name());
        } catch (Exception error) { throw new IllegalStateException(error); }
        var prefs = getPreferences(MODE_PRIVATE);
        origin = prefs.getString("origin", "");
        volumePaging = prefs.getBoolean("readingVolumePaging", true);
        var layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        web = new WebView(this);
        web.setBackgroundColor(android.graphics.Color.rgb(18, 18, 22));
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.getSettings().setSupportZoom(true);
        web.getSettings().setBuiltInZoomControls(true);
        web.getSettings().setDisplayZoomControls(false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                Uri url = request.getUrl();
                if (sameOrigin(url)) return false;
                if (request.hasGesture() && ("https".equals(url.getScheme()) || "http".equals(url.getScheme()))) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, url)); } catch (android.content.ActivityNotFoundException ignored) { }
                }
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                loaded = false;
                loadFailed = false;
                loading.setVisibility(android.view.View.VISIBLE);
            }
            @Override public void onPageFinished(WebView view, String url) {
                loading.setVisibility(android.view.View.GONE);
                loaded = !loadFailed && sameOrigin(Uri.parse(url));
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
                handler.cancel();
                showConnectionError("The server's HTTPS certificate could not be verified. If your private server uses HTTP, enter http:// before its address.");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) showConnectionError("The server returned HTTP " + response.getStatusCode() + ".");
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showConnectionError("Could not open " + origin + ". Check that the server is running and your VPN is connected.\n\n" + error.getDescription());
                }
            }
        });
        var content = new FrameLayout(this);
        content.addView(web, new FrameLayout.LayoutParams(-1, -1));
        loading = new ProgressBar(this);
        var spinnerLayout = new FrameLayout.LayoutParams(-2, -2, android.view.Gravity.CENTER);
        content.addView(loading, spinnerLayout);
        loading.setVisibility(android.view.View.GONE);
        layout.addView(content, new LinearLayout.LayoutParams(-1, -1));
        setContentView(layout);
        layout.requestApplyInsets();
        if (!origin.isEmpty()) web.loadUrl(origin); else configure();
    }

    private void showConnectionError(String message) {
        loaded = false;
        loadFailed = true;
        loading.setVisibility(android.view.View.GONE);
        if (isFinishing() || (connectionError != null && connectionError.isShowing())) return;
        connectionError = new AlertDialog.Builder(this).setTitle("Cannot connect to Lumiverse")
            .setMessage(message)
            .setPositiveButton("Retry", (dialog, which) -> web.loadUrl(origin))
            .setNeutralButton("Change server", (dialog, which) -> configure())
            .setNegativeButton("Close", (dialog, which) -> finish()).show();
    }

    private boolean sameOrigin(Uri url) {
        return ServerAddress.sameOrigin(origin, url.toString());
    }

    private void configure() {
        var input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("https://your-lumiverse-server");
        input.setText(origin);
        var settings = new LinearLayout(this);
        settings.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        settings.setPadding(padding, 0, padding, 0);
        settings.addView(input);
        var toggle = new Switch(this);
        toggle.setText(R.string.volume_paging);
        toggle.setChecked(volumePaging);
        settings.addView(toggle);
        var dialog = new AlertDialog.Builder(this).setTitle("Lumiverse server")
            .setMessage("Enter your server address, for example 192.168.1.10:7860. Private IP addresses use HTTP by default; other addresses use HTTPS. HTTP has no TLS encryption, so use it only over a trusted connection such as your VPN.")
            .setView(settings).setNegativeButton("Cancel", (ignored, which) -> { if (origin.isEmpty()) finish(); }).setPositiveButton("Connect", null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                origin = ServerAddress.normalize(input.getText().toString());
            } catch (IllegalArgumentException error) {
                input.setError("Enter a server address with an optional http:// or https:// prefix, without a path, credentials, query or fragment.");
                return;
            }
            volumePaging = toggle.isChecked();
            getPreferences(MODE_PRIVATE).edit().putString("origin", origin)
                .putBoolean("readingVolumePaging", volumePaging).apply();
            loaded = false;
            web.loadUrl(origin);
            dialog.dismiss();
        }));
        dialog.show();
    }

    private void page(int direction) {
        if (loaded && sameOrigin(Uri.parse(web.getUrl() == null ? "" : web.getUrl())))
            web.evaluateJavascript(pageScript.replace("__DIRECTION__", Integer.toString(direction)), null);
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        int decision = pagingKeys.handle(event.getKeyCode(), event.getAction(), event.getRepeatCount(),
            volumePaging && loaded && web.hasWindowFocus());
        if (decision == VolumePagingKeys.UP) page(-1);
        if (decision == VolumePagingKeys.DOWN) page(1);
        if (decision != VolumePagingKeys.PASS) return true;
        return super.dispatchKeyEvent(event);
    }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else new AlertDialog.Builder(this).setTitle("Lumiverse")
            .setItems(new String[]{"Connection settings", "Close app"}, (dialog, which) -> {
                if (which == 0) configure(); else finish();
            }).setNegativeButton("Cancel", null).show();
    }
    @Override protected void onPause() { pagingKeys.reset(); web.onPause(); CookieManager.getInstance().flush(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() { web.destroy(); super.onDestroy(); }
}
