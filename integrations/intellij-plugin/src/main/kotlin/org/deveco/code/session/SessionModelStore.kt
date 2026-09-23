package org.deveco.code.session

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.util.PluginStateFiles
import java.util.concurrent.CopyOnWriteArrayList

@Service(Service.Level.PROJECT)
internal class SessionModelStore(private val project: Project) {

    data class ModelEntry(var sessionId: String = "", var modelId: String = "")

    data class CachedModelEntry(
        var providerId: String = "",
        var providerName: String = "",
        var modelId: String = "",
        var modelName: String = "",
        var source: String = "",
    )

    data class CachedCatalog(var models: MutableList<CachedModelEntry> = mutableListOf())

    data class CustomModelEntry(
        var providerId: String = "",
        var providerName: String = "",
        var modelId: String = "",
        var modelName: String = "",
    )

    data class CustomModelRegistry(var entries: MutableList<CustomModelEntry> = mutableListOf())

    data class ProviderTypeEntry(var providerId: String = "", var providerName: String = "", var type: String = "")

    data class ProviderTypeRegistry(var entries: MutableList<ProviderTypeEntry> = mutableListOf())

    data class BlacklistEntry(var providerId: String = "", var modelId: String = "")

    data class State(
        var entries: MutableList<ModelEntry> = mutableListOf(),
        var globalModelId: String? = null,
        var globalModelConfigured: Boolean = false,
        var manuallySelected: MutableList<String> = mutableListOf(),
        var blacklist: MutableList<BlacklistEntry> = mutableListOf(),
        var favorites: MutableList<String> = mutableListOf(),
    )

    @Volatile private var state = PluginStateFiles.readJsonGlobal("models.json", State::class.java) ?: State()

    @Volatile private var cachedCatalog: CachedCatalog =
        PluginStateFiles.readJsonGlobal("model-catalog-cache.json", CachedCatalog::class.java) ?: CachedCatalog()

    @Volatile private var customModelRegistry: CustomModelRegistry =
        PluginStateFiles.readJsonGlobal("custom-models.json", CustomModelRegistry::class.java) ?: CustomModelRegistry()

    @Volatile private var providerTypeRegistry: ProviderTypeRegistry =
        PluginStateFiles.readJsonGlobal("provider-types.json", ProviderTypeRegistry::class.java)
            ?: ProviderTypeRegistry()
    private val listeners = CopyOnWriteArrayList<(String?) -> Unit>()
    private val customModelListeners = CopyOnWriteArrayList<() -> Unit>()
    private val blacklistListeners = CopyOnWriteArrayList<() -> Unit>()
    private val favoriteListeners = CopyOnWriteArrayList<() -> Unit>()
    private val stateLock = Any()
    private val log = Logger.getInstance(SessionModelStore::class.java)

    // Marshals listener notification to the EDT when called off-EDT (e.g.
    // from apply()'s pooled-thread block). Listeners typically rebuild Swing
    // trees, so running them on a pooled thread would violate EDT rules.
    private fun fireListeners(listeners: CopyOnWriteArrayList<() -> Unit>) {
        val fire = {
            listeners.forEach { listener ->
                try {
                    listener()
                } catch (e: Exception) {
                    log.warn("Listener failed", e)
                }
            }
        }
        val app = ApplicationManager.getApplication()
        if (app.isDispatchThread) fire() else app.invokeLater { fire() }
    }

    fun getModelId(sessionId: String): String? = state.entries.firstOrNull { it.sessionId == sessionId }?.modelId

    fun setModelId(sessionId: String, modelId: String?) {
        synchronized(stateLock) {
            val newEntries = state.entries.filterNot { it.sessionId == sessionId }.toMutableList()
            if (modelId != null) newEntries.add(ModelEntry(sessionId, modelId))
            persistStateLocked(newEntries = newEntries)
        }
    }

