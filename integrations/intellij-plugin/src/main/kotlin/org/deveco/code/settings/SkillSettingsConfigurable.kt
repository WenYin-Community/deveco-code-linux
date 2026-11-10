package org.deveco.code.settings

import com.intellij.icons.AllIcons
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionToolbar
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import org.deveco.code.MyMessageBundle
import org.deveco.code.skill.ImportOutcome
import org.deveco.code.skill.SkillEntry
import org.deveco.code.skill.SkillStore
import org.deveco.code.skill.SkillType
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Dimension
import java.awt.Font
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.awt.event.MouseMotionAdapter
import java.nio.file.Files
import java.nio.file.Path
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.Icon
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTable
import javax.swing.ListSelectionModel
import javax.swing.border.EmptyBorder
import javax.swing.table.AbstractTableModel
import javax.swing.table.TableCellRenderer

class SkillSettingsConfigurable(private val project: com.intellij.openapi.project.Project) : Configurable {
    private val log = Logger.getInstance(SkillSettingsConfigurable::class.java)
    private var sections: List<SkillSectionPanel> = emptyList()
    private val mainPanel: JPanel = JPanel().apply { layout = BoxLayout(this, BoxLayout.Y_AXIS) }

    private var originalSkills: List<SkillEntry> = emptyList()
    private var currentSkills: MutableList<SkillEntry> = mutableListOf()

    override fun getDisplayName(): String = MyMessageBundle.message("settings.skill.displayName")

    override fun createComponent(): JComponent {
        mainPanel.removeAll()
        sections = listOf(SkillType.GLOBAL, SkillType.PROJECT).map { SkillSectionPanel(it) }
        var first = true
        for (section in sections) {
            if (!first) mainPanel.add(Box.createVerticalStrut(14))
            first = false
            mainPanel.add(section.component)
        }
        mainPanel.add(Box.createVerticalGlue())
        reload()
        return mainPanel
    }

    override fun isModified(): Boolean {
        if (originalSkills.size != currentSkills.size) return true
        val origMap = originalSkills.associateBy { "${it.type}.${it.name}" }
        for (cur in currentSkills) {
            val key = "${cur.type}.${cur.name}"
            val orig = origMap[key]
            if (orig == null) return true
            if (orig.enabled != cur.enabled) return true
        }
        return false
    }

