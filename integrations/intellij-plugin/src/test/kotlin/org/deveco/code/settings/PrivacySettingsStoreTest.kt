package org.deveco.code.settings

import org.deveco.code.util.devecoStorageRoot
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.nio.file.Files

class PrivacySettingsStoreTest {

    private var originalKv: ByteArray? = null

    @Before
    fun prepareStore() {
        val kv = kvJsonPath()
        originalKv = if (Files.isRegularFile(kv)) Files.readAllBytes(kv) else null
        deleteKvPath()
        Files.createDirectories(kv.parent)
        // The store is a process-wide object, so the "applied in this session" flag would
        // otherwise leak from one test into the next.
        PrivacySettingsStore.resetToolImprovementArbitrationForTest()
    }

    @After
    fun restoreStore() {
        deleteKvPath()
        originalKv?.let {
            Files.createDirectories(kvJsonPath().parent)
            Files.write(kvJsonPath(), it)
        }
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
        // A non-empty directory at the atomic-move destination makes the apply fail without
        // persisting anything. The migration must not read that as a deliberate choice, or it
        // would decline and the migrator would retire the legacy key anyway.
        val kv = kvJsonPath()
        Files.createDirectories(kv)
        Files.writeString(kv.resolve("sentinel"), "keep")
        try {
            PrivacySettingsStore.writeToolImprovementEnabled(true)
            fail("expected the apply to throw")
        } catch (expected: java.io.IOException) {
        } finally {
            kv.toFile().deleteRecursively()
        }
        assertTrue(PrivacySettingsStore.writeToolImprovementEnabledForced(true))
        assertTrue(PrivacySettingsStore.readToolImprovementEnabled())
    }

    private fun seedKvJson(content: String) {
        val file = kvJsonPath()
        java.nio.file.Files.createDirectories(file.parent)
        java.nio.file.Files.writeString(file, content)
    }

    private fun kvJsonPath(): java.nio.file.Path = devecoStorageRoot.resolve("state").resolve("kv.json")

    private fun deleteKvPath() {
        kvJsonPath().toFile().deleteRecursively()
    }
}
