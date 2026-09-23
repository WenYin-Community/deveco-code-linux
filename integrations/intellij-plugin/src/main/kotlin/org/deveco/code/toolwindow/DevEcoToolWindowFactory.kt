package org.deveco.code.toolwindow

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Splitter
import com.intellij.openapi.ui.ThreeComponentsSplitter
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import java.awt.Component
import java.awt.Container
import java.awt.Dimension
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import java.awt.event.HierarchyEvent
import java.awt.event.HierarchyListener

private const val MIN_WIDTH = 300
private const val NO_MIN_HEIGHT = 0
private const val LOGGER_NAME = "DevEcoToolWindowMinWidth"

class DevEcoToolWindowFactory :
    ToolWindowFactory,
    DumbAware {
    override fun shouldBeAvailable(project: Project): Boolean = true

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        toolWindow.addDevEcoComposeTab(project)
        val content = toolWindow.contentManager.contents.firstOrNull() ?: return
        content.displayName = null
        val component = content.component
        component.minimumSize = Dimension(MIN_WIDTH, NO_MIN_HEIGHT)
        val enforcer = MinWidthEnforcer(component, MIN_WIDTH)
        component.addHierarchyListener(enforcer)
        component.addComponentListener(enforcer)
    }
}

private class MinWidthEnforcer(private val target: Component, private val minWidth: Int) :
    ComponentAdapter(),
    HierarchyListener {
    private val log = Logger.getInstance(LOGGER_NAME)
    private var reentering = false

    override fun hierarchyChanged(e: HierarchyEvent) {
        if ((e.changeFlags.toInt() and HierarchyEvent.PARENT_CHANGED) == 0) return
        enforce()
    }

    override fun componentResized(e: ComponentEvent) {
        if (reentering) return
        if (target.width >= minWidth) return
        enforce()
        snapBack()
    }

    private fun enforce() {
        var parent: Container? = target.parent ?: return
        while (parent != null) {
            when (parent) {
                is ThreeComponentsSplitter -> configureThreeComponents(parent)
                is Splitter -> configureSplitter(parent)
            }
            parent = parent.parent
        }
    }

    private fun configureThreeComponents(splitter: ThreeComponentsSplitter) {
        splitter.minSize = minWidth
        splitter.setHonorComponentsMinimumSize(true)
        toolWindowSide(splitter)?.minimumSize = Dimension(minWidth, NO_MIN_HEIGHT)
    }

    private fun configureSplitter(splitter: Splitter) {
        splitter.setHonorComponentsMinimumSize(true)
        splitterSide(splitter)?.minimumSize = Dimension(minWidth, NO_MIN_HEIGHT)
    }

    private fun splitterSide(splitter: Splitter): Component? {
        val first = splitter.firstComponent
        if (first?.isAncestorOf(target) == true) return first
        val second = splitter.secondComponent
        return second?.takeIf { it.isAncestorOf(target) }
    }

    private fun snapBack() {
        var parent: Container? = target.parent ?: return
        while (parent != null) {
            if (parent is ThreeComponentsSplitter && applySnapIfToolWindowSide(parent)) return
            parent = parent.parent
        }
    }

    private fun applySnapIfToolWindowSide(splitter: ThreeComponentsSplitter): Boolean {
        val side = toolWindowSide(splitter)
        val isFirst = side === splitter.firstComponent
        val isLast = side === splitter.lastComponent
        if (!isFirst && !isLast) return false
        reentering = true
        try {
            if (isFirst) splitter.firstSize = minWidth else splitter.lastSize = minWidth
            log.warn(
                "snapBack: width=${target.width} -> $minWidth, side=${if (isFirst) "first" else "last"}, splitter=${splitter.hashCode()}",
            )
        } finally {
            reentering = false
        }
        return true
    }

    private fun toolWindowSide(splitter: ThreeComponentsSplitter): Component? {
        val candidates = listOf(splitter.firstComponent, splitter.lastComponent, splitter.innerComponent)
        return candidates.firstOrNull { it != null && it.isAncestorOf(target) }
    }
}
