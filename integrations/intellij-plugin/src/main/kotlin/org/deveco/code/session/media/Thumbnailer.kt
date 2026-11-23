package org.deveco.code.session.media

import com.intellij.openapi.diagnostic.Logger
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.io.FilterInputStream
import java.io.FilterOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CancellationException
import javax.imageio.ImageIO

private val log = Logger.getInstance("Thumbnailer")

private fun throwIfImageOperationCancelled(isCancelled: () -> Boolean) {
    if (isCancelled()) throw CancellationException("Image operation cancelled")
}

private class CancellationAwareInputStream(input: InputStream, private val isCancelled: () -> Boolean) :
    FilterInputStream(input) {
    override fun read(): Int {
        throwIfImageOperationCancelled(isCancelled)
        return super.read()
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        throwIfImageOperationCancelled(isCancelled)
        return super.read(buffer, offset, length)
    }
}

private class CancellationAwareOutputStream(output: OutputStream, private val isCancelled: () -> Boolean) :
    FilterOutputStream(output) {
    override fun write(value: Int) {
        throwIfImageOperationCancelled(isCancelled)
        super.write(value)
    }

    override fun write(buffer: ByteArray, offset: Int, length: Int) {
        throwIfImageOperationCancelled(isCancelled)
        super.write(buffer, offset, length)
    }
}

internal object Thumbnailer {
    private const val MAX_PX = 256
    private const val QUALITY = 0.85f

    fun generateThumbnail(imageBytes: ByteArray, isCancelled: () -> Boolean = { false }): ByteArray? {
        throwIfImageOperationCancelled(isCancelled)
        val original = decodeForThumbnail(imageBytes, isCancelled) ?: return null
        throwIfImageOperationCancelled(isCancelled)
        val w = original.width
        val h = original.height
        if (w <= 0 || h <= 0) return null
        val scale = minOf(MAX_PX.toFloat() / w, MAX_PX.toFloat() / h, 1f)
        val tw = (w * scale).toInt().coerceAtLeast(1)
        val th = (h * scale).toInt().coerceAtLeast(1)
        // JPEG has no alpha channel. Writing an ARGB image directly to the JPEG
        // encoder fails with "Bogus input colorspace", which previously left the
        // composer without a preview. Render onto an opaque white RGB thumbnail.
        val thumb = BufferedImage(tw, th, BufferedImage.TYPE_INT_RGB)
        val g: Graphics2D = thumb.createGraphics()
        try {
            g.color = java.awt.Color.WHITE
            g.fillRect(0, 0, tw, th)
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR)
            g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY)
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g.drawImage(original, 0, 0, tw, th, null)
        } finally {
            g.dispose()
        }
        throwIfImageOperationCancelled(isCancelled)
        val out = ByteArrayOutputStream()
        val qualityOut = javax.imageio.plugins.jpeg.JPEGImageWriteParam(null).apply {
            // The param defaults to MODE_COPY_FROM_METADATA, where
            // setCompressionQuality throws; the quality knob needs MODE_EXPLICIT.
            compressionMode = javax.imageio.ImageWriteParam.MODE_EXPLICIT
            compressionQuality = QUALITY
        }
        try {
            val writer = ImageIO.getImageWritersByFormatName("jpg").next()
            val imageOutput = ImageIO.createImageOutputStream(CancellationAwareOutputStream(out, isCancelled))
            try {
                writer.output = imageOutput
                writer.write(null, javax.imageio.IIOImage(thumb, null, null), qualityOut)
            } finally {
                writer.dispose()
                imageOutput.close()
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            log.warn("JPEG writer failed, falling back to default encoder", error)
            out.reset()
            throwIfImageOperationCancelled(isCancelled)
            ImageIO.write(thumb, "jpg", CancellationAwareOutputStream(out, isCancelled))
        }
        throwIfImageOperationCancelled(isCancelled)
        return out.toByteArray()
    }

    private fun decodeForThumbnail(imageBytes: ByteArray, isCancelled: () -> Boolean): BufferedImage? = runCatching {
        throwIfImageOperationCancelled(isCancelled)
        val input = ImageIO.createImageInputStream(
            CancellationAwareInputStream(imageBytes.inputStream(), isCancelled),
        ) ?: return null
        try {
            val readers = ImageIO.getImageReaders(input)
            if (!readers.hasNext()) return null
            val reader = readers.next()
            try {
                reader.input = input
                val width = reader.getWidth(0)
                val height = reader.getHeight(0)
                if (width <= 0 || height <= 0) return null
                // Decode a bounded source image instead of allocating the full original
                // and only then shrinking it. For large images this is the main peak-
                // memory reduction; the final precise resize below remains unchanged.
                val sample = (maxOf(width, height) / MAX_PX).coerceAtLeast(1)
                val param = reader.defaultReadParam
                param.setSourceSubsampling(sample, sample, 0, 0)
                throwIfImageOperationCancelled(isCancelled)
                reader.read(0, param).also { throwIfImageOperationCancelled(isCancelled) }
            } finally {
                reader.dispose()
            }
        } finally {
            input.close()
        }
    }.onFailure {
        if (it is CancellationException) throw it
        log.warn("Failed to decode image for thumbnail", it)
    }.getOrNull()
}

