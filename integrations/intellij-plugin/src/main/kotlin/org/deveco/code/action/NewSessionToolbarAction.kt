package org.deveco.code.action

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.Presentation
import com.intellij.openapi.actionSystem.ex.CustomComponentAction
import com.intellij.openapi.actionSystem.impl.ActionButtonWithText
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.util.ui.JBFont
import com.intellij.util.ui.JBUI
import org.deveco.code.MyMessageBundle
import java.awt.Component
import java.awt.Graphics
import java.awt.Graphics2D
import javax.swing.Icon
import javax.swing.JComponent

class NewSessionToolbarAction :
    AnAction(),
    CustomComponentAction,
    DumbAware {
    private val log = Logger.getInstance(NewSessionToolbarAction::class.java)
    private val icon = ScaledIcon(AllIcons.General.Add, JBUI.scale(12))

    override fun createCustomComponent(presentation: Presentation, place: String): JComponent =
        object : ActionButtonWithText(
            this,
            presentation,
            place,
            JBUI.size(28, 28),
        ) {
            init {
                font = JBFont.medium().deriveFont(13f)
            }

            override fun paintBorder(g: Graphics) {}

            override fun iconTextSpace(): Int = JBUI.scale(8)
        }

    override fun updateCustomComponent(component: JComponent, presentation: Presentation) {
        component.isVisible = presentation.isVisible
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun update(event: AnActionEvent) {
        event.presentation.isVisible = true
        val project = event.project
        event.presentation.isEnabled = project != null && !DevEcoSessionActions.forProject(project).busy
        event.presentation.icon = icon
        event.presentation.text = MyMessageBundle.message("toolwindow.deveco.new.title")
        event.presentation.description = MyMessageBundle.message("action.newSession.description")
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        activateToolWindow(project)
        val actions = DevEcoSessionActions.forProject(project)
        if (actions.newSessionHandler != null) {
            actions.newSession()
        } else {
            ApplicationManager.getApplication().invokeLater {
                DevEcoSessionActions.forProject(project).newSession()
            }
        }
    }

    private fun activateToolWindow(project: Project) {
        runCatching {
            ToolWindowManager.getInstance(project).getToolWindow("DevEco Code")?.activate(null)
        }.onFailure { log.warn("Failed to activate DevEco Code tool window", it) }
    }

    private class ScaledIcon(private val delegate: Icon, private val size: Int) : Icon {
        override fun getIconWidth() = size

        override fun getIconHeight() = size

        override fun paintIcon(c: Component?, g: Graphics, x: Int, y: Int) {
            val g2 = g.create() as Graphics2D
            try {
                g2.translate(x, y)
                g2.scale(size.toDouble() / delegate.iconWidth, size.toDouble() / delegate.iconHeight)
                delegate.paintIcon(c, g2, 0, 0)
            } finally {
                g2.dispose()
            }
        }
    }
}
