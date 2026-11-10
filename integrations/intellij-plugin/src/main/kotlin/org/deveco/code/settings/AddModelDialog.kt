package org.deveco.code.settings

import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.CheckBoxList
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.JBColor
import com.intellij.ui.SearchTextField
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.ThreeStateCheckBox
import com.intellij.util.ui.UIUtil
import org.deveco.code.MyMessageBundle
import org.deveco.code.acp.AcpClientService
import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.session.SessionModelStore
import java.awt.BorderLayout
import java.awt.CardLayout
import java.awt.Color
import java.awt.Component
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.GridBagLayout
import java.awt.GridLayout
import java.awt.Font
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.Insets
import java.awt.Point
import java.awt.RenderingHints
import java.awt.event.InputEvent
import java.awt.event.ItemEvent
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.awt.geom.Path2D
import java.awt.geom.RoundRectangle2D
import java.net.URI
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.ListCellRenderer
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
import javax.swing.border.EmptyBorder
import javax.swing.event.DocumentEvent

internal sealed class AddModelResult {
    internal data class ConnectExisting(
        val providerId: String,
        val providerName: String,
        val apiKey: String?,
        val models: List<DevEcoHttpApi.ProviderModelInfo>,
        val toDelete: List<DevEcoHttpApi.ProviderModelInfo> = emptyList(),
        val unselectedModels: List<DevEcoHttpApi.ProviderModelInfo> = emptyList(),
        val allModels: List<DevEcoHttpApi.ProviderModelInfo> = emptyList(),
        val disconnected: Boolean = false,
    ) : AddModelResult()
    internal data class AddCustom(val provider: DevEcoHttpApi.CustomProvider) : AddModelResult()
}

// Protocols offered for manually added providers. The npm id is written into
// the provider definition's `npm` field; the backend resolves it through its
// bundled SDK registry (BUNDLED_PROVIDERS in provider.ts), so extending this
// list needs no backend change as long as the SDK ships with the CLI.
internal enum class ModelProtocol(val npm: String, private val labelKey: String) {
    OPENAI_COMPATIBLE("@ai-sdk/openai-compatible", "settings.models.dialog.protocol.openaiCompatible"),
    OPENAI("@ai-sdk/openai", "settings.models.dialog.protocol.openai"),
    ANTHROPIC("@ai-sdk/anthropic", "settings.models.dialog.protocol.anthropic"),
    ;

    override fun toString(): String = MyMessageBundle.message(labelKey)
}

// Combo item for the protocol dropdown. Known protocols map to ModelProtocol;
// Preserved wraps an npm id from the stored provider definition that is not
// one of the known protocols (e.g. hand-edited into the config as
// @ai-sdk/groq) so saving the dialog keeps the raw value instead of
// silently rewriting it to OpenAI Compatible.
internal sealed interface ProtocolChoice {
    val npm: String

    data class Known(val protocol: ModelProtocol) : ProtocolChoice {
        override val npm: String get() = protocol.npm
        override fun toString(): String = protocol.toString()
    }

    data class Preserved(val rawNpm: String) : ProtocolChoice {
        override val npm: String get() = rawNpm
        override fun toString(): String = MyMessageBundle.message("settings.models.dialog.protocol.preserved", rawNpm)
    }

    companion object {
        fun knownChoices(): Array<ProtocolChoice> = ModelProtocol.entries.map { Known(it) }.toTypedArray()

        // Choices for a stored npm id: the known protocols, plus a
        // "keep current" entry when the stored value is not one of them.
        fun choicesFor(storedNpm: String?): List<ProtocolChoice> {
            val known = ModelProtocol.entries.map { Known(it) }
            return if (storedNpm != null && ModelProtocol.entries.none { it.npm == storedNpm }) {
                known + Preserved(storedNpm)
            } else {
                known
            }
        }
    }
}

