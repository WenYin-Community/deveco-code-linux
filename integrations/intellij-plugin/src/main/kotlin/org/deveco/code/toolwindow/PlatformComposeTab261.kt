package org.deveco.code.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import org.deveco.code.sessions.DevEcoSessions
import org.jetbrains.jewel.bridge.JewelComposePanel
import java.awt.Dimension
import java.awt.LayoutManager
import javax.swing.JPanel

private const val MIN_WIDTH = 420

internal fun ToolWindow.addDevEcoComposeTab(project: Project) {
    val composePanel = JewelComposePanel {
        DevEcoSessions(project)
    }
    
    val wrapper = JPanel(object : LayoutManager {
        override fun addLayoutComponent(name: String?, comp: java.awt.Component?) = Unit
        override fun removeLayoutComponent(comp: java.awt.Component?) = Unit
        override fun preferredLayoutSize(parent: java.awt.Container) =
            Dimension(MIN_WIDTH, parent.components.firstOrNull()?.preferredSize?.height ?: 0)
        override fun minimumLayoutSize(parent: java.awt.Container) = Dimension(0, 0)
        override fun layoutContainer(parent: java.awt.Container) {
            if (parent.componentCount > 0) {
                val w = MIN_WIDTH.coerceAtLeast(parent.width)
                parent.getComponent(0).setBounds(0, 0, w, parent.height)
            }
        }
    }).apply {
        isOpaque = true
        minimumSize = Dimension(0, 0)
        add(composePanel)
    }
    
    val content = com.intellij.ui.content.ContentFactory.getInstance().createContent(wrapper, "", false)
    contentManager.addContent(content)
}
