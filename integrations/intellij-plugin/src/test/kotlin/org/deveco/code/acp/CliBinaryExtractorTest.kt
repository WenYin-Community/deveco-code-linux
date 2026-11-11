package org.deveco.code.acp

import com.intellij.openapi.application.PathManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * Unit tests for [CliBinaryExtractor]: manifest-driven extraction of the
 * bundled CLI into `<system>/@deveco`, the version-marker short-circuit, and
 * re-extraction when the marker is stale. The manifest and its entries are
 * supplied by `src/test/resources/cli/` (plus the binary-like entries generated
 * by the `generateCliTestFixtures` Gradle task, which keeps an `.exe` and a
 * node_modules path out of the repository) so no real CLI build is needed
 * (`-x bundleLocalCli`).
 */
class CliBinaryExtractorTest {

    companion object {
        private val isWindows = System.getProperty("os.name").lowercase().startsWith("windows")
        private val binaryName = if (isWindows) "deveco.exe" else "deveco"

        @BeforeClass
        @JvmStatic
        fun ensurePlatformPaths() {
            if (System.getProperty("idea.system.path") == null) {
                System.setProperty("idea.system.path", Files.createTempDirectory("deveco-test-system").toString())
            }
            if (System.getProperty("idea.config.path") == null) {
                System.setProperty("idea.config.path", Files.createTempDirectory("deveco-test-config").toString())
            }
        }
    }

    private fun targetDir(): File = File(PathManager.getSystemPath(), "@deveco")

    private fun marker(): File = File(targetDir(), ".version")

    private fun binaryFile(): File = File(File(targetDir(), "bin"), binaryName)

    /** Forces a full re-extraction regardless of the current marker state. */
    private fun extractFresh(): String {
        targetDir().mkdirs()
        marker().writeText("stale-version-forces-reextraction")
        return CliBinaryExtractor.extract()
    }

    @Test
    fun extractWritesManifestEntriesAndReturnsBinaryPath() {
        val binary = extractFresh()

        assertEquals(binaryFile().absolutePath, binary)
        assertEquals("fake-$osBinaryWord-binary", File(binary).readText().trim())
        assertEquals("vendor-v1", File(targetDir(), "vendor/info.txt").readText().trim())
        assertTrue(marker().isFile)
        // Manifest entries without a matching classpath resource are skipped.
        assertFalse(File(targetDir(), "missing/no-resource.txt").exists())
    }

    @Test
    fun secondExtractShortCircuitsWhenVersionMatches() {
        extractFresh()
        binaryFile().writeText("corrupted")

        val binary = CliBinaryExtractor.extract()

        assertEquals(binaryFile().absolutePath, binary)
        // Same plugin version → early return, the corrupted bytes survive.
        assertEquals("corrupted", binaryFile().readText())
    }

    @Test
    fun staleMarkerVersionTriggersReextraction() {
        extractFresh()
        binaryFile().writeText("corrupted")
        marker().writeText("stale-version-forces-reextraction")

        val binary = CliBinaryExtractor.extract()

        assertEquals(binaryFile().absolutePath, binary)
        assertEquals("fake-$osBinaryWord-binary", binaryFile().readText().trim())
    }

    @Test
    fun extractWritesVendorCliEntryWhenCliJsIsPresent() {
        extractFresh()

        val entry = File(targetDir(), "vendor/.deveco-cli-entry")
        assertTrue(entry.isFile)
        val cliJs = File(targetDir(), "node_modules/@deveco/deveco-cli/dist/cli.js")
        assertEquals(cliJs.absolutePath + "\n", entry.readText())
    }

    @Test
    fun extractedBinEntryIsMarkedExecutableOnUnix() {
        assumeTrue(!isWindows)

        extractFresh()

        assertTrue(File(File(targetDir(), "bin"), "deveco").canExecute())
    }

    private val osBinaryWord: String
        get() = if (isWindows) "windows" else "unix"
}
