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
}
