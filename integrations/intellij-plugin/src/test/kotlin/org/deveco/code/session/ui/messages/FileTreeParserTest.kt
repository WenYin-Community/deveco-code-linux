package org.deveco.code.session.ui.messages

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

    @Test
    fun `tree-drawing prefixes are stripped at column zero`() {
        val text = "├── entry/src/main/ets/pages/Index.ets\n" +
            "└── AppScope/app.json5"

        assertEquals(
            listOf("entry/src/main/ets/pages/Index.ets", "AppScope/app.json5"),
            FileTreeParser.parseFilePaths(text),
        )
    }

    /**
     * Documents current behavior for indented tree output: the prefix stripper removes
     * only the first leading run of tree characters and does not rescan after whitespace,
     * so "│   └── file" keeps its "└──" run and is then rejected by isFilePath. If this
     * test starts failing, the stripper learned to handle nested runs — replace it with
     * extraction assertions.
     */
    @Test
    fun `indented tree lines keep their inner prefix and are rejected`() {
        val text = "├── entry/src/main/ets/pages/Index.ets\n" +
            "│   └── build-profile.json5\n" +
            "└── AppScope/app.json5"

        assertEquals(
            listOf("entry/src/main/ets/pages/Index.ets", "AppScope/app.json5"),
            FileTreeParser.parseFilePaths(text),
        )
    }

    @Test
    fun `markdown list markers are stripped`() {
        val text = "- src/a.kt\n" +
            "* b/c.kt\n" +
            "+ d/e.kt\n" +
            "1. f/g.kt\n" +
            "10. h/i.kt"

        assertEquals(
            listOf("src/a.kt", "b/c.kt", "d/e.kt", "f/g.kt", "h/i.kt"),
            FileTreeParser.parseFilePaths(text),
        )
    }

    @Test
    fun `descriptive tool-output prefixes are stripped for every verb`() {
        val text = "read: 3 files src/main/a.kt\n" +
            "wrote: 1 file build.gradle.kts\n" +
            "Edited: 2 files entry/src/main/ets/x.ets\n" +
            "found: 10 files src/b.kt"

        assertEquals(
            listOf("src/main/a.kt", "build.gradle.kts", "entry/src/main/ets/x.ets", "src/b.kt"),
            FileTreeParser.parseFilePaths(text),
        )
    }

    @Test
    fun `prose error and chinese task lines are rejected`() {
        val text = "Update build-profile.json5 to API 26\n" +
            "Error: something failed\n" +
            "创建 HomeView.ets 支付宝首页\n" +
            "src/real/File.kt"

        assertEquals(listOf("src/real/File.kt"), FileTreeParser.parseFilePaths(text))
    }

    @Test
    fun `isFilePath accepts relative absolute and windows paths`() {
        assertTrue(FileTreeParser.isFilePath("src/main/kotlin/File.kt"))
        assertTrue(FileTreeParser.isFilePath("build.gradle.kts"))
        assertTrue(FileTreeParser.isFilePath("a/b/c"))
        assertTrue(FileTreeParser.isFilePath("C:/Users/x.txt"))
        assertTrue(FileTreeParser.isFilePath("C:\\Users\\x.txt"))
    }

    @Test
    fun `isFilePath rejects non-path text`() {
        assertFalse(FileTreeParser.isFilePath("TODO: fix"))
        assertFalse(FileTreeParser.isFilePath("update file.ts now"))
        assertFalse(FileTreeParser.isFilePath(".gitignore"))
        assertFalse(FileTreeParser.isFilePath("result[0]"))
        assertFalse(FileTreeParser.isFilePath("user@example.com"))
        assertFalse(FileTreeParser.isFilePath("path/to/file..."))
        assertFalse(FileTreeParser.isFilePath("fn(x).ts"))
        assertFalse(FileTreeParser.isFilePath("a=b/c.ts"))
        assertFalse(FileTreeParser.isFilePath("#heading.md"))
        assertFalse(FileTreeParser.isFilePath("中文.ets"))
        assertFalse(FileTreeParser.isFilePath("foo in bar"))
        assertFalse(FileTreeParser.isFilePath("├── x.ets"))
    }

    @Test
    fun `getFileName handles both separators`() {
        assertEquals("c.txt", FileTreeParser.getFileName("a/b\\c.txt"))
        assertEquals("plain.kt", FileTreeParser.getFileName("plain.kt"))
    }

    @Test
    fun `getDirectoryPath returns the parent or empty`() {
        assertEquals("a/b", FileTreeParser.getDirectoryPath("a/b/c.txt"))
        assertEquals("C:\\x\\y", FileTreeParser.getDirectoryPath("C:\\x\\y\\z.ets"))
        assertEquals("", FileTreeParser.getDirectoryPath("file.txt"))
    }

    @Test
    fun `getFileExtension lowercases and handles no extension`() {
        assertEquals("md", FileTreeParser.getFileExtension("A/B/README.MD"))
        assertEquals("", FileTreeParser.getFileExtension("src/main/kotlin"))
    }

    @Test
    fun `isDirectoryPath detects separators or missing extension`() {
        assertTrue(FileTreeParser.isDirectoryPath("src/main/"))
        assertTrue(FileTreeParser.isDirectoryPath("src\\main"))
        assertTrue(FileTreeParser.isDirectoryPath("entry/src/main/ets"))
        assertFalse(FileTreeParser.isDirectoryPath("src/main.kt"))
        assertFalse(FileTreeParser.isDirectoryPath(""))
    }

    @Test
    fun `normalizePath strips drive letters and extracts project dirs`() {
        assertEquals("entry/src/Main.ets", FileTreeParser.normalizePath("C:\\Users\\p\\entry\\src\\Main.ets"))
        assertEquals("oh_modules/x.js", FileTreeParser.normalizePath("/proj/oh_modules/x.js"))
        assertEquals("foo/bar.ets", FileTreeParser.normalizePath("C:/foo/bar.ets"))
        assertEquals("random/path.ets", FileTreeParser.normalizePath("random/path.ets"))
    }
}
