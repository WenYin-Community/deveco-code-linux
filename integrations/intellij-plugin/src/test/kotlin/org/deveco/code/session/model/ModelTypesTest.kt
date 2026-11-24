package org.deveco.code.session.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class ModelTypesTest {

    // FileReference

    @Test
    fun `file reference keeps the last path segment as its name`() {
        assertEquals("Index.ets", FileReference("entry/src/main/ets/pages/Index.ets", 1, 2).fileName)
        assertEquals("notes.txt", FileReference("notes.txt", 1, 2).fileName)
    }

    @Test
    fun `a line range is present only with positive bounds`() {
        assertTrue(FileReference("a", 1, 1).hasLineRange)
        assertFalse(FileReference("a", 0, 3).hasLineRange)
        assertFalse(FileReference("a", 2, 0).hasLineRange)
    }

    @Test
    fun `line ranges render single lines and spans`() {
        assertEquals("5", FileReference("a", 5, 5).lineRange)
        assertEquals("5-9", FileReference("a", 5, 9).lineRange)
    }

    // SessionViewState

    @Test
    fun `initial view state follows the tail with no preview or selection`() {
        val state = SessionViewState.initial()

        assertNull(state.anchorMessageId)
        assertEquals(0, state.firstVisibleItemIndex)
        assertEquals(0, state.firstVisibleItemOffset)
        assertTrue(state.followTail)
        assertTrue(state.expandedThoughts.isEmpty())
        assertTrue(state.expandedTools.isEmpty())
        assertNull(state.previewFilePath)
        assertNull(state.previewLine)
        assertNull(state.previewOffset)
        assertNull(state.previewLimit)
        assertEquals(0f, state.previewProportion, 0f)
        assertEquals("", state.draft)
        assertTrue(state.fileReferences.isEmpty())
        assertTrue(state.attachments.isEmpty())
        assertNull(state.selectedModelId)
    }

    @Test
    fun `viewport state captures the scroll position`() {
        val viewport = SessionViewportState("anchor", 12, 34, followTail = false)

        assertEquals("anchor", viewport.anchorMessageId)
        assertEquals(12, viewport.firstVisibleItemIndex)
        assertEquals(34, viewport.firstVisibleItemOffset)
        assertFalse(viewport.followTail)
        assertEquals(viewport, viewport.copy())
    }

    // ToolFileLocation

    @Test
    fun `tool file locations default to a path-only window`() {
        val location = ToolFileLocation("entry/src/main/ets/pages/Index.ets")

        assertEquals("entry/src/main/ets/pages/Index.ets", location.path)
        assertNull(location.line)
        assertNull(location.offset)
        assertNull(location.limit)
    }

    @Test
    fun `tool file locations compare structurally with their window`() {
        assertEquals(ToolFileLocation("a", 3, 1, 5), ToolFileLocation("a", 3, 1, 5))
        assertEquals(ToolFileLocation("a", line = 7), ToolFileLocation("a", line = 7))
    }
}
