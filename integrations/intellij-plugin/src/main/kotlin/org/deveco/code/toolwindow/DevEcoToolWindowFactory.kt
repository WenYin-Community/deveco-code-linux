package org.deveco.code.toolwindow

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import org.deveco.code.settings.ToolImprovementConsentMigrator

class DevEcoToolWindowFactory :
    ToolWindowFactory,
    DumbAware {
    override fun shouldBeAvailable(project: Project): Boolean = true

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        ToolImprovementConsentMigrator.migrate()
        toolWindow.addDevEcoComposeTab(project)
        val content = toolWindow.contentManager.contents.firstOrNull() ?: return
        content.displayName = null
    }
}
