package org.deveco.code.session.editor

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.impl.EditorWindow
import com.intellij.openapi.fileEditor.impl.EditorWindowHolder
import com.intellij.openapi.fileEditor.impl.FileEditorManagerImpl
import com.intellij.openapi.fileEditor.impl.FileEditorOpenOptions
import com.intellij.openapi.project.Project
import java.awt.Component

/**
 * EditorWindow owning an editor's Swing component: the platform wraps every editor in an
 * EditorWindowHolder (its tabbed container), so the first such ancestor is its window.
 */
internal fun editorWindowOf(editor: FileEditor): EditorWindow? {
    var component: Component? = editor.component
    while (component != null) {
        if (component is EditorWindowHolder) return component.editorWindow
        component = component.parent
    }
    return null
}

/**
 * Window hosting [editor]: its Swing ancestry while its tab is selected, otherwise the window
 * that still lists its file. The platform detaches the component of a background tab, so the
 * ancestry alone reports "no window" for every tab that is not in front.
 */
internal fun windowOf(project: Project, editor: FileEditor): EditorWindow? {
    editorWindowOf(editor)?.let { return it }
    val manager = FileEditorManager.getInstance(project) as? FileEditorManagerImpl ?: return null
    return manager.splitters.getWindows().firstOrNull { it.getComposite(editor.file) != null }
}

/**
 * Opens the chat as the first tab of the leftmost editor group, so a split view still
 * shows it in the group read first instead of the one that happens to hold focus.
 */
internal fun placeChatTabFirst(project: Project, file: SessionVirtualFile, focusEditor: Boolean) {
    val manager = FileEditorManager.getInstance(project) as? FileEditorManagerImpl ?: return
    // A null window opens in the focused group, which is the best fallback available.
    manager.openFile(file, leftmostWindow(manager), FileEditorOpenOptions(index = 0, requestFocus = focusEditor))
}

// Neither the Swing tree nor the creation order of the editor groups matches their visual
// order once the area is split, so "leftmost" is decided by the screen position of each
// group's tab container: smallest x wins, ties go to the smaller y (a vertical split).
private fun leftmostWindow(manager: FileEditorManagerImpl): EditorWindow? {
    val windows = manager.splitters.getWindows()
    val visible = windows.filter { it.isShowing }
    // Nothing is laid out yet (project opening); locationOnScreen throws for a component
    // that is not showing, so fall back to the creation order.
    if (visible.isEmpty()) return windows.firstOrNull()
    return visible.minByOrNull { it.tabOrigin() }
}

private fun EditorWindow.tabOrigin(): Long = with(tabbedPane.component.locationOnScreen) {
    // Tab containers of different groups never share x, so x dominates; y breaks a tie.
    x.toLong() * 100_000 + y
}

/**
 * Selects the chat tab where it already lives. The chat is a single tab, so a caller that
 * found an open editor must reveal that editor's group instead of opening a copy in the
 * focused split. The window's own manager is used because a chat docked into a separate
 * window belongs to a different FileEditorManagerImpl than the project's main one.
 */
internal fun revealChatTab(project: Project, file: SessionVirtualFile, editor: FileEditor, focusEditor: Boolean) {
    val window = windowOf(project, editor)
    if (window == null) {
        // The tab exists but belongs to a window we cannot reach (a dock window whose manager
        // is not the project's). Opening a copy in the main frame would create a second chat tab.
        Logger.getInstance("SessionEditorWindow").warn("chat-tab: no window for the chat editor, leaving the tab as is")
        return
    }
    window.manager.openFile(file, window, FileEditorOpenOptions(requestFocus = focusEditor))
}
