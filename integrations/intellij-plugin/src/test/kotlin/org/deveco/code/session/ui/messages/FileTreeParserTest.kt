package org.deveco.code.session.ui.messages

import org.junit.Assert.assertEquals
import org.junit.Test

class FileTreeParserTest {

    @Test
    fun `grep header line keeps windows path verbatim with trailing colon`() {
        val text = "Found 2 matches\n" +
            "C:\\skills\\quick-apis\\01-layout.md:\n" +
            "  Line 4: > **index**\n" +
            "\n" +
            "C:\\skills\\quick-apis\\11-dialog.md:\n" +
            "  Line 37: Column() {\n"
        assertEquals(
            listOf("C:\\skills\\quick-apis\\01-layout.md:", "C:\\skills\\quick-apis\\11-dialog.md:"),
            FileTreeParser.parseFilePaths(text),
        )
    }

    @Test
    fun `grep header line keeps posix path verbatim with trailing colon`() {
        assertEquals(listOf("/skills/01-layout.md:"), FileTreeParser.parseFilePaths("/skills/01-layout.md:"))
    }

    @Test
    fun `posix file whose name ends with a colon keeps both colons`() {
        assertEquals(listOf("/skills/foo.md::"), FileTreeParser.parseFilePaths("/skills/foo.md::"))
    }

    @Test
    fun `plain path lines are unchanged`() {
        assertEquals(
            listOf("src/main/ets/Index.ets", "C:\\proj\\src\\Main.ets"),
            FileTreeParser.parseFilePaths("src/main/ets/Index.ets\nC:\\proj\\src\\Main.ets"),
        )
    }

    @Test
    fun `descriptive prefix is still stripped`() {
        assertEquals(listOf("src/a.md"), FileTreeParser.parseFilePaths("read: 3 files src/a.md"))
    }

    @Test
    fun `colon only and blank lines are rejected`() {
        assertEquals(emptyList<String>(), FileTreeParser.parseFilePaths(":\n\n   \nLine 4: content"))
    }

    @Test
    fun `search sections group match lines under their header`() {
        val text = "C:\\proj\\entry\\src\\Index.ets:\n" +
            "  Line 4: > **index**\n" +
            "  Line 37: Column() {\n" +
            "\n" +
            "entry/src/XhsHomePage.ets:\n" +
            "  Line 12: struct XhsHomePage {\n"
        val sections = FileTreeParser.parseSearchSections(text)
        assertEquals(null, sections.note)
        assertEquals(
            listOf("C:\\proj\\entry\\src\\Index.ets:", "entry/src/XhsHomePage.ets:"),
            sections.sections.map { it.path },
        )
        assertEquals(
            listOf(SearchMatch(4, "> **index**"), SearchMatch(37, "Column() {"), SearchMatch(12, "struct XhsHomePage {")),
            sections.sections.flatMap { it.matches },
        )
    }

    @Test
    fun `search sections keep truncation notice and path-only lines`() {
        val text = "entry/src/a.ets:\n" +
            "  Line 1: x\n" +
            "(Results truncated. Consider using a more specific path or pattern.)\n" +
            "entry/src/b.ets\n"
        val sections = FileTreeParser.parseSearchSections(text)
        assertEquals("(Results truncated. Consider using a more specific path or pattern.)", sections.note)
        assertEquals(listOf(1, 0), sections.sections.map { it.matches.size })
    }

    @Test
    fun `search sections empty for prose output`() {
        val sections = FileTreeParser.parseSearchSections("No matches found.")
        assertEquals(emptyList<SearchSection>(), sections.sections)
        assertEquals(null, sections.note)
    }
}
