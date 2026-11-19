package org.deveco.code.session

import com.intellij.testFramework.LightPlatformTestCase
import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.util.PluginStateFiles
import java.nio.file.Files

/**
 * Platform-fixture unit tests for [SessionModelStore]: global model preference,
 * manual-selection marks, model blacklist / favorites with listener fan-out,
 * custom model registry, provider-type registry (protocol preservation), and
 * catalog caching. Global state files are wiped per test for isolation; the
 * store persists synchronously, so cross-instance reads are deterministic.
 */
class SessionModelStoreTest : LightPlatformTestCase() {

    private lateinit var store: SessionModelStore

    override fun setUp() {
        super.setUp()
        Files.deleteIfExists(PluginStateFiles.globalPath("models.json"))
        Files.deleteIfExists(PluginStateFiles.globalPath("custom-models.json"))
        Files.deleteIfExists(PluginStateFiles.globalPath("provider-types.json"))
        store = SessionModelStore(getProject())
    }

    private fun customModel(providerId: String, modelId: String): SessionModelStore.CustomModelEntry =
        SessionModelStore.CustomModelEntry(providerId, providerId.uppercase(), modelId, modelId.uppercase())

    // --- Global model preference ---

    fun testGlobalModelDefaults() {
        assertNull(store.getGlobalModelId())
        assertFalse(store.isGlobalModelConfigured())
    }

    fun testSetGlobalModelIdPersistsAndNotifiesListeners() {
        val notified = mutableListOf<String?>()
        store.addGlobalModelListener { notified.add(it) }

        store.setGlobalModelId("prov/model-a")

        assertEquals("prov/model-a", store.getGlobalModelId())
        assertTrue(store.isGlobalModelConfigured())
        assertEquals(listOf<String?>("prov/model-a"), notified)

        // Synchronous disk write: a fresh store instance reads it back.
        assertEquals("prov/model-a", SessionModelStore(getProject()).getGlobalModelId())
    }

    fun testRemovedGlobalModelListenerStopsReceivingUpdates() {
        val notified = mutableListOf<String?>()
        val listener: (String?) -> Unit = { notified.add(it) }
        store.addGlobalModelListener(listener)
        store.setGlobalModelId("prov/model-a")
        store.removeGlobalModelListener(listener)
        store.setGlobalModelId("prov/model-b")

        assertEquals(listOf<String?>("prov/model-a"), notified)
    }

    fun testUpgradeGlobalModelIdSilentlySkipsListeners() {
        store.setGlobalModelId("bare-model")
        val notified = mutableListOf<String?>()
        store.addGlobalModelListener { notified.add(it) }

        store.upgradeGlobalModelIdSilently("prov/bare-model")

        assertEquals("prov/bare-model", store.getGlobalModelId())
        assertTrue(notified.isEmpty())
    }

    // --- Manual selection marks ---

    fun testManualSelectionMarksAndUnmarks() {
        assertFalse(store.wasManuallySelected("s1"))
        store.markManuallySelected("s1")
        assertTrue(store.wasManuallySelected("s1"))
        store.unmarkManuallySelected("s1")
        assertFalse(store.wasManuallySelected("s1"))
    }

    fun testMarkManuallySelectedIsIdempotent() {
        store.markManuallySelected("s1")
        store.markManuallySelected("s1")
        store.unmarkManuallySelected("s1")

        assertFalse(store.wasManuallySelected("s1"))
    }

    fun testRemoveSessionClearsManualSelectionMark() {
        store.markManuallySelected("s1")
        store.removeSession("s1")

        assertFalse(store.wasManuallySelected("s1"))
    }

    // --- Blacklist ---

    fun testBlacklistAddRemoveAndListenerFanOut() {
        val notifications = mutableListOf<Unit>()
        store.addBlacklistListener { notifications.add(Unit) }

        store.addToBlacklist("prov", "model-a")
        store.addToBlacklist("prov", "model-a") // duplicate: no-op, no second fire

        assertTrue(store.isBlacklisted("prov", "model-a"))
        assertEquals(1, store.getBlacklist().size)
        assertEquals(1, notifications.size)

        store.removeFromBlacklist("prov", "model-a")

        assertFalse(store.isBlacklisted("prov", "model-a"))
        assertEquals(2, notifications.size)
    }

