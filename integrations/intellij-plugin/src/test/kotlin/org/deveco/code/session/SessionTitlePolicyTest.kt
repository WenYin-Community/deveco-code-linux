package org.deveco.code.session

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for [SessionTitlePolicy]: placeholder-title detection (bare and
 * timestamped "New session" forms) and first-prompt title normalization.
 */
class SessionTitlePolicyTest {

    @Test
    fun isUntitledMatchesNullAndBlankTitles() {
        assertTrue(SessionTitlePolicy.isUntitled(null))
        assertTrue(SessionTitlePolicy.isUntitled(""))
        assertTrue(SessionTitlePolicy.isUntitled("   "))
    }

    @Test
    fun isUntitledMatchesBarePlaceholderCaseInsensitively() {
        assertTrue(SessionTitlePolicy.isUntitled("New session"))
        assertTrue(SessionTitlePolicy.isUntitled("new session"))
        assertTrue(SessionTitlePolicy.isUntitled("NEW SESSION"))
        assertTrue(SessionTitlePolicy.isUntitled("  New session  "))
    }

    @Test
    fun isUntitledMatchesTimestampedPlaceholder() {
        assertTrue(SessionTitlePolicy.isUntitled("New session - 2026-11-11 10:00:00"))
        assertTrue(SessionTitlePolicy.isUntitled("new SESSION - 2026-01-02 03:04:05"))
        assertTrue(SessionTitlePolicy.isUntitled("New session-2026-11-11 10:00:00"))
    }

    @Test
    fun isUntitledRejectsRealTitles() {
        assertFalse(SessionTitlePolicy.isUntitled("Migration plan"))
        assertFalse(SessionTitlePolicy.isUntitled("New sessions"))
        assertFalse(SessionTitlePolicy.isUntitled("New session extra"))
        assertFalse(SessionTitlePolicy.isUntitled("Session 2 follow-up"))
    }

    @Test
    fun fromFirstPromptCollapsesWhitespace() {
        assertEquals("hello world", SessionTitlePolicy.fromFirstPrompt("  hello   world  "))
        assertEquals("fix login bug now", SessionTitlePolicy.fromFirstPrompt("fix\nlogin\tbug   now"))
    }

    @Test
    fun fromFirstPromptFallsBackToPlaceholderForEmptyText() {
        assertEquals("New Session", SessionTitlePolicy.fromFirstPrompt(""))
        assertEquals("New Session", SessionTitlePolicy.fromFirstPrompt("   \n\t "))
    }

    @Test
    fun fromFirstPromptKeepsNormalText() {
        assertEquals("Refactor the ACP layer", SessionTitlePolicy.fromFirstPrompt("Refactor the ACP layer"))
    }
}
