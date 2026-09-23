package org.deveco.code.session.editor

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import org.deveco.code.session.editor.SessionFileEditor

class SessionFileEditorProvider :
    FileEditorProvider,
    DumbAware {
    override fun accept(project: Project, file: VirtualFile): Boolean = file is SessionVirtualFile

    override fun createEditor(project: Project, file: VirtualFile): FileEditor =
        SessionFileEditor(project, file as SessionVirtualFile)

    override fun getEditorTypeId(): String = "deveco-session-chat"

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}
