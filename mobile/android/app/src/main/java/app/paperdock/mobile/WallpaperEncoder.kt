// SPDX-License-Identifier: AGPL-3.0-only
package app.paperdock.mobile

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject

@UnstableApi
internal class WallpaperEncoder(private val context: Context) {
    private var encoder: Transformer? = null
    private var cancelActive: (() -> Unit)? = null

    fun cancel() { cancelActive?.invoke() }

    fun progress(): Int {
        val holder = ProgressHolder()
        encoder?.getProgress(holder)
        return holder.progress
    }

    suspend fun encode(source: File, destination: File, low: Boolean): JSONObject {
        check(encoder == null) { "请先完成当前视频优化。" }
        val original = withContext(Dispatchers.IO) { metadata(source) }
        val width = original.getInt("width")
        val height = original.getInt("height")
        require(original.getDouble("seconds") in 0.01..300.0) { "视频最长支持 5 分钟。" }
        val long = if (low) 1280 else 1920
        val short = if (low) 720 else 1080
        val scale = minOf(1.0, long.toDouble() / maxOf(width, height), short.toDouble() / minOf(width, height))
        val outputWidth = (width * scale).roundToInt().coerceAtLeast(2) / 2 * 2
        val outputHeight = (height * scale).roundToInt().coerceAtLeast(2) / 2 * 2
        val fps = if (low) 24f else 30f
        val effects = Effects(emptyList(), listOf(
            Presentation.createForWidthAndHeight(outputWidth, outputHeight, Presentation.LAYOUT_SCALE_TO_FIT),
            FrameDropEffect.createDefaultFrameDropEffect(fps),
        ))
        val item = EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(source))).setRemoveAudio(true).setEffects(effects).build()
        try {
            suspendCancellableCoroutine { continuation ->
                val listener = object : Transformer.Listener {
                    override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                        if (continuation.isActive) continuation.resume(Unit)
                    }
                    override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                        if (continuation.isActive) continuation.resumeWithException(exportException)
                    }
                }
                val transformer = Transformer.Builder(context).setVideoMimeType(MimeTypes.VIDEO_H264).addListener(listener).build()
                encoder = transformer
                cancelActive = { continuation.cancel() }
                continuation.invokeOnCancellation { android.os.Handler(android.os.Looper.getMainLooper()).post { transformer.cancel() } }
                transformer.start(item, destination.absolutePath)
            }
            val result = withContext(Dispatchers.IO) { metadata(destination) }
            return JSONObject().put("original", original).put("output", result)
        } finally {
            encoder = null
            cancelActive = null
        }
    }

    private fun metadata(file: File): JSONObject {
        val reader = MediaMetadataRetriever()
        try {
            reader.setDataSource(file.absolutePath)
            val width = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: error("无法读取视频尺寸。")
            val height = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: error("无法读取视频尺寸。")
            require(width > 0 && height > 0) { "视频尺寸无效。" }
            val rotation = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            val swap = rotation % 180 != 0
            val duration = (reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull() ?: 0.0) / 1000
            val frames = reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)?.toDoubleOrNull()
            val fps = if (frames != null && duration > 0) frames / duration
                else reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)?.toDoubleOrNull() ?: 30.0
            return JSONObject().put("width", if (swap) height else width).put("height", if (swap) width else height)
                .put("seconds", duration).put("fps", fps).put("bytes", file.length())
        } finally { reader.release() }
    }
}