    fun removeSession(sessionId: String) {
        synchronized(stateLock) {
            val newEntries = state.entries.filterNot { it.sessionId == sessionId }.toMutableList()
            val newSelected = state.manuallySelected.filterNot { it == sessionId }.toMutableList()
            persistStateLocked(newEntries = newEntries, newManuallySelected = newSelected)
        }
    }

    fun getGlobalModelId(): String? = state.globalModelId

    fun isGlobalModelConfigured(): Boolean = state.globalModelConfigured

    fun setGlobalModelId(modelId: String?) {
        val notifyListeners: List<(String?) -> Unit>
        synchronized(stateLock) {
            persistStateLocked(newGlobalModelId = modelId, newGlobalModelConfigured = true)
            notifyListeners = listeners.toList()
        }
        notifyListeners.forEach { listener ->
            try {
                listener(modelId)
            } catch (e: Exception) {
                log.warn("Listener failed", e)
            }
        }
    }

    fun addGlobalModelListener(listener: (String?) -> Unit) {
        listeners.add(listener)
    }

    fun removeGlobalModelListener(listener: (String?) -> Unit) {
        listeners.remove(listener)
    }

    fun wasManuallySelected(sessionId: String): Boolean = sessionId in state.manuallySelected

    fun markManuallySelected(sessionId: String) {
        synchronized(stateLock) {
            if (sessionId !in state.manuallySelected) {
                val newSelected = state.manuallySelected.toMutableList()
                newSelected.add(sessionId)
                persistStateLocked(newManuallySelected = newSelected)
            }
        }
    }

    fun cacheCatalog(models: List<DevEcoHttpApi.ModelInfo>) {
        cachedCatalog = CachedCatalog(
            models.map {
                CachedModelEntry(it.providerId, it.providerName, it.modelId, it.modelName, it.source)
            }.toMutableList(),
        )
        runCatching { PluginStateFiles.writeJsonGlobal("model-catalog-cache.json", cachedCatalog) }
            .onFailure { log.warn("Failed to persist catalog cache", it) }
    }

    fun getCachedCatalog(): List<DevEcoHttpApi.ModelInfo> = cachedCatalog.models.map {
        DevEcoHttpApi.ModelInfo(it.providerId, it.providerName, it.modelId, it.modelName, it.source)
    }

    fun addCustomModels(entries: List<CustomModelEntry>) {
        if (entries.isEmpty()) return
        val map = customModelRegistry.entries.associateBy { it.providerId to it.modelId }.toMutableMap()
        for (e in entries) map[e.providerId to e.modelId] = e
        customModelRegistry = CustomModelRegistry(map.values.toMutableList())
        runCatching { PluginStateFiles.writeJsonGlobal("custom-models.json", customModelRegistry) }
            .onFailure { log.warn("Failed to persist custom model registry", it) }
        notifyCustomModelListeners()
    }

    fun removeCustomModel(providerId: String, modelId: String) {
        val map = customModelRegistry.entries.associateBy { it.providerId to it.modelId }.toMutableMap()
        if (map.remove(providerId to modelId) == null) return
        customModelRegistry = CustomModelRegistry(map.values.toMutableList())
        runCatching { PluginStateFiles.writeJsonGlobal("custom-models.json", customModelRegistry) }
            .onFailure { log.warn("Failed to persist custom model registry", it) }
        notifyCustomModelListeners()
    }

    fun getCustomModels(): List<CustomModelEntry> = customModelRegistry.entries.toList()

    fun addCustomModelListener(listener: () -> Unit) {
        customModelListeners.add(listener)
    }

    fun removeCustomModelListener(listener: () -> Unit) {
        customModelListeners.remove(listener)
    }

    private fun notifyCustomModelListeners() {
        fireListeners(customModelListeners)
    }

    // --- Provider type registry ---

