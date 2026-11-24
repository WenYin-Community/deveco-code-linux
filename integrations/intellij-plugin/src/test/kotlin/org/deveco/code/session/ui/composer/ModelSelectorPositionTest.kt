package org.deveco.code.session.ui.composer

import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests for [DropdownPositionProvider] in ModelSelector.kt: the default
 * above-anchor placement (which deliberately tolerates clipping off-screen),
 * the end-aligned variant, and the flip-on-overflow variant that keeps the
 * popup fully inside the window. The fixed anchor gap is 2px.
 */
class ModelSelectorPositionTest {

    private val window = IntSize(800, 600)
    private val content = IntSize(100, 40)
    private val ltr = LayoutDirection.Ltr

    private fun position(
        anchor: IntRect,
        endAligned: Boolean = false,
        flipOnOverflow: Boolean = false,
        windowSize: IntSize = window,
    ): IntOffset = DropdownPositionProvider(endAligned, flipOnOverflow)
        .calculatePosition(anchor, windowSize, ltr, content)

    @Test
    fun testDefaultOpensAboveAnchorAtLeftEdge() {
        assertEquals(
            IntOffset(10, 18),
            position(IntRect(10, 60, 50, 80)),
        )
    }

    @Test
    fun testDefaultClampsNegativeXToZero() {
        assertEquals(IntOffset(0, 18), position(IntRect(-5, 60, 50, 80)))
    }

    @Test
    fun testDefaultToleratesClippingAboveTheScreen() {
        // Documented behavior: without flipOnOverflow the popup may clip when
        // there is no room above the anchor — y stays negative.
        assertEquals(IntOffset(10, -22), position(IntRect(10, 20, 50, 40)))
    }

    @Test
    fun testEndAlignedAlignsPopupRightEdgeWithAnchor() {
        assertEquals(IntOffset(100, 18), position(IntRect(10, 60, 200, 80), endAligned = true))
    }

    @Test
    fun testFlipOnOverflowKeepsPopupAboveWhenThereIsRoom() {
        assertEquals(IntOffset(10, 18), position(IntRect(10, 60, 50, 80), flipOnOverflow = true))
    }

    @Test
    fun testFlipOnOverflowDropsBelowAnchorWhenAboveWouldClip() {
        // anchor bottom = 40, so below-placement y = 40 + 2px gap.
        assertEquals(IntOffset(10, 42), position(IntRect(10, 20, 50, 40), flipOnOverflow = true))
    }

    @Test
    fun testFlipOnOverflowClampsXIntoTheWindow() {
        assertEquals(
            IntOffset(20, 18),
            position(IntRect(150, 60, 200, 80), flipOnOverflow = true, windowSize = IntSize(120, 600)),
        )
    }

    @Test
    fun testEndAlignedWithFlipClampsBothEdges() {
        assertEquals(
            IntOffset(20, 42),
            position(
                IntRect(150, 20, 200, 40),
                endAligned = true,
                flipOnOverflow = true,
                windowSize = IntSize(120, 600),
            ),
        )
    }
}
