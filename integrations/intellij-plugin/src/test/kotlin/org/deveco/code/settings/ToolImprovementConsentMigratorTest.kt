package org.deveco.code.settings

import com.intellij.ide.util.PropertiesComponent
import com.intellij.testFramework.LightPlatformTestCase
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import org.deveco.code.util.devecoStorageRoot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import java.nio.file.Files

/**
 * Platform tests for [ToolImprovementConsentMigrator]: the legacy IDE
 * properties key migrates into kv.json exactly once — "true" enables the
 * tool-improvement switch, anything else disables it, the legacy key is
 * removed, and without the key nothing is written.
 */
class ToolImprovementConsentMigratorTest : LightPlatformTestCase() {

    private val consentKey = "deveco.code.data.toolImprovement.enabled"
    private var kvBackup: ByteArray? = null

    private fun kvFile() = devecoStorageRoot.resolve("state").resolve("kv.json")

    override fun setUp() {
        super.setUp()
        // The arbitration flag is process-wide; without this reset an earlier test
        // class's settings-page apply would make the migrator decline its forced
        // write, and the migration would retire the legacy key without writing.
        PrivacySettingsStore.resetToolImprovementArbitrationForTest()
        kvBackup = if (Files.isRegularFile(kvFile())) Files.readAllBytes(kvFile()) else null
        Files.deleteIfExists(kvFile())
        PropertiesComponent.getInstance().unsetValue(consentKey)
    }

    override fun tearDown() {
        val backup = kvBackup
        if (backup != null) Files.write(kvFile(), backup) else Files.deleteIfExists(kvFile())
        PropertiesComponent.getInstance().unsetValue(consentKey)
        super.tearDown()
    }

    private fun kvToolImprovement(): Boolean? {
        val file = kvFile()
        if (!Files.isRegularFile(file)) return null
        val kv = Json.parseToJsonElement(Files.readString(file))
        return (kv as? kotlinx.serialization.json.JsonObject)
            ?.get("deveco_tool_improvement_enabled")
            ?.let { it as? JsonPrimitive }?.booleanOrNull
    }

    fun testWithoutLegacyKeyNothingIsWritten() {
        ToolImprovementConsentMigrator.migrate()

        assertFalse(Files.isRegularFile(kvFile()))
        assertNull(PropertiesComponent.getInstance().getValue(consentKey))
    }

    fun testLegacyTrueMigratesToEnabledAndClearsTheKey() {
        PropertiesComponent.getInstance().setValue(consentKey, "true")

        ToolImprovementConsentMigrator.migrate()

        assertTrue(PrivacySettingsStore.readToolImprovementEnabled())
        assertNull(PropertiesComponent.getInstance().getValue(consentKey))
    }

    fun testLegacyFalseMigratesToDisabled() {
        PropertiesComponent.getInstance().setValue(consentKey, "false")

        ToolImprovementConsentMigrator.migrate()

        assertFalse(PrivacySettingsStore.readToolImprovementEnabled())
    }

    fun testMigrationIsOneShot() {
        PropertiesComponent.getInstance().setValue(consentKey, "true")
        ToolImprovementConsentMigrator.migrate()
        assertTrue(PrivacySettingsStore.readToolImprovementEnabled())

        // A later manual change must survive a second migration attempt.
        PrivacySettingsStore.writeToolImprovementEnabled(false)

        ToolImprovementConsentMigrator.migrate()

        assertEquals(false, kvToolImprovement())
    }
}
