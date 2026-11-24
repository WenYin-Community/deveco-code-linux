package org.deveco.code.session.model

import org.junit.Assert.assertEquals
import org.junit.Test

internal class FileReferenceTest {
    @Test
    fun `editor navigation uses a zero based line index`() {
        assertEquals(9, FileReference("/tmp/Main.kt", 10, 20).openLineIndex)
        assertEquals(0, FileReference("/tmp/Main.kt", 0, 0).openLineIndex)
    }
}
