// SPDX-License-Identifier: AGPL-3.0-only
package app.paperdock.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.media3.common.util.UnstableApi
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

@UnstableApi
class WorkbenchActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val processor by lazy { DocumentProcessor(applicationContext) }
    private val wallpaper by lazy { WallpaperEncoder(applicationContext) }
    private lateinit var web: WebView
    private var picker: ValueCallback<Array<Uri>>? = null
    private var screenshot: String? = null
    private var pending: Export? = null
    private var preparingExport = false

    private data class Export(val request: String, val name: String, val mime: String, val file: File)

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        web = WebView(this)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = !owns(request.url)

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (!owns(request.url)) return WebResourceResponse("text/plain", "UTF-8", null)
                val path = request.url.path.orEmpty().removePrefix("/")
                if (path.split('/').any { it == ".." }) return WebResourceResponse("text/plain", "UTF-8", null)
                return try { WebResourceResponse(contentType(path), null, assets.open(path)) }
                catch (_: java.io.IOException) { WebResourceResponse("text/plain", "UTF-8", null) }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                picker?.onReceiveValue(null)
                picker = callback
                return try {
                    startActivityForResult(params.createIntent(), PICK_FILES)
                    true
                } catch (_: Exception) {
                    picker = null
                    callback.onReceiveValue(null)
                    true
                }
            }
        }
        web.addJavascriptInterface(Bridge(), "PaperDockAndroid")
        setContentView(web)
        web.loadUrl("https://$ORIGIN/workbench/index.html")
    }

    private fun owns(uri: Uri) = uri.scheme == "https" && uri.host == ORIGIN && uri.path.orEmpty().startsWith("/workbench/")

    private inner class Bridge {
        @JavascriptInterface
        fun postMessage(raw: String) {
            val message = runCatching { JSONObject(raw) }.getOrNull() ?: return
            val id = message.optString("id").takeIf { it.matches(Regex("[0-9a-f-]{36}")) } ?: return
            scope.launch {
                try {
                    when (message.optString("action")) {
                        "ocr" -> reply(id, recognize(message))
                        "save" -> save(id, message)
                        "list" -> reply(id, downloads())
                        "open" -> { open(message); reply(id, JSONObject()) }
                        "screenshot" -> chooseScreenshot(id)
                        "video" -> encodeWallpaper(id, message)
                        "video-status" -> reply(id, JSONObject().put("state", "optimizing").put("progress", wallpaper.progress()))
                        "video-cancel" -> { wallpaper.cancel(); reply(id, JSONObject()) }
                        else -> error("不支持的手机操作。")
                    }
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) { reply(id, error = failure.message ?: "手机操作失败。") }
            }
        }
    }

    private fun reply(id: String, value: Any? = null, error: String? = null) {
        val message = JSONObject().put("id", id).put("value", value ?: JSONObject.NULL)
        if (error != null) message.put("error", error)
        web.evaluateJavascript("window.paperDockReply?.(${message});", null)
    }

    private suspend fun recognize(message: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val name = message.getString("name")
        val pdf = name.endsWith(".pdf", ignoreCase = true)
        val file = cacheInput(message, if (pdf) ".pdf" else ".image")
        try {
            if (!pdf && message.optBoolean("locations")) {
                val lines = processor.imageLocations(Uri.fromFile(file))
                return@withContext JSONObject().put("pages", 1).put("text", lines.joinToString("\n") { it.text })
                    .put("locations", JSONArray(lines.map { line -> JSONObject().put("text", line.text).put("box", JSONArray(line.box)) }))
            }
            var pages = 1
            val text = processor.recognize(listOf(InputDocument(Uri.fromFile(file), name, pdf))) { _, total -> pages = total }
            JSONObject().put("text", text).put("pages", pages)
        } finally { file.delete() }
    }

    private fun cacheInput(message: JSONObject, suffix: String): File {
        val encoded = message.getString("data")
        require(encoded.length <= 96 * 1024 * 1024) { "文件太大，请缩小后再试。" }
        val file = File.createTempFile("paperdock-bridge-", suffix, cacheDir)
        try {
            file.writeBytes(Base64.decode(encoded, Base64.DEFAULT))
            return file
        } catch (failure: Exception) { file.delete(); throw failure }
    }

    private suspend fun encodeWallpaper(id: String, message: JSONObject) {
        val input = withContext(Dispatchers.IO) { cacheInput(message, ".video") }
        val output = File.createTempFile("paperdock-wallpaper-", ".mp4", cacheDir)
        output.delete()
        try {
            val metadata = wallpaper.encode(input, output, message.optBoolean("low"))
            val data = withContext(Dispatchers.IO) {
                require(output.length() in 1..(45L * 1024 * 1024)) { "优化副本超过 45 MB，请选择更短的视频。" }
                Base64.encodeToString(output.readBytes(), Base64.NO_WRAP)
            }
            reply(id, JSONObject().put("data", data).put("metadata", metadata))
        } catch (cancelled: CancellationException) { reply(id, error = "已取消视频优化。") }
        finally { input.delete(); output.delete() }
    }

    private suspend fun save(id: String, message: JSONObject) {
        check(pending == null && !preparingExport) { "请先完成当前保存。" }
        val name = File(message.getString("name")).name.take(180)
        require(name.isNotBlank()) { "请填写文件名。" }
        val mime = contentType(name)
        preparingExport = true
        val file = try { withContext(Dispatchers.IO) { cacheInput(message, ".export") } }
            finally { preparingExport = false }
        pending = Export(id, name, mime, file)
        try {
            startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                type = mime
                addCategory(Intent.CATEGORY_OPENABLE)
                putExtra(Intent.EXTRA_TITLE, name)
            }, SAVE_FILE)
        } catch (failure: Exception) { pending = null; file.delete(); throw failure }
    }

    private fun chooseScreenshot(id: String) {
        check(screenshot == null) { "请先完成当前截图选择。" }
        screenshot = id
        try { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE), PICK_SCREENSHOT) }
        catch (failure: Exception) { screenshot = null; throw failure }
    }

    @Deprecated("Uses the system file picker and save sheet")
    override fun onActivityResult(request: Int, result: Int, data: Intent?) {
        super.onActivityResult(request, result, data)
        when (request) {
            PICK_FILES -> {
                val callback = picker
                picker = null
                callback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data))
            }
            SAVE_FILE -> {
                val export = pending ?: return
                pending = null
                val uri = data?.data?.takeIf { result == RESULT_OK }
                if (uri == null) { export.file.delete(); reply(export.request, JSONObject().put("cancelled", true)); return }
                scope.launch { finishExport(export, uri, data?.flags ?: 0) }
            }
            PICK_SCREENSHOT -> {
                val id = screenshot ?: return
                screenshot = null
                val uri = data?.data?.takeIf { result == RESULT_OK }
                if (uri == null) { reply(id); return }
                scope.launch {
                    try {
                        val value = withContext(Dispatchers.IO) {
                            val input = contentResolver.openInputStream(uri) ?: error("无法读取截图。")
                            val bytes = input.use { source ->
                                val output = ByteArrayOutputStream()
                                val chunk = ByteArray(65536)
                                while (true) {
                                    val count = source.read(chunk)
                                    if (count < 0) break
                                    require(output.size() + count <= 25 * 1024 * 1024) { "截图文件过大。" }
                                    output.write(chunk, 0, count)
                                }
                                output.toByteArray()
                            }
                            JSONObject().put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                                .put("type", contentResolver.getType(uri) ?: "image/png")
                        }
                        reply(id, value)
                    } catch (failure: Exception) { reply(id, error = failure.message ?: "读取截图失败。") }
                }
            }
        }
    }

    private suspend fun finishExport(export: Export, uri: Uri, flags: Int) {
        try {
            withContext(Dispatchers.IO) {
                val output = contentResolver.openOutputStream(uri, "wt") ?: error("无法写入保存位置。")
                output.use { stream -> export.file.inputStream().use { it.copyTo(stream) } }
            }
            runCatching { contentResolver.takePersistableUriPermission(uri, flags and Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            val id = UUID.randomUUID().toString()
            val saved = JSONObject().put("id", id).put("name", export.name).put("status", "已保存")
                .put("path", export.name).put("uri", uri.toString()).put("mime", export.mime)
            val previous = downloads()
            val entries = JSONArray().put(saved)
            for (index in 0 until minOf(199, previous.length())) entries.put(previous.getJSONObject(index))
            getPreferences(MODE_PRIVATE).edit().putString("exports", entries.toString()).apply()
            reply(export.request, JSONObject().put("path", export.name).put("record_id", id))
        } catch (failure: Exception) { reply(export.request, error = failure.message ?: "保存失败。") }
        finally { export.file.delete() }
    }

    private fun downloads() = JSONArray(getPreferences(MODE_PRIVATE).getString("exports", "[]") ?: "[]")

    private fun open(message: JSONObject) {
        val records = downloads()
        val id = message.getString("record")
        val record = (0 until records.length()).map { records.getJSONObject(it) }.firstOrNull { it.getString("id") == id }
            ?: error("找不到这条保存记录。")
        val uri = Uri.parse(record.getString("uri"))
        val mime = record.getString("mime")
        val intent = if (message.optBoolean("share")) Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
            else Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
        startActivity(Intent.createChooser(intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), null))
    }

    override fun onDestroy() {
        scope.cancel()
        pending?.file?.delete()
        picker?.onReceiveValue(null)
        web.removeJavascriptInterface("PaperDockAndroid")
        web.destroy()
        super.onDestroy()
    }

    private fun contentType(path: String): String = when (path.substringAfterLast('.').lowercase()) {
        "html" -> "text/html"
        "css" -> "text/css"
        "js" -> "text/javascript"
        "wasm" -> "application/wasm"
        "woff" -> "font/woff"
        "woff2" -> "font/woff2"
        "pdf" -> "application/pdf"
        "txt", "md" -> "text/plain"
        "csv" -> "text/csv"
        "json" -> "application/json"
        "zip" -> "application/zip"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        "odt" -> "application/vnd.oasis.opendocument.text"
        "epub" -> "application/epub+zip"
        else -> "application/octet-stream"
    }

    private companion object {
        const val ORIGIN = "appassets.androidplatform.net"
        const val PICK_FILES = 20
        const val SAVE_FILE = 21
        const val PICK_SCREENSHOT = 22
    }
}
