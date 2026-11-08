// SPDX-License-Identifier: AGPL-3.0-only
package app.paperdock.mobile

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.Rect
import android.graphics.pdf.PdfDocument
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import com.paddle.ocr.PaddleOCR
import com.paddle.ocr.util.OpenCVUtils
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlin.coroutines.coroutineContext
import kotlin.math.roundToInt

internal data class InputDocument(val uri: Uri, val name: String, val pdf: Boolean)

internal class DocumentProcessor(private val context: Context) {
    suspend fun recognize(input: List<InputDocument>, progress: suspend (Int, Int) -> Unit): String =
        withContext(Dispatchers.IO) {
            check(OpenCVUtils.init(context)) { "无法加载 OCR 图像处理组件。" }
            val recognizer = withContext(NonCancellable) { PaddleOCR.create(context) }
            try {
                val sections = mutableListOf<String>()
                if (input.singleOrNull()?.pdf == true) {
                    forEachPdfPage(input.single().uri) { page, index, total ->
                        progress(index + 1, total)
                        val bitmap = renderPage(page)
                        try {
                            val text = recognizeBitmap(recognizer, bitmap)
                            if (text.isNotBlank()) sections.add("第 ${index + 1} 页\n$text")
                        } finally {
                            bitmap.recycle()
                        }
                    }
                } else {
                    for ((index, document) in input.withIndex()) {
                        coroutineContext.ensureActive()
                        progress(index + 1, input.size)
                        val bitmap = readImage(document.uri)
                        try {
                            val text = recognizeBitmap(recognizer, bitmap)
                            if (text.isNotBlank()) sections.add(text)
                        } finally {
                            bitmap.recycle()
                        }
                    }
                }
                sections.joinToString("\n\n")
            } finally {
                withContext(NonCancellable) { recognizer.release() }
            }
        }

    suspend fun imagesToPdf(input: List<InputDocument>): File = withContext(Dispatchers.IO) {
        val output = File.createTempFile("paperdock-", ".pdf", context.cacheDir)
        try {
            val pdf = PdfDocument()
            try {
                for ((index, document) in input.withIndex()) {
                    coroutineContext.ensureActive()
                    val bitmap = readImage(document.uri)
                    try {
                        val width = 595
                        val height = (width.toDouble() * bitmap.height / bitmap.width).roundToInt().coerceIn(1, 4000)
                        val page = pdf.startPage(PdfDocument.PageInfo.Builder(width, height, index + 1).create())
                        page.canvas.drawColor(Color.WHITE)
                        val factor = minOf(width.toFloat() / bitmap.width, height.toFloat() / bitmap.height)
                        val drawnWidth = (bitmap.width * factor).roundToInt()
                        val drawnHeight = (bitmap.height * factor).roundToInt()
                        val left = (width - drawnWidth) / 2
                        val top = (height - drawnHeight) / 2
                        page.canvas.drawBitmap(bitmap, null, Rect(left, top, left + drawnWidth, top + drawnHeight), null)
                        pdf.finishPage(page)
                    } finally {
                        bitmap.recycle()
                    }
                }
                FileOutputStream(output).use(pdf::writeTo)
            } finally {
                pdf.close()
            }
            output
        } catch (failure: Exception) {
            output.delete()
            throw failure
        }
    }

    private suspend fun recognizeBitmap(recognizer: PaddleOCR, bitmap: Bitmap): String =
        recognizer.recognize(bitmap).results.joinToString("\n") { it.text.trim() }.trim()

    private suspend fun forEachPdfPage(uri: Uri, block: suspend (PdfRenderer.Page, Int, Int) -> Unit) {
        val local = File.createTempFile("paperdock-input-", ".pdf", context.cacheDir)
        try {
            val input = context.contentResolver.openInputStream(uri) ?: error("无法读取所选 PDF。")
            input.use { source ->
                local.outputStream().use { destination ->
                    val buffer = ByteArray(64 * 1024)
                    var copied = 0L
                    while (true) {
                        coroutineContext.ensureActive()
                        val count = source.read(buffer)
                        if (count < 0) break
                        copied += count
                        require(copied <= MAX_PDF_BYTES) { "预览版支持 50 MB 以内的 PDF。" }
                        destination.write(buffer, 0, count)
                    }
                }
            }
            ParcelFileDescriptor.open(local, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                PdfRenderer(descriptor).use { renderer ->
                    require(renderer.pageCount in 1..MAX_PDF_PAGES) { "预览版一次最多识别 20 页 PDF。" }
                    for (index in 0 until renderer.pageCount) {
                        coroutineContext.ensureActive()
                        renderer.openPage(index).use { page -> block(page, index, renderer.pageCount) }
                    }
                }
            }
        } finally {
            local.delete()
        }
    }

    private fun readImage(uri: Uri): Bitmap = ImageDecoder.decodeBitmap(
        ImageDecoder.createSource(context.contentResolver, uri),
    ) { decoder, info, _ ->
        val (width, height) = boundedDimensions(info.size.width, info.size.height)
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        decoder.setTargetSize(width, height)
    }

    private fun renderPage(page: PdfRenderer.Page): Bitmap {
        val (width, height) = boundedDimensions(page.width, page.height, allowUpscale = true)
        return Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also {
            it.eraseColor(Color.WHITE)
            page.render(it, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
        }
    }

    private fun boundedDimensions(width: Int, height: Int, allowUpscale: Boolean = false): Pair<Int, Int> {
        val ratio = MAX_IMAGE_EDGE.toDouble() / maxOf(width, height)
        val scale = if (allowUpscale) ratio else minOf(ratio, 1.0)
        return maxOf(1, (width * scale).roundToInt()) to maxOf(1, (height * scale).roundToInt())
    }

    private companion object {
        const val MAX_IMAGE_EDGE = 1800
        const val MAX_PDF_PAGES = 20
        const val MAX_PDF_BYTES = 50L * 1024 * 1024
    }
}
