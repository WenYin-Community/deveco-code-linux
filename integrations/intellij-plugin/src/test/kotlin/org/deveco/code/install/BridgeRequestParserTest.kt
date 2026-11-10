package org.deveco.code.install

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

internal class BridgeRequestParserTest {

    @Test
    fun `legacy array form resolves to the compile-error defaults`() {
        val request = BridgeRequestParser.parse("""[{"type":"TEXT","text":"boom"}]""")

        assertEquals(
            BridgeRequest(
                contexts = listOf(BridgeContext("TEXT", "boom")),
                promptPrefix = PromptLeadIn.Default,
                mode = "build",
                session = SessionTarget.BlankOrNew,
                sendImmediately = true,
            ),
            request,
        )
    }

    @Test
    fun `object form reads contexts and every option`() {
        val request = BridgeRequestParser.parse(
            """
            {
              "contexts": [{"type":"file","text":"/a/b.ets"},{"type":"TEXT","text":"err"}],
              "options": {"prompt":"take a look","mode":"plan","session":"current","send":false}
            }
            """.trimIndent(),
        )

        assertEquals(listOf(BridgeContext("FILE", "/a/b.ets"), BridgeContext("TEXT", "err")), request?.contexts)
        assertEquals(PromptLeadIn.Text("take a look"), request?.promptPrefix)
        assertEquals("plan", request?.mode)
        assertEquals(SessionTarget.Current, request?.session)
        assertEquals(false, request?.sendImmediately)
    }

    @Test
    fun `prompt distinguishes absent from an explicit opt-out`() {
        assertEquals(PromptLeadIn.Default, parseOptions("""{}""")?.promptPrefix)
        assertEquals(PromptLeadIn.None, parseOptions("""{"prompt":null}""")?.promptPrefix)
        assertEquals(PromptLeadIn.None, parseOptions("""{"prompt":"   "}""")?.promptPrefix)
        assertEquals(PromptLeadIn.Text("fix it"), parseOptions("""{"prompt":"fix it"}""")?.promptPrefix)
    }

    @Test
    fun `mode distinguishes absent from an explicit opt-out`() {
        assertEquals("build", parseOptions("""{}""")?.mode)
        assertNull(parseOptions("""{"mode":null}""")?.mode)
        assertNull(parseOptions("""{"mode":""}""")?.mode)
        assertEquals("ask", parseOptions("""{"mode":"ask"}""")?.mode)
    }

    @Test
    fun `session ignores case and surrounding whitespace`() {
        assertEquals(SessionTarget.New, parseOptions("""{"session":"new"}""")?.session)
        assertEquals(SessionTarget.BlankOnly, parseOptions("""{"session":" BLANK_ONLY "}""")?.session)
        assertEquals(SessionTarget.Current, parseOptions("""{"session":"Current"}""")?.session)
        assertEquals(SessionTarget.BlankOrNew, parseOptions("""{"session":"blank_or_new"}""")?.session)
    }

    @Test
    fun `unknown session values fall back to the historical behaviour`() {
        assertEquals(SessionTarget.BlankOrNew, parseOptions("""{"session":"whichever"}""")?.session)
        // A caller still on the removed "deliver to one specific conversation" form must degrade
        // safely instead of throwing or addressing a conversation that was never resolved.
        assertEquals(SessionTarget.BlankOrNew, parseOptions("""{"session":"SESSION:ses_123"}""")?.session)
    }

    @Test
    fun `context entries without a usable type and text are dropped`() {
        val request = BridgeRequestParser.parse(
            """[{"type":"TEXT","text":"keep"},{"text":"no type"},{"type":"TEXT"},{"type":"TEXT","text":"  "}]""",
        )

        assertEquals(listOf(BridgeContext("TEXT", "keep")), request?.contexts)
    }

    @Test
    fun `payloads that cannot carry a prompt parse to null`() {
        assertNull(BridgeRequestParser.parse("[]"))
        assertNull(BridgeRequestParser.parse("""{"contexts":[]}"""))
        assertNull(BridgeRequestParser.parse("""{"options":{"mode":"build"}}"""))
        assertNull(BridgeRequestParser.parse("""{"contexts":[{"type":"TEXT","text":"x"}"""))
        assertNull(BridgeRequestParser.parse("not json at all"))
        assertNull(BridgeRequestParser.parse("\"a bare string\""))
        assertNull(BridgeRequestParser.parse("123"))
        assertNull(BridgeRequestParser.parse(""))
    }

    @Test
    fun `a non-object context entry is skipped rather than failing the payload`() {
        val request = BridgeRequestParser.parse("""["nope",{"type":"TEXT","text":"keep"}]""")

        assertEquals(listOf(BridgeContext("TEXT", "keep")), request?.contexts)
    }

    private fun parseOptions(options: String): BridgeRequest? =
        BridgeRequestParser.parse("""{"contexts":[{"type":"TEXT","text":"x"}],"options":$options}""")
}
