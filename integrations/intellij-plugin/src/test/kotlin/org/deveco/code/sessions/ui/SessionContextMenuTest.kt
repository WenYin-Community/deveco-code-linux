package org.deveco.code.sessions.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for [isEmptyConversation] in SessionContextMenu.kt: a session
 * counts as an empty (never-named) conversation when its title is null/blank
 * or starts with the "New session" prefix, case-insensitively.
 */
class SessionContextMenuTest {

    @Test
    fun testNullTitleCountsAsEmpty() {
        assertTrue(isEmptyConversation(null))
    }

    @Test
    fun testBlankTitlesCountAsEmpty() {
        assertTrue(isEmptyConversation(""))
        assertTrue(isEmptyConversation("   "))
    }

    @Test
    fun testUntitledPrefixIsMatchedCaseInsensitively() {
        assertTrue(isEmptyConversation("New session"))
        assertTrue(isEmptyConversation("new session at 10:00"))
        assertTrue(isEmptyConversation("New session: fix login bug"))
    }

    @Test
    fun testNamedConversationsAreNotEmpty() {
        assertFalse(isEmptyConversation("Renamed chat"))
        assertFalse(isEmptyConversation("Fix login bug"))
    }

    @Test
    fun testSimilarPrefixesAreNotUntitled() {
        // Only the exact "New session" prefix counts as untitled.
        assertFalse(isEmptyConversation("news session"))
        assertFalse(isEmptyConversation("Newsession"))
        assertFalse(isEmptyConversation("Session new"))
    }
}
