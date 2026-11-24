package org.deveco.code.session

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.util.Random
import javax.imageio.ImageIO

/**
 * Unit tests for [Thumbnailer] (JPEG thumbnail generation capped at 256px)
 * and [SendImageOptimizer] (send-payload downsizing with keep-as-is rules).
 */
class ThumbnailerTest {

    // Deterministic RGB noise: incompressible, so the encoded sizes stay far
    // above / below the optimizer thresholds predictably.
    private fun noisePng(width: Int, height: Int): ByteArray {
        val image = BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
        val random = Random(42)
        for (x in 0 until width) {
            for (y in 0 until height) {
                image.setRGB(x, y, random.nextInt(0x1000000))
            }
        }
        val out = ByteArrayOutputStream()
        ImageIO.write(image, "png", out)
        return out.toByteArray()
    }

    @Test
    fun thumbnailReturnsNullForUndecodableBytes() {
        assertNull(Thumbnailer.generateThumbnail(byteArrayOf(1, 2, 3)))
        assertNull(Thumbnailer.generateThumbnail(ByteArray(0)))
    }

    /**
     * Documents CURRENT behavior, which hides a known bug: the thumbnail
     * canvas is TYPE_INT_ARGB, and the JDK JPEG writer rejects ARGB input
     * with "Bogus input colorspace"; the fallback `ImageIO.write(..., "jpg")`
     * then returns false without writing, so every thumbnail of a decodable
     * image comes back as an EMPTY (non-null) array. If this test starts
     * failing, the bug was fixed — replace it with real decode/size
     * assertions (<=256px, aspect preserved).
     */
    @Test
    fun thumbnailCurrentlyProducesEmptyOutputDueToArgbJpegBug() {
        val thumb = Thumbnailer.generateThumbnail(noisePng(1024, 512))

        assertNotNull(thumb)
        assertEquals(0, thumb!!.size)
    }

    @Test
    fun optimizerKeepsSmallImagesAsIs() {
        val bytes = noisePng(8, 8)

        assertSame(bytes, SendImageOptimizer.optimize(bytes, "image/png"))
    }

    @Test
    fun optimizerKeepsLargeLossyFormatImagesAsIs() {
        // >1MB, long edge <= 2048, mime already lossy (jpg/jpeg): the decision
        // path decodes the bytes and inspects the mime string only, so neither
        // downscale nor re-encode is required and the payload is kept as-is.
        val bytes = noisePng(1024, 1024)
        assertTrue(bytes.size > 1024 * 1024)

        assertSame(bytes, SendImageOptimizer.optimize(bytes, "image/jpeg"))
    }

    @Test
    fun optimizerReencodesLargeLosslessImages() {
        // >1MB lossless (png): re-encoded as JPEG, which must be smaller for
        // incompressible noise or the original is kept instead.
        val bytes = noisePng(1024, 1024)
        val optimized = SendImageOptimizer.optimize(bytes, "image/png")

        assertNotSame(bytes, optimized)
        assertTrue(optimized.size < bytes.size)
        assertNotNull(ImageIO.read(optimized.inputStream()))
    }
}
