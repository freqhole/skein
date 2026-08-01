package net.freqhole.skein

import android.os.Bundle
import androidx.core.view.WindowCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // let android draw system bars itself so the webview doesn't extend behind them.
    WindowCompat.setDecorFitsSystemWindows(window, true)
    super.onCreate(savedInstanceState)
  }
}
