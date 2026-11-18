package org.deveco.code.settings

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger

object ToolImprovementConsentMigrator {
    private val log = Logger.getInstance(ToolImprovementConsentMigrator::class.java)
    private const val CONSENT_KEY = "deveco.code.data.toolImprovement.enabled"

    /**
     * The migration writes kv.json, so it runs off the EDT instead of inside
     * `createToolWindowContent`. Tool window content can be created for several projects
     * within one startup; [migrate] serializes those callers, and its legacy-key check is
     * idempotent, so the second caller finds the key unset and returns without writing.
     */
    @JvmStatic
    fun migrateAsync() {
        ApplicationManager.getApplication().executeOnPooledThread { migrate() }
    }

    @JvmStatic
    @Synchronized
    fun migrate() {
        val props = PropertiesComponent.getInstance()
        val value = props.getValue(CONSENT_KEY) ?: return
        val enabled = value == "true"
        // Overwrite kv.json (same lock as the settings page apply) unless the user already applied
        // a choice in this process: a value the CLI or an earlier run left behind is not a newer
        // decision, and the legacy property is the only record of the original consent. A failed
        // write keeps the legacy key so the next launch retries; only a decided outcome retires it.
        val adopted = try {
            PrivacySettingsStore.writeToolImprovementEnabledForced(enabled)
        } catch (e: Exception) {
            log.warn("Failed to migrate tool improvement consent", e)
            return
        }
        props.unsetValue(CONSENT_KEY)
        if (adopted) {
            log.info("Migrated tool improvement consent from IDE properties to kv.json (enabled=$enabled)")
        } else {
            log.info("Kept the consent applied in this session; cleared the legacy IDE property")
        }
    }
}
