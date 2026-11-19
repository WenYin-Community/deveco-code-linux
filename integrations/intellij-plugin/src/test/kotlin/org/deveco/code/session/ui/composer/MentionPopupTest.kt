package org.deveco.code.session.ui.composer

import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.testFramework.LightPlatformTestCase
import java.nio.file.Files
import java.nio.file.Path

/**
 * Platform-fixture unit tests for [computeMentionItems] in MentionPopup.kt:
 * the "@<query>" text-parsing gate (must start a word, no spaces in the
 * query, cursor clamping) and the project-wide VFS search under the light
 * project's base directory (case-insensitive name match, excluded top-level
 * directories, forward-slash relative paths, 20-result cap).
 *
 * Fixture files are written to disk under the project base dir and pulled
 * into the VFS with a single sync refresh. They are NOT created through the
 * VirtualFile write API: VFS file-creation events trigger file-type
 * detection, which initializes the textmate subsystem and logs a missing
 * builtin-bundle ERROR in the bare test SDK (surfacing as
 * TestLoggerAssertionError). Each test uses a unique query prefix so tests
 * stay independent of VFS traversal order and of each other's fixtures.
 */
class MentionPopupTest : LightPlatformTestCase() {

    private lateinit var baseVFile: com.intellij.openapi.vfs.VirtualFile

    override fun setUp() {
        super.setUp()
        // Already in the VFS: the light project is opened from this directory.
        baseVFile = LocalFileSystem.getInstance().findFileByPath(getProject().basePath!!)!!
    }

    // The Ultimate test SDK ships the Vue.js plugin, whose LSP loader fails to
    // initialize in the test environment (its plugin dist dir cannot be
    // resolved). The first VFS event batch that reaches the Vue async
    // listener triggers that one-time class-init failure, which surfaces as a
    // TestLoggerAssertionError from the refresh call. It is environment noise,
    // not a product failure: swallow it, then retry the refresh in case the
    // aborted event batch left the VFS stale.
    private fun isKnownVueTestNoise(t: Throwable): Boolean {
        var cause: Throwable? = t
        while (cause != null) {
            if (cause.stackTrace.any { it.className.startsWith("org.jetbrains.vuejs.") }) return true
            cause = cause.cause
        }
        return false
    }

    private fun refreshIgnoringVueNoise() {
        repeat(3) {
            try {
                VfsUtil.markDirtyAndRefresh(false, true, false, baseVFile)
                return
            } catch (t: Throwable) {
                if (!isKnownVueTestNoise(t)) throw t
            }
        }
    }

    private fun createFixtureFile(dirPath: String, fileName: String) {
        val dir = Files.createDirectories(Path.of(getProject().basePath!!, dirPath))
        Files.createFile(dir.resolve(fileName))
        refreshIgnoringVueNoise()
    }

    // --- text-parsing gate ---

    fun testNoAtSignYieldsNoItems() {
        assertTrue(computeMentionItems("hello world", 11, getProject()).isEmpty())
    }

    fun testAtInsideAWordYieldsNoItems() {
        assertTrue(computeMentionItems("foo@bar", 7, getProject()).isEmpty())
    }

    fun testQueryContainingSpaceYieldsNoItems() {
        assertTrue(computeMentionItems("@foo bar", 8, getProject()).isEmpty())
    }

    fun testCursorBeyondEndIsClamped() {
        createFixtureFile("mention-clamp", "cursor.txt")

        assertEquals(
            computeMentionItems("@cursor", 7, getProject()),
            computeMentionItems("@cursor", 100, getProject()),
        )
    }

    // --- VFS search ---

    fun testAtStartOfTextMatchesFiles() {
        createFixtureFile("mention-start", "atstart.txt")

        val items = computeMentionItems("@atstart", 8, getProject())

        assertEquals(1, items.size)
        assertEquals("atstart.txt", items.single().name)
        assertEquals("mention-start/atstart.txt", items.single().relativePath)
        assertTrue(items.single().path.endsWith("mention-start/atstart.txt"))
        assertTrue(items.single().path.startsWith(getProject().basePath!!))
    }

    fun testMatchIsCaseInsensitive() {
        createFixtureFile("mention-case", "CaseTest.txt")

        assertEquals(1, computeMentionItems("@casetest", 9, getProject()).size)
    }

    fun testExcludedTopLevelDirectoriesAreSkipped() {
        createFixtureFile("build/mention-excl", "skipme.txt")
        createFixtureFile("src/mention-excl", "keepme.txt")

        assertTrue(computeMentionItems("@skipme", 7, getProject()).isEmpty())
        assertEquals(
            "src/mention-excl/keepme.txt",
            computeMentionItems("@keepme", 7, getProject()).single().relativePath,
        )
    }

    fun testNestedRelativePathUsesForwardSlashes() {
        createFixtureFile("deep/nest/mention-nest", "found.txt")

        val item = computeMentionItems("@found", 6, getProject()).single()

        assertEquals("deep/nest/mention-nest/found.txt", item.relativePath)
    }

    fun testResultsAreCappedAtTwenty() {
        for (i in 1..25) {
            createFixtureFile("mention-cap", "capmatch$i.txt")
        }

        assertEquals(20, computeMentionItems("@capmatch", 9, getProject()).size)
    }

    fun testNonMatchingQueryReturnsNothing() {
        createFixtureFile("mention-nomatch", "present.txt")

        assertTrue(computeMentionItems("@absent", 7, getProject()).isEmpty())
    }
}