    override fun apply() {
        val errors = mutableListOf<Pair<String, String>>()
        val currentSnapshot = currentSkills.toList()
        ApplicationManager.getApplication().executeOnPooledThread {
            val currentKeys = currentSnapshot.map { "${it.type}.${it.name}" }.toSet()
            val originalKeys = originalSkills.map { "${it.type}.${it.name}" }.toSet()
            val appliedKeys = (originalKeys intersect currentKeys).toMutableSet()
            var structuralChange = false

            // Delete removed rows (skip individual refresh — batch at the end).
            for (entry in originalSkills) {
                val key = "${entry.type}.${entry.name}"
                if (key !in currentKeys) {
                    SkillStore.delete(entry, project, refresh = false)
                    appliedKeys.remove(key)
                    structuralChange = true
                }
            }
            // Import new rows (skip individual refresh).
            for (entry in currentSnapshot) {
                val key = "${entry.type}.${entry.name}"
                if (key !in originalKeys) {
                    val result = SkillStore.importSkill(entry.skillMdPath, entry.type, project, refresh = false)
                    if (result.outcome == ImportOutcome.SUCCESS) {
                        appliedKeys.add(key)
                        structuralChange = true
                    } else {
                        errors.add(MyMessageBundle.message("skill.import.title", entry.name) to result.message)
                    }
                }
            }
            // Only refresh the instance when skills were added/removed —
            // refreshInstance disposes the backend and triggers an async
            // re-scan. Calling it for pure enabled-state changes would send
            // the PATCH before the backend re-discovers the skill (HTTP 404).
            val service = project.getService(org.deveco.code.acp.AcpClientService::class.java)
            if (structuralChange) {
                val refreshed = runCatching { service.refreshInstance() }
                    .onFailure { log.warn("Instance refresh failed after apply", it) }
                    .isSuccess
                if (refreshed) {
                    // refreshInstance only disposes the project instance; the
                    // backend re-scans skills lazily on the next /skill read.
                    // PATCH /skill/:name 404s against a half-scanned instance,
                    // and setEnabled swallows that 404 — so without this wait
                    // the backend preference used to diverge permanently from
                    // local UI state whenever a structural change coincided
                    // with an enabled toggle. Poll /skill until the (name,
                    // scope) set settles, so the toggles' PATCHes land against
                    // rediscovered skills and succeed.
                    runCatching { SkillStore.stableSkillEntries(service) }
                        .onFailure { log.warn("Skill re-discovery poll failed after refresh", it) }
                }
            }
            // Only PATCH rows whose enabled state actually changed. The local
            // state write in setEnabled is instant and reliable; the backend
            // PATCH now lands after re-discovery (above) so it no longer 404s.
            for (entry in currentSnapshot) {
                val key = "${entry.type}.${entry.name}"
                if (key !in appliedKeys) continue
                val orig = originalSkills.find { "${it.type}.${it.name}" == key }
                val origEnabled = orig?.enabled ?: true
                if (origEnabled != entry.enabled) {
                    SkillStore.setEnabled(entry.name, entry.type, entry.enabled, project)
                }
            }
            // Single broadcast for all changes.
            SkillStore.notifyChanged(project)
            originalSkills = currentSnapshot.filter { "${it.type}.${it.name}" in appliedKeys }
        }.get()

        for ((title, message) in errors) {
            Messages.showMessageDialog(message, title, Messages.getErrorIcon())
        }
        reload()
    }

    override fun reset() {
        reload()
    }

    private fun reload() {
        // listAll hits the DevEco Code HTTP endpoint, so run it off-EDT and
        // refresh the table on EDT to avoid freezing the Settings dialog.
        ApplicationManager.getApplication().executeOnPooledThread {
            val loaded = runCatching { SkillStore.listAll(project) }.getOrElse { emptyList() }
            ApplicationManager.getApplication().invokeLater {
                // Preserve rows that aren't on disk yet (e.g. a just-failed
                // import) so the user can retry on the same row instead of
                // re-picking the source via the file chooser. skillMdPath is
                // the picked source for pending imports but the installed
                // SKILL.md for rows loaded by an earlier reload — without the
                // existence check a skill whose folder was deleted manually
                // would resurrect as a "pending" row on every reset/apply.
                val loadedKeys = loaded.map { "${it.type}.${it.name}" }.toSet()
                val pending = currentSkills.filter {
                    "${it.type}.${it.name}" !in loadedKeys && Files.exists(it.skillMdPath)
                }
                val merged = loaded + pending
                originalSkills = loaded
                currentSkills = merged.toMutableList()
                for (section in sections) section.refresh(currentSkills)
            }
        }
    }

    private fun refreshSections() {
        for (section in sections) section.refresh(currentSkills)
    }

