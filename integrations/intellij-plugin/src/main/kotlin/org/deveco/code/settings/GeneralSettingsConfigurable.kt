package org.deveco.code.settings

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.options.ConfigurationException
import com.intellij.ui.JBColor
import com.intellij.ui.TitledSeparator
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import org.deveco.code.MyMessageBundle
import java.awt.Dimension
import java.io.IOException
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.border.EmptyBorder

/**
 * "General" settings page under the "AI" node: privacy collection switches.
 *
 * The two checkboxes persist into DevEco Code's `state/kv.json` via
 * [PrivacySettingsStore], so the CLI subprocess honors them without a
 * restart. Defaults match the CLI: analytics enabled, tool improvement disabled.
 */
class GeneralSettingsConfigurable : Configurable {
    private var analyticsCheckbox: JBCheckBox? = null
    private var improvementCheckbox: JBCheckBox? = null
    private var panel: JPanel? = null

    override fun getDisplayName(): String = MyMessageBundle.message("settings.general.displayName")

    override fun createComponent(): JComponent {
        val analytics = JBCheckBox(MyMessageBundle.message("settings.privacy.stats.title"))
        val improvement = JBCheckBox(MyMessageBundle.message("settings.privacy.improvement.title"))
        analyticsCheckbox = analytics
        improvementCheckbox = improvement
        panel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = EmptyBorder(0, 0, 0, 0)
            add(
                TitledSeparator(MyMessageBundle.message("settings.privacy.data.collection.title")).apply {
                    alignmentX = JPanel.LEFT_ALIGNMENT
                    maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
                },
            )
            add(Box.createVerticalStrut(10))
            add(
                analytics.apply {
                    alignmentX = JPanel.LEFT_ALIGNMENT
                },
            )
            add(descriptionLabel(MyMessageBundle.message("settings.privacy.stats.description")))
            add(Box.createVerticalStrut(10))
            add(
                improvement.apply {
                    alignmentX = JPanel.LEFT_ALIGNMENT
                },
            )
            add(descriptionLabel(MyMessageBundle.message("settings.privacy.improvement.description")))
            add(Box.createVerticalGlue())
        }
        reset()
        return panel as JComponent
    }

    override fun isModified(): Boolean {
        val analytics = analyticsCheckbox ?: return false
        val improvement = improvementCheckbox ?: return false
        return analytics.isSelected != PrivacySettingsStore.readAnalyticsEnabled() ||
            improvement.isSelected != PrivacySettingsStore.readToolImprovementEnabled()
    }

    override fun apply() {
        val analytics = analyticsCheckbox ?: return
        val improvement = improvementCheckbox ?: return
        try {
            PrivacySettingsStore.writeAnalyticsEnabled(analytics.isSelected)
            PrivacySettingsStore.writeToolImprovementEnabled(improvement.isSelected)
        } catch (e: IOException) {
            throw ConfigurationException("Failed to save privacy settings: ${e.message}")
        }
    }

    override fun reset() {
        analyticsCheckbox?.isSelected = PrivacySettingsStore.readAnalyticsEnabled()
        improvementCheckbox?.isSelected = PrivacySettingsStore.readToolImprovementEnabled()
    }

    override fun disposeUIResources() {
        analyticsCheckbox = null
        improvementCheckbox = null
        panel = null
    }

    private fun descriptionLabel(text: String): JBLabel = JBLabel(text).apply {
        alignmentX = JPanel.LEFT_ALIGNMENT
        foreground = JBColor.GRAY
        border = EmptyBorder(0, 24, 0, 8)
    }
}
