package org.deveco.code.acp

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

internal object CliBinaryExtractor {

    private val log = Logger.getInstance(CliBinaryExtractor::class.java)
    private const val RESOURCE_PREFIX = "cli"
    private const val MANIFEST = "manifest.txt"
    private const val MARKER = ".version"

    private val osName = System.getProperty("os.name").lowercase()
    private val isWindows = osName.startsWith("windows")
    private val binaryName = if (isWindows) "deveco.exe" else "deveco"

    fun extract(): String {
        val targetDir = Path.of(PathManager.getSystemPath(), "@deveco")
        val binary = targetDir.resolve("bin").resolve(binaryName).toFile()
        val marker = targetDir.resolve(MARKER).toFile()

        val pluginVersion = pluginVersion()
        if (binary.isFile && marker.isFile && marker.readText().trim() == pluginVersion) {
            return binary.absolutePath
        }

        val classLoader = CliBinaryExtractor::class.java.classLoader
        val manifestUrl = classLoader.getResource("$RESOURCE_PREFIX/$MANIFEST")
            ?: throw IllegalStateException("CLI manifest not found in plugin resources")

        val entries = manifestUrl.openStream().use { stream ->
            stream.bufferedReader().readLines().filter { it.isNotBlank() }
        }

        targetDir.toFile().mkdirs()

        for (entry in entries) {
            val resourceUrl = classLoader.getResource("$RESOURCE_PREFIX/$entry") ?: continue
            val destFile = targetDir.resolve(entry.replace('/', File.separatorChar)).toFile()
            destFile.parentFile?.mkdirs()
            resourceUrl.openStream().use { input ->
                Files.copy(input, destFile.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
            if (entry.startsWith("bin/") || entry.startsWith("vendor/ripgrep/")) {
                destFile.setExecutable(true, false)
            }
        }

        marker.writeText(pluginVersion)

        log.debug("Extracted bundled CLI: ${binary.name} (version=$pluginVersion)")
        return binary.absolutePath
    }

    private fun pluginVersion(): String {
        val descriptor = PluginManagerCore.getPlugin(
            PluginId.getId("org.deveco.code.deveco-code-jetbrains-plugin"),
        )
        return descriptor?.version ?: "unknown"
    }
}