    private inner class SkillSectionPanel(val type: SkillType) {
        private val model = SkillTableModel(type)
        private val table: JTable
        private lateinit var toolbar: ActionToolbar
        val component: JComponent

        init {
            table = JTable(model).apply {
                rowHeight = SKILL_TABLE_ROW_HEIGHT
                autoCreateRowSorter = true
                setShowGrid(false)
                intercellSpacing = Dimension(0, 0)
                // Stretch over the whole viewport so the area below the last row
                // is painted with the table background instead of showing the
                // scroll pane/panel background through (visible in light themes).
                fillsViewportHeight = true
                columnModel.getColumn(0).cellRenderer = CheckboxRenderer()
                columnModel.getColumn(0).preferredWidth = SKILL_ICON_COLUMN_PREF_WIDTH
                columnModel.getColumn(0).minWidth = SKILL_ICON_COLUMN_MIN_WIDTH
                columnModel.getColumn(0).maxWidth = SKILL_ICON_COLUMN_MAX_WIDTH
                columnModel.getColumn(1).cellRenderer = SkillInfoRenderer()
                columnModel.getColumn(1).preferredWidth = SKILL_NAME_COLUMN_WIDTH
                setSelectionMode(ListSelectionModel.MULTIPLE_INTERVAL_SELECTION)
                tableHeader.isVisible = false
                preferredScrollableViewportSize =
                    Dimension(SKILL_TABLE_VIEWPORT_WIDTH, SKILL_TABLE_VISIBLE_ROWS * SKILL_TABLE_ROW_HEIGHT)
            }

            val importAction = makeAction(AllIcons.General.Add, "skill.tooltip.import", { true }) { importSkill() }
            val deleteAction =
                makeAction(AllIcons.General.Remove, "skill.tooltip.delete", {
                    table.selectedRowCount > 0
                }) { deleteSelected() }

            val actionGroup = DefaultActionGroup().apply {
                add(importAction)
                add(deleteAction)
            }
            toolbar = ActionManager.getInstance().createActionToolbar(
                "skillToolbar_${type.name}",
                actionGroup,
                true,
            )

            table.selectionModel.addListSelectionListener {
                ApplicationManager.getApplication().invokeLater { toolbar.updateActionsImmediately() }
            }

            attachHoverTracking(table)

            component = buildPanel()
        }

        fun refresh(all: List<SkillEntry>) {
            model.items = all.filter { it.type == type }
            ApplicationManager.getApplication().invokeLater { toolbar.updateActionsImmediately() }
        }

        private fun buildPanel(): JComponent {
            val panel = JPanel(BorderLayout())
            val north = JPanel().apply { layout = BoxLayout(this, BoxLayout.Y_AXIS) }
            val titleLabel = JBLabel(MyMessageBundle.message(type.sectionKey)).apply {
                font = font.deriveFont(Font.BOLD, 14f)
                border = EmptyBorder(0, 0, 2, 0)
                alignmentX = JPanel.LEFT_ALIGNMENT
            }
            val descLabel = JBLabel(MyMessageBundle.message(type.descriptionKey)).apply {
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
                    insets = java.awt.Insets(0, 0, 0, 8)
                }
                gbc.gridx = 0
                add(titleLabel, gbc)
                gbc.fill = GridBagConstraints.HORIZONTAL
                gbc.weightx = 1.0
                gbc.insets = java.awt.Insets(0, 0, 0, 0)
                gbc.gridx = 1
                add(javax.swing.JSeparator(), gbc)
            }
            north.add(titleRow)
            north.add(descLabel)
            north.add(Box.createVerticalStrut(4))
            panel.add(north, BorderLayout.NORTH)

            toolbar.targetComponent = panel
            val tablePanel = JPanel(BorderLayout()).apply {
                border = javax.swing.BorderFactory.createMatteBorder(1, 1, 1, 1, JBColor.border())
            }
            val toolbarPanel = JPanel(BorderLayout()).apply {
                isOpaque = true
                background = JBColor.namedColor("TableHeader.background", 0xF2F2F2)
                border = javax.swing.BorderFactory.createMatteBorder(0, 0, 1, 0, JBColor.border())
                // An opaque ActionToolbar paints its own Panel.background, which
                // shows as a differently-colored block beside the buttons.
                toolbar.component.isOpaque = false
                add(toolbar.component, BorderLayout.WEST)
            }
            val scrollPane = JScrollPane(table).apply {
                border = EmptyBorder(0, 0, 0, 0)
            }
            val emptyLabel = JBLabel(MyMessageBundle.message("skill.empty")).apply {
                foreground = JBColor.namedColor("Label.infoForeground", 0x6C707E)
                horizontalAlignment = JLabel.CENTER
                border = EmptyBorder(20, 0, 20, 0)
            }
            tablePanel.add(toolbarPanel, BorderLayout.NORTH)
            tablePanel.add(scrollPane, BorderLayout.CENTER)
            panel.add(tablePanel, BorderLayout.CENTER)

            model.addTableModelListener {
                scrollPane.setViewportView(if (model.items.isEmpty()) emptyLabel else table)
            }
            scrollPane.setViewportView(if (model.items.isEmpty()) emptyLabel else table)

            return panel
        }

