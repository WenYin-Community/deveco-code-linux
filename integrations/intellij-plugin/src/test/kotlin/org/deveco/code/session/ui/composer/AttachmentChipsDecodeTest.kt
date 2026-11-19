package org.deveco.code.session.ui.composer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import javax.imageio.ImageIO

/**
 * Unit tests for [decodeToImageBitmap] in AttachmentChips.kt: decodable
 * raster images produce a bitmap (downscaled to at most 256px on the longer
 * side, untouched when already small enough), while undecodable input
 * (garbage, empty, non-raster formats such as svg text) yields null instead
 * of throwing.
 */
class AttachmentChipsDecodeTest {

    private fun pngBytes(width: Int, height: Int): ByteArray {
        val out = ByteArrayOutputStream()
        ImageIO.write(BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB), "PNG", out)
        return out.toByteArray()
    }

    @Test
    fun testSmallImageDecodesUnscaled() {
        val bitmap = decodeToImageBitmap(pngBytes(10, 5))

        assertNotNull(bitmap)
        assertEquals(10, bitmap!!.width)
        assertEquals(5, bitmap.height)
    }

    @Test
    fun testLargeImageIsDownscaledToThumbnailMaximum() {
        // 512x256 scales by exactly 0.5 -> 256x128 thumbnail.
        val bitmap = decodeToImageBitmap(pngBytes(512, 256))

        assertNotNull(bitmap)
        assertEquals(256, bitmap!!.width)
        assertEquals(128, bitmap.height)
    }

    @Test
    fun testGarbageBytesReturnNull() {
        assertNull(decodeToImageBitmap("this is not an image at all".toByteArray()))
    }

    @Test
    fun testEmptyBytesReturnNull() {
        assertNull(decodeToImageBitmap(ByteArray(0)))
    }

    @Test
    fun testThumbnailStaysWithinThumbnailMaximum() {
        val bitmap = decodeToImageBitmap(pngBytes(999, 400))

        assertNotNull(bitmap)
        assertTrue(bitmap!!.width <= 256)
        assertTrue(bitmap.height <= 256)
    }
}
