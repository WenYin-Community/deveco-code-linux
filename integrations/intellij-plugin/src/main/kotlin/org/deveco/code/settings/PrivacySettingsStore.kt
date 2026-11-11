package org.deveco.code.settings

import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.deveco.code.util.devecoStorageRoot
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * Privacy collection switches persisted in DevEco Code's state key-value store
 * (`<storageRoot>/state/kv.json`), the same file the CLI subprocess reads.
 *
 * Key names must match `packages/opencode/src/cli/deveco-privacy-settings.ts`:
 * - `analytics_enabled` — statistics collection (default: enabled)
 * - `deveco_tool_improvement_enabled` — experience-improvement collection,
 *   effective only when a Huawei-provided model is used (default: disabled)
 *
 * The CLI reads these keys lazily (per session collection and per model
 * request), so changes apply without restarting the subprocess.
 *
 * The CLI writes this file under its own cross-process lock with atomic
 * rename; this store cannot cheaply join that protocol, so it performs
 * read-modify-write with an atomic rename instead. Both writers preserve
 * unknown keys, and realistic write sources (crash reports, language changes,
 * settings apply) never overlap in practice.
 */
object PrivacySettingsStore {
    private val log = Logger.getInstance(PrivacySettingsStore::class.java)

    private const val ANALYTICS_ENABLED_KEY = "analytics_enabled"
    private const val TOOL_IMPROVEMENT_ENABLED_KEY = "deveco_tool_improvement_enabled"

    private val json = Json { prettyPrint = true }

    private fun kvFile(): Path = devecoStorageRoot.resolve("state").resolve("kv.json")

    fun readAnalyticsEnabled(): Boolean = readBoolean(ANALYTICS_ENABLED_KEY, fallback = true)

    fun readToolImprovementEnabled(): Boolean = readBoolean(TOOL_IMPROVEMENT_ENABLED_KEY, fallback = false)

    @Throws(java.io.IOException::class)
    fun writeAnalyticsEnabled(enabled: Boolean) = writeSingle(ANALYTICS_ENABLED_KEY, enabled)

    @Throws(java.io.IOException::class)
    fun writeToolImprovementEnabled(enabled: Boolean) = writeSingle(TOOL_IMPROVEMENT_ENABLED_KEY, enabled)

    // One lock covers the whole read-merge-write: the settings page applies on the EDT
    // while the one-time consent migration runs on a pooled thread, so without this
    // lock their concurrent cycles could lose updates or race on the temp file. This
    // restores the serialization the EDT provided before the migration went async.
    @Synchronized
    private fun writeSingle(key: String, value: Boolean) {
        val file = kvFile()
        Files.createDirectories(file.parent)
        val existing = try {
            if (Files.isRegularFile(file)) {
                json.parseToJsonElement(Files.readString(file, StandardCharsets.UTF_8)) as? JsonObject
            } else {
                null
            }
        } catch (e: Exception) {
            log.warn("kv.json is unreadable, continuing from an empty object: ${e.message}")
            null
        }
        val merged = buildJsonObject {
            existing?.forEach { (k, v) -> put(k, v) }
            put(key, value)
        }
        // A unique temp name per write: concurrent IDE writers can no longer collide on
        // the same temporary path, and a failed write cleans up after itself. The atomic
        // move still lands every reader on either the old or the new file.
        val tmp = Files.createTempFile(file.parent, "kv", ".tmp")
        try {
            Files.writeString(tmp, merged.toString(), StandardCharsets.UTF_8)
            try {
                Files.move(tmp, file, StandardCopyOption.ATOMIC_MOVE)
            } catch (e: AtomicMoveNotSupportedException) {
                Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            Files.deleteIfExists(tmp)
        }
    }

    private fun readBoolean(key: String, fallback: Boolean): Boolean {
        return try {
            val file = kvFile()
            if (!Files.isRegularFile(file)) return fallback
            val kv =
                json.parseToJsonElement(Files.readString(file, StandardCharsets.UTF_8)) as? JsonObject
                    ?: return fallback
            (kv[key] as? JsonPrimitive)?.booleanOrNull ?: fallback
        } catch (e: Exception) {
            log.warn("Failed to read privacy setting $key, using default $fallback: ${e.message}")
            fallback
        }
    }
}