    fun addProviderType(providerId: String, providerName: String, type: String) {
        val map = providerTypeRegistry.entries.associateBy { it.providerId }.toMutableMap()
        map[providerId] = ProviderTypeEntry(providerId, providerName, type)
        providerTypeRegistry = ProviderTypeRegistry(map.values.toMutableList())
        runCatching { PluginStateFiles.writeJsonGlobal("provider-types.json", providerTypeRegistry) }
            .onFailure { log.warn("Failed to persist provider type registry", it) }
    }

    fun removeProviderType(providerId: String) {
        val map = providerTypeRegistry.entries.associateBy { it.providerId }.toMutableMap()
        if (map.remove(providerId) == null) return
        providerTypeRegistry = ProviderTypeRegistry(map.values.toMutableList())
        runCatching { PluginStateFiles.writeJsonGlobal("provider-types.json", providerTypeRegistry) }
            .onFailure { log.warn("Failed to persist provider type registry", it) }
    }

    fun getProviderType(providerId: String): String? =
        providerTypeRegistry.entries.firstOrNull { it.providerId == providerId }?.type

    fun getProviderTypes(): List<ProviderTypeEntry> = providerTypeRegistry.entries.toList()

    // --- Blacklist (unchecked models) ---

    fun addToBlacklist(providerId: String, modelId: String) {
        synchronized(stateLock) {
            if (state.blacklist.any { it.providerId == providerId && it.modelId == modelId }) return
            val newBlacklist = state.blacklist.toMutableList()
            newBlacklist.add(BlacklistEntry(providerId, modelId))
            persistStateLocked(newBlacklist = newBlacklist)
        }
        notifyBlacklistListeners()
    }

    fun removeFromBlacklist(providerId: String, modelId: String) {
        val changed: Boolean
        synchronized(stateLock) {
            val newBlacklist = state.blacklist.filterNot {
                it.providerId == providerId && it.modelId == modelId
            }.toMutableList()
            changed = newBlacklist.size != state.blacklist.size
            if (changed) persistStateLocked(newBlacklist = newBlacklist)
        }
        if (changed) notifyBlacklistListeners()
    }

    fun isBlacklisted(providerId: String, modelId: String): Boolean =
        state.blacklist.any { it.providerId == providerId && it.modelId == modelId }

    fun getBlacklist(): List<BlacklistEntry> = state.blacklist.toList()

    fun addBlacklistListener(listener: () -> Unit) {
        blacklistListeners.add(listener)
    }

    fun removeBlacklistListener(listener: () -> Unit) {
        blacklistListeners.remove(listener)
    }

    private fun notifyBlacklistListeners() {
        fireListeners(blacklistListeners)
    }

    // --- Favorites ---

    fun toggleFavorite(providerId: String, modelId: String) {
        val key = "$providerId/$modelId"
        synchronized(stateLock) {
            val newFavorites = state.favorites.toMutableList()
            if (!newFavorites.remove(key)) {
                newFavorites.add(key)
            }
            persistStateLocked(newFavorites = newFavorites)
        }
        notifyFavoriteListeners()
    }

    fun isFavorite(providerId: String, modelId: String): Boolean = "$providerId/$modelId" in state.favorites

    fun getFavorites(): List<String> = state.favorites.toList()

    fun removeFavorite(providerId: String, modelId: String) {
        val key = "$providerId/$modelId"
        synchronized(stateLock) {
            if (!state.favorites.contains(key)) return
            val newFavorites = state.favorites.filterNot { it == key }.toMutableList()
            persistStateLocked(newFavorites = newFavorites)
        }
        notifyFavoriteListeners()
    }

    fun removeBlacklistForProvider(providerId: String) {
        val changed: Boolean
        synchronized(stateLock) {
            val newBlacklist = state.blacklist.filterNot { it.providerId == providerId }.toMutableList()
            changed = newBlacklist.size != state.blacklist.size
            if (changed) persistStateLocked(newBlacklist = newBlacklist)
        }
        if (changed) notifyBlacklistListeners()
    }

