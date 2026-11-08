// SPDX-License-Identifier: AGPL-3.0-only
package app.paperdock.mobile

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OfflineDocumentTest {
    @Test fun localImageAndScannedPdfRecognition() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val bitmap = Bitmap.createBitmap(1050, 310, Bitmap.Config.ARGB_8888)
        val input = File.createTempFile("printed-sample-", ".png", context.cacheDir)
        try {
            val canvas = Canvas(bitmap)
            canvas.drawColor(Color.WHITE)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; textSize = 75f }
            canvas.drawText("PaperDock OCR 2026", 65f, 125f, paint)
            canvas.drawText("本地文字识别测试", 65f, 235f, paint)
            input.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            val processor = DocumentProcessor(context)
            val document = InputDocument(Uri.fromFile(input), input.name, false)
            val imageText = processor.recognize(listOf(document)) { _, _ -> }
            assertTrue("Expected digits in image OCR. Got: $imageText", "2026" in imageText)
            assertTrue("Expected Chinese in image OCR. Got: $imageText", "文字" in imageText)
            val pdf = processor.imagesToPdf(listOf(document, document))
            try {
                ParcelFileDescriptor.open(pdf, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                    PdfRenderer(descriptor).use { assertEquals(2, it.pageCount) }
                }
                val scanText = processor.recognize(listOf(InputDocument(Uri.fromFile(pdf), pdf.name, true))) { _, _ -> }
                assertTrue("Expected both PDF pages in scan OCR. Got: $scanText", "第 1 页" in scanText && "第 2 页" in scanText)
                assertTrue("Expected image text preserved in PDF. Got: $scanText", "2026" in scanText)
            } finally {
                pdf.delete()
            }
        } finally {
            bitmap.recycle()
            input.delete()
        }
    }
}
