package org.deveco.code.session.editor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionTabPolicyTest {

    @Test
    fun `switching to another session re-binds the tab`() {
        assertTrue(SessionTabPolicy.requiresRebind("session-a", "session-b"))
        assertFalse(SessionTabPolicy.requiresRebind("session-a", "session-a"))
    }

    @Test
    fun `the live editor's file wins over listed and remembered files`() {
        assertEquals(
            "live",
            SessionTabPolicy.pickChatFile(
                liveFile = "live",
                listedFiles = listOf("listed"),
                rememberedFile = "remembered",
            ),
        )
    }

    @Test
    fun `a listed file is used when the registry has no editor`() {
        assertEquals(
            "listed",
            SessionTabPolicy.pickChatFile(
                liveFile = null,
                listedFiles = listOf("listed"),
                rememberedFile = "remembered",
            ),
        )
    }

    @Test
    fun `the remembered file is the last resort`() {
        assertEquals(
            "remembered",
            SessionTabPolicy.pickChatFile(liveFile = null, listedFiles = emptyList(), rememberedFile = "remembered"),
        )
    }

    @Test
    fun `no file means the tab has to be created`() {
        assertNull(
            SessionTabPolicy.pickChatFile<String>(liveFile = null, listedFiles = emptyList(), rememberedFile = null),
        )
    }

    @Test
    fun `the newest attached editor is revealed over a detached leftover`() {
        val attached = setOf("old-attached", "new-attached")
        assertEquals(
            "new-attached",
            SessionTabPolicy.revealTarget(listOf("old-attached", "detached", "new-attached")) { it in attached },
        )
    }

    @Test
    fun `the newest live editor is revealed when none is attached`() {
        assertEquals(
            "detached",
            SessionTabPolicy.revealTarget(listOf("old-attached", "detached")) { false },
        )
    }

    @Test
    fun `no candidate leaves nothing to reveal`() {
        assertNull(SessionTabPolicy.revealTarget<String>(emptyList()) { true })
    }
}
