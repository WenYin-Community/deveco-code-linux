package org.deveco.code.session.ui.messages

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests for fence-language normalization ([normalizeFenceLanguage]) —
 * the unit-testable half of markdown code-block rendering. The block
 * splitting in MarkdownWithCodeBlocks lives in a private helper consumed by
 * a @Composable and is therefore left to UI tests; the normalization maps
 * fence info strings to language IDs the bundled 261 Jewel highlighter can
 * resolve: ArkTS is registered as "ExtendTypeScript" (no ets/arkts alias
 * exists), JSON5 falls back to JSON, and HTML/HTM to the closest shipped
 * highlighter, XML.
 */
class FenceLanguageTest {

    @Test
    fun arktsAliasesMapToRegisteredExtendTypeScriptId() {
        assertEquals("extendtypescript", normalizeFenceLanguage("ets"))
        assertEquals("extendtypescript", normalizeFenceLanguage("arkts"))
        assertEquals("extendtypescript", normalizeFenceLanguage("ArkTS"))
    }

    @Test
    fun typescriptAndJson5AliasesMapToBaseLanguages() {
        assertEquals("typescript", normalizeFenceLanguage("ts"))
        assertEquals("typescript", normalizeFenceLanguage("tsx"))
        assertEquals("json", normalizeFenceLanguage("json5"))
    }

    @Test
    fun htmlFencesFallBackToXmlHighlighter() {
        assertEquals("xml", normalizeFenceLanguage("html"))
        assertEquals("xml", normalizeFenceLanguage("htm"))
    }

    @Test
    fun unknownLanguagesArePassedThroughLowercased() {
        assertEquals("kotlin", normalizeFenceLanguage("Kotlin"))
        assertEquals("c++", normalizeFenceLanguage("C++"))
        assertEquals("python", normalizeFenceLanguage("python"))
    }

    @Test
    fun missingFenceLanguageNormalizesToEmptyString() {
        assertEquals("", normalizeFenceLanguage(null))
        assertEquals("", normalizeFenceLanguage(""))
    }
}
