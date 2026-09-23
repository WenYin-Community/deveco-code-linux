package org.deveco.code.acp

import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.Logger
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * Validates the plugin-bundled CLI before spawn: probing `--version` and
 * `acp --help` turns a stream-parse failure into an actionable error, and
 * patching PATH resolves `/usr/bin/env node` when the IDE was launched from
 * the macOS GUI (no shell PATH inherited).
 */
internal object DevEcoCodeDetector {
    private val log = Logger.getInstance(DevEcoCodeDetector::class.java)
    private const val PROBE_TIMEOUT_SECONDS = 5L

    data class Detection(val executable: Path, val version: String, val diagnostics: List<String>)

    class AcpUnavailableException(message: String) : Exception(message)

    /**
     * Validates [executable] supports ACP. Throws [AcpUnavailableException] when the
     * binary is missing, not executable, or fails `--version` / `acp --help`.
     */
    fun validateAcp(executable: Path): Detection {
        val diagnostics = ArrayList<String>()
        if (!Files.isRegularFile(executable)) {
            throw AcpUnavailableException("DevEco Code executable is not a regular file: $executable")
        }
        if (!isWindows() && !Files.isExecutable(executable)) {
            throw AcpUnavailableException("$executable is not executable")
        }
        val version = runProbe(listOf(executable.toString(), "--version"), diagnostics, "--version")
            ?.takeIf { it.isNotBlank() }
            ?: throw AcpUnavailableException(
                "$executable failed --version probe. ${diagnostics.joinToString("; ")}",
            )
        runProbe(listOf(executable.toString(), "acp", "--help"), diagnostics, "acp --help")
            ?: throw AcpUnavailableException(
                "$executable does not support ACP. ${diagnostics.joinToString("; ")}",
            )
        return Detection(executable, version.trim(), diagnostics)
    }

    private fun runProbe(command: List<String>, diagnostics: ArrayList<String>, label: String): String? {
        // Windows .cmd/.bat launchers cannot be exec'd directly by ProcessBuilder;
        // route them through `cmd /c`.
        val exec = command[0].lowercase(Locale.ROOT)
        val effective = if (exec.endsWith(".cmd") || exec.endsWith(".bat")) {
            listOf("cmd", "/c") + command
        } else {
            command
        }
        return try {
            val builder = ProcessBuilder(effective)
            configureRuntimeEnvironment(builder, Path.of(command[0]))
            val process = builder.start()
            if (!process.waitFor(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroyForcibly()
                diagnostics.add("${command[0]} timed out running $label")
                return null
            }
            val stdout = String(process.inputStream.readAllBytes(), StandardCharsets.UTF_8)
            val stderr = String(process.errorStream.readAllBytes(), StandardCharsets.UTF_8)
            // ACP help is written to stderr to keep stdout reserved for the protocol.
            val output = stdout.ifBlank { stderr }
            if (process.exitValue() != 0 || output.isBlank()) {
                diagnostics.add("${command[0]} failed $label: ${stderr.take(300)}")
                return null
            }
            output
        } catch (e: Exception) {
            diagnostics.add("${command[0]} failed $label: ${e.message}")
            null
        }
    }

    /**
     * Prepends the executable's parent directory plus common Node locations to the
     * process PATH so `/usr/bin/env node` resolves even when the IDE GUI process
     * did not inherit the user's shell PATH.
     */
    fun configureRuntimeEnvironment(builder: ProcessBuilder, executable: Path) {
        val directories = LinkedHashSet<String>()
        executable.toAbsolutePath().normalize().parent?.let { directories.add(it.toString()) }
        val studioHome = builder.environment()["DEVECO_HOME"] ?: PathManager.getHomePath()
        val studioNode = Path.of(studioHome, "tools", "node")
        val nodeDirectory = if (isWindows()) studioNode else studioNode.resolve("bin")
        if (Files.isDirectory(nodeDirectory)) directories.add(nodeDirectory.toString())
        if (!isWindows()) {
            directories.add("/opt/homebrew/bin")
            directories.add("/usr/local/bin")
            directories.add("/usr/bin")
            directories.add("/bin")
        }
        builder.environment()["PATH"]?.split(File.pathSeparator)?.forEach { dir ->
            if (dir.isNotBlank()) directories.add(dir)
        }
        builder.environment()["PATH"] = directories.joinToString(File.pathSeparator)
    }

    private fun isWindows(): Boolean = System.getProperty("os.name").lowercase(Locale.ROOT).contains("win")
}
