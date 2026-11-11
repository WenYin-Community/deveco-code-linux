package org.deveco.code.action

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.editor.SessionEditorRegistry
import org.deveco.code.session.editor.revealChatTab
import org.deveco.code.session.model.FileReference
import javax.swing.Icon

/**
 * Sends selected code to the currently open DevEco Code session tab,
 * or creates a new session if no tab is open.
 */
class QuickChatAction :
    AnAction(
        MyMessageBundle.message("action.quickChat.text"),
        MyMessageBundle.message("action.quickChat.description"),
        null as Icon?,
    ),
    DumbAware {
    private val log = Logger.getInstance(QuickChatAction::class.java)

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val editor = event.getData(CommonDataKeys.EDITOR) ?: return
        val virtualFile = event.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        if (!editor.selectionModel.hasSelection()) return

        val selection = editor.selectionModel
        val document = editor.document
        val startLine = document.getLineNumber(selection.selectionStart) + 1
        val endLine = document.getLineNumber(selection.selectionEnd) + 1

        val fileRef = FileReference(
            path = virtualFile.path,
            startLine = startLine,
            endLine = endLine,
        )

        activateToolWindow(project)

        val existingEditor = SessionEditorRegistry.getInstance(project).chatEditor()
        if (existingEditor != null) {
            existingEditor.controller.addFileReference(fileRef)
            revealChatTab(project, existingEditor.sessionFile, existingEditor, focusEditor = true)
            return
        }

        val actions = DevEcoSessionActions.forProject(project)
        // The handoff addresses whichever editor the new session's open constructs —
        // clearing any stale key so it cannot be pinned to an unrelated session.
        actions.pendingSessionId = null
        actions.pendingFileReference = fileRef
        val handler = actions.newSessionHandler
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

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    private fun activateToolWindow(project: Project) {
        runCatching {
            ToolWindowManager.getInstance(project).getToolWindow("DevEco Code")?.activate(null)
        }.onFailure { log.warn("Failed to activate DevEco Code tool window", it) }
    }
}
