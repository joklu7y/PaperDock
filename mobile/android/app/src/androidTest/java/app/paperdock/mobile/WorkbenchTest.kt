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
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkbenchTest {
    @Test fun bundledWorkbenchLoadsInWebView() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val intent = Intent(instrumentation.targetContext, WorkbenchActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activity = instrumentation.startActivitySync(intent)
        try {
            fun script(expression: String): String? {
                var response: String? = null
                val complete = CountDownLatch(1)
                instrumentation.runOnMainSync {
                    val view = activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as WebView
                    view.evaluateJavascript(expression) { value -> response = value; complete.countDown() }
                }
                return if (complete.await(3, TimeUnit.SECONDS)) response else null
            }
            fun eventually(expression: String): Boolean {
                repeat(20) {
                    if (script(expression) == "true") return true
                    Thread.sleep(300)
                }
                return false
            }
            assertTrue("Expected the desktop-style workbench to load from the APK's local assets",
                eventually("!!document.querySelector('.pd-mobile') && document.body.innerText.includes('今天想处理什么文档')"))
            val wasm = activity.assets.list("workbench/assets")?.firstOrNull { it.endsWith(".wasm") }
            assertNotNull("Expected the offline PDF engine in the APK", wasm)
            script("fetch('./assets/$wasm').then(r=>r.arrayBuffer()).then(b=>{window.paperdockWasmLoaded=WebAssembly.validate(b)}).catch(()=>{window.paperdockWasmLoaded=false});void 0")
            assertTrue("Expected the bundled WASM engine to load with the network disabled", eventually("window.paperdockWasmLoaded === true"))
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }
}