internal class AddModelDialog(
    private val project: Project,
    private val existingModels: List<DevEcoHttpApi.ModelInfo> = emptyList(),
    private val blacklist: Set<Pair<String, String>> = emptySet(),
    private val editProviderId: String? = null,
    private val editProviderName: String? = null,
    private val editBaseUrl: String? = null,
    private val editModels: List<DevEcoHttpApi.ProviderModelInfo> = emptyList(),
    private val editSingleModelId: String? = null,
    private val editAllModels: List<DevEcoHttpApi.ProviderModelInfo> = emptyList(),
    private val editHasAuth: Boolean = false,
    private val editApiNpm: String? = null,
) : DialogWrapper(project) {
    private val log = Logger.getInstance(AddModelDialog::class.java)
    private val service get() = project.getService(AcpClientService::class.java)
    private val modelStore get() = project.getService(SessionModelStore::class.java)

    var result: AddModelResult? = null
        private set

    // Set when resetApiKey mutated the backend (deleteAuthentication +
    // refreshInstance). The caller uses this to decide whether to reload
    // the settings page even if the dialog was cancelled — the backend
    // state changed regardless of the dialog result.
    var backendMutated = false
        private set

    private var activeTab = 0

    private val tabProviderButton = TabButton(msg("settings.models.dialog.tab.provider")) { selectTab(0) }
    private val tabManualButton = TabButton(msg("settings.models.dialog.tab.manual")) { selectTab(1) }
    private val cardPanel = JPanel(CardLayout())

    // --- Tab 1: Add via Provider ---
    private val providerCombo = JComboBox<DevEcoHttpApi.ProviderInfo>()
    private val apiKeyField1 = JBPasswordField()
    // Select-all tri-state checkbox for the model table, mirroring the row
    // checkboxes below: checkmark when every visible (filtered) model is
    // selected, empty box when none, and the platform indeterminate icon
    // (selected background + dash) for partial selection. The third state is
    // display-only — user clicks always mean "all on" or "all off".
    private val selectAllButton = ThreeStateCheckBox(msg("settings.models.dialog.selectAll"), ThreeStateCheckBox.State.NOT_SELECTED).apply {
        isThirdStateEnabled = false
        addActionListener { toggleSelectAllVisible() }
    }

    // Model search: filters the table to matching models, with the matched
    // characters highlighted in each row label. The width follows the design
    // spec (146px at 100% zoom); the height is left to the platform default
    // (see ModelSearchField) so the field stays level with the provider/API
    // key inputs at any IDE zoom.
    private val modelSearchField = ModelSearchField().apply {
        textEditor.emptyText.text = msg("settings.models.search")
    }

    // 40px (at 100% zoom) table header: select-all checkbox on the left
    // (12px left inset, aligned with the model checkbox column below), search
    // field on the right (12px off the table's right edge), both vertically
    // centered — GridBagLayout centers a lone child on both axes, while
    // FlowLayout would top-align it. All metrics are JBUI-scaled so the
    // header grows with the IDE zoom exactly like the platform controls do.
    private val modelTableHeader = JPanel(BorderLayout()).apply {
        isOpaque = false
        border = javax.swing.BorderFactory.createMatteBorder(0, 0, 1, 0, JBColor.border())
        preferredSize = Dimension(0, JBUI.scale(40))
        add(JPanel(GridBagLayout()).apply {
            isOpaque = false
            border = JBUI.Borders.empty(0, 12, 0, 0)
            add(selectAllButton)
        }, BorderLayout.WEST)
        add(JPanel(GridBagLayout()).apply {
            isOpaque = false
            border = JBUI.Borders.empty(0, 0, 0, 12)
            add(modelSearchField)
        }, BorderLayout.EAST)
    }

    private val modelList = ModelCheckBoxList().apply {
        setCheckBoxListListener { index, value -> onModelToggled(index, value) }
        // Flat rows with the checkbox column at a 12px left inset, matching
        // the select-all checkbox above; replaces the platform renderer's
        // focus-cell border, which this table does not use. Row height comes
        // from the renderer's preferred size so it scales with the zoom.
        setCellRenderer(object : ListCellRenderer<JCheckBox> {
            private val rowBorder = JBUI.Borders.empty(2, 12, 2, 8)
            override fun getListCellRendererComponent(
                list: JList<out JCheckBox>?,
                value: JCheckBox?,
                index: Int,
                isSelected: Boolean,
                cellHasFocus: Boolean,
            ): Component {
                value?.apply {
                    isOpaque = true
                    background = if (isSelected) list?.selectionBackground else list?.background
                    foreground = if (isSelected) list?.selectionForeground else list?.foreground
                    border = rowBorder
                }
                return value ?: JLabel()
            }
        })
    }
    private val lastLoadedModels = java.util.concurrent.CopyOnWriteArrayList<DevEcoHttpApi.ProviderModelInfo>()
    private val selectedModels = mutableSetOf<DevEcoHttpApi.ProviderModelInfo>()
    private val providerStatusLabel = JBLabel("").apply {
        foreground = JBColor(0x999999, 0x999999)
        font = font.deriveFont(Font.PLAIN, 11f)
    }
    private var isUpdatingProviders = false
    // Guard so programmatic search-text resets (provider reload, Esc clear)
    // don't re-enter the document listener's filter path.
    private var isApplyingFilter = false

    // Tracks whether the API key field currently shows the masked placeholder for
    // a provider that already has auth. When true, OK should NOT send a key to
    // the backend (the existing key is kept). Cleared on first focus to allow
    // the user to type a new key.
    private var apiKeyPrefilled = false
    // Same mechanism for Tab 2's API key field. When true (masked
    // "............" showing for a provider that has auth), the OK
    // handler must NOT send the dots as a real key — send null to
    // preserve the existing stored key.
    private var apiKey2Prefilled = false

    // Reset button for Tab 1. Made a field so applyApiKeyState can disable
    // it for built-in providers whose auth must never be removed.
    private val resetApiKeyButton = JButton(msg("settings.models.dialog.resetApiKey")).apply {
        isFocusPainted = false
        margin = Insets(0, 8, 0, 8)
        addActionListener { resetApiKey() }
    }

    private fun isBuiltinProvider(providerId: String): Boolean =
        providerId.equals("deveco", ignoreCase = true)

    // --- Tab 2: Add Manually ---
    private val providerNameField = JBTextField().apply { emptyText.text = msg("settings.models.dialog.ph.providerName") }
    private val urlField = JBTextField().apply { emptyText.text = msg("settings.models.dialog.ph.url") }
    // API protocol for the manual provider. Selection defaults to OpenAI
    // Compatible in add mode; edit mode prefills from the stored npm id
    // (see prefillProtocolChoice).
    private val protocolCombo = JComboBox<ProtocolChoice>(ProtocolChoice.knownChoices())
    // True once the user has typed into providerNameField directly — after that,
    // URL edits stop overwriting it. Reset to false when the field is cleared so
    // URL auto-fill works again.
    private var providerNameUserEdited = false
    // Guard so a programmatic providerName set (from the URL listener) isn't
    // misread as a user edit by the providerNameField listener.
    private var settingProviderNameFromUrl = false
    private val apiKeyField2 = JBPasswordField().apply {
        emptyText.text = msg("settings.models.dialog.ph.apiKeyOptional")
    }
    private val modelRowsPanel = object : JPanel(), javax.swing.Scrollable {
        init {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
        }
        override fun getPreferredScrollableViewportSize(): Dimension = Dimension(400, 100)
        override fun getScrollableBlockIncrement(visibleRect: java.awt.Rectangle, orientation: Int, direction: Int): Int = 32
        override fun getScrollableUnitIncrement(visibleRect: java.awt.Rectangle, orientation: Int, direction: Int): Int = 32
        override fun getScrollableTracksViewportWidth(): Boolean = true
        override fun getScrollableTracksViewportHeight(): Boolean = false
    }
    private val modelRows = mutableListOf<ModelRow>()
    private val addModelButton = JPanel(FlowLayout(FlowLayout.CENTER, 0, 0)).apply {
        isOpaque = false
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        // 1px rounded (radius 4) outline in the theme component border color
        // (#C9CCD6 light / #4E5157 dark, matching text field borders) with
        // 6/12 inner padding.
        border = object : javax.swing.border.AbstractBorder() {
            private val pad = Insets(6, 12, 6, 12)
            override fun getBorderInsets(c: Component): Insets = pad
            override fun paintBorder(c: Component?, g: Graphics, x: Int, y: Int, width: Int, height: Int) {
                val g2 = g.create() as Graphics2D
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                g2.color = JBColor(0xC9CCD6, 0x4E5157)
                g2.draw(RoundRectangle2D.Float(x + 0.5f, y + 0.5f, width - 1f, height - 1f, 8f, 8f))
                g2.dispose()
            }
        }
        val click = object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) = addModelRow()
        }
        addMouseListener(click)
        val label = JLabel(msg("settings.models.dialog.addModel")).apply {
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(click)
        }
        add(label)
        val size = Dimension(maxOf(76, label.preferredSize.width + 24), 28)
        preferredSize = size
        minimumSize = size
        maximumSize = size
    }

    private val TAB_ACTIVE_BG = JBColor(0xFFFFFF, 0x393B40)
    private val TAB_INACTIVE_BG = JBColor(0xF7F8FA, 0x2B2D30)
    // The active fill is white in the light theme and dark gray in the dark
    // theme, so the label follows the theme's default foreground to stay
    // readable on either fill (a fixed white only worked when both themes
    // used the dark gray fill). Inactive tabs use the same default.
    private val TAB_ACTIVE_FG = JBColor.foreground()
    private val TAB_INACTIVE_FG = JBColor.foreground()
    private val TAB_BORDER = JBColor(0xC4C4C4, 0x515151)

    init {
        title = when {
            editSingleModelId != null -> msg("settings.models.dialog.title.editModel")
            editProviderId != null -> msg("settings.models.dialog.title.editProvider")
            else -> msg("settings.models.dialog.title")
        }
        setOKButtonText(if (editProviderId != null) msg("settings.models.save") else msg("settings.models.dialog.confirm"))
        init()
        setupProviderCombo()
        setupListeners()
        setupModelSearchKeys()
        if (editProviderId != null) {
            tabProviderButton.isVisible = false
            tabManualButton.isVisible = false
            prefillEditMode()
            selectTab(1)
        } else {
            addModelRow()
            loadModelTable(emptyList(), "")
            // Placeholder keeps the combo model non-empty while providers
            // load, so the popup cannot collapse to a sliver during the
            // async load window.
            isUpdatingProviders = true
            providerCombo.addItem(placeholderProvider(msg("settings.models.dialog.loadingProviders")))
            isUpdatingProviders = false
            selectTab(0)
            loadProviders()
        }
        updateOkState()
    }

    // Swap the default [OK][Cancel] button order to [Cancel][OK].
    override fun createActions(): Array<javax.swing.Action> = arrayOf(cancelAction, okAction)

    private fun prefillEditMode() {
        providerNameField.text = editProviderName ?: ""
        urlField.text = editBaseUrl ?: ""
        prefillProtocolChoice(editApiNpm)
        if (editSingleModelId != null) {
            // Edit single model: lock provider fields so only model id/name
            // are editable. Show a masked placeholder when the backend has
            // an API key, otherwise leave blank. The key is never sent back
            // (validateTab2 forces null in this mode), so the placeholder is
            // purely visual.
            providerNameField.isEnabled = false
            urlField.isEnabled = false
            protocolCombo.isEnabled = false
            apiKeyField2.isEnabled = false
            if (editHasAuth) {
                apiKeyField2.text = "............"
                apiKey2Prefilled = true
            }
            addModelButton.isVisible = false
            val target = editModels.firstOrNull()
                ?: editAllModels.firstOrNull { it.id == editSingleModelId }
            if (target != null) {
                val row = ModelRow()
                row.modelIdField.text = target.id
                row.nameField.text = target.name
                row.deleteButton.isVisible = false
                modelRows.add(row)
            }
        } else {
            if (editHasAuth) {
                apiKeyField2.text = "............"
                apiKey2Prefilled = true
            }
            for (model in editModels) {
                val row = ModelRow()
                row.modelIdField.text = model.id
                row.nameField.text = model.name
                modelRows.add(row)
            }
        }
        if (modelRows.isEmpty()) addModelRow()
        rebuildModelRows()
    }

    // Prefill the protocol combo from the stored npm id. Unrecognized values
    // (hand-edited config npm) appear as an extra "keep current" choice,
    // preselected so an unchanged save preserves them; the user can still
    // switch to a known protocol explicitly.
    private fun prefillProtocolChoice(storedNpm: String?) {
        val choices = ProtocolChoice.choicesFor(storedNpm)
        protocolCombo.model = DefaultComboBoxModel(choices.toTypedArray())
        protocolCombo.selectedItem = choices.firstOrNull { it.npm == storedNpm } ?: choices.first()
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(BorderLayout())
        panel.preferredSize = Dimension(520, 420)
        val tabHeader = object : JPanel() {
            override fun paint(g: Graphics) {
                if (!tabProviderButton.isVisible) {
                    super.paint(g)
                    return
                }
                val selLeft = activeTab == 0
                val arc = 8f
                // 0.5 offsets keep the 1px strokes inside crisp pixel rows.
                val x0 = tabProviderButton.x + 0.5f
                val y0 = tabProviderButton.y + 0.5f
                val x1 = tabManualButton.x + tabManualButton.width - 0.5f
                val y1 = tabProviderButton.y + tabProviderButton.height - 0.5f
                val j = tabManualButton.x + 0.5f
                val fy0 = y0 + 1
                val fy1 = y1 - 1

                // Active and inactive card fills: each is a full rounded
                // rectangle covering one tab. The active card's inner side
                // sits against the divider; the inactive card mirrors it on
                // the other side.
                val activeFill = Path2D.Float()
                val inactiveFill = Path2D.Float()
                if (selLeft) {
                    val fx0 = x0 + 1
                    val v = j - 1
                    activeFill.moveTo(fx0, fy0 + arc)
                    activeFill.quadTo(fx0, fy0, fx0 + arc, fy0)
                    activeFill.lineTo(v - arc, fy0)
                    activeFill.quadTo(v, fy0, v, fy0 + arc)
                    activeFill.lineTo(v, fy1 - arc)
                    activeFill.quadTo(v, fy1, v - arc, fy1)
                    activeFill.lineTo(fx0 + arc, fy1)
                    activeFill.quadTo(fx0, fy1, fx0, fy1 - arc)
                    activeFill.closePath()

                    val fx1 = x1 - 1
                    val w = j + 1
                    inactiveFill.moveTo(w, fy0 + arc)
                    inactiveFill.quadTo(w, fy0, w + arc, fy0)
                    inactiveFill.lineTo(fx1 - arc, fy0)
                    inactiveFill.quadTo(fx1, fy0, fx1, fy0 + arc)
                    inactiveFill.lineTo(fx1, fy1 - arc)
                    inactiveFill.quadTo(fx1, fy1, fx1 - arc, fy1)
                    inactiveFill.lineTo(w + arc, fy1)
                    inactiveFill.quadTo(w, fy1, w, fy1 - arc)
                    inactiveFill.closePath()
                } else {
                    val fx1 = x1 - 1
                    val v = j + 1
                    activeFill.moveTo(v, fy0 + arc)
                    activeFill.quadTo(v, fy0, v + arc, fy0)
                    activeFill.lineTo(fx1 - arc, fy0)
                    activeFill.quadTo(fx1, fy0, fx1, fy0 + arc)
                    activeFill.lineTo(fx1, fy1 - arc)
                    activeFill.quadTo(fx1, fy1, fx1 - arc, fy1)
                    activeFill.lineTo(v + arc, fy1)
                    activeFill.quadTo(v, fy1, v, fy1 - arc)
                    activeFill.closePath()

                    val fx0 = x0 + 1
                    val w = j - 1
                    inactiveFill.moveTo(fx0, fy0 + arc)
                    inactiveFill.quadTo(fx0, fy0, fx0 + arc, fy0)
                    inactiveFill.lineTo(w - arc, fy0)
                    inactiveFill.quadTo(w, fy0, w, fy0 + arc)
                    inactiveFill.lineTo(w, fy1 - arc)
                    inactiveFill.quadTo(w, fy1, w - arc, fy1)
                    inactiveFill.lineTo(fx0 + arc, fy1)
                    inactiveFill.quadTo(fx0, fy1, fx0, fy1 - arc)
                    inactiveFill.closePath()
                }
                val g2 = g.create() as Graphics2D
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                // Inactive first so the active fill can sit on top.
                g2.color = TAB_INACTIVE_BG
                g2.fill(inactiveFill)
                g2.color = TAB_ACTIVE_BG
                g2.fill(activeFill)
                g2.dispose()
                super.paint(g)
                val g3 = g.create() as Graphics2D
                g3.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                g3.color = TAB_BORDER
                g3.draw(RoundRectangle2D.Float(x0, y0, x1 - x0, y1 - y0, arc * 2, arc * 2))
                val divider = Path2D.Float()
                divider.moveTo(if (selLeft) j - arc else j + arc, y0)
                divider.quadTo(j, y0, j, y0 + arc)
                divider.lineTo(j, y1 - arc)
                divider.quadTo(j, y1, if (selLeft) j - arc else j + arc, y1)
                g3.draw(divider)
                g3.dispose()
            }
        }.apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            isOpaque = false
            add(Box.createHorizontalStrut(8))
            add(tabProviderButton)
            add(tabManualButton)
            add(Box.createHorizontalGlue())
        }
        cardPanel.add(createProviderPanel(), PROVIDER_TAB)
        cardPanel.add(createManualPanel(), MANUAL_TAB)
        panel.add(tabHeader, BorderLayout.NORTH)
        panel.add(cardPanel, BorderLayout.CENTER)
        return panel
    }

    override fun getPreferredFocusedComponent(): JComponent? = preferredFocusForTab(activeTab)

    override fun doOKAction() {
        val error = if (activeTab == 0) validateTab1() else validateTab2()
        if (error != null) {
            setErrorText(error)
            return
        }
        setErrorText(null)
        close(OK_EXIT_CODE)
    }

    // --- Tab switching ---

    private fun selectTab(index: Int) {
        activeTab = index
        tabProviderButton.foreground = if (index == 0) TAB_ACTIVE_FG else TAB_INACTIVE_FG
        tabManualButton.foreground = if (index == 1) TAB_ACTIVE_FG else TAB_INACTIVE_FG
        tabProviderButton.parent?.repaint()
        (cardPanel.layout as CardLayout).show(cardPanel, if (index == 0) PROVIDER_TAB else MANUAL_TAB)
        setErrorText(null)
        updateOkState()
        // Without this, focus stays on the clicked tab button or on a
        // component of the now-hidden card, so typing lands nowhere useful.
        SwingUtilities.invokeLater { preferredFocusForTab(index)?.requestFocusInWindow() }
    }

    private fun preferredFocusForTab(index: Int): JComponent? = when {
        index == 0 -> providerCombo
        // Edit-single-model disables the URL field, and disabled components
        // reject focus — target the model id input instead.
        editSingleModelId != null -> modelRows.firstOrNull()?.modelIdField
        else -> urlField
    }

    // --- Tab 1: Provider-based ---

    private fun createProviderPanel(): JComponent {
        return JPanel(BorderLayout()).apply {
            isOpaque = false
            border = EmptyBorder(8, 8, 8, 8)
            val top = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                isOpaque = false
                add(fieldRow(msg("settings.models.dialog.provider"), providerCombo))
                add(Box.createVerticalStrut(8))
                add(fieldRowWithReset(msg("settings.models.dialog.apiKey"), apiKeyField1))
                add(Box.createVerticalStrut(6))
                add(createInfoBanner(msg("settings.models.dialog.tip.autoAdd")))
                add(Box.createVerticalStrut(8))
            }
            add(top, BorderLayout.NORTH)
            add(JPanel(BorderLayout()).apply {
                isOpaque = false
                border = javax.swing.BorderFactory.createMatteBorder(1, 1, 1, 1, JBColor.border())
                add(modelTableHeader, BorderLayout.NORTH)
                add(JScrollPane(modelList).apply {
                    border = EmptyBorder(0, 0, 0, 0)
                    viewportBorder = EmptyBorder(0, 0, 0, 0)
                }, BorderLayout.CENTER)
            }, BorderLayout.CENTER)
            add(providerStatusLabel, BorderLayout.SOUTH)
        }
    }

    private fun createInfoBanner(text: String): JPanel {
        val bannerBg = JBColor(0xEDF6FF, 0x1E3A5F)
        val borderColor = JBColor(0xB8DFFF, 0x2A5078)
        return RoundedCardPanel(BorderLayout(8, 0), fill = bannerBg, outline = borderColor).apply {
            border = javax.swing.BorderFactory.createEmptyBorder(6, 10, 6, 10)
            maximumSize = Dimension(Integer.MAX_VALUE, 40)
            add(JLabel(AllIcons.General.Information).apply {
                isOpaque = false
                preferredSize = Dimension(16, 16)
                verticalAlignment = SwingConstants.CENTER
            }, BorderLayout.WEST)
            add(JBLabel(text).apply {
                isOpaque = false
                font = font.deriveFont(Font.PLAIN, 11f)
                foreground = JBColor.foreground()
            }, BorderLayout.CENTER)
        }
    }

    private fun fieldRowWithReset(labelText: String, field: JComponent): JPanel {
        val label = JBLabel(labelText).apply {
            preferredSize = Dimension(100, 28)
            horizontalAlignment = SwingConstants.LEFT
        }
        // Disable reset button for built-in providers (auth must never be
        // removed), when the field is truly empty, or when the provider has
        // no stored auth to reset (e.g. after a reset in this dialog session).
        val updateResetState = {
            val provider = providerCombo.selectedItem as? DevEcoHttpApi.ProviderInfo
            val builtin = provider != null && isBuiltinProvider(provider.id)
            val hasContent = apiKeyPrefilled || String(apiKeyField1.password).trim().isNotEmpty()
            resetApiKeyButton.isEnabled = hasContent && !builtin && (provider?.hasAuth == true)
        }
        apiKeyField1.document.addDocumentListener(object : DocumentAdapter() {
            override fun textChanged(e: DocumentEvent) = updateResetState()
        })
        apiKeyField1.addFocusListener(object : java.awt.event.FocusAdapter() {
            override fun focusLost(e: java.awt.event.FocusEvent) = updateResetState()
        })
        return JPanel(BorderLayout(8, 0)).apply {
            isOpaque = false
            add(label, BorderLayout.WEST)
            add(field, BorderLayout.CENTER)
            add(resetApiKeyButton, BorderLayout.EAST)
            maximumSize = Dimension(Integer.MAX_VALUE, 32)
            updateResetState()
        }
    }

    private fun resetApiKey() {
        val provider = providerCombo.selectedItem as? DevEcoHttpApi.ProviderInfo
        if (provider == null) return
        if (!provider.hasAuth) return
        if (isBuiltinProvider(provider.id)) return
        val confirm = Messages.showOkCancelDialog(
            project,
            msg("settings.models.dialog.resetApiKeyConfirm"),
            msg("settings.models.dialog.resetApiKey"),
            msg("settings.models.dialog.resetApiKey"),
            Messages.getCancelButton(),
            Messages.getWarningIcon(),
        )
        if (confirm != Messages.OK) return
        backendMutated = true
        // Update UI immediately for instant visual feedback.
        apiKeyPrefilled = false
        apiKeyField1.text = ""
        providerStatusLabel.text = msg("settings.models.dialog.apiKeyReset")
        val idx = providerCombo.selectedIndex
        val updated = provider.copy(hasAuth = false)
        isUpdatingProviders = true
        if (idx >= 0) providerCombo.removeItemAt(idx)
        providerCombo.insertItemAt(updated, if (idx >= 0) idx else 0)
        if (idx >= 0) providerCombo.selectedIndex = idx else providerCombo.selectedIndex = 0
        isUpdatingProviders = false
        updateOkState()
        // Immediately delete the API key from the backend. DELETE /auth
        // also removes the entry from auth.json — the backend's authRemove
        // handler calls Auth.remove which rewrites the file. After the
        // delete, refreshInstance (disposeInstance) reloads the backend
        // so availableProviders() reflects hasAuth=false — without it the
        // in-memory s.providers snapshot stays stale and the dialog would
        // still show the provider as "connected" with a masked key.
        //
        // Both the deleteAuthentication and refreshInstance are wrapped
        // in service.backendMutationLock, the same lock apply() uses, so
        // they cannot race with apply()'s deleteProviderModel +
        // refreshInstance flow.
        //
        // If the user re-enters a key and clicks OK, apply()'s
        // connectProvider does PUT /auth which writes the new key to
        // auth.json, overwriting this deletion.
        ApplicationManager.getApplication().executeOnPooledThread {
            synchronized(service.backendMutationLock) {
                log.debug("resetApiKey: deleteAuthentication for ${provider.id}")
                runCatching { service.deleteAuthentication(provider.id) }
                    .onFailure {
                        log.warn("resetApiKey: deleteAuthentication failed for ${provider.id}", it)
                        ApplicationManager.getApplication().invokeLater {
                            Messages.showErrorDialog(project, it.message ?: "Failed", msg("settings.models.dialog.resetApiKey"))
                        }
                    }
                    .onSuccess {
                        log.debug("resetApiKey: deleteAuthentication succeeded, refreshing instance")
                        runCatching { service.refreshInstance() }
                            .onFailure { log.warn("resetApiKey: refreshInstance failed", it) }
                        // Poll modelCatalog() until the backend confirms the
                        // provider is gone. After refreshInstance (dispose),
                        // the next request creates a new instance that reads
                        // the updated auth.json. But there may be a brief
                        // window where the old instance still serves stale
                        // data (key still present). Retry until the catalog
                        // no longer includes this provider's models, then
                        // update the cache — this is the ONLY sync point
                        // that ensures the cache matches the backend.
                        var catalog = runCatching { service.modelCatalog() }.getOrElse { emptyList() }
                        var attempts = 0
                        while (attempts < 10 && catalog.any { it.providerId == provider.id }) {
                            log.debug("resetApiKey: catalog still includes ${provider.id} (attempt ${attempts + 1}), retrying")
                            try { Thread.sleep(300) } catch (_: InterruptedException) {}
                            catalog = runCatching { service.modelCatalog() }.getOrElse { emptyList() }
                            attempts++
                        }
                        if (catalog.isNotEmpty()) {
                            val resetProviders = runCatching { service.availableProviders() }.getOrElse { emptyList() }
                            val resetDisconnected = resetProviders.filter { !it.hasAuth }.map { it.id }.toSet()
                            val safeCatalog = if (resetDisconnected.isNotEmpty()) {
                                catalog.filter { it.providerId !in resetDisconnected }
                            } else {
                                catalog
                            }
                            modelStore.cacheCatalog(safeCatalog)
                            log.debug("resetApiKey: cache synced (${safeCatalog.size} models, ${provider.id} excluded)")
                        }
                    }
            }
            ApplicationManager.getApplication().invokeLater {
                project.messageBus.syncPublisher(
                    org.deveco.code.session.SESSION_REFRESH_TOPIC,
                ).onSessionsChanged()
            }
        }
    }

    private fun setupProviderCombo() {
        // No custom renderer on purpose: the platform's New UI combo renderer
        // paints the rounded inset selection and popup spacing, and any
        // setRenderer call bypasses it. The display text (name plus the
        // connected suffix) comes from ProviderInfo.toString().
        providerCombo.addItemListener { e ->
            if (isUpdatingProviders) return@addItemListener
            if (e.stateChange == ItemEvent.SELECTED) {
                val provider = e.item as? DevEcoHttpApi.ProviderInfo
                if (provider != null && provider.id != PLACEHOLDER_PROVIDER_ID) {
                    selectedModels.clear()
                    applyApiKeyState(provider)
                    loadModels(provider)
                }
                updateOkState()
            }
        }
    }

    // Sentinel placeholder row for the provider combo. The combo model is
    // never empty: while the list loads it shows a "loading" placeholder, and
    // an empty catalog shows the no-providers placeholder, so the popup always
    // has at least one row instead of collapsing to a zero-height sliver.
    private fun placeholderProvider(text: String) =
        DevEcoHttpApi.ProviderInfo(PLACEHOLDER_PROVIDER_ID, text, null, 0)

    private fun applyApiKeyState(provider: DevEcoHttpApi.ProviderInfo) {
        // Rule 3: for providers that already have an API key, show masked
        // placeholder dots in the field and make the key optional. For
        // providers without auth, clear the field and make it required.
        if (provider.hasAuth) {
            apiKeyPrefilled = true
            // JBPasswordField masks any non-empty content with echo chars,
            // so setting a fixed placeholder string produces the masked display.
            apiKeyField1.text = "............"
        } else {
            apiKeyPrefilled = false
            apiKeyField1.text = ""
        }
    }

    // Load path: runs on provider switch (and initial load). Unlike the
    // filter path it owns the pre-check side effects and resets the search,
    // because the model set as a whole changed and a stale query would show
    // a confusing partial list.
    private fun loadModelTable(
        models: List<DevEcoHttpApi.ProviderModelInfo>,
        providerId: String,
        existingKeys: Set<Pair<String, String>> = emptySet(),
        providerConnected: Boolean = false,
    ) {
        lastLoadedModels.clear()
        lastLoadedModels.addAll(models)
        val existingModelIds = existingKeys.map { it.second }.toSet()
        // A provider that is neither connected nor has configured models is
        // "new": it enters the dialog with every (non-blacklisted) model
        // checked, so connecting it is one API key + OK away. Connected
        // providers keep the existing behavior — only their already-added
        // models are pre-checked.
        val checkAll = existingKeys.isEmpty() && !providerConnected
        for (model in models) {
            val alreadyAdded = model.id in existingModelIds
            val isBlacklisted = (providerId to model.id) in blacklist
            // Pre-check: config state (or the new-provider default), never
            // re-checking blacklisted models.
            if (((alreadyAdded || checkAll) && !isBlacklisted) || model in selectedModels) selectedModels.add(model)
        }
        isApplyingFilter = true
        try {
            modelSearchField.textEditor.text = ""
        } finally {
            isApplyingFilter = false
        }
        applyModelFilter("")
        updateOkState()
        // Models just arrived for the provider the user picked; if focus is
        // still on the provider combo, land it in the search field so typing
        // filters immediately (never steal it from the API key field). Skip
        // while the popup is open: keyboard navigation changes the selection
        // per key press, and stealing focus here would close the popup and
        // commit the navigated-to item without Enter.
        if (providerCombo.isFocusOwner && !providerCombo.isPopupVisible && modelList.itemsCount > 0) {
            modelSearchField.textEditor.requestFocusInWindow()
        }
    }

    // Filter path: pure view rebuild from (lastLoadedModels, selectedModels,
    // query). Never mutates selectedModels — checked states are only
    // restored, and addItem's checked argument raises no listener events,
    // so there is no feedback loop with onModelToggled.
    private fun applyModelFilter(query: String) {
        modelList.clear()
        for (model in lastLoadedModels) {
            if (!modelMatches(model, query)) continue
            modelList.addItem(model, modelRowText(model, query), model in selectedModels)
        }
        if (modelList.itemsCount > 0) modelList.selectedIndex = 0
        modelList.emptyText.text = if (query.isEmpty()) msg("settings.models.empty") else msg("settings.models.dialog.noMatch")
        updateSelectAllButton()
    }

    private fun modelMatches(model: DevEcoHttpApi.ProviderModelInfo, query: String): Boolean =
        query.isEmpty() || "${model.name} (${model.id})".contains(query, ignoreCase = true)

    // Row label with the matched substrings emphasized (bold + link color,
    // theme-aware). HTML is required because the platform CheckBoxList
    // renders plain JCheckBox labels; escape everything before injecting
    // markup.
    private fun modelRowText(model: DevEcoHttpApi.ProviderModelInfo, query: String): String {
        val plain = "${model.name} (${model.id})"
        if (query.isEmpty()) return plain
        val sb = StringBuilder("<html>")
        var i = 0
        while (i < plain.length) {
            val hit = plain.indexOf(query, i, ignoreCase = true)
            if (hit < 0) {
                sb.append(escapeHtml(plain.substring(i)))
                break
            }
            sb.append(escapeHtml(plain.substring(i, hit)))
            sb.append("<b><font color='#").append(modelMatchColorHex()).append("'>")
            sb.append(escapeHtml(plain.substring(hit, hit + query.length)))
            sb.append("</font></b>")
            i = hit + query.length
        }
        return sb.append("</html>").toString()
    }

    private fun escapeHtml(s: String): String =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    // Link-style blue that stays readable on both light and dark row
    // backgrounds; JBColor resolves to the active theme at render time.
    private fun modelMatchColorHex(): String =
        Integer.toHexString(JBColor(0x2470B3, 0x589DF6).rgb and 0xFFFFFF).padStart(6, '0')

    private fun onModelToggled(index: Int, value: Boolean) {
        val model = modelList.getItemAt(index) ?: return
        if (value) selectedModels.add(model) else selectedModels.remove(model)
        updateSelectAllButton()
        updateOkState()
    }

    // Select-all scope is the currently visible rows (i.e. the filtered
    // matches); with no query that is simply all models. The target state
    // comes from the tri-state checkbox the user just clicked (its model
    // already flipped before this listener runs).
    private fun toggleSelectAllVisible() {
        val visible = (0 until modelList.itemsCount).mapNotNull { modelList.getItemAt(it) }
        if (visible.isEmpty()) return
        val select = selectAllButton.state == ThreeStateCheckBox.State.SELECTED
        for (model in visible) {
            if (select) selectedModels.add(model) else selectedModels.remove(model)
            modelList.setItemSelected(model, select)
        }
        modelList.repaint()
        updateSelectAllButton()
        updateOkState()
    }

    // Sync the tri-state checkbox with the visible rows: checkmark for all
    // selected, empty for none, indeterminate (dash) for partial.
    private fun updateSelectAllButton() {
        val visible = (0 until modelList.itemsCount).mapNotNull { modelList.getItemAt(it) }
        selectAllButton.state = when {
            visible.isNotEmpty() && visible.all { it in selectedModels } -> ThreeStateCheckBox.State.SELECTED
            visible.any { it in selectedModels } -> ThreeStateCheckBox.State.DONT_CARE
            else -> ThreeStateCheckBox.State.NOT_SELECTED
        }
    }

    private fun toggleCurrentModel() {
        val index = modelList.selectedIndex
        if (index < 0) return
        val model = modelList.getItemAt(index) ?: return
        if (model in selectedModels) selectedModels.remove(model) else selectedModels.add(model)
        modelList.setItemSelected(model, model in selectedModels)
        modelList.repaint()
        updateSelectAllButton()
        updateOkState()
    }

    private fun moveModelSelection(delta: Int) {
        if (modelList.itemsCount == 0) return
        val target = (modelList.selectedIndex + delta).coerceIn(0, modelList.itemsCount - 1)
        modelList.selectedIndex = target
        modelList.ensureIndexIsVisible(target)
    }

    private fun clearModelSearch() {
        isApplyingFilter = true
        try {
            modelSearchField.textEditor.text = ""
        } finally {
            isApplyingFilter = false
        }
        applyModelFilter("")
    }

    private fun setupModelSearchKeys() {
        val editor = modelSearchField.textEditor
        editor.document.addDocumentListener(docListener {
            if (isApplyingFilter) return@docListener
            applyModelFilter(modelSearchField.textEditor.text.trim())
        })
        // Key listeners run ahead of the editor's keymap/InputMap, so
        // consuming here deterministically overrides both the text field's
        // default Enter (notify-field-accept) and the dialog's default
        // button / Esc cancel. Enter/Esc only take over while a query is
        // active; otherwise they fall through to doOKAction/doCancelAction,
        // preserving the dialog's normal key semantics.
        editor.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                when (e.keyCode) {
                    KeyEvent.VK_DOWN -> {
                        moveModelSelection(1)
                        e.consume()
                    }
                    KeyEvent.VK_UP -> {
                        moveModelSelection(-1)
                        e.consume()
                    }
                    KeyEvent.VK_ENTER -> {
                        if (modelSearchField.textEditor.text.isNotBlank()) toggleCurrentModel() else doOKAction()
                        e.consume()
                    }
                    KeyEvent.VK_ESCAPE -> {
                        if (modelSearchField.textEditor.text.isNotBlank()) clearModelSearch() else doCancelAction()
                        e.consume()
                    }
                }
            }
        })
        modelList.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                when (e.keyCode) {
                    KeyEvent.VK_ENTER -> {
                        toggleCurrentModel()
                        e.consume()
                    }
                    KeyEvent.VK_ESCAPE -> {
                        if (modelSearchField.textEditor.text.isNotBlank()) clearModelSearch() else doCancelAction()
                        e.consume()
                    }
                }
            }

            // Typing any printable character with the list focused jumps into
            // the search field with that character — the "type to search"
            // entry point. Space is excluded (it toggles the row checkbox
            // via the platform CheckBoxList handler), and so are control
            // chars and modified keystrokes (Ctrl+C etc.).
            override fun keyTyped(e: KeyEvent) {
                val ch = e.keyChar
                if (ch == ' ' || ch.isISOControl()) return
                val mods = e.modifiersEx and (InputEvent.CTRL_DOWN_MASK or InputEvent.ALT_DOWN_MASK or InputEvent.META_DOWN_MASK)
                if (mods != 0) return
                e.consume()
                val field = modelSearchField.textEditor
                field.requestFocusInWindow()
                field.text += ch
                field.caretPosition = field.text.length
            }
        })
    }

    private fun loadProviders() {
        ApplicationManager.getApplication().executeOnPooledThread {
            // The provider catalog comes from the DevEco Code HTTP server, which
            // may not be connected yet if this dialog is opened before the tool
            // window / settings page finished booting it. Start it (like
            // SkillStore does) so the provider list is not empty, then give the
            // catalog a moment to populate.
            if (!service.isConnected()) {
                // connect() is designed to return false rather than throw, but
                // a disposal race on shared.attach() can still raise. If it
                // does, fall through to the catalog read below — an
                // unconnected backend yields an empty provider list, so the
                // combo shows the no-providers placeholder instead of the
                // loading one stuck forever.
                runCatching { service.connect() }
                    .onFailure { log.warn("loadProviders: service.connect() failed", it) }
            }
            var providers = runCatching { service.availableProviders() }
                .getOrElse { emptyList() }
            var attempts = 0
            while (providers.isEmpty() && attempts < 10 && service.isConnected()) {
                try { Thread.sleep(300) } catch (_: InterruptedException) {}
                providers = runCatching { service.availableProviders() }.getOrElse { emptyList() }
                attempts++
            }
            // Exclude custom providers (those with an explicit "npm" field in
            // the raw global config — created via Tab 2's addCustomProvider)
            // from the "add via provider" dropdown. They are managed through
            // the edit flow, not re-added through Tab 1. Reading the backend
            // config directly avoids relying on a client-side registry that
            // could drift out of sync with the backend. Then keep only the
            // whitelisted provider ids — the full backend catalog (200+)
            // makes the dropdown unusable.
            val customIds = runCatching { service.customProviderIds() }.getOrElse { emptySet() }
            val displayProviders = providers.filter { it.id !in customIds && it.id in PROVIDER_WHITELIST }
            ApplicationManager.getApplication().invokeLater({
                isUpdatingProviders = true
                providerCombo.removeAllItems()
                if (displayProviders.isEmpty()) {
                    // Keep a placeholder so an empty catalog still opens a
                    // normal-height popup instead of a sliver; the status
                    // label below explains why the list is empty.
                    providerCombo.addItem(placeholderProvider(msg("settings.models.dialog.err.noProvider")))
                } else {
                    for (p in displayProviders) providerCombo.addItem(p)
                }
                isUpdatingProviders = false
                providerStatusLabel.text = if (displayProviders.isEmpty()) msg("settings.models.dialog.err.noProvider") else ""
                if (displayProviders.isNotEmpty()) {
                    providerCombo.selectedIndex = 0
                    val first = displayProviders[0]
                    applyApiKeyState(first)
                    loadModels(first)
                }
                updateOkState()
            }, ModalityState.any())
        }
    }

    private fun loadModels(provider: DevEcoHttpApi.ProviderInfo) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val models = runCatching { service.availableProviderModels(provider.id) }
                .getOrElse { emptyList() }
            val existingKeys = existingModels
                .filter { it.providerId == provider.id }
                .map { it.providerId to it.modelId }
                .toSet()
            ApplicationManager.getApplication().invokeLater({
                loadModelTable(models, provider.id, existingKeys, provider.hasAuth)
            }, ModalityState.any())
        }
    }

    private fun validateTab1(): String? {
        val provider = providerCombo.selectedItem as? DevEcoHttpApi.ProviderInfo
        if (provider == null || provider.id == PLACEHOLDER_PROVIDER_ID) return msg("settings.models.dialog.err.noProvider")
        val apiKey = if (apiKeyPrefilled) {
            null
        } else {
            String(apiKeyField1.password).trim().ifEmpty { null }
        }
        val existingForProvider = existingModels
            .filter { it.providerId == provider.id }
            .map { DevEcoHttpApi.ProviderModelInfo(it.modelId, it.modelName) }
        // Disconnection: the API key was reset and no new key was entered.
        // The provider can no longer serve models, so stage removal of all
        // its existing models from the settings list.
        if (apiKey == null && !provider.hasAuth) {
            if (existingForProvider.isEmpty()) return msg("settings.models.dialog.err.apiKeyRequired")
            result = AddModelResult.ConnectExisting(
                provider.id, provider.name, null,
                emptyList(),
                existingForProvider,
                emptyList(),
                lastLoadedModels.toList(),
                disconnected = true,
            )
            return null
        }
        // Compute models to delete: previously-added models for this provider
        // that the user has now unchecked.
        val toDelete = existingForProvider.filter { it !in selectedModels }
        // unselected = catalog models not checked, EXCLUDING those already in
        // toDelete (to avoid double-processing in the settings page).
        val toDeleteIds = toDelete.map { it.id }.toSet()
        val unselected = lastLoadedModels.filter { it !in selectedModels && it.id !in toDeleteIds }
        if (selectedModels.isEmpty() && toDelete.isEmpty()) return msg("settings.models.dialog.err.modelRequired")
        result = AddModelResult.ConnectExisting(provider.id, provider.name, apiKey, selectedModels.toList(), toDelete, unselected, lastLoadedModels.toList())
        return null
    }

    // --- Tab 2: Manual ---

    private fun createManualPanel(): JComponent {
        return JPanel(BorderLayout()).apply {
            isOpaque = false
            border = EmptyBorder(20, 8, 8, 8)
            val labelWidth = manualLabelColumnWidth()
            val top = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                isOpaque = false
                add(fieldRow(msg("settings.models.dialog.providerName"), providerNameField, labelWidth))
                add(Box.createVerticalStrut(12))
                add(fieldRow(msg("settings.models.dialog.url"), urlField, labelWidth))
                add(Box.createVerticalStrut(12))
                add(fieldRow(msg("settings.models.dialog.protocol"), protocolCombo, labelWidth))
                add(Box.createVerticalStrut(12))
                add(fieldRow(msg("settings.models.dialog.apiKey"), apiKeyField2, labelWidth))
                add(Box.createVerticalStrut(12))
                add(JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
                    isOpaque = false
                    preferredSize = Dimension(0, 28)
                    minimumSize = Dimension(0, 28)
                    maximumSize = Dimension(Integer.MAX_VALUE, 28)
                    add(addModelButton)
                })
                add(Box.createVerticalStrut(6))
            }
            add(top, BorderLayout.NORTH)
            val sp = JScrollPane(modelRowsPanel)
            sp.border = null
            sp.horizontalScrollBarPolicy = JScrollPane.HORIZONTAL_SCROLLBAR_NEVER
            sp.addComponentListener(object : java.awt.event.ComponentAdapter() {
                override fun componentResized(e: java.awt.event.ComponentEvent) {
                    val w = sp.viewport.width
                    if (w > 0 && modelRowsPanel.width != w) {
                        modelRowsPanel.setSize(w, modelRowsPanel.height)
                        modelRowsPanel.doLayout()
                    }
                }
            })
            add(sp, BorderLayout.CENTER)
        }
    }

    private fun addModelRow() {
        modelRows.add(ModelRow())
        rebuildModelRows()
        updateOkState()
    }

    private fun removeModelRow(row: ModelRow) {
        modelRows.remove(row)
        rebuildModelRows()
        updateOkState()
    }

    private fun rebuildModelRows() {
        modelRowsPanel.removeAll()
        for ((index, row) in modelRows.withIndex()) {
            if (index > 0) modelRowsPanel.add(Box.createVerticalStrut(6))
            modelRowsPanel.add(row.panel)
        }
        modelRowsPanel.revalidate()
        modelRowsPanel.repaint()
    }

    private fun validateTab2(): String? {
        val url = urlField.text.trim()
        // In edit mode, URL field is disabled — skip URL format validation.
        // The URL was pre-filled from the provider cache; if empty, the
        // addCustomProvider call will surface the error.
        if (editProviderId == null && !url.startsWith("http://") && !url.startsWith("https://")) {
            return msg("settings.models.dialog.err.urlFormat")
        }
        // In edit-single-model mode or when the API key field shows the
        // masked placeholder, the key is never sent back — the provider ID
        // is unchanged so PendingEdit does not delete the old provider,
        // preserving the existing stored key.
        val apiKey = if (editSingleModelId != null || apiKey2Prefilled) null
            else String(apiKeyField2.password).trim().ifEmpty { null }
        val rows = modelRows.filter { it.modelIdField.text.trim().isNotEmpty() || it.nameField.text.trim().isNotEmpty() }
        if (rows.isEmpty()) return msg("settings.models.dialog.err.noModels")
        for (row in rows) {
            if (row.modelIdField.text.trim().isEmpty()) return msg("settings.models.dialog.err.modelIdRequired")
        }
        val modelIds = rows.map { it.modelIdField.text.trim() }
        modelIds.groupingBy { it }.eachCount().entries.firstOrNull { it.value > 1 }?.key
            ?.let { return msg("settings.models.dialog.err.dupModelId", it) }
        val providerName = providerNameField.text.trim().ifBlank { extractProviderName(url) }
        if (providerName.isBlank()) return msg("settings.models.dialog.err.urlFormat")
        val models = if (editSingleModelId != null) {
            // Reconstruct the full model list with the edited model updated,
            // so the backend replaces the provider definition atomically.
            val edited = rows.first()
            val newId = edited.modelIdField.text.trim()
            val newName = edited.nameField.text.trim().ifEmpty { newId }
            if (newId != editSingleModelId && editAllModels.any { it.id == newId }) {
                return msg("settings.models.dialog.err.dupModelId", newId)
            }
            editAllModels.map { model ->
                if (model.id == editSingleModelId) DevEcoHttpApi.CustomModel(newId, newName)
                else DevEcoHttpApi.CustomModel(model.id, model.name)
            }
        } else {
            rows.map {
                val mid = it.modelIdField.text.trim()
                val mname = it.nameField.text.trim().ifEmpty { mid }
                DevEcoHttpApi.CustomModel(mid, mname)
            }
        }
        val providerId = if (editProviderId != null) editProviderId
            else providerName.lowercase().replace(" ", "-")
        // Duplicate-provider guard. A derived id matching an existing provider
        // silently clobbers it (addCustomProvider PATCHes provider.<id>); a name
        // collision leaves two providers sharing one display name, producing
        // indistinguishable groups in the settings tree. In edit mode the id is
        // fixed, so only a changed name is checked — a no-op save must not be
        // blocked by a pre-existing duplicate from another provider.
        if (editProviderId == null) {
            if (providerId in existingModels.map { it.providerId }.toSet()) {
                return msg("settings.models.dialog.err.dupProviderId", providerId)
            }
            if (providerName.lowercase() in existingModels.map { it.providerName.lowercase() }.toSet()) {
                return msg("settings.models.dialog.err.dupProviderName", providerName)
            }
        } else if (providerName != editProviderName) {
            val otherNames = existingModels
                .filter { it.providerId != editProviderId }
                .map { it.providerName.lowercase() }
                .toSet()
            if (providerName.lowercase() in otherNames) {
                return msg("settings.models.dialog.err.dupProviderName", providerName)
            }
        }
        val apiNpm = (protocolCombo.selectedItem as? ProtocolChoice)?.npm ?: DevEcoHttpApi.CustomProvider.DEFAULT_API_NPM
        result = AddModelResult.AddCustom(DevEcoHttpApi.CustomProvider(providerId, providerName, url, apiKey, emptyMap(), models, apiNpm))
        return null
    }

    // --- shared helpers ---

    private fun setupListeners() {
        apiKeyField1.document.addDocumentListener(docListener { updateOkState() })
        apiKeyField1.addFocusListener(object : java.awt.event.FocusAdapter() {
            override fun focusGained(e: java.awt.event.FocusEvent) {
                if (apiKeyPrefilled) {
                    apiKeyPrefilled = false
                    apiKeyField1.text = ""
                }
            }
        })
        apiKeyField2.document.addDocumentListener(docListener { updateOkState() })
        apiKeyField2.addFocusListener(object : java.awt.event.FocusAdapter() {
            override fun focusGained(e: java.awt.event.FocusEvent) {
                if (apiKey2Prefilled) {
                    apiKey2Prefilled = false
                    apiKeyField2.text = ""
                }
            }
        })
        urlField.document.addDocumentListener(docListener {
            // Auto-fill providerName from the URL only while the user hasn't
            // manually typed into providerNameField. We can't just check
            // isEmpty(): the listener fires per keystroke, so an early partial
            // URL (e.g. "https://a") would fill a one-char name, after which
            // the field is non-empty and auto-fill would stop — leaving a
            // stuck single character. providerNameUserEdited stays false
            // through these programmatic fills (guarded by
            // settingProviderNameFromUrl) and only flips true on a direct user
            // keystroke in providerNameField, so the URL keeps refining the
            // name until the user overrides it.
            if (!providerNameUserEdited) {
                val name = extractProviderName(urlField.text.trim())
                if (name.isNotEmpty()) {
                    settingProviderNameFromUrl = true
                    try {
                        providerNameField.text = name
                    } finally {
                        settingProviderNameFromUrl = false
                    }
                }
            }
            updateOkState()
        })
        providerNameField.document.addDocumentListener(docListener {
            // A direct user edit marks the field as user-owned so the URL
            // listener stops clobbering it; clearing the field revokes that so
            // URL auto-fill works again. settingProviderNameFromUrl filters out
            // the programmatic sets coming from the URL listener above.
            if (!settingProviderNameFromUrl) {
                providerNameUserEdited = providerNameField.text.trim().isNotEmpty()
            }
            updateOkState()
        })
    }

    private fun docListener(action: () -> Unit) = object : DocumentAdapter() {
        override fun textChanged(e: DocumentEvent) = action()
    }

    private fun updateOkState() {
        val enabled = if (activeTab == 0) isTab1Valid() else isTab2Valid()
        setOKActionEnabled(enabled)
    }

    private fun isTab1Valid(): Boolean {
        val provider = providerCombo.selectedItem as? DevEcoHttpApi.ProviderInfo ?: return false
        if (provider.id == PLACEHOLDER_PROVIDER_ID) return false
        val apiKeyOk = apiKeyPrefilled || provider.hasAuth ||
            String(apiKeyField1.password).trim().isNotEmpty()
        // API key is required for the Add Model button. After resetApiKey
        // (hasAuth=false, no new key entered), the OK button must be
        // disabled — the disconnection is already handled immediately by
        // resetApiKey's deleteAuthentication + refreshInstance.
        if (!apiKeyOk) return false
        val hasExisting = existingModels.any { it.providerId == provider.id }
        return selectedModels.isNotEmpty() || hasExisting
    }

    private fun isTab2Valid(): Boolean {
        // In edit mode, URL field is disabled — skip URL validation.
        // The URL was pre-filled from the provider cache; if empty, the
        // error surfaces in validateTab2 or addCustomProvider.
        if (editProviderId == null) {
            val url = urlField.text.trim()
            if (!url.startsWith("http://") && !url.startsWith("https://")) return false
        }
        return modelRows.any { it.modelIdField.text.trim().isNotEmpty() }
    }

    private fun fieldRow(labelText: String, field: JComponent, labelWidth: Int = 100, maxHeight: Int = 32): JPanel {
        val label = JBLabel(labelText).apply {
            preferredSize = Dimension(labelWidth, 28)
            horizontalAlignment = SwingConstants.LEFT
        }
        return JPanel(BorderLayout(8, 0)).apply {
            isOpaque = false
            add(label, BorderLayout.WEST)
            add(field, BorderLayout.CENTER)
            maximumSize = Dimension(Integer.MAX_VALUE, maxHeight)
        }
    }

    private fun manualLabelColumnWidth(): Int {
        val texts = listOf(
            msg("settings.models.dialog.providerName"),
            msg("settings.models.dialog.url"),
            msg("settings.models.dialog.protocol"),
            msg("settings.models.dialog.apiKey"),
        )
        val probe = JBLabel()
        val fm = probe.getFontMetrics(probe.font)
        // The BorderLayout hgap (8) already provides the label-to-field gap,
        // so the column is just the widest label's text width.
        return texts.maxOf { fm.stringWidth(it) }
    }

    private inner class TabButton(text: String, onClick: () -> Unit) : JButton(text) {
        init {
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            font = font.deriveFont(Font.PLAIN, 12f)
            isFocusPainted = false
            isContentAreaFilled = false
            isBorderPainted = false
            isOpaque = false
            border = EmptyBorder(2, 6, 2, 6)
            margin = Insets(0, 0, 0, 0)
            addActionListener { onClick() }
        }
    }

    private fun extractProviderName(url: String): String {
        if (!url.startsWith("http://") && !url.startsWith("https://")) return ""
        return try {
            val uri = URI(url.trim())
            val host = uri.host ?: return ""
            val parts = host.removePrefix("www.").split(".")
            if (parts.size >= 2) parts[parts.size - 2] else parts[0]
        } catch (e: Exception) {
            ""
        }
    }

    private fun msg(key: String, vararg params: Any?): String = MyMessageBundle.message(key, *params)

    // Search field with the design-spec width. The height is inherited from
    // the platform (same formula as every other text field in this dialog):
    // 30px at 100% zoom, growing in lockstep with the provider/API key
    // inputs at higher IDE zooms. Forcing an unscaled height instead would
    // leave the field visibly shorter than its neighbours whenever the zoom
    // is above 100%, because platform control heights are JBUI-scaled.
    private inner class ModelSearchField : SearchTextField(false) {
        override fun getPreferredSize(): Dimension {
            val ps = super.getPreferredSize()
            ps.width = JBUI.scale(146)
            return ps
        }
    }

    // The platform CheckBoxList only toggles when the click lands inside the
    // checkbox icon (~20px); the previous layout had one full-row JCheckBox
    // per model, so keep that behavior by remapping any click inside the row
    // bounds onto the checkbox. Point(0,0) is always within the checkbox
    // dimension check the base ClickListener performs.
    private inner class ModelCheckBoxList : CheckBoxList<DevEcoHttpApi.ProviderModelInfo>() {
        override fun findPointRelativeToCheckBox(x: Int, y: Int, checkBox: JCheckBox, index: Int): Point? {
            val bounds = getCellBounds(index, index) ?: return null
            return if (x in 0 until bounds.width && y in 0 until bounds.height) Point(0, 0) else null
        }
    }

    private inner class ModelRow {
        val modelIdField = JBTextField().apply {
            emptyText.text = msg("settings.models.dialog.ph.modelId")
            document.addDocumentListener(docListener { updateOkState() })
        }
        val nameField = JBTextField().apply {
            emptyText.text = msg("settings.models.dialog.ph.displayNameOptional")
            document.addDocumentListener(docListener { updateOkState() })
        }
        val deleteButton = JButton(AllIcons.Actions.GC).apply {
            toolTipText = msg("settings.models.delete")
            isContentAreaFilled = false
            isBorderPainted = false
            isOpaque = false
            margin = Insets(0, 0, 0, 0)
            border = EmptyBorder(2, 8, 2, 8)
            preferredSize = Dimension(icon.iconWidth + 16, icon.iconHeight + 4)
            minimumSize = preferredSize
            addActionListener { removeModelRow(this@ModelRow) }
        }
        val panel = JPanel(BorderLayout()).apply {
            isOpaque = false
            maximumSize = Dimension(Integer.MAX_VALUE, 32)
            alignmentX = Component.LEFT_ALIGNMENT
            add(JPanel(GridLayout(1, 2, 8, 0)).apply {
                isOpaque = false
                add(modelIdField)
                add(nameField)
            }, BorderLayout.CENTER)
            add(deleteButton, BorderLayout.EAST)
        }
    }

    companion object {
        private const val PROVIDER_TAB = "provider"
        private const val MANUAL_TAB = "manual"
        private const val PLACEHOLDER_PROVIDER_ID = "__placeholder__"

        // Whitelist of provider ids shown in the "add via provider" dropdown.
        // Keyed by provider id (the catalog's stable machine key used for
        // config/auth storage and HTTP routes), never by display name: names
        // are mutable labels that models.dev may rename on its hourly refresh,
        // and they have no uniqueness guarantee. Ids that no longer exist
        // upstream simply drop out of the dropdown; connected providers and
        // the model settings tree are unaffected either way. Full id/name
        // pairs: integrations/intellij-plugin/supported-providers.csv.
        private val PROVIDER_WHITELIST = setOf(
            "alibaba",
            "alibaba-cn",
            "alibaba-coding-plan",
            "alibaba-coding-plan-cn",
            "alibaba-token-plan",
            "alibaba-token-plan-cn",
            "deepseek",
            "kimi-code-plan-global",
            "kimi-code-plan-cn",
            "minimax",
            "minimax-cn",
            "minimax-coding-plan",
            "minimax-cn-coding-plan",
            "moonshotai",
            "moonshotai-cn",
            "zai",
            "zai-coding-plan",
            "zhipuai",
            "zhipuai-coding-plan",
        )
    }
}
