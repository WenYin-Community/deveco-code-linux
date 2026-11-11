package org.deveco.code.acp

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Unit tests for [DevEcoCodeDetector]: ACP probe validation against a fake
 * probe-responsive script (the probe only checks that `--version` and
 * `acp --help` produce output with exit code 0), and PATH patching for
 * spawned CLI processes.
 */
class DevEcoCodeDetectorTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private val isWindows = System.getProperty("os.name").lowercase().startsWith("windows")
    private var previousIdeaHome: String? = null
    private var previousIdeaHomePath: String? = null

    @Before
    fun pinIdeHomeForPathManager() {
        // configureRuntimeEnvironment falls back to PathManager.getHomePath()
        // when DEVECO_HOME is absent from the spawned process environment;
        // pin the IDE home system properties so the fallback resolves inside
        // a plain unit test JVM.
        previousIdeaHome = System.getProperty("idea.home")
        previousIdeaHomePath = System.getProperty("idea.home.path")
        val home = tmp.newFolder("ide-home").absolutePath
        System.setProperty("idea.home", home)
        System.setProperty("idea.home.path", home)
    }

    @After
    fun restoreIdeHome() {
        restoreSystemProperty("idea.home", previousIdeaHome)
        restoreSystemProperty("idea.home.path", previousIdeaHomePath)
    }

    @Test
    fun validateAcpRejectsMissingExecutable() {
        val missing = tmp.root.toPath().resolve("missing-deveco")

        val error = assertThrows(DevEcoCodeDetector.AcpUnavailableException::class.java) {
            DevEcoCodeDetector.validateAcp(missing)
        }

        assertTrue(error.message!!.contains("not a regular file"))
    }

    @Test
    fun validateAcpRejectsNonExecutableFileOnUnix() {
        assumeTrue(!isWindows)
        val plain = tmp.newFile("plain-script")
        plain.writeText("#!/bin/sh\necho 1.0\n")

        val error = assertThrows(DevEcoCodeDetector.AcpUnavailableException::class.java) {
            DevEcoCodeDetector.validateAcp(plain.toPath())
        }

        assertTrue(error.message!!.contains("is not executable"))
    }

    @Test
    fun validateAcpAcceptsProbeResponsiveExecutable() {
        val script = writeProbeScript(echoVersion = "1.2.3-test")

        val detection = DevEcoCodeDetector.validateAcp(script.toPath())

        assertEquals("1.2.3-test", detection.version)
        assertEquals(script.toPath(), detection.executable)
    }

    @Test
    fun validateAcpRejectsFailingProbe() {
        val script = writeProbeScript(echoVersion = null)

        val error = assertThrows(DevEcoCodeDetector.AcpUnavailableException::class.java) {
            DevEcoCodeDetector.validateAcp(script.toPath())
        }

        assertTrue(error.message!!.contains("failed --version probe"))
    }

    @Test
    fun configureRuntimeEnvironmentPrependsExecutableAndNodeDirectories() {
        val binDir = tmp.newFolder("bin")
        val executable = File(binDir, if (isWindows) "tool.exe" else "tool").apply { writeText("") }
        val studioHome = tmp.newFolder("studio")
        val nodeDir = File(
            studioHome,
            if (isWindows) "tools${File.separatorChar}node" else "tools${File.separatorChar}node${File.separatorChar}bin",
        )
        assertTrue(nodeDir.mkdirs())

        val builder = ProcessBuilder("noop")
        builder.environment()["DEVECO_HOME"] = studioHome.absolutePath
        val originalPath = if (isWindows) "C:\\legacy\\bin" else "/legacy/bin"
        builder.environment()["PATH"] = originalPath

        DevEcoCodeDetector.configureRuntimeEnvironment(builder, executable.toPath())

        val entries = builder.environment()["PATH"]!!.split(File.pathSeparator)
        assertEquals(binDir.absolutePath, entries.first())
        assertTrue(entries.contains(nodeDir.absolutePath))
        assertEquals(originalPath, entries.last())
    }

    private fun writeProbeScript(echoVersion: String?): File {
        val script = File(tmp.root, if (isWindows) "probe.cmd" else "probe")
        if (isWindows) {
            // Windows .cmd launchers are routed through `cmd /c` by the probe.
            script.writeText(
                if (echoVersion == null) {
                    "@echo off\r\nexit /b 1\r\n"
                } else {
                    "@echo off\r\necho $echoVersion\r\n"
                },
            )
        } else {
            script.writeText(if (echoVersion == null) "#!/bin/sh\nexit 1\n" else "#!/bin/sh\necho $echoVersion\n")
            assertTrue(script.setExecutable(true, false))
        }
        return script
    }

    private fun restoreSystemProperty(key: String, value: String?) {
        if (value == null) {
            System.clearProperty(key)
        } else {
            System.setProperty(key, value)
        }
    }
}
