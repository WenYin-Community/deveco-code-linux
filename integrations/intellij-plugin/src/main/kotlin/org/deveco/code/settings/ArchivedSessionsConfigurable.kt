package org.deveco.code.settings

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionToolbar
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.IconLoader
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import org.deveco.code.MyMessageBundle
import org.deveco.code.acp.AcpClientService
import org.deveco.code.session.FavoriteRecord
import org.deveco.code.session.SESSION_REFRESH_TOPIC
import org.deveco.code.session.SessionControllerRegistry
import org.deveco.code.session.SessionStorage
import org.deveco.code.session.editor.SessionVirtualFile
import org.deveco.code.util.runInEdt
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Dimension
import java.awt.Font
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.Icon
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JSeparator
import javax.swing.JTable
import javax.swing.ListSelectionModel
import javax.swing.border.EmptyBorder
import javax.swing.table.AbstractTableModel
import javax.swing.table.TableCellRenderer

class ArchivedSessionsConfigurable(private val project: Project) : Configurable {
    private val log = Logger.getInstance(ArchivedSessionsConfigurable::class.java)
    private val tableModel = ArchivedTableModel()
    private val mainPanel: JPanel = JPanel(BorderLayout())
    private lateinit var toolbar: ActionToolbar
    private val pendingActions = mutableMapOf<String, PendingAction>()
    private val table: JTable = JTable(tableModel).apply {
        rowHeight = 28
        autoCreateRowSorter = true
        setShowGrid(false)
        intercellSpacing = Dimension(0, 0)
        // Stretch over the whole viewport so the area below the last row is
        // painted with the table background instead of showing the scroll
        // pane/panel background through (visible in light themes).
        fillsViewportHeight = true
        columnModel.getColumn(0).preferredWidth = 520
        columnModel.getColumn(0).cellRenderer = ArchivedCellRenderer()
        setSelectionMode(ListSelectionModel.MULTIPLE_INTERVAL_SELECTION)
        tableHeader.isVisible = false
    }
    private val emptyLabel = JBLabel(MyMessageBundle.message("archived.empty")).apply {
        foreground = JBColor.namedColor("Label.infoForeground", 0x6C707E)
        horizontalAlignment = JLabel.CENTER
        border = EmptyBorder(20, 0, 20, 0)
    }
    private val scrollPane = JScrollPane(table).apply { border = EmptyBorder(0, 0, 0, 0) }

    override fun getDisplayName(): String = MyMessageBundle.message("settings.archived.displayName")

    override fun createComponent(): JComponent {
        mainPanel.removeAll()
        val north = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
        }
        val titleLabel = JBLabel(MyMessageBundle.message("archived.title")).apply {
            font = font.deriveFont(Font.BOLD, 14f)
            border = EmptyBorder(0, 0, 2, 0)
            alignmentX = JPanel.LEFT_ALIGNMENT
        }
        val descLabel = JBLabel(MyMessageBundle.message("archived.description")).apply {
            foreground = JBColor.namedColor("Label.infoForeground", 0x6C707E)
            alignmentX = JPanel.LEFT_ALIGNMENT
        }
        val titleRow = JPanel(GridBagLayout()).apply {
            isOpaque = false
            alignmentX = JPanel.LEFT_ALIGNMENT
            val gbc = GridBagConstraints().apply {
                anchor = GridBagConstraints.CENTER
                fill = GridBagConstraints.NONE
                gridy = 0
                weightx = 0.0
                insets = Insets(0, 0, 0, 8)
            }
            gbc.gridx = 0
            add(titleLabel, gbc)
            gbc.fill = GridBagConstraints.HORIZONTAL
            gbc.weightx = 1.0
            gbc.insets = Insets(0, 0, 0, 0)
            gbc.gridx = 1
            add(JSeparator(), gbc)
        }
        north.add(titleRow)
        north.add(descLabel)
        north.add(Box.createVerticalStrut(4))
        mainPanel.add(north, BorderLayout.NORTH)

