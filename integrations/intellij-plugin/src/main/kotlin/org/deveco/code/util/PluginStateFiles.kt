package org.deveco.code.util

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.intellij.openapi.project.Project
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.Properties
import java.util.UUID

internal object PluginStateFiles {
    private val gson: Gson = GsonBuilder().disableHtmlEscaping().create()

    fun path(project: Project, name: String): Path {
        val key = project.locationHash.replace(Regex("[^A-Za-z0-9._-]"), "_")
        return devecoStorageRoot.resolve("state/plugin/projects").resolve(key).resolve(name)
    }

    fun globalPath(name: String): Path = devecoStorageRoot.resolve("state/plugin/global").resolve(name)

    fun <T> readJson(project: Project, name: String, type: Class<T>): T? = runCatching {
        val file = path(project, name)
        if (!Files.isRegularFile(file)) null else gson.fromJson(Files.readString(file), type)
    }.getOrNull()

    fun writeJson(project: Project, name: String, value: Any) {
        write(path(project, name), gson.toJson(value).toByteArray(StandardCharsets.UTF_8))
    }

    fun <T> readJsonGlobal(name: String, type: Class<T>): T? = runCatching {
        val file = globalPath(name)
        if (!Files.isRegularFile(file)) null else gson.fromJson(Files.readString(file), type)
    }.getOrNull()

    fun writeJsonGlobal(name: String, value: Any) {
        write(globalPath(name), gson.toJson(value).toByteArray(StandardCharsets.UTF_8))
    }

    fun readProperties(project: Project, name: String): Properties {
        val result = Properties()
        val file = path(project, name)
        if (Files.isRegularFile(file)) Files.newInputStream(file).use(result::load)
        return result
    }

    fun writeProperties(project: Project, name: String, value: Properties) {
        val bytes = java.io.ByteArrayOutputStream().use { output ->
            value.store(output, null)
            output.toByteArray()
        }
        write(path(project, name), bytes)
    }

    private fun write(target: Path, bytes: ByteArray) {
        Files.createDirectories(target.parent)
        val temporary = target.resolveSibling(".${target.fileName}.tmp-${UUID.randomUUID()}")
        Files.write(temporary, bytes)
        try {
            Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING)
        } finally {
            Files.deleteIfExists(temporary)
        }
    }
}
