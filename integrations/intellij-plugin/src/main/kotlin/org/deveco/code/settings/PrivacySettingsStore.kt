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
 *   effective only when a Huawei-provided model is used (default: enabled)
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

    fun readAnalyticsEnabled(): Boolean = readBoolean(ANALYTICS_ENABLED_KEY)

    fun readToolImprovementEnabled(): Boolean = readBoolean(TOOL_IMPROVEMENT_ENABLED_KEY)

    /**
     * Persists both switches. Preserves unrelated keys already present in
     * `kv.json` (crash-upload flag, language, upgrade state, ...). Throws
     * [java.io.IOException] so callers can surface the failure.
     */
    @Throws(java.io.IOException::class)
    fun write(analyticsEnabled: Boolean, toolImprovementEnabled: Boolean) {
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
            existing?.forEach { (key, value) -> put(key, value) }
            put(ANALYTICS_ENABLED_KEY, analyticsEnabled)
            put(TOOL_IMPROVEMENT_ENABLED_KEY, toolImprovementEnabled)
        }
        val tmp = file.resolveSibling("kv.json.${ProcessHandle.current().pid()}.tmp")
        Files.writeString(tmp, merged.toString(), StandardCharsets.UTF_8)
        try {
            Files.move(tmp, file, StandardCopyOption.ATOMIC_MOVE)
        } catch (e: AtomicMoveNotSupportedException) {
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private fun readBoolean(key: String): Boolean {
        return try {
            val file = kvFile()
            if (!Files.isRegularFile(file)) return true
            val kv =
                json.parseToJsonElement(Files.readString(file, StandardCharsets.UTF_8)) as? JsonObject ?: return true
            (kv[key] as? JsonPrimitive)?.booleanOrNull ?: true
        } catch (e: Exception) {
            log.warn("Failed to read privacy setting $key, using default: ${e.message}")
            true
        }
    }
}