        val restoreAction =
            makeAction(::restoreIcon, "archived.restore", {
                table.selectedRowCount > 0
            }) { markPending(PendingAction.RESTORE) }
        val deleteAction =
            makeAction({ AllIcons.General.Remove }, "archived.delete", {
                table.selectedRowCount > 0
            }) { markPending(PendingAction.DELETE) }
        toolbar = ActionManager.getInstance().createActionToolbar(
            "archivedToolbar",
            DefaultActionGroup().apply {
                add(restoreAction)
                add(deleteAction)
            },
            true,
        )
        toolbar.targetComponent = mainPanel
        val toolbarPanel = JPanel(BorderLayout()).apply {
            isOpaque = true
            background = JBColor.namedColor("TableHeader.background", 0xF2F2F2)
            border = BorderFactory.createMatteBorder(0, 0, 1, 0, JBColor.border())
            // An opaque ActionToolbar paints its own Panel.background, which
            // shows as a differently-colored block beside the buttons.
            toolbar.component.isOpaque = false
            add(toolbar.component, BorderLayout.WEST)
        }
        val tablePanel = JPanel(BorderLayout()).apply {
            border = BorderFactory.createMatteBorder(1, 1, 1, 1, JBColor.border())
            add(toolbarPanel, BorderLayout.NORTH)
            add(scrollPane, BorderLayout.CENTER)
        }
        mainPanel.add(tablePanel, BorderLayout.CENTER)

