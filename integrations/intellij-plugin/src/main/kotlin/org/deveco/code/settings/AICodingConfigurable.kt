package org.deveco.code.settings

import com.intellij.openapi.options.Configurable
import org.deveco.code.MyMessageBundle
import javax.swing.JComponent

class AICodingConfigurable : Configurable {
    override fun getDisplayName(): String = MyMessageBundle.message("settings.aiCoding.displayName")
    override fun createComponent(): JComponent? = null
    override fun isModified(): Boolean = false
    override fun apply() {}
}
