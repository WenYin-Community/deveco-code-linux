package org.deveco.code.sessions.ui

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import org.deveco.code.MyMessageBundle
import java.awt.BorderLayout
import java.awt.KeyboardFocusManager
import java.awt.MouseInfo
import java.awt.Point
import java.awt.Window
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextField
import javax.swing.SwingUtilities
import javax.swing.event.PopupMenuEvent
import javax.swing.event.PopupMenuListener

internal fun isEmptyConversation(title: String?): Boolean =
    title.isNullOrBlank() || title.startsWith("New session", ignoreCase = true)

internal data class SessionContextActions(
    val onRename: () -> Unit,
    val onStopAndDelete: () -> Unit,
    val onDelete: () -> Unit,
    val onArchive: () -> Unit,
    val onToggleFavorite: () -> Unit,
)

internal fun showNativeSessionContextMenu(
    isRunning: Boolean,
    favorite: Boolean,
    isEmpty: Boolean,
    actions: SessionContextActions,
    onDismiss: () -> Unit,
) {
    val group = DefaultActionGroup().apply {
        if (isEmpty) {
            add(SimpleAction(MyMessageBundle.message("session.menu.delete"), actions.onDelete))
        } else {
            add(SimpleAction(MyMessageBundle.message("session.menu.rename"), actions.onRename))
            add(
                SimpleAction(
                    if (favorite) {
                        MyMessageBundle.message("session.menu.unfavorite")
                    } else {
                        MyMessageBundle.message("session.menu.favorite")
                    },
                    actions.onToggleFavorite,
                ),
            )
            add(
                SimpleAction(
                    if (isRunning) {
                        MyMessageBundle.message("session.menu.stopAndDelete")
                    } else {
                        MyMessageBundle.message("session.menu.archive")
                    },
                    if (isRunning) actions.onStopAndDelete else actions.onArchive,
                ),
            )
        }
    }
    ApplicationManager.getApplication().invokeLater {
        val invoker = currentInvoker() ?: return@invokeLater
        val screenPoint = MouseInfo.getPointerInfo()?.location ?: return@invokeLater
        val relative = Point(screenPoint)
        SwingUtilities.convertPointFromScreen(relative, invoker)
        val popup = ActionManager.getInstance().createActionPopupMenu(ActionPlaces.EDITOR_POPUP, group)
        var dismissed = false
        val fireDismiss = {
            if (!dismissed) {
                dismissed = true
                onDismiss()
            }
        }
        popup.component.addPopupMenuListener(object : PopupMenuListener {
            override fun popupMenuWillBecomeVisible(e: PopupMenuEvent) {}
            override fun popupMenuWillBecomeInvisible(e: PopupMenuEvent) = fireDismiss()
            override fun popupMenuCanceled(e: PopupMenuEvent) = fireDismiss()
        })
        popup.component.show(invoker, relative.x, relative.y)
    }
}

internal fun showRenameDialog(
    project: Project,
    currentTitle: String?,
    hoverColor: java.awt.Color,
    onConfirm: (String) -> Unit,
) {
    ApplicationManager.getApplication().invokeLater {
        val dialog = object : DialogWrapper(project) {
            private val field = JTextField(currentTitle ?: "").apply {
                columns = 32
                selectionColor = hoverColor
                val lum = (0.299 * hoverColor.red + 0.587 * hoverColor.green + 0.114 * hoverColor.blue) / 255.0
                selectedTextColor = if (lum > 0.5) java.awt.Color.BLACK else java.awt.Color.WHITE
                addFocusListener(object : java.awt.event.FocusAdapter() {
                    override fun focusGained(e: java.awt.event.FocusEvent) = selectAll()
                })
            }
            init {
                title = MyMessageBundle.message("session.rename.title")
                setOKButtonText(MyMessageBundle.message("session.rename.ok"))
                setCancelButtonText(MyMessageBundle.message("session.rename.cancel"))
                init()
                field.selectAll()
                setOKActionEnabled(field.text.trim().isNotEmpty())
                field.document.addDocumentListener(object : javax.swing.event.DocumentListener {
                    override fun insertUpdate(e: javax.swing.event.DocumentEvent) = updateOkEnabled()
                    override fun removeUpdate(e: javax.swing.event.DocumentEvent) = updateOkEnabled()
                    override fun changedUpdate(e: javax.swing.event.DocumentEvent) = updateOkEnabled()
                    private fun updateOkEnabled() {
                        setOKActionEnabled(field.text.trim().isNotEmpty())
                    }
                })
            }
            override fun createCenterPanel(): JComponent = JPanel(BorderLayout()).apply {
                isOpaque = false
                border = javax.swing.border.EmptyBorder(16, 16, 16, 16)
                add(field, BorderLayout.CENTER)
            }
            override fun getPreferredFocusedComponent(): JComponent = field
            override fun doOKAction() {
                val text = field.text.trim()
                if (text.isNotEmpty()) {
                    onConfirm(text)
                    close(OK_EXIT_CODE)
                }
            }
        }
        dialog.show()
    }
}

private fun currentInvoker(): java.awt.Component? {
    val focusOwner = KeyboardFocusManager.getCurrentKeyboardFocusManager().focusOwner
    if (focusOwner != null && focusOwner.isShowing) return focusOwner
    val windows = Window.getWindows()
    return windows.firstOrNull { it.isShowing }?.let { root ->
        SwingUtilities.getRootPane(root) ?: root
    }
}

private class SimpleAction(text: String, private val perform: () -> Unit) : AnAction() {
    init {
        templatePresentation.text = text
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun actionPerformed(e: AnActionEvent) = perform()
}
