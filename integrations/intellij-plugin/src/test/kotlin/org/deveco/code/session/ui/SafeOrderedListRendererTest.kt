package org.deveco.code.session.ui

import org.jetbrains.jewel.markdown.MarkdownBlock
import org.jetbrains.jewel.markdown.processing.MarkdownProcessor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class SafeOrderedListRendererTest {

    private val processor = MarkdownProcessor()

    @Test
    fun `zero start list parses to startFrom 0 and is clamped`() {
        val lists = collectOrderedLists(processor.processMarkdownDocument("0. item"))
        assertEquals(1, lists.size)
        assertEquals(0, lists[0].startFrom)
        assertEquals(1, clampedOrderedListStart(lists[0]).startFrom)
    }

    @Test
    fun `block quoted zero start list is clamped`() {
        val lists = collectOrderedLists(processor.processMarkdownDocument("> 0. first"))
        assertEquals(1, lists.size)
        assertEquals(0, lists[0].startFrom)
        assertEquals(1, clampedOrderedListStart(lists[0]).startFrom)
    }

    @Test
    fun `zero start list nested in list item is clamped`() {
        val lists = collectOrderedLists(processor.processMarkdownDocument("- a\n\n  0. b"))
        assertEquals(1, lists.size)
        assertEquals(0, lists[0].startFrom)
        assertEquals(1, clampedOrderedListStart(lists[0]).startFrom)
    }

    @Test
    fun `zero start list in nested block quotes is clamped`() {
        val lists = collectOrderedLists(processor.processMarkdownDocument("> > 0. x"))
        assertEquals(1, lists.size)
        assertEquals(0, lists[0].startFrom)
        assertEquals(1, clampedOrderedListStart(lists[0]).startFrom)
    }

    @Test
    fun `positive start list is preserved unchanged`() {
        val lists = collectOrderedLists(processor.processMarkdownDocument("3. item"))
        assertEquals(1, lists.size)
        assertEquals(3, lists[0].startFrom)
        assertSame(lists[0], clampedOrderedListStart(lists[0]))
    }

    private fun collectOrderedLists(blocks: List<MarkdownBlock>): List<MarkdownBlock.ListBlock.OrderedList> {
        val result = mutableListOf<MarkdownBlock.ListBlock.OrderedList>()
        fun walk(current: MarkdownBlock) {
            if (current is MarkdownBlock.ListBlock.OrderedList) result.add(current)
            when (current) {
                is MarkdownBlock.BlockQuote -> current.children.forEach(::walk)
                is MarkdownBlock.ListItem -> current.children.forEach(::walk)
                is MarkdownBlock.ListBlock -> current.children.forEach(::walk)
                else -> Unit
            }
        }
        blocks.forEach(::walk)
        return result
    }
}