    fun removeFavoritesForProvider(providerId: String) {
        val changed: Boolean
        synchronized(stateLock) {
            val prefix = "$providerId/"
            val newFavorites = state.favorites.filterNot { it.startsWith(prefix) }.toMutableList()
            changed = newFavorites.size != state.favorites.size
            if (changed) persistStateLocked(newFavorites = newFavorites)
        }
        if (changed) notifyFavoriteListeners()
    }

    // Migrates (providerId, oldId) -> (providerId, newId) for blacklist entries,
    // favorite keys, and per-session entries[].modelId. Called by
    // ModelSettingsConfigurable.apply() on a confirmed single-model rename.
    // globalModelId is migrated separately by the caller via setGlobalModelId
    // (needs to fire listeners so open sessions follow the rename).
    fun migrateModelId(providerId: String, oldId: String, newId: String) {
        if (oldId == newId) return
        var blacklistChanged = false
        var favoritesChanged = false
        synchronized(stateLock) {
            val newBlacklist = state.blacklist.map {
                if (it.providerId == providerId && it.modelId == oldId) BlacklistEntry(providerId, newId) else it
            }.toMutableList()
            val oldKey = "$providerId/$oldId"
            val newKey = "$providerId/$newId"
            val newFavorites = state.favorites.map { if (it == oldKey) newKey else it }.toMutableList()
            // ModelEntry has no providerId, so modelId-only matching would
            // cross-migrate sessions using the same model ID under a different
            // provider. Only migrate entries when oldId appears under exactly
            // one provider across the catalog and custom-model registry.
            val providerCount = (
                cachedCatalog.models.filter { it.modelId == oldId }.map { it.providerId } +
                customModelRegistry.entries.filter { it.modelId == oldId }.map { it.providerId }
            ).toSet().size
            val newEntries: MutableList<ModelEntry>? = if (providerCount <= 1) {
                state.entries.map {
                    if (it.modelId == oldId) ModelEntry(it.sessionId, newId) else it
                }.toMutableList()
            } else {
                null
            }
            blacklistChanged = newBlacklist != state.blacklist
            favoritesChanged = newFavorites != state.favorites
            persistStateLocked(newEntries = newEntries, newBlacklist = newBlacklist, newFavorites = newFavorites)
        }
        if (blacklistChanged) notifyBlacklistListeners()
        if (favoritesChanged) notifyFavoriteListeners()
    }

    fun addFavoriteListener(listener: () -> Unit) {
        favoriteListeners.add(listener)
    }

    fun removeFavoriteListener(listener: () -> Unit) {
        favoriteListeners.remove(listener)
    }

    private fun notifyFavoriteListeners() {
        fireListeners(favoriteListeners)
    }

    // --- Unified persistence ---

    // Creates a new State from the current state, substituting any provided
    // lists. Never mutates the old State's lists — unsynchronized readers that
    // hold a reference to the old State are safe because its lists are never
    // structurally modified after creation.
    private fun persistStateLocked(
        newEntries: MutableList<ModelEntry>? = null,
        newGlobalModelId: String? = state.globalModelId,
        newGlobalModelConfigured: Boolean = state.globalModelConfigured,
        newManuallySelected: MutableList<String>? = null,
        newBlacklist: MutableList<BlacklistEntry>? = null,
        newFavorites: MutableList<String>? = null,
    ) {
        val snapshot = State(
            newEntries ?: state.entries.map { it.copy() }.toMutableList(),
            newGlobalModelId,
            newGlobalModelConfigured,
            newManuallySelected ?: state.manuallySelected.toMutableList(),
            newBlacklist ?: state.blacklist.map { it.copy() }.toMutableList(),
            newFavorites ?: state.favorites.toMutableList(),
        )
        state = snapshot
        runCatching { PluginStateFiles.writeJsonGlobal("models.json", snapshot) }
            .onFailure { log.warn("Failed to persist state", it) }
    }

    companion object {
        fun getInstance(project: Project): SessionModelStore = project.getService(SessionModelStore::class.java)
    }
}
