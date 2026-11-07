// SPDX-License-Identifier: AGPL-3.0-only
package app.paperdock.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val processor by lazy { DocumentProcessor(applicationContext) }
    private var selection = emptyList<InputDocument>()
    private var busy = false
    private var pendingPdf: File? = null
    private lateinit var status: TextView
    private lateinit var filenames: TextView
    private lateinit var result: EditText
    private lateinit var select: Button
    private lateinit var recognize: Button
    private lateinit var convert: Button
    private lateinit var save: Button
    private lateinit var progress: ProgressBar

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        buildScreen()
        updateButtons()
    }

    private fun buildScreen() {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(16))
        }
        column.addView(TextView(this).apply { text = "PaperDock"; textSize = 27f })
        column.addView(TextView(this).apply {
            text = "安卓离线预览 · 图片、扫描件与 PDF"
            setPadding(0, dp(4), 0, dp(14))
        })
        select = button(column, "选择图片或 PDF", ::pickDocuments)
        filenames = TextView(this).apply { text = "尚未选择文件"; setPadding(0, dp(5), 0, dp(8)) }
        column.addView(filenames)
        recognize = button(column, "离线识别文字", ::recognizeSelection)
        convert = button(column, "把所选图片转为 PDF", ::convertSelection)
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            visibility = View.GONE
        }
        column.addView(progress)
        status = TextView(this).apply {
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            setPadding(0, dp(8), 0, dp(8))
            text = "文件和识别结果留在设备上。"
        }
        column.addView(status)
        result = EditText(this).apply {
            id = RESULT_ID
            hint = "识别结果，可在这里校对"
            gravity = android.view.Gravity.TOP or android.view.Gravity.START
            minLines = 5
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
            setSingleLine(false)
            isFocusableInTouchMode = true
            addTextChangedListener(object : android.text.TextWatcher {
                override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = updateButtons()
                override fun afterTextChanged(text: android.text.Editable?) = Unit
            })
        }
        column.addView(result)
        save = button(column, "保存 TXT") { createDocument(SAVE_TEXT, "text/plain", "PaperDock-OCR.txt") }
        column.isFocusableInTouchMode = true
        setContentView(ScrollView(this).apply { isFillViewport = true; addView(column) })
        column.requestFocus()
    }

    private fun button(parent: LinearLayout, title: String, click: () -> Unit): Button = Button(this).apply {
        text = title
        isAllCaps = false
        setOnClickListener { click() }
        parent.addView(this, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    }

    @Suppress("DEPRECATION")
    private fun pickDocuments() {
        startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            type = "*/*"
            addCategory(Intent.CATEGORY_OPENABLE)
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/pdf", "image/*"))
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }, OPEN_DOCUMENTS)
    }

    @Suppress("DEPRECATION")
    private fun createDocument(request: Int, mime: String, name: String) {
        startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            type = mime
            addCategory(Intent.CATEGORY_OPENABLE)
            putExtra(Intent.EXTRA_TITLE, name)
        }, request)
    }

    @Deprecated("Uses the platform Storage Access Framework activity contract")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK || data == null) {
            if (requestCode == SAVE_PDF) {
                pendingPdf?.delete()
                pendingPdf = null
                status.text = "已取消保存。"
            }
            return
        }
        when (requestCode) {
            OPEN_DOCUMENTS -> loadSelection(data)
            SAVE_TEXT -> data.data?.let(::writeText)
            SAVE_PDF -> data.data?.let(::writePdf)
        }
    }

    private fun loadSelection(data: Intent) = runOperation("正在打开文件…") {
        val uris = data.clipData?.let { clip -> (0 until clip.itemCount).map { clip.getItemAt(it).uri } }
            ?: listOfNotNull(data.data)
        val documents = withContext(Dispatchers.IO) {
            uris.distinct().map { uri ->
                val name = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                    ?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "文件"
                val type = contentResolver.getType(uri).orEmpty()
                val pdf = type == "application/pdf" || name.endsWith(".pdf", ignoreCase = true)
                require(pdf || type.startsWith("image/")) { "请选择图片或 PDF。" }
                InputDocument(uri, name, pdf)
            }
        }
        require(documents.size in 1..10) { "一次请选择 1 到 10 张图片或一份 PDF。" }
        require(documents.none { it.pdf } || documents.size == 1) { "请单独导入一份 PDF。" }
        selection = documents
        result.setText("")
        filenames.text = documents.joinToString("\n") { it.name }
        status.text = "已导入 ${documents.size} 个文件。"
    }

    private fun recognizeSelection() = runOperation("正在加载离线识别模型…") {
        val text = processor.recognize(selection) { index, total ->
            withContext(Dispatchers.Main) { status.text = "正在识别 $index / $total…" }
        }
        result.setText(text)
        status.text = if (text.isBlank()) "没有识别到文字，请检查图片清晰度。" else "识别完成，可以校对并保存 TXT。"
    }

    private fun convertSelection() = runOperation("正在生成 PDF…") {
        pendingPdf?.delete()
        pendingPdf = processor.imagesToPdf(selection)
        status.text = "PDF 已生成，请选择保存位置。"
        createDocument(SAVE_PDF, "application/pdf", "PaperDock-图片.pdf")
    }

    private fun writeText(uri: Uri) = runOperation("正在保存 TXT…") {
        val text = result.text.toString()
        withContext(Dispatchers.IO) {
            val output = contentResolver.openOutputStream(uri, "wt") ?: error("无法打开保存位置。")
            output.bufferedWriter(Charsets.UTF_8).use { it.write(text) }
        }
        status.text = "TXT 已保存。"
    }

    private fun writePdf(uri: Uri) {
        val file = pendingPdf ?: return
        pendingPdf = null
        runOperation("正在保存 PDF…") {
            withContext(Dispatchers.IO) {
                try {
                    val output = contentResolver.openOutputStream(uri, "wt") ?: error("无法打开保存位置。")
                    output.use { stream -> file.inputStream().use { it.copyTo(stream) } }
                } finally {
                    file.delete()
                }
            }
            status.text = "PDF 已保存。"
        }
    }

    private fun runOperation(message: String, task: suspend () -> Unit) {
        if (busy) return
        busy = true
        status.text = message
        updateButtons()
        scope.launch {
            try {
                task()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                status.text = "处理失败。${failure.message ?: "请检查文件后重试。"}"
            } finally {
                busy = false
                updateButtons()
            }
        }
    }

    private fun updateButtons() {
        if (!::save.isInitialized) return
        select.isEnabled = !busy
        recognize.isEnabled = !busy && selection.isNotEmpty()
        convert.isEnabled = !busy && selection.isNotEmpty() && selection.none { it.pdf }
        save.isEnabled = !busy && !result.text.isNullOrBlank()
        progress.visibility = if (busy) View.VISIBLE else View.GONE
    }

    override fun onDestroy() {
        scope.cancel()
        pendingPdf?.delete()
        super.onDestroy()
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()

    private companion object {
        const val OPEN_DOCUMENTS = 10
        const val SAVE_TEXT = 11
        const val SAVE_PDF = 12
        const val RESULT_ID = 0x7f0a00f0
    }
}
