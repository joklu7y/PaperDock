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
            fun eventually(expression: String, attempts: Int = 20): Boolean {
                repeat(attempts) {
                    if (script(expression) == "true") return true
                    Thread.sleep(300)
                }
                return false
            }
            assertTrue("Expected the phone workbench to load from the APK's local assets",
                eventually("document.querySelector('.pd-mobile .pd-home h2')?.textContent === '文档工具'"))
            val wasm = activity.assets.list("workbench/assets")?.firstOrNull { it.endsWith(".wasm") }
            assertNotNull("Expected the offline PDF engine in the APK", wasm)
            script("fetch('./assets/$wasm').then(r=>r.arrayBuffer()).then(b=>{window.paperdockWasmLoaded=WebAssembly.validate(b)}).catch(()=>{window.paperdockWasmLoaded=false});void 0")
            assertTrue("Expected the bundled WASM engine to load with the network disabled", eventually("window.paperdockWasmLoaded === true"))

            script("document.querySelector('.pd-tool-list button').click(); void 0")
            val fileInput = "document.querySelector('input[accept*=\".tiff\"]')"
            assertTrue("Expected the OCR file picker", eventually("!!$fileInput"))
            script("""
                window.ocrInitialScale = visualViewport.scale;
                const image = document.createElement('canvas');
                image.width = 960; image.height = 240;
                const drawing = image.getContext('2d');
                drawing.fillStyle = 'white'; drawing.fillRect(0, 0, 960, 240);
                drawing.fillStyle = 'black'; drawing.font = '64px sans-serif';
                drawing.fillText('PaperDock OCR 2026', 65, 130);
                image.toBlob(blob => {
                    const input = $fileInput;
                    const files = new DataTransfer();
                    files.items.add(new File([blob], 'workbench-' + 'a'.repeat(96) + '.png', {type:'image/png'}));
                    input.files = files.files;
                    input.dispatchEvent(new Event('change', {bubbles:true}));
                });
                void 0;
            """.trimIndent())
            val start = "Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim().endsWith('开始识别'))"
            assertTrue("Expected a queued image to enable OCR", eventually("$start?.disabled === false"))
            val fits = "document.documentElement.scrollWidth <= document.documentElement.clientWidth && visualViewport.scale === window.ocrInitialScale"
            assertTrue("A long filename must fit before recognition", eventually(fits))
            script("$start.click(); void 0")
            val reminder = "Array.from(document.querySelectorAll('[role=status]')).some(node => node.textContent.includes('识别可能有误，请仔细甄别'))"
            assertTrue("The review reminder should appear when recognition starts", eventually(reminder))
            assertTrue("Expected the offline OCR result", eventually("document.querySelector('textarea')?.value.includes('2026') === true", attempts = 60))
            assertTrue("A long filename must fit after recognition", eventually(fits))
            assertTrue("The review reminder should remain with the result", eventually(reminder))
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }
}
