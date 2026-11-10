package org.deveco.code.action

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.util.IconLoader
import com.intellij.ui.JBColor
import org.deveco.code.MyMessageBundle

/**
 * Submenu group in the editor's right-click context menu.
 * Contains child actions like "Quick Chat".
 */
class JumpToChatAction :
    DefaultActionGroup(),
    DumbAware {
    init {
        templatePresentation.text = MyMessageBundle.message("action.jumpToChat.text")
        templatePresentation.description = MyMessageBundle.message("action.jumpToChat.description")
    }

    override fun getChildren(event: AnActionEvent?): Array<AnAction> = arrayOf(QuickChatAction())

    override fun update(event: AnActionEvent) {
        val editor = event.getData(CommonDataKeys.EDITOR)
        event.presentation.isEnabledAndVisible = editor != null && editor.selectionModel.hasSelection()

        // 动态设置主题图标
        val bg = JBColor.background()
        val brightness = (bg.red * 0.299 + bg.green * 0.587 + bg.blue * 0.114) / 255.0
        val variant = if (brightness < 0.5) "dark" else "light"
        event.presentation.icon = IconLoader.getIcon("/icons/icon-$variant.svg", JumpToChatAction::class.java)
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
}
