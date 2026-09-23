package org.deveco.code.action

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.editor.SessionFileEditor
import org.deveco.code.session.editor.SessionVirtualFile
import org.deveco.code.session.model.FileReference
import javax.swing.Icon

private const val MAX_SELECTION_LINES = 500

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
        var endLine = document.getLineNumber(selection.selectionEnd) + 1

        val lineCount = endLine - startLine + 1
        if (lineCount > MAX_SELECTION_LINES) {
            Messages.showInfoMessage(
                project,
                MyMessageBundle.message("action.jump.to.chat.truncated.message", lineCount, MAX_SELECTION_LINES),
                MyMessageBundle.message("action.jump.to.chat.truncated.title"),
            )
            endLine = startLine + MAX_SELECTION_LINES - 1
        }

        val fileRef = FileReference(
            path = virtualFile.path,
            startLine = startLine,
            endLine = endLine,
        )

        activateToolWindow(project)

        val mgr = FileEditorManager.getInstance(project)
        val existingFile = mgr.openFiles.filterIsInstance<SessionVirtualFile>().firstOrNull()
        val existingEditor = existingFile?.let { f ->
            mgr.getEditors(f).filterIsInstance<SessionFileEditor>().firstOrNull()
        }

        if (existingEditor != null && existingFile != null) {
            existingEditor.controller.addFileReference(fileRef)
            mgr.openFile(existingFile, true)
            return
        }

        val actions = DevEcoSessionActions.forProject(project)
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