    fun testRemoveBlacklistForProviderDropsAllItsEntries() {
        store.addToBlacklist("prov-1", "model-a")
        store.addToBlacklist("prov-1", "model-b")
        store.addToBlacklist("prov-2", "model-c")

        store.removeBlacklistForProvider("prov-1")

        assertFalse(store.isBlacklisted("prov-1", "model-a"))
        assertFalse(store.isBlacklisted("prov-1", "model-b"))
        assertTrue(store.isBlacklisted("prov-2", "model-c"))
    }

    // --- Favorites ---

    fun testToggleFavoriteFlipsState() {
        store.toggleFavorite("prov", "model-a")
        assertTrue(store.isFavorite("prov", "model-a"))

        store.toggleFavorite("prov", "model-a")
        assertFalse(store.isFavorite("prov", "model-a"))
    }

    fun testRemoveFavoritesForProvider() {
        store.toggleFavorite("prov-1", "model-a")
        store.toggleFavorite("prov-2", "model-b")

        store.removeFavoritesForProvider("prov-1")

        assertFalse(store.isFavorite("prov-1", "model-a"))
        assertTrue(store.isFavorite("prov-2", "model-b"))
    }

    fun testMigrateModelIdMovesBlacklistAndFavoriteKeys() {
        store.addToBlacklist("prov", "old-id")
        store.toggleFavorite("prov", "old-id")

        store.migrateModelId("prov", "old-id", "new-id")

        assertFalse(store.isBlacklisted("prov", "old-id"))
        assertTrue(store.isBlacklisted("prov", "new-id"))
        assertFalse(store.isFavorite("prov", "old-id"))
        assertTrue(store.isFavorite("prov", "new-id"))
    }

    // --- Custom models ---

    fun testCustomModelsDedupeAndPersist() {
        store.addCustomModels(listOf(customModel("prov", "model-a"), customModel("prov", "model-b")))

        // Same (providerId, modelId) again: deduplicated, not appended.
        store.addCustomModels(listOf(customModel("prov", "model-a")))
        assertEquals(2, store.getCustomModels().size)

        // Synchronous disk write: a fresh store instance reads the registry.
        assertEquals(2, SessionModelStore(getProject()).getCustomModels().size)

        store.removeCustomModel("prov", "model-a")
        assertEquals(1, store.getCustomModels().size)
    }

    // --- Provider types ---

    fun testProviderTypeProtocolSurvivesReregisterWithoutProtocol() {
        store.addProviderType("prov", "Prov", "openai", "anthropic")
        store.addProviderType("prov", "Prov", "openai")

        assertEquals("openai", store.getProviderType("prov"))
        assertEquals("anthropic", store.getProviderProtocol("prov"))

        store.removeProviderType("prov")
        assertNull(store.getProviderType("prov"))
        assertNull(store.getProviderProtocol("prov"))
    }

    fun testProviderTypesPersistAcrossStoreInstances() {
        store.addProviderType("prov", "Prov", "anthropic")

        val reloaded = SessionModelStore(getProject())

        assertEquals("anthropic", reloaded.getProviderType("prov"))
        assertEquals(1, reloaded.getProviderTypes().size)
    }

    // --- Catalog cache ---

    fun testCatalogCachingAndCustomModelUnion() {
        assertFalse(store.catalogEverFed())
        assertTrue(store.getCachedCatalog().isEmpty())
        assertTrue(store.catalogModelIds().isEmpty())

        store.cacheCatalog(
            listOf(
                DevEcoHttpApi.ModelInfo("prov", "Prov", "model-a", "Model A", "builtin"),
                DevEcoHttpApi.ModelInfo("prov", "Prov", "model-b", "Model B", "builtin"),
            ),
        )
        store.addCustomModels(listOf(customModel("custom-prov", "model-x")))

        assertTrue(store.catalogEverFed())
        assertEquals(2, store.getCachedCatalog().size)
        assertEquals(
            setOf("prov/model-a", "prov/model-b", "custom-prov/model-x"),
            store.catalogModelIds(),
        )
    }
}
