package org.deveco.code.action

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.project.DumbAware
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
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
}
