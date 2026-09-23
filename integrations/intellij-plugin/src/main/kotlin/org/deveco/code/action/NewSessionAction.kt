package org.deveco.code.action

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import org.deveco.code.MyMessageBundle
import org.deveco.code.action.DevEcoSessionActions

class NewSessionAction :
    AnAction(),
    DumbAware {
    private val log = Logger.getInstance(NewSessionAction::class.java)

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        activateToolWindow(project)
        val handler = DevEcoSessionActions.forProject(project).newSessionHandler
        if (handler != null) {
            handler.invoke()
        } else {
            Messages.showInfoMessage(
                project,
                MyMessageBundle.message("toolwindow.deveco.action.open.window"),
                MyMessageBundle.message("toolwindow.deveco.new.title"),
            )
        }
    }

    override fun update(event: AnActionEvent) {
        val project = event.project
        event.presentation.text = MyMessageBundle.message("toolwindow.deveco.new.title")
        event.presentation.description = MyMessageBundle.message("action.newSession.description")
        event.presentation.isEnabledAndVisible = project != null
    }

    private fun activateToolWindow(project: Project) {
        runCatching {
            ToolWindowManager.getInstance(project).getToolWindow("DevEco Code")?.activate(null)
        }.onFailure { log.warn("Failed to activate DevEco Code tool window", it) }
    }
}
