// SPDX-License-Identifier: AGPL-3.0-only
package app.paperdock.mobile

import android.content.Intent
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkbenchTest {
    @Test fun bundledWorkbenchLoadsInWebView() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val intent = Intent(instrumentation.targetContext, WorkbenchActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activity = instrumentation.startActivitySync(intent)
        try {
            var ready = false
            for (attempt in 0 until 20) {
                val complete = CountDownLatch(1)
                instrumentation.runOnMainSync {
                    val view = activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as WebView
                    view.evaluateJavascript("!!document.querySelector('.pd-mobile') && document.body.innerText.includes('今天想处理什么文档')") { result ->
                        ready = result == "true"
                        complete.countDown()
                    }
                }
                if (complete.await(2, TimeUnit.SECONDS) && ready) break
                Thread.sleep(500)
            }
            assertTrue("Expected the desktop-style workbench to load from the APK's local assets", ready)
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }
}
