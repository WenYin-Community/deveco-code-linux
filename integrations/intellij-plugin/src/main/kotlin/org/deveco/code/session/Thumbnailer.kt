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
