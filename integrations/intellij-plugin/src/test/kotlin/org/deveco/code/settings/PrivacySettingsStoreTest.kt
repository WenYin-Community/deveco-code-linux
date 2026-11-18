package org.deveco.code.settings

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
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

    @Before
    fun resetArbitration() {
        // The store is a process-wide object, so the "applied in this session" flag would
        // otherwise leak from one test into the next.
        PrivacySettingsStore.resetToolImprovementArbitrationForTest()
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
    fun `forced write adopts the legacy value on a store without a value`() {
        // Fresh store, as on the first launch after an upgrade: no persisted value yet.
        java.nio.file.Files.deleteIfExists(kvJsonPath())
        assertTrue(PrivacySettingsStore.writeToolImprovementEnabledForced(true))
        assertTrue(PrivacySettingsStore.readToolImprovementEnabled())
    }

    @Test
    fun `forced write overwrites a value nobody applied through the settings page`() {
        // The CLI writes the same key with its own default, so a value in kv.json is not proof of
        // a newer decision; the legacy consent must still win and the other key must survive.
        seedKvJson("""{"analytics_enabled":true,"deveco_tool_improvement_enabled":true}""")
        assertTrue(PrivacySettingsStore.writeToolImprovementEnabledForced(false))
        assertFalse(PrivacySettingsStore.readToolImprovementEnabled())
        assertTrue(PrivacySettingsStore.readAnalyticsEnabled())
    }

    @Test
    fun `forced write ordered after a settings page apply never overwrites it`() {
        // Deterministic reproduction of the reviewed interleaving: the user applies a
        // choice after the legacy property was written, then the one-time migration runs
        // its forced write — sequencing the calls forces exactly that order, and the
        // applied value must win.
        PrivacySettingsStore.writeToolImprovementEnabled(false)
        assertFalse(PrivacySettingsStore.writeToolImprovementEnabledForced(true))
        assertFalse(PrivacySettingsStore.readToolImprovementEnabled())

        // Symmetric direction: a user-enabled choice must not be turned off either.
        PrivacySettingsStore.writeToolImprovementEnabled(true)
        assertFalse(PrivacySettingsStore.writeToolImprovementEnabledForced(false))
        assertTrue(PrivacySettingsStore.readToolImprovementEnabled())
    }

    @Test
    fun `a failed settings page apply still lets the migration write`() {
        // Swapping state/ for a regular file makes createDirectories throw, so the apply fails
        // without persisting anything; the migration must not read that as a deliberate choice,
        // or it would decline and the migrator would retire the legacy key anyway.
        val state = kvJsonPath().parent
        java.nio.file.Files.createDirectories(state)
        java.nio.file.Files.deleteIfExists(kvJsonPath())
        java.nio.file.Files.deleteIfExists(state)
        java.nio.file.Files.writeString(state, "not a directory")
        try {
            PrivacySettingsStore.writeToolImprovementEnabled(true)
            fail("expected the apply to throw")
        } catch (expected: java.io.IOException) {
        } finally {
            java.nio.file.Files.deleteIfExists(state)
        }
        assertTrue(PrivacySettingsStore.writeToolImprovementEnabledForced(true))
        assertTrue(PrivacySettingsStore.readToolImprovementEnabled())
    }

    private fun seedKvJson(content: String) {
        val file = kvJsonPath()
        java.nio.file.Files.createDirectories(file.parent)
        java.nio.file.Files.writeString(file, content)
    }

    private fun kvJsonPath(): java.nio.file.Path =
        java.nio.file.Path.of(System.getProperty("idea.system.path"), "deveco-code", "v1", "state", "kv.json")
}
