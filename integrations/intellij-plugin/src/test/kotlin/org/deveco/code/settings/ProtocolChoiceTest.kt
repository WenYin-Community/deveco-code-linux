package org.deveco.code.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Plain unit tests for the protocol-choice model of the Add-Model dialog
 * ([ProtocolChoice] / [ModelProtocol]): the combo offers every known
 * protocol, a stored npm id that already matches one of them adds no extra
 * entry, and an unknown stored npm id is preserved as a dedicated choice so
 * saving keeps the raw value instead of silently rewriting it.
 */
class ProtocolChoiceTest {

    @Test
    fun testKnownChoicesCoverEveryProtocolExactlyOnce() {
        val choices = ProtocolChoice.knownChoices()

        assertEquals(ModelProtocol.entries.size, choices.size)
        choices.filterIsInstance<ProtocolChoice.Known>().forEach { known ->
            assertTrue(ModelProtocol.entries.contains(known.protocol))
        }
    }

    @Test
    fun testKnownStoredNpmAddsNoPreservedEntry() {
        val choices = ProtocolChoice.choicesFor(ModelProtocol.OPENAI_COMPATIBLE.npm)

        assertEquals(ModelProtocol.entries.size, choices.size)
        assertTrue(choices.none { it is ProtocolChoice.Preserved })
    }

    @Test
    fun testUnknownStoredNpmIsAppendedAsPreserved() {
        val storedNpm = "@ai-sdk/groq"

        val choices = ProtocolChoice.choicesFor(storedNpm)

        assertEquals(ModelProtocol.entries.size + 1, choices.size)
        val preserved = choices.last() as ProtocolChoice.Preserved
        assertEquals(storedNpm, preserved.npm)
        assertEquals(ModelProtocol.entries.size, choices.filterIsInstance<ProtocolChoice.Known>().size)
    }

    @Test
    fun testNullStoredNpmYieldsKnownChoicesOnly() {
        val choices = ProtocolChoice.choicesFor(null)

        assertEquals(ModelProtocol.entries.size, choices.size)
        assertTrue(choices.none { it is ProtocolChoice.Preserved })
    }

    @Test
    fun testProtocolNpmIdsStayDistinct() {
        // choicesFor() matches stored ids against npm values, so two protocols
        // sharing one npm id would break the preserved-entry detection.
        assertEquals(ModelProtocol.entries.size, ModelProtocol.entries.map { it.npm }.toSet().size)
    }
}