        private fun selectedEntries(): List<SkillEntry> = table.selectedRows.toList().mapNotNull { row ->
            model.items.getOrNull(table.convertRowIndexToModel(row))
        }

        private fun importSkill() {
            val typeName = MyMessageBundle.message(type.sectionKey)
            // chooseJars/chooseJarsAsFiles must be set for .zip sources to be
            // visible and returned as a plain file on IDE 243, whose descriptor
            // hides archives unless one of them is set. On 261 both flags fold
            // into chooseFiles, so behavior there is unchanged.
            val descriptor = FileChooserDescriptor(true, true, true, true, false, false).apply {
                title = MyMessageBundle.message("skill.import.title", typeName)
                description = "Choose a Skill folder or .zip archive containing exactly one SKILL.md"
            }
            val initialFile = lastImportDir()
                ?: project.basePath?.let { LocalFileSystem.getInstance().findFileByPath(it) }
                ?: LocalFileSystem.getInstance().findFileByPath(System.getProperty("user.home"))
            val virtualFile = FileChooser.chooseFile(descriptor, project, initialFile) ?: return
            rememberImportDir(virtualFile)

            val name = virtualFile.name
            val isDir = virtualFile.isDirectory
            val isZip = name.endsWith(".zip", ignoreCase = true)
            if (!isDir && !isZip) {
                Messages.showMessageDialog(
                    "Please choose a Skill folder or .zip archive containing exactly one SKILL.md",
                    MyMessageBundle.message("skill.import.title", typeName),
                    Messages.getWarningIcon(),
                )
                return
            }

            val sourcePath = Path.of(virtualFile.path)
            // Validate synchronously at selection time so the row is added (and
            // Apply becomes enabled) the moment the chooser closes; a bad source
            // shows an error dialog now and never enters the list. The actual
            // install is deferred to Apply.
            val preview = try {
                org.deveco.code.skill.SkillInstaller.preview(sourcePath)
            } catch (e: org.deveco.code.skill.SkillInstaller.SkillImportException) {
                Messages.showMessageDialog(
                    e.message,
                    MyMessageBundle.message("skill.import.title", typeName),
                    Messages.getErrorIcon(),
                )
                return
            } catch (e: Exception) {
                Messages.showMessageDialog(
                    e.message ?: e.javaClass.simpleName,
                    MyMessageBundle.message("skill.import.title", typeName),
                    Messages.getErrorIcon(),
                )
                return
            }
            // Within-scope duplicate check at selection time: reject if a skill
            // with this name already exists in the SAME scope — either a row
            // already in the table, or one already on disk (checked
            // synchronously so we don't miss it when the async reload hasn't
            // finished). Cross-scope same-name is allowed.
            if (currentSkills.any { it.type == type && it.name == preview.name } ||
                SkillStore.targetExists(preview.name, type, project)
            ) {
                Messages.showMessageDialog(
                    MyMessageBundle.message("skill.import.duplicate"),
                    MyMessageBundle.message("skill.import.title", typeName),
                    Messages.getWarningIcon(),
                )
                return
            }
            currentSkills.add(SkillEntry(preview.name, sourcePath, type, true, preview.description))
            refreshSections()
        }

