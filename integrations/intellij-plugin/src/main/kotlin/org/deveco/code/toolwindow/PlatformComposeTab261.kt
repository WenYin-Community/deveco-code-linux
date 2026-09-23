package org.deveco.code.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import org.deveco.code.sessions.DevEcoSessions
import org.jetbrains.jewel.bridge.addComposeTab

internal fun ToolWindow.addDevEcoComposeTab(project: Project) {
    addComposeTab("", focusOnClickInside = true) {
        DevEcoSessions(project)
    }
}