internal object SendImageOptimizer {
    private const val MAX_LONG_EDGE = 2048
    private const val JPEG_QUALITY = 0.85f
    private const val KEEP_AS_IS_BYTES = 1L * 1024 * 1024
    private val LOSSY_FORMATS = setOf("jpg", "jpeg")

    fun optimize(bytes: ByteArray, mimeType: String, isCancelled: () -> Boolean = { false }): ByteArray {
        throwIfImageOperationCancelled(isCancelled)
        if (bytes.size <= KEEP_AS_IS_BYTES) return bytes
        val original = try {
            ImageIO.read(CancellationAwareInputStream(bytes.inputStream(), isCancelled))
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            null
        } ?: return bytes
        throwIfImageOperationCancelled(isCancelled)
        val w = original.width
        val h = original.height
        if (w <= 0 || h <= 0) return bytes
        val longEdge = maxOf(w, h)
        val needDownscale = longEdge > MAX_LONG_EDGE
        val ext = mimeType.substringAfter('/', "").lowercase()
        val needLossy = ext !in LOSSY_FORMATS
        if (!needDownscale && !needLossy) return bytes
        val scale = if (needDownscale) MAX_LONG_EDGE.toFloat() / longEdge else 1f
        val tw = (w * scale).toInt().coerceAtLeast(1)
        val th = (h * scale).toInt().coerceAtLeast(1)
        val out = java.awt.image.BufferedImage(tw, th, java.awt.image.BufferedImage.TYPE_INT_RGB)
        val g: java.awt.Graphics2D = out.createGraphics()
        try {
            g.setRenderingHint(
                java.awt.RenderingHints.KEY_INTERPOLATION,
                java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR,
            )
            g.setRenderingHint(java.awt.RenderingHints.KEY_RENDERING, java.awt.RenderingHints.VALUE_RENDER_QUALITY)
            g.setRenderingHint(java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_ON)
            // Fill white background for images with alpha channel — JPEG has no alpha,
            // so transparent pixels would otherwise render as pure black.
            if (original.colorModel.hasAlpha()) {
                g.color = java.awt.Color.WHITE
                g.fillRect(0, 0, tw, th)
            }
            g.drawImage(original, 0, 0, tw, th, null)
        } finally {
            g.dispose()
        }
        throwIfImageOperationCancelled(isCancelled)
        val baos = java.io.ByteArrayOutputStream()
        try {
            val writer = javax.imageio.ImageIO.getImageWritersByFormatName("jpg").next()
            val param = javax.imageio.plugins.jpeg.JPEGImageWriteParam(null).apply {
                // Same MODE_EXPLICIT requirement as in Thumbnailer above; without
                // it the throw silently degraded every send to the default encoder.
                compressionMode = javax.imageio.ImageWriteParam.MODE_EXPLICIT
                compressionQuality = JPEG_QUALITY
            }
            val imageOutput = ImageIO.createImageOutputStream(CancellationAwareOutputStream(baos, isCancelled))
            try {
                writer.output = imageOutput
                writer.write(null, javax.imageio.IIOImage(out, null, null), param)
            } finally {
                writer.dispose()
                imageOutput.close()
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            log.warn("JPEG writer failed, falling back to default encoder", error)
            baos.reset()
            throwIfImageOperationCancelled(isCancelled)
            ImageIO.write(out, "jpg", CancellationAwareOutputStream(baos, isCancelled))
        }
        throwIfImageOperationCancelled(isCancelled)
        return baos.toByteArray().takeIf { it.size < bytes.size } ?: bytes
    }
}
