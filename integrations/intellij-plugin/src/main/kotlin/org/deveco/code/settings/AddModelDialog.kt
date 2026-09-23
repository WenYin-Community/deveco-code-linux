package org.deveco.code.settings

import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.UIUtil
import org.deveco.code.MyMessageBundle
import org.deveco.code.acp.AcpClientService
import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.session.SessionModelStore
import java.awt.BorderLayout
import java.awt.CardLayout
import java.awt.Component
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.GridLayout
import java.awt.Font
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.Insets
import java.awt.RenderingHints
import java.awt.event.ItemEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.net.URI
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultListCellRenderer
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.SwingConstants
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
    private val modelTableHeader = JPanel(BorderLayout()).apply {
        isOpaque = false
        border = javax.swing.BorderFactory.createMatteBorder(0, 0, 1, 0, JBColor.border())
        add(JButton(AllIcons.Actions.Refresh).apply {
            isContentAreaFilled = false
            isBorderPainted = false
            isOpaque = false
            margin = Insets(0, 0, 0, 0)
            border = EmptyBorder(2, 8, 2, 0)
            preferredSize = Dimension(icon.iconWidth + 8, icon.iconHeight + 4)
            minimumSize = preferredSize
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            toolTipText = msg("settings.models.reload")
            addActionListener {
                val provider = providerCombo.selectedItem as? DevEcoHttpApi.ProviderInfo
                if (provider != null) loadModels(provider)
            }
        }, BorderLayout.WEST)
    }
    private val modelListPanel = object : JPanel(), javax.swing.Scrollable {
        init { layout = BoxLayout(this, BoxLayout.Y_AXIS) }
        override fun getPreferredScrollableViewportSize(): Dimension = preferredSize
        override fun getScrollableBlockIncrement(visibleRect: java.awt.Rectangle, orientation: Int, direction: Int): Int = 28
        override fun getScrollableUnitIncrement(visibleRect: java.awt.Rectangle, orientation: Int, direction: Int): Int = 28
        override fun getScrollableTracksViewportWidth(): Boolean = true
        override fun getScrollableTracksViewportHeight(): Boolean = false
    }
    private val lastLoadedModels = java.util.concurrent.CopyOnWriteArrayList<DevEcoHttpApi.ProviderModelInfo>()
    private val selectedModels = mutableSetOf<DevEcoHttpApi.ProviderModelInfo>()
    private val providerStatusLabel = JBLabel("").apply {
        foreground = JBColor(0x999999, 0x999999)
        font = font.deriveFont(Font.PLAIN, 11f)
    }
    private var isUpdatingProviders = false

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
    private val addModelButton = JButton(msg("settings.models.dialog.addModel")).apply {
        addActionListener { addModelRow() }
    }

    private val TAB_ACTIVE_BG = JBColor(0xE0E0E0, 0x383838)
    private val TAB_BORDER = JBColor(0xC4C4C4, 0x515151)

    init {
        title = when {
            editSingleModelId != null -> msg("settings.models.dialog.title.editModel")
            editProviderId != null -> msg("settings.models.dialog.title.editProvider")
            else -> msg("settings.models.dialog.title")
        }
        setOKButtonText(if (editProviderId != null) msg("settings.models.save") else msg("settings.models.add"))
        init()
        setupProviderCombo()
        setupListeners()
        if (editProviderId != null) {
            tabProviderButton.isVisible = false
            tabManualButton.isVisible = false
            prefillEditMode()
            selectTab(1)
        } else {
            addModelRow()
            rebuildModelTable(emptyList(), "")
            selectTab(0)
            loadProviders()
        }
        updateOkState()
    }

    private fun prefillEditMode() {
        providerNameField.text = editProviderName ?: ""
        urlField.text = editBaseUrl ?: ""
        if (editSingleModelId != null) {
            // Edit single model: lock provider fields so only model id/name
            // are editable. Show a masked placeholder when the backend has
            // an API key, otherwise leave blank. The key is never sent back
            // (validateTab2 forces null in this mode), so the placeholder is
            // purely visual.
            providerNameField.isEnabled = false
            urlField.isEnabled = false
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

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(BorderLayout())
        panel.preferredSize = Dimension(520, 420)
        // Tab header
        val tabHeader = JPanel().apply {
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

    override fun getPreferredFocusedComponent(): JComponent? =
        if (activeTab == 0) providerCombo else urlField

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
        tabProviderButton.active = (index == 0)
        tabManualButton.active = (index == 1)
        (cardPanel.layout as CardLayout).show(cardPanel, if (index == 0) PROVIDER_TAB else MANUAL_TAB)
        setErrorText(null)
        updateOkState()
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
                add(JScrollPane(modelListPanel).apply {
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
        return object : JPanel(BorderLayout(8, 0)) {
            override fun paintComponent(g: Graphics) {
                val g2 = g.create() as Graphics2D
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                g2.color = bannerBg
                g2.fillRoundRect(0, 0, width - 1, height - 1, 8, 8)
                g2.color = borderColor
                g2.drawRoundRect(0, 0, width - 1, height - 1, 8, 8)
                g2.dispose()
                super.paintComponent(g)
            }
        }.apply {
            isOpaque = false
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
                log.info("resetApiKey: deleteAuthentication for ${provider.id}")
                runCatching { service.deleteAuthentication(provider.id) }
                    .onFailure {
                        log.warn("resetApiKey: deleteAuthentication failed for ${provider.id}", it)
                        ApplicationManager.getApplication().invokeLater {
                            Messages.showErrorDialog(project, it.message ?: "Failed", msg("settings.models.dialog.resetApiKey"))
                        }
                    }
                    .onSuccess {
                        log.info("resetApiKey: deleteAuthentication succeeded, refreshing instance")
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
                            log.info("resetApiKey: catalog still includes ${provider.id} (attempt ${attempts + 1}), retrying")
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
                            log.info("resetApiKey: cache synced (${safeCatalog.size} models, ${provider.id} excluded)")
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
        providerCombo.setRenderer(object : DefaultListCellRenderer() {
            override fun getListCellRendererComponent(list: JList<*>?, value: Any?, index: Int, selected: Boolean, focused: Boolean): Component {
                super.getListCellRendererComponent(list, value, index, selected, focused)
                (value as? DevEcoHttpApi.ProviderInfo)?.let {
                    text = if (it.hasAuth) "${it.name} (${msg("settings.models.dialog.connected")})" else it.name
                }
                return this
            }
        })
        providerCombo.addItemListener { e ->
            if (isUpdatingProviders) return@addItemListener
            if (e.stateChange == ItemEvent.SELECTED) {
                val provider = e.item as? DevEcoHttpApi.ProviderInfo
                if (provider != null) {
                    selectedModels.clear()
                    applyApiKeyState(provider)
                    loadModels(provider)
                }
                updateOkState()
            }
        }
    }

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

    private fun rebuildModelTable(models: List<DevEcoHttpApi.ProviderModelInfo>, providerId: String, existingKeys: Set<Pair<String, String>> = emptySet()) {
        modelListPanel.removeAll()
        lastLoadedModels.clear()
        lastLoadedModels.addAll(models)

        val existingModelIds = existingKeys.map { it.second }.toSet()

        for (model in models) {
            val alreadyAdded = model.id in existingModelIds
            val isBlacklisted = (providerId to model.id) in blacklist
            modelListPanel.add(JPanel(BorderLayout(8, 0)).apply {
                isOpaque = false
                maximumSize = Dimension(Integer.MAX_VALUE, 28)
                border = EmptyBorder(0, 8, 0, 0)
                add(JCheckBox("${model.name} (${model.id})").apply {
                    isOpaque = false
                    isFocusPainted = false
                    border = EmptyBorder(0, 0, 0, 0)
                    margin = Insets(0, 0, 0, 0)
                    // Pre-check: model is in config AND not blacklisted
                    isSelected = (alreadyAdded && !isBlacklisted) || model in selectedModels
                    if (isSelected) selectedModels.add(model)
                    addItemListener { e ->
                        if (e.stateChange == ItemEvent.SELECTED) selectedModels.add(model)
                        else if (e.stateChange == ItemEvent.DESELECTED) selectedModels.remove(model)
                        updateOkState()
                    }
                }, BorderLayout.WEST)
            })
        }

        if (models.isEmpty()) {
            modelListPanel.add(JLabel(msg("settings.models.empty")).apply {
                foreground = JBColor(0x999999, 0x999999)
                border = EmptyBorder(4, 8, 4, 8)
            })
        }

        modelListPanel.revalidate()
        modelListPanel.repaint()
        updateOkState()
    }

    private fun loadProviders() {
        ApplicationManager.getApplication().executeOnPooledThread {
            // The provider catalog comes from the DevEco Code HTTP server, which
            // may not be connected yet if this dialog is opened before the tool
            // window / settings page finished booting it. Start it (like
            // SkillStore does) so the provider list is not empty, then give the
            // catalog a moment to populate.
            if (!service.isConnected()) service.connect()
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
            // could drift out of sync with the backend.
            val customIds = runCatching { service.customProviderIds() }.getOrElse { emptySet() }
            val displayProviders = providers.filter { it.id !in customIds }
            ApplicationManager.getApplication().invokeLater({
                isUpdatingProviders = true
                providerCombo.removeAllItems()
                for (p in displayProviders) providerCombo.addItem(p)
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
                rebuildModelTable(models, provider.id, existingKeys)
            }, ModalityState.any())
        }
    }

    private fun validateTab1(): String? {
        val provider = providerCombo.selectedItem as? DevEcoHttpApi.ProviderInfo
        if (provider == null) return msg("settings.models.dialog.err.noProvider")
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
            border = EmptyBorder(8, 8, 8, 8)
            val top = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                isOpaque = false
                add(fieldRow(msg("settings.models.dialog.providerName"), providerNameField))
                add(Box.createVerticalStrut(8))
                add(fieldRow(msg("settings.models.dialog.url"), urlField))
                add(Box.createVerticalStrut(8))
                add(fieldRow(msg("settings.models.dialog.apiKey"), apiKeyField2))
                add(Box.createVerticalStrut(6))
                add(JPanel(BorderLayout()).apply {
                    isOpaque = false
                    maximumSize = Dimension(Integer.MAX_VALUE, 20)
                    add(JBLabel(msg("settings.models.dialog.model")).apply {
                        font = font.deriveFont(Font.BOLD, 12f)
                        preferredSize = Dimension(100, 20)
                    }, BorderLayout.WEST)
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
            add(JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
                isOpaque = false
                add(addModelButton)
            }, BorderLayout.SOUTH)
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
            if (row.modelIdField.text.trim().isEmpty()) return msg("settings.models.err.modelIdRequired")
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
        result = AddModelResult.AddCustom(DevEcoHttpApi.CustomProvider(providerId, providerName, url, apiKey, emptyMap(), models))
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

    private fun fieldRow(labelText: String, field: JComponent, maxHeight: Int = 32): JPanel {
        val label = JBLabel(labelText).apply {
            preferredSize = Dimension(100, 28)
            horizontalAlignment = SwingConstants.LEFT
        }
        return JPanel(BorderLayout(8, 0)).apply {
            isOpaque = false
            add(label, BorderLayout.WEST)
            add(field, BorderLayout.CENTER)
            maximumSize = Dimension(Integer.MAX_VALUE, maxHeight)
        }
    }

    private inner class TabButton(text: String, onClick: () -> Unit) : JButton(text) {
        var active = false
            set(value) {
                field = value
                repaint()
            }

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

        override fun paintComponent(g: Graphics) {
            val g2 = g.create() as Graphics2D
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            if (active) {
                g2.color = TAB_ACTIVE_BG
                g2.fillRoundRect(0, 0, width - 1, height - 1, 8, 8)
            }
            g2.color = TAB_BORDER
            g2.drawRoundRect(0, 0, width - 1, height - 1, 8, 8)
            g2.dispose()
            super.paintComponent(g)
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
    }
}
