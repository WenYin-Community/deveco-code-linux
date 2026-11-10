package org.deveco.code.session.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Kotlin port of `packages/tui/test/util/skill-match.test.ts` — the same
 * canonical cases the TUI's `matchSkillExpansion` is held to, plus the
 * plugin-specific `toTypedText` shape and index-building guards.
 */
class SkillExpansionTest {

    private val body = "# DevEco CLI\n\n`devecocli` wraps DevEco Studio's toolchain."

    private fun index(vararg skills: Pair<String, String>) =
        SkillExpansionIndex.build(skills.map { SkillBody(it.first, it.second) })

    @Test
    fun `matches text equal to the trimmed skill body`() {
        val result = index("devecocli" to "$body\n").match(body)
        assertEquals("devecocli", result?.name)
        assertEquals("", result?.args)
    }

    @Test
    fun `matches body followed by arguments`() {
        val result = index("devecocli" to body).match("$body\n\nstart Pixel")
        assertEquals("devecocli", result?.name)
        assertEquals("start Pixel", result?.args)
    }

    @Test
    fun `trims whitespace around arguments`() {
        val result = index("devecocli" to body).match("$body\n\n  start Pixel  ")
        assertEquals("start Pixel", result?.args)
    }

    @Test
    fun `matches the only skill whose body fits among several`() {
        val idx = index("alpha" to "# Alpha\n\nAlpha body.", "devecocli" to body)
        assertEquals("devecocli", idx.match(body)?.name)
        assertEquals("alpha", idx.match("# Alpha\n\nAlpha body.")?.name)
    }

    @Test
    fun `returns null for unrelated text`() {
        val idx = index("devecocli" to body)
        assertNull(idx.match("help me fix this bug"))
        assertNull(idx.match(body.take(10)))
    }

    @Test
    fun `empty index matches nothing`() {
        assertNull(SkillExpansionIndex.EMPTY.match(body))
    }

    @Test
    fun `returns null for empty text`() {
        assertNull(index("devecocli" to body).match(""))
    }

    @Test
    fun `skills with empty bodies never match`() {
        val idx = index("empty" to "   \n", "devecocli" to body)
        assertNull(idx.match("   \n"))
        assertEquals("devecocli", idx.match(body)?.name)
    }

    @Test
    fun `matches an ARGUMENTS body invoked without arguments`() {
        val content = "Glossary term: \$ARGUMENTS\n\nLook it up."
        val result = index("glossary" to content).match("Glossary term: \n\nLook it up.")
        assertEquals("glossary", result?.name)
        assertEquals("", result?.args)
    }

    @Test
    fun `recovers arguments from a single ARGUMENTS occurrence`() {
        val content = "Glossary term: \$ARGUMENTS\n\nLook it up."
        val result = index("glossary" to content).match("Glossary term: concurrency\n\nLook it up.")
        assertEquals("glossary", result?.name)
        assertEquals("concurrency", result?.args)
    }

    @Test
    fun `recovers arguments shared by multiple ARGUMENTS occurrences`() {
        val content = "Find \$ARGUMENTS in the index, then open \$ARGUMENTS."
        val result = index("lookup" to content).match("Find arc in the index, then open arc.")
        assertEquals("lookup", result?.name)
        assertEquals("arc", result?.args)
    }

    @Test
    fun `rejects text whose length cannot come from repeated ARGUMENTS splices`() {
        val content = "Find \$ARGUMENTS in the index, then open \$ARGUMENTS."
        assertNull(index("lookup" to content).match("Find arc in the index, then open circle."))
    }

    @Test
    fun `matches a placeholder body invoked without arguments`() {
        val content = "First \$1 second \$2\n\nDone."
        val result = index("pair" to content).match("First  second \n\nDone.")
        assertEquals("pair", result?.name)
        assertEquals("", result?.args)
    }

    @Test
    fun `cannot recover positional arguments and falls back to full rendering`() {
        val content = "First \$1 second \$2\n\nDone."
        assertNull(index("pair" to content).match("First a second b\n\nDone."))
    }

    @Test
    fun `matches a body whose shell interpolation produced no output`() {
        val content = "Row `Terminate execution!` then `quoted` done\n\nInvestigate."
        val result = index("runtime-fix" to content).match("Row `Terminate executionquoted` done\n\nInvestigate.")
        assertEquals("runtime-fix", result?.name)
        assertEquals("", result?.args)
    }

    @Test
    fun `matches appended arguments when shell interpolation produced no output`() {
        val content = "Run !`git status` and report."
        val result = index("report" to content).match("Run  and report.\n\nafter deploy")
        assertEquals("report", result?.name)
        assertEquals("after deploy", result?.args)
    }

    @Test
    fun `matches an ARGUMENTS body with shell interpolation when output is empty and no args`() {
        val content = "Generate from !`bun script/raw-changelog.ts \$ARGUMENTS`"
        val result = index("changelog" to content).match("Generate from")
        assertEquals("changelog", result?.name)
        assertEquals("", result?.args)
    }

    @Test
    fun `cannot recover arguments for ARGUMENTS bodies containing shell interpolation`() {
        val content = "Generate from !`bun script/raw-changelog.ts \$ARGUMENTS`"
        assertNull(index("changelog" to content).match("Generate from latest tag"))
    }

    @Test
    fun `toTypedText rebuilds the composer invocation shape`() {
        assertEquals("/devecocli", SkillExpansionMatch("devecocli", "").toTypedText())
        assertEquals("/devecocli start Pixel", SkillExpansionMatch("devecocli", "start Pixel").toTypedText())
    }

    @Test
    fun `restored typed text never re-matches, keeping the sweep idempotent`() {
        // The controller skips text starting with "/", but even without that guard
        // a restored "/name args" is not a template expansion and must not match.
        val idx = index("devecocli" to body)
        assertNull(idx.match("/devecocli start Pixel"))
    }

    @Test
    fun `a degenerate zero placeholder in a skill body does not crash the index`() {
        // build() expands every body once; "$0" would index args at -1 without the
        // guard in expandCommandTemplate.
        val idx = index("weird" to "cost is \$0 today")
        assertNull(idx.match("something unrelated"))
    }
}
