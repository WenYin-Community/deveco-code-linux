package org.deveco.code.session

import com.intellij.openapi.diagnostic.Logger
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO

private val log = Logger.getInstance("Thumbnailer")

internal object Thumbnailer {
    private const val MAX_PX = 256
    private const val QUALITY = 0.85f

    fun generateThumbnail(imageBytes: ByteArray): ByteArray? {
        val original = runCatching {
            ImageIO.read(imageBytes.inputStream())
        }.onFailure { log.warn("Failed to decode image for thumbnail", it) }.getOrNull() ?: return null
        val w = original.width
        val h = original.height
        if (w <= 0 || h <= 0) return null
        val scale = minOf(MAX_PX.toFloat() / w, MAX_PX.toFloat() / h, 1f)
        val tw = (w * scale).toInt().coerceAtLeast(1)
        val th = (h * scale).toInt().coerceAtLeast(1)
        val thumb = BufferedImage(tw, th, BufferedImage.TYPE_INT_ARGB)
        val g: Graphics2D = thumb.createGraphics()
        try {
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR)
            g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY)
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g.drawImage(original, 0, 0, tw, th, null)
        } finally {
            g.dispose()
        }
        val out = ByteArrayOutputStream()
        val qualityOut = javax.imageio.plugins.jpeg.JPEGImageWriteParam(null).apply {
            // The param defaults to MODE_COPY_FROM_METADATA, where
            // setCompressionQuality throws; the quality knob needs MODE_EXPLICIT.
            compressionMode = javax.imageio.ImageWriteParam.MODE_EXPLICIT
            compressionQuality = QUALITY
        }
        runCatching {
            val writer = ImageIO.getImageWritersByFormatName("jpg").next()
            writer.output = ImageIO.createImageOutputStream(out)
            writer.write(null, javax.imageio.IIOImage(thumb, null, null), qualityOut)
            writer.dispose()
        }.getOrElse { e ->
            log.warn("JPEG writer failed, falling back to default encoder", e)
            out.reset()
            ImageIO.write(thumb, "jpg", out)
        }
        return out.toByteArray()
    }
}

internal object SendImageOptimizer {
    private const val MAX_LONG_EDGE = 2048
    private const val JPEG_QUALITY = 0.85f
    private const val KEEP_AS_IS_BYTES = 1L * 1024 * 1024
    private val LOSSY_FORMATS = setOf("jpg", "jpeg")

    fun optimize(bytes: ByteArray, mimeType: String): ByteArray {
        if (bytes.size <= KEEP_AS_IS_BYTES) return bytes
        val original = runCatching {
            javax.imageio.ImageIO.read(bytes.inputStream())
        }.getOrNull() ?: return bytes
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
        val baos = java.io.ByteArrayOutputStream()
        runCatching {
            val writer = javax.imageio.ImageIO.getImageWritersByFormatName("jpg").next()
            val param = javax.imageio.plugins.jpeg.JPEGImageWriteParam(null).apply {
                // Same MODE_EXPLICIT requirement as in Thumbnailer above; without
                // it the throw silently degraded every send to the default encoder.
                compressionMode = javax.imageio.ImageWriteParam.MODE_EXPLICIT
                compressionQuality = JPEG_QUALITY
            }
            writer.output = javax.imageio.ImageIO.createImageOutputStream(baos)
            writer.write(null, javax.imageio.IIOImage(out, null, null), param)
            writer.dispose()
        }.getOrElse { e ->
            baos.reset()
            javax.imageio.ImageIO.write(out, "jpg", baos)
        }
        return baos.toByteArray().takeIf { it.size < bytes.size } ?: bytes
    }
}
