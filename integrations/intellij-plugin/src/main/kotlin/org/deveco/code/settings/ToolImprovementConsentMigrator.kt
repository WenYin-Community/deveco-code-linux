package org.deveco.code.settings

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.diagnostic.Logger

object ToolImprovementConsentMigrator {
    private val log = Logger.getInstance(ToolImprovementConsentMigrator::class.java)
    private const val CONSENT_KEY = "deveco.code.data.toolImprovement.enabled"

    @JvmStatic
    fun migrate() {
        val props = PropertiesComponent.getInstance()
        val value = props.getValue(CONSENT_KEY) ?: return
        props.unsetValue(CONSENT_KEY)
        val enabled = value == "true"
        try {
            PrivacySettingsStore.writeToolImprovementEnabled(enabled)
            log.info("Migrated tool improvement consent from IDE properties to kv.json (enabled=$enabled)")
        } catch (e: Exception) {
            log.warn("Failed to migrate tool improvement consent", e)
        }
    }
}