        table.selectionModel.addListSelectionListener {
            ApplicationManager.getApplication().invokeLater { toolbar.updateActionsImmediately() }
        }
        reload()
        return mainPanel
    }

    private fun selectedRecords(): List<FavoriteRecord> = table.selectedRows.toList().mapNotNull { row ->
        tableModel.items.getOrNull(table.convertRowIndexToModel(row))
    }

    private fun markPending(action: PendingAction) {
        val records = selectedRecords()
        if (records.isEmpty()) return
        for (rec in records) pendingActions[rec.sessionId] = action
        tableModel.fireTableDataChanged()
    }

    override fun isModified(): Boolean = pendingActions.isNotEmpty()

    override fun apply() {
        val actions = pendingActions.toMap()
        pendingActions.clear()
        tableModel.fireTableDataChanged()
        if (actions.isEmpty()) return
        ApplicationManager.getApplication().executeOnPooledThread {
            for ((sessionId, action) in actions) {
                try {
                    when (action) {
                        PendingAction.RESTORE -> {
                            // Let unarchive failures propagate — the outer catch
                            // surfaces them and only updates local state on
                            // success below. Wrapping this in runCatching (the old
                            // code) swallowed network/5xx errors so the local
                            // archive record was removed even though the server
                            // was still archived, making the UI show "restored"
                            // while the session stayed unreachable.
                            project.getService(AcpClientService::class.java).unarchiveSession(sessionId)
                            SessionStorage.unarchive(project, sessionId)
                        }

                        PendingAction.DELETE -> {
                            project.getService(AcpClientService::class.java).deleteSession(sessionId)
                            SessionStorage.deleteLocalSession(project, sessionId)
                            closeEditor(sessionId)
                        }
                    }
                } catch (e: Exception) {
                    log.warn("apply failed for $sessionId ($action)", e)
                    if (e.message?.contains("404") == true) {
                        SessionStorage.deleteLocalSession(project, sessionId)
                        closeEditor(sessionId)
                    } else {
                        project.runInEdt {
                            Messages.showErrorDialog(
                                project,
                                MyMessageBundle.message("archived.apply.failed"),
                                MyMessageBundle.message("settings.archived.displayName"),
                            )
                        }
                    }
                }
            }
            publishRefresh()
            project.runInEdt { reload() }
        }
    }

    override fun reset() {
        pendingActions.clear()
        reload()
    }

    private fun closeEditor(sessionId: String) {
        project.runInEdt {
            val mgr = FileEditorManager.getInstance(project)
            mgr.openFiles.filterIsInstance<SessionVirtualFile>()
                .filter { it.sessionId == sessionId }
                .forEach { mgr.closeFile(it) }
            // Permanently deleted here; drop any cached controller so it is not re-attached.
            SessionControllerRegistry.getInstance(project).evict(sessionId)
        }
    }

    private fun publishRefresh() {
        project.messageBus.syncPublisher(SESSION_REFRESH_TOPIC).onSessionsChanged()
    }

    private fun reload() {
        val records = SessionStorage.archived(project).values
            .sortedByDescending { it.archivedAt ?: 0L }
        tableModel.items = records
        scrollPane.setViewportView(if (records.isEmpty()) emptyLabel else table)
        ApplicationManager.getApplication().invokeLater { toolbar.updateActionsImmediately() }
    }

    private fun makeAction(
        iconProvider: () -> Icon?,
        tooltipKey: String,
        enabledCheck: () -> Boolean,
        action: () -> Unit,
    ): AnAction = object : AnAction() {
        init {
            templatePresentation.icon = iconProvider()
            templatePresentation.text = MyMessageBundle.message(tooltipKey)
            templatePresentation.description = MyMessageBundle.message(tooltipKey)
        }
        override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
        override fun actionPerformed(e: AnActionEvent) = action()
        override fun update(e: AnActionEvent) {
            e.presentation.isEnabled = enabledCheck()
            // Re-resolved on every update so the icon follows dark/light theme switches.
            iconProvider()?.let { e.presentation.icon = it }
        }
    }

    // archived-restore-dark.svg is the design export as delivered (white glyph =
    // dark theme); the light twin differs only in the path fill color. Keep the
    // two files in sync when the design glyph changes.
    private fun restoreIcon(): Icon {
        val bg = JBColor.background()
        val brightness = (bg.red * 0.299 + bg.green * 0.587 + bg.blue * 0.114) / 255.0
        val variant = if (brightness < 0.5) "dark" else "light"
        return IconLoader.getIcon("/icons/archived-restore-$variant.svg", ArchivedSessionsConfigurable::class.java)
    }

    private class ArchivedTableModel : AbstractTableModel() {
        var items: List<FavoriteRecord> = emptyList()
        override fun getRowCount(): Int = items.size
        override fun getColumnCount(): Int = 1
        override fun getColumnName(c: Int): String = ""
        override fun getValueAt(r: Int, c: Int): Any = items[r]
    }

    private enum class PendingAction { RESTORE, DELETE }

    private inner class ArchivedCellRenderer :
        JPanel(GridBagLayout()),
        TableCellRenderer {
        private val titleLabel = JBLabel()
        private val timeLabel = JBLabel()
        private val pendingLabel = JBLabel()

        init {
            isOpaque = true
            border = EmptyBorder(2, 6, 2, 8)
            val gbc = GridBagConstraints().apply {
                anchor = GridBagConstraints.WEST
                fill = GridBagConstraints.NONE
                gridy = 0
                weightx = 0.0
            }
            gbc.gridx = 0
            add(titleLabel, gbc)
            gbc.gridx = 1
            add(Box.createHorizontalStrut(8), gbc)
            gbc.weightx = 1.0
            gbc.gridx = 2
            add(timeLabel, gbc)
            gbc.gridx = 3
            add(Box.createHorizontalStrut(10), gbc)
            gbc.weightx = 0.0
            gbc.gridx = 4
            add(pendingLabel, gbc)
        }

        override fun getTableCellRendererComponent(
            table: JTable,
            value: Any?,
            isSelected: Boolean,
            hasFocus: Boolean,
            row: Int,
            column: Int,
        ): Component {
            val rec = value as? FavoriteRecord ?: return this
            titleLabel.text = rec.title?.takeIf { it.isNotBlank() } ?: rec.sessionId
            timeLabel.text = formatTime(rec.updatedAt)
            val pending = pendingActions[rec.sessionId]
            pendingLabel.text = when (pending) {
                PendingAction.RESTORE -> MyMessageBundle.message("archived.pending.restore")
                PendingAction.DELETE -> MyMessageBundle.message("archived.pending.delete")
                null -> ""
            }
            if (isSelected) {
                background = table.selectionBackground
                titleLabel.foreground = table.selectionForeground
                timeLabel.foreground = table.selectionForeground
                pendingLabel.foreground = table.selectionForeground
            } else {
                background = table.background
                titleLabel.foreground = JBColor.foreground()
                timeLabel.foreground = JBColor.namedColor("Label.infoForeground", 0x6C707E)
                pendingLabel.foreground = if (pending == PendingAction.DELETE) {
                    JBColor.RED
                } else {
                    JBColor.namedColor("Label.infoForeground", 0x6C707E)
                }
            }
            return this
        }

        private fun formatTime(iso: String?): String {
            if (iso.isNullOrBlank()) return ""
            return try {
                val instant = java.time.Instant.parse(iso)
                java.time.LocalDateTime.ofInstant(instant, java.time.ZoneId.systemDefault())
                    .format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd"))
            } catch (_: Exception) {
                iso
            }
        }
    }
}
