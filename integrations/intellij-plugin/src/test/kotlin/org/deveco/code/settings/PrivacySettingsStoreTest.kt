package org.deveco.code.settings

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class PrivacySettingsStoreTest {

    companion object {
        @BeforeClass
        @JvmStatic
        fun pinStorageRoot() {
            // devecoStorageRoot caches PathManager.getSystemPath() on first access; pinning
            // it to a temp directory keeps this test self-contained on a plain-JUnit
            // classpath and isolated from any real IDE state.
            System.setProperty(
                "idea.system.path",
                java.nio.file.Files.createTempDirectory("privacy-store-test").toAbsolutePath().toString(),
            )
        }
    }

    @Test
    fun `a write preserves the other key written before it`() {
        PrivacySettingsStore.writeAnalyticsEnabled(true)
        PrivacySettingsStore.writeToolImprovementEnabled(false)
        assertTrue(PrivacySettingsStore.readAnalyticsEnabled())
        assertFalse(PrivacySettingsStore.readToolImprovementEnabled())

        PrivacySettingsStore.writeAnalyticsEnabled(false)
        assertFalse(PrivacySettingsStore.readAnalyticsEnabled())
        assertFalse(PrivacySettingsStore.readToolImprovementEnabled())
    }

    @Test
    fun `concurrent writers never fail or drop the untouched key`() {
        PrivacySettingsStore.writeAnalyticsEnabled(true)
        PrivacySettingsStore.writeToolImprovementEnabled(false)

        val failures = ArrayList<Throwable>()
        val writers = (1..2).map { worker ->
            Thread {
                repeat(100) { round ->
                    try {
                        PrivacySettingsStore.writeAnalyticsEnabled((round + worker) % 2 == 0)
                    } catch (e: Throwable) {
                        synchronized(failures) { failures.add(e) }
                    }
                }
            }.apply { isDaemon = true }
        }
        writers.forEach { it.start() }
        writers.forEach { it.join() }

        assertTrue("concurrent writes failed: $failures", failures.isEmpty())
        // The merged, serialized write keeps the untouched key present no matter how the
        // two writers interleave; the read must land on a valid state.
        assertFalse(PrivacySettingsStore.readToolImprovementEnabled())
    }

    @Test
    fun `conditional write adopts the legacy value on a store without a value`() {
        // Fresh store, as on the first launch after an upgrade: no persisted value yet.
        java.nio.file.Files.deleteIfExists(kvJsonPath())
        assertTrue(PrivacySettingsStore.writeToolImprovementEnabledIfAbsent(true))
        assertTrue(PrivacySettingsStore.readToolImprovementEnabled())
    }

    @Test
    fun `conditional write ordered after a user write never overwrites it`() {
        // Deterministic reproduction of the reviewed interleaving: the user applies a
        // choice (plain write) after the legacy property was written, then the one-time
        // migration runs its conditional write — sequencing the calls forces exactly
        // that order, and the newer value must win.
        PrivacySettingsStore.writeToolImprovementEnabled(false)
        assertFalse(PrivacySettingsStore.writeToolImprovementEnabledIfAbsent(true))
        assertFalse(PrivacySettingsStore.readToolImprovementEnabled())

        // Symmetric direction: a user-enabled choice must not be turned off either.
        PrivacySettingsStore.writeToolImprovementEnabled(true)
        assertFalse(PrivacySettingsStore.writeToolImprovementEnabledIfAbsent(false))
        assertTrue(PrivacySettingsStore.readToolImprovementEnabled())
    }

    private fun kvJsonPath(): java.nio.file.Path =
        java.nio.file.Path.of(System.getProperty("idea.system.path"), "deveco-code", "v1", "state", "kv.json")
}
