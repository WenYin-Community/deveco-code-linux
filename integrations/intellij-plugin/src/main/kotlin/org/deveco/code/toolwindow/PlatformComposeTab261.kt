package org.deveco.code.toolwindow

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.ui.components.JBLabel
import com.intellij.util.concurrency.AppExecutorUtil
import org.deveco.code.MyMessageBundle
import org.deveco.code.action.DevEcoSessionActions
import org.deveco.code.sessions.DevEcoSessions
import org.jetbrains.jewel.bridge.JewelComposePanel
import java.awt.Dimension
import java.awt.LayoutManager
import java.util.concurrent.CompletableFuture
import javax.swing.JPanel
import javax.swing.SwingConstants

private const val MIN_WIDTH = 420
private val log = Logger.getInstance(DevEcoToolWindowFactory::class.java)

internal fun ToolWindow.addDevEcoComposeTab(project: Project) {
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
        add(JBLabel(MyMessageBundle.message("toolwindow.deveco.status.loading"), SwingConstants.CENTER))
    }

    val content = com.intellij.ui.content.ContentFactory.getInstance().createContent(wrapper, "", false)
    contentManager.addContent(content)

    // AuthenticatedDevEcoSessions resolves this project service during composition.
    // Initialize it (and its lazy SessionOps) off the EDT so the first composition
    // does not block on service startup and plugin class loading.
    val servicePreload = CompletableFuture.runAsync(
        {
            DevEcoSessionActions.forProject(project).ops
            Unit
        },
        AppExecutorUtil.getAppExecutorService(),
    )

    servicePreload.whenComplete { _, failure ->
        if (failure != null) {
            log.warn("Tool window preload failed", failure)
        }
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed || !content.isValid) return@invokeLater
            wrapper.removeAll()
            wrapper.add(JewelComposePanel { DevEcoSessions(project) })
            wrapper.revalidate()
            wrapper.repaint()
        }
    }
}
