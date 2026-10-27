package app.singpulse.tv;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Prevent Android TV screensaver / sleep mode during parties
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Allow unmuted HTML5 <video> autoplay without clicking the remote
        WebSettings webSettings = this.bridge.getWebView().getSettings();
        webSettings.setMediaPlaybackRequiresUserGesture(false);
    }
}