        // The original code always started at project.basePath, ignoring where
        // the user browsed to last time. The platform's built-in last-opened-
        // file store is shared across every IDE file chooser and ignored by
        // 261's native dialog, so we keep a dedicated per-import memory.
        private fun lastImportDir(): VirtualFile? {
            val path = PropertiesComponent.getInstance(project).getValue(LAST_IMPORT_DIR_KEY) ?: return null
            return LocalFileSystem.getInstance().findFileByPath(path)
        }

        // Record at selection time, not on successful import: after a rejected
        // pick the user most likely continues browsing the same directory.
        private fun rememberImportDir(file: VirtualFile) {
            val dir = if (file.isDirectory) file else file.parent
            if (dir != null && dir.isValid) {
                PropertiesComponent.getInstance(project).setValue(LAST_IMPORT_DIR_KEY, dir.path)
            }
        }

        private fun deleteSelected() {
            val entries = selectedEntries()
            if (entries.isEmpty()) return
            val names = entries.joinToString(", ") { it.name }
            val confirmed = Messages.showYesNoDialog(
                MyMessageBundle.message("skill.delete.confirm", names),
                MyMessageBundle.message("skill.delete.title"),
                Messages.getQuestionIcon(),
            )
            if (confirmed == Messages.YES) {
                currentSkills.removeAll(entries)
                refreshSections()
            }
        }
    }

    private inner class SkillTableModel(val type: SkillType) : AbstractTableModel() {
        var items: List<SkillEntry> = emptyList()
            set(value) {
                field = value
                fireTableDataChanged()
            }

        override fun getRowCount(): Int = items.size
        override fun getColumnCount(): Int = 2
        override fun getColumnName(column: Int): String = ""

        override fun getValueAt(row: Int, col: Int): Any = when (col) {
            0 -> items[row].enabled
            1 -> items[row]
            else -> ""
        }

        override fun getColumnClass(col: Int): Class<*> = when (col) {
            0 -> java.lang.Boolean::class.java
            else -> Any::class.java
        }

        override fun isCellEditable(row: Int, col: Int): Boolean = col == 0

        override fun setValueAt(value: Any?, row: Int, col: Int) {
            if (col == 0 && value is Boolean) {
                val entry = items[row]
                val key = "${entry.type}.${entry.name}"
                val idx = currentSkills.indexOfFirst { "${it.type}.${it.name}" == key }
                if (idx >= 0) {
                    currentSkills[idx] = currentSkills[idx].copy(enabled = value)
                }
                items = items.mapIndexed { i, e -> if (i == row) e.copy(enabled = value) else e }
                fireTableRowsUpdated(row, row)
            }
        }
    }

    private class CheckboxRenderer :
        JPanel(BorderLayout()),
        TableCellRenderer {
        private val cb = javax.swing.JCheckBox().apply { isOpaque = false }

        init {
            isOpaque = true
            border = EmptyBorder(0, 8, 0, 0)
            add(cb, BorderLayout.EAST)
        }

        override fun getTableCellRendererComponent(
            table: JTable,
            value: Any?,
            isSelected: Boolean,
            hasFocus: Boolean,
            row: Int,
            column: Int,
        ): Component {
            cb.isSelected = value as? Boolean ?: false
            background = rowBackground(table, row, isSelected)
            cb.background = background
            return this
        }
    }

    private class SkillInfoRenderer :
        JPanel(GridBagLayout()),
        TableCellRenderer {
        private val nameLabel = JBLabel()
        private val descLabel = JBLabel()

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
            add(nameLabel, gbc)
            gbc.gridx = 1
            add(Box.createHorizontalStrut(8), gbc)
            gbc.weightx = 1.0
            gbc.gridx = 2
            add(descLabel, gbc)
        }

        override fun getTableCellRendererComponent(
            table: JTable,
            value: Any?,
            isSelected: Boolean,
            hasFocus: Boolean,
            row: Int,
            column: Int,
        ): Component {
            val entry = value as? SkillEntry ?: return this
            nameLabel.text = entry.name
            // Tooltip shows the on-disk SKILL.md location (the DevEco-Code-reported
            // installed path after reload), so users can see where it was stored.
            nameLabel.toolTipText = entry.skillMdPath.toString().ifBlank { entry.name }
            nameLabel.font = nameLabel.font.deriveFont(Font.BOLD)
            val desc = entry.description
            descLabel.text = if (desc.length > MAX_DESC_PREVIEW_LEN) desc.take(MAX_DESC_PREVIEW_LEN) + "..." else desc
            descLabel.toolTipText = desc
            if (isSelected) {
                background = table.selectionBackground
                nameLabel.foreground = table.selectionForeground
                descLabel.foreground = table.selectionForeground
            } else {
                background = rowBackground(table, row, isSelected)
                val enabled = entry.enabled
                nameLabel.foreground = if (enabled) {
                    JBColor.foreground()
                } else {
                    JBColor.namedColor("Label.disabledForeground", 0x999999)
                }
                descLabel.foreground = if (enabled) {
                    JBColor.namedColor("Label.infoForeground", 0x6C707E)
                } else {
                    JBColor.namedColor("Label.disabledForeground", 0x999999)
                }
            }
            return this
        }
    }

    private fun attachHoverTracking(table: JTable) {
        table.addMouseMotionListener(object : MouseMotionAdapter() {
            override fun mouseMoved(e: MouseEvent) {
                val row = table.rowAtPoint(e.point)
                val prev = table.getClientProperty("hoveredRow") as? Int ?: -1
                if (row != prev) {
                    table.putClientProperty("hoveredRow", row)
                    table.repaint()
                }
            }
        })
        table.addMouseListener(object : MouseAdapter() {
            override fun mouseExited(e: MouseEvent) {
                table.putClientProperty("hoveredRow", -1)
                table.repaint()
            }
        })
    }

    companion object {
        private const val LAST_IMPORT_DIR_KEY = "deveco.code.skill.import.lastDir"

        private const val SKILL_TABLE_ROW_HEIGHT = 28
        private const val SKILL_TABLE_VISIBLE_ROWS = 5
        private const val MAX_DESC_PREVIEW_LEN = 60
        private const val SKILL_ICON_COLUMN_PREF_WIDTH = 24
        private const val SKILL_ICON_COLUMN_MIN_WIDTH = 22
        private const val SKILL_ICON_COLUMN_MAX_WIDTH = 26
        private const val SKILL_NAME_COLUMN_WIDTH = 400
        private const val SKILL_TABLE_VIEWPORT_WIDTH = 600

        private fun rowBackground(table: JTable, row: Int, isSelected: Boolean): java.awt.Color {
            val hoveredRow = table.getClientProperty("hoveredRow") as? Int ?: -1
            return when {
                isSelected -> table.selectionBackground

                // Dark-aware fallback: classic dark themes define no
                // Table.hoverBackground key, so a light-only default would leak
                // a light blue hover into dark UI. Values mirror JBUI's
                // DefaultRendererHoverBackground pair.
                row == hoveredRow -> JBColor.namedColor("Table.hoverBackground", JBColor(0xEDF5FC, 0x464A4D))

                else -> table.background
            }
        }

        private fun makeAction(
            icon: Icon?,
            tooltipKey: String,
            enabledCheck: () -> Boolean,
            action: () -> Unit,
        ): AnAction = object : AnAction() {
            init {
                if (icon != null) templatePresentation.icon = icon
                templatePresentation.text = MyMessageBundle.message(tooltipKey)
                templatePresentation.description = MyMessageBundle.message(tooltipKey)
            }
            override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
            override fun actionPerformed(e: AnActionEvent) = action()
            override fun update(e: AnActionEvent) {
                e.presentation.isEnabled = enabledCheck()
            }
        }
    }
}
