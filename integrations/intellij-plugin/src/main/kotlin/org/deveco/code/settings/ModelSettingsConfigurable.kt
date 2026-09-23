package org.deveco.code.settings

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.JBColor
import com.intellij.ui.SearchTextField
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.UIUtil
import org.deveco.code.MyMessageBundle
import org.deveco.code.acp.AcpClientService
import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.session.SessionModelStore
import org.deveco.code.session.SESSION_REFRESH_TOPIC
import org.deveco.code.util.opencodeConfigDir
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.Graphics
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.nio.file.Files
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.Icon
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JSeparator
import javax.swing.JTree
import javax.swing.ListSelectionModel
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
import javax.swing.border.EmptyBorder
import javax.swing.event.DocumentEvent
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeCellRenderer
import javax.swing.tree.DefaultTreeModel

class ModelSettingsConfigurable(private val project: Project) : Configurable {
    private val log = Logger.getInstance(ModelSettingsConfigurable::class.java)
    private val service get() = project.getService(AcpClientService::class.java)
    private val modelStore get() = project.getService(SessionModelStore::class.java)

    private val pendingAdds = mutableListOf<DevEcoHttpApi.CustomProvider>()
    private val pendingConnects = mutableListOf<PendingConnect>()
    private val pendingFileDeletes = mutableListOf<Pair<String, String>>()
    private val pendingProviderDeletes = mutableListOf<String>()
    private val pendingAuthRemovals = mutableListOf<String>()
    private val pendingEdits = mutableListOf<PendingEdit>()
    private var pendingPreferred: String? = null
    // Pending checkbox toggles — staged as an in-memory overlay
    // (pendingChecks/pendingUnchecks) over the committed blacklist until Apply,
    // then synced to backend config via connectProvider (provider type) or
    // addCustomProvider (manual type) AND committed to the local blacklist.
    // The local blacklist is NOT written on toggle: rebuildTree renders the
    // effective set (committed ∪ pendingUnchecks − pendingChecks), and apply()
    // commits the overlay only after the backend sync succeeds — so the checkbox
    // UI, the model-store blacklist, and the chat model dropdown all stay
    // consistent with the last-applied state until Apply is pressed.
    // providerId → set of modelIds. Keying by providerId (rather than a flat
    // Set<Pair>) preserves every checked model under one provider and makes
    // the consumer's destructuring unambiguous — the old Set<Pair> + toMap()
    // collapsed same-provider toggles to the last pair and had a swapped
    // destructuring that fed modelId where providerId was expected.
    private val pendingChecks = mutableMapOf<String, MutableSet<String>>()
    private val pendingUnchecks = mutableMapOf<String, MutableSet<String>>()
    private var committedModels: List<DevEcoHttpApi.ModelInfo> = emptyList()
    private var providerBaseUrls: Map<String, String> = emptyMap()
    private var providerAuthMap: Map<String, Boolean> = emptyMap()
    private var committedPreferred: String? = null
    private var preferredInitialized = false
    private var hoveredRow = -1
    // Reuses AcpClientService.backendMutationLock — the same lock
    // AddModelDialog.resetApiKey uses — so backend mutations from the
    // dialog (deleteAuthentication + refreshInstance) cannot race with
    // apply()'s deleteProviderModel + refreshInstance flow.
    private val applyDeletesLock get() = service.backendMutationLock

    // Cached lookup maps rebuilt in rebuildTree() to avoid O(n) per-row
    // scans in the cell renderer (which fires for every visible row on
    // every repaint).
    private var typeCache: Map<String, String> = emptyMap()
    // Effective rendered blacklist = committed (modelStore) ∪ pendingUnchecks −
    // pendingChecks. Computed in rebuildTree; toggleBlacklist updates it
    // synchronously (± the toggled key) so rapid toggles paint correctly before
    // the deferred rebuildTree runs.
    private var blacklistCache: Set<Pair<String, String>> = emptySet()

    private val mainPanel = JPanel(BorderLayout())
    private val searchField = SearchTextField()
    private val treeModel = DefaultTreeModel(DefaultMutableTreeNode("root"))
    private val tree: JTree

    init {
        tree = object : JTree(treeModel) {
            override fun getScrollableTracksViewportWidth(): Boolean = true
            override fun getScrollableTracksViewportHeight(): Boolean {
                val viewport = parent as? javax.swing.JViewport ?: return false
                return viewport.height >= preferredSize.height
            }
            override fun getPreferredScrollableViewportSize(): Dimension = Dimension(600, 420)
            override fun paint(g: Graphics) {
                g.color = UIUtil.getPanelBackground()
                g.fillRect(0, 0, width, height)
                val selectedRow = getSelectionRows()?.firstOrNull()
                val savedPath = selectionPath
                clearSelection()
                for (row in 0 until rowCount) {
                    val bounds = getRowBounds(row) ?: continue
                    val rect = java.awt.Rectangle(0, bounds.y, width, bounds.height)
                    when {
                        row == selectedRow -> {
                            g.color = UIUtil.getTableSelectionBackground()
                            g.fillRect(rect.x, rect.y, rect.width, rect.height)
                        }
                        row == hoveredRow -> {
                            g.color = HOVER_BG
                            g.fillRect(rect.x, rect.y, rect.width, rect.height)
                        }
                    }
                }
                super.paint(g)
                selectionPath = savedPath
            }
        }.apply {
            isOpaque = false
            isRootVisible = false
            showsRootHandles = false
            rowHeight = 28
            toggleClickCount = 0
            putClientProperty("JTree.lineStyle", "None")
            selectionModel.selectionMode = ListSelectionModel.SINGLE_SELECTION
            setCellRenderer(ModelTreeCellRenderer())
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    val row = getClosestRowForLocation(e.x, e.y)
                    if (row < 0) return
                    val bounds = getRowBounds(row)
                    if (bounds == null || e.y < bounds.y || e.y >= bounds.y + bounds.height) return
                    val path = getPathForRow(row) ?: return
                    val node = path.lastPathComponent as? DefaultMutableTreeNode ?: return
                    val userObject = node.userObject
                    when (userObject) {
                        is ProviderGroupNode -> {
                            if (!handleProviderClick(e, userObject)) {
                                if (isExpanded(row)) collapseRow(row) else expandRow(row)
                            }
                        }
                        is DevEcoHttpApi.ModelInfo -> {
                            selectionPath = path
                            handleModelClick(e, userObject, bounds.x)
                        }
                    }
                }
                override fun mouseEntered(e: MouseEvent) {
                    repaintTree()
                }
                override fun mouseExited(e: MouseEvent) {
                    if (hoveredRow != -1) {
                        hoveredRow = -1
                        repaintTree()
                    }
                }
            })
            addMouseMotionListener(object : java.awt.event.MouseMotionAdapter() {
                override fun mouseMoved(e: MouseEvent) {
                    val row = getClosestRowForLocation(e.x, e.y)
                    val bounds = if (row >= 0) getRowBounds(row) else null
                    val newHovered = if (bounds != null && e.y >= bounds.y && e.y < bounds.y + bounds.height) row else -1
                    if (newHovered != hoveredRow) {
                        hoveredRow = newHovered
                        repaintTree()
                    }
                }
            })
        }
    }

    override fun getDisplayName(): String = MyMessageBundle.message("settings.models.displayName")

    override fun createComponent(): JComponent {
        mainPanel.removeAll()
        pendingAdds.clear(); pendingConnects.clear(); pendingFileDeletes.clear(); pendingProviderDeletes.clear(); pendingAuthRemovals.clear(); pendingEdits.clear()
        pendingPreferred = null; preferredInitialized = false; pendingChecks.clear(); pendingUnchecks.clear()

        val openLink = JBLabel(msg("settings.models.openConfig")).apply {
            foreground = LINK_COLOR
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : MouseAdapter() { override fun mouseClicked(e: MouseEvent) = openConfigFile() })
        }

        searchField.textEditor.emptyText.text = msg("settings.models.search")
        searchField.text = ""
        searchField.textEditor.document.addDocumentListener(object : DocumentAdapter() {
            override fun textChanged(e: DocumentEvent) = rebuildTree()
        })

        // NORTH: search field above the table (where the old title was)
        val north = JPanel().apply { layout = BoxLayout(this, BoxLayout.Y_AXIS) }
        north.add(searchField)
        north.add(Box.createVerticalStrut(4))
        mainPanel.add(north, BorderLayout.NORTH)

        // CENTER: table header [+ Add Model] + tree
        val centerPanel = JPanel(BorderLayout())

        // Table header row: [+ Add Model] left-aligned with tree chevrons below
        val headerRow = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            isOpaque = true
            background = JBColor.namedColor("TableHeader.background", 0xF2F2F2)
            border = javax.swing.BorderFactory.createMatteBorder(1, 1, 1, 1, JBColor.border())
            preferredSize = Dimension(Integer.MAX_VALUE, 32)
            maximumSize = Dimension(Integer.MAX_VALUE, 32)
        }
        // 16px left padding to align + with the expand chevron in the tree below
        headerRow.add(Box.createHorizontalStrut(16))
        val addIcon = JLabel(AllIcons.General.Add).apply {
            isOpaque = false
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            preferredSize = Dimension(16, 20)
            horizontalAlignment = SwingConstants.CENTER
        }
        val addLabel = JLabel(msg("settings.models.add")).apply {
            isOpaque = false
            font = font.deriveFont(Font.BOLD, 12f)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        }
        addIcon.addMouseListener(object : MouseAdapter() { override fun mouseClicked(e: MouseEvent) = addCustomProvider() })
        addLabel.addMouseListener(object : MouseAdapter() { override fun mouseClicked(e: MouseEvent) = addCustomProvider() })
        headerRow.add(addIcon)
        headerRow.add(Box.createHorizontalStrut(4))
        headerRow.add(addLabel)
        headerRow.add(Box.createHorizontalGlue())
        centerPanel.add(headerRow, BorderLayout.NORTH)

        // Tree below header
        val treePanel = JPanel(BorderLayout()).apply {
            border = javax.swing.BorderFactory.createMatteBorder(0, 1, 1, 1, JBColor.border())
        }
        treePanel.add(JScrollPane(tree).apply { border = EmptyBorder(0, 0, 0, 0) }, BorderLayout.CENTER)
        centerPanel.add(treePanel, BorderLayout.CENTER)
        mainPanel.add(centerPanel, BorderLayout.CENTER)

        // SOUTH: open config link below table, 8px gap above and below
        val southPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
            add(Box.createVerticalStrut(8))
            add(JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
                isOpaque = false
                add(openLink)
            })
            add(Box.createVerticalStrut(8))
        }
        mainPanel.add(southPanel, BorderLayout.SOUTH)

        reload()
        return mainPanel
    }

    override fun isModified(): Boolean =
        pendingAdds.isNotEmpty() || pendingConnects.isNotEmpty() ||
            pendingFileDeletes.isNotEmpty() || pendingProviderDeletes.isNotEmpty() ||
            pendingAuthRemovals.isNotEmpty() || pendingEdits.isNotEmpty() ||
            pendingPreferred != null || pendingChecks.isNotEmpty() || pendingUnchecks.isNotEmpty()

    override fun apply() {
        val adds = pendingAdds.toList()
        val connects = pendingConnects.toList()
        val fileDeletes = pendingFileDeletes.toList()
        val providerDeletes = pendingProviderDeletes.toList()
        val authRemovals = pendingAuthRemovals.toList()
        val edits = pendingEdits.toList()
        val preferred = pendingPreferred
        // Snapshot the live maps (copy each id set) so toggles made on the
        // EDT while apply() runs on the pooled thread don't mutate the view.
        val checks = pendingChecks.mapValues { (_, ids) -> ids.toSet() }
        val unchecks = pendingUnchecks.mapValues { (_, ids) -> ids.toSet() }
        // Disable the tree during apply so checkbox toggles made while the
        // pooled-thread work is running are not silently discarded by the
        // unconditional pending-clear in the success callback below.
        tree.isEnabled = false
        ApplicationManager.getApplication().executeOnPooledThread {
            val errors = mutableListOf<String>()
            var catalog: List<DevEcoHttpApi.ModelInfo> = emptyList()
            // Snapshot provider definitions for rollback. If any operation
            // fails, re-apply the original definitions to restore the
            // pre-Apply state (full rollback, not partial).
            val rollbackSnapshots = mutableMapOf<String, DevEcoHttpApi.CustomProvider>()
            try {
                synchronized(applyDeletesLock) {
                    // Pre-snapshot all affected providers for rollback
                    val affectedProviderIds = (checks.keys + unchecks.keys).toSet()
                    for (pid in affectedProviderIds) {
                        runCatching { snapshotProviderForRollback(pid, rollbackSnapshots) }
                    }
                    if (fileDeletes.isNotEmpty()) {
                        for ((pid, mid) in fileDeletes) {
                            runCatching { service.deleteProviderModel(pid, mid) }
                                .onFailure { log.warn("Apply: deleteProviderModel $pid/$mid failed", it) }
                        }
                    }
                    for (providerId in providerDeletes) {
                        log.info("Apply: deleteProvider $providerId")
                        runCatching { service.deleteProvider(providerId) }
                            .onFailure { log.warn("Apply: deleteProvider $providerId failed", it) }
                        cleanupProviderState(providerId)
                        modelStore.removeProviderType(providerId)
                        for (m in committedModels.filter { it.providerId == providerId }) {
                            modelStore.removeCustomModel(providerId, m.modelId)
                        }
                    }
                    log.info("Apply: adds=${adds.size} connects=${connects.size} fileDeletes=${fileDeletes.size} providerDeletes=${providerDeletes.size} edits=${edits.size}")
                    for (provider in adds) {
                        runCatching { service.addCustomProvider(provider) }
                            .onFailure {
                                log.warn("Apply: addCustomProvider ${provider.id} failed", it)
                                errors.add("Provider '${provider.name}': ${it.message ?: "unknown error"}")
                            }
                            .onSuccess {
                                modelStore.addProviderType(provider.id, provider.name, "manual")
                                log.info("Apply: addCustomProvider ${provider.id} succeeded")
                            }
                    }
                    for (connect in connects) {
                        log.info("Apply: connectProvider ${connect.providerId} apiKey=${if (connect.apiKey != null) "(set)" else "null"} models=${connect.models.size}")
                        runCatching { service.connectProvider(connect.providerId, connect.apiKey, connect.models) }
                            .onFailure {
                                log.warn("Apply: connectProvider ${connect.providerId} failed", it)
                                errors.add("Provider '${connect.providerName}': ${it.message ?: "unknown error"}")
                            }
                            .onSuccess {
                                modelStore.addProviderType(connect.providerId, connect.providerName, "provider")
                            }
                    }
                    for (edit in edits) {
                        // Clean up orphaned blacklist/favorites if the
                        // provider ID changed (e.g., provider name was edited).
                        if (edit.oldProviderId != edit.newProvider.id) {
                            cleanupProviderState(edit.oldProviderId)
                            runCatching { service.deleteProvider(edit.oldProviderId) }
                                .onFailure { log.warn("Apply: deleteProvider ${edit.oldProviderId} failed", it) }
                        } else {
                            // Provider ID unchanged — explicitly delete old
                            // models that are no longer in the new definition.
                            // addCustomProvider PATCHes the config, but if the
                            // backend deep-merges, stale models would persist.
                            val newModelIds = edit.newProvider.models.map { it.id }.toSet()
                            for (oldId in edit.oldModelIds) {
                                if (oldId !in newModelIds) {
                                    runCatching { service.deleteProviderModel(edit.oldProviderId, oldId) }
                                        .onFailure { log.warn("Apply: deleteProviderModel (edit stale) ${edit.oldProviderId}/$oldId failed", it) }
                                }
                            }
                        }
                        runCatching { service.addCustomProvider(edit.newProvider) }
                            .onFailure {
                                log.warn("Apply: addCustomProvider (edit) ${edit.newProvider.id} failed", it)
                                errors.add("Provider '${edit.newProvider.name}': ${it.message ?: "unknown error"}")
                            }
                            .onSuccess {
                                if (edit.oldProviderId != edit.newProvider.id) {
                                    modelStore.removeProviderType(edit.oldProviderId)
                                }
                                modelStore.addProviderType(edit.newProvider.id, edit.newProvider.name, "manual")
                            }
                    }
                    // Delete auth for disconnected providers BEFORE
                    // refreshInstance — this ensures the backend reads
                    // the updated auth state when it restarts.
                    for (providerId in authRemovals) {
                        log.info("Apply: deleteAuthentication $providerId")
                        runCatching { service.deleteAuthentication(providerId) }
                            .onFailure { log.warn("Apply: deleteAuthentication $providerId failed", it) }
                    }
                    runCatching { service.refreshInstance() }
                        .onFailure { errors.add("Backend reload failed: ${it.message ?: "unknown error"}") }
                    // pollUntilStable and storeApiKey must stay inside the
                    // lock — storeApiKey does PUT /auth which would race
                    // with resetApiKey's DELETE /auth if it ran outside.
                    // CliTokenBridge (part of DevEco Studio) overwrites
                    // auth.json on every process start with only the deveco
                    // OAuth token, losing API keys stored by connectProvider's
                    // PUT auth call. pollUntilStable confirms the new process
                    // is running, so PUT auth now goes to the new process.
                    catalog = pollUntilStable()
                    // Refresh the catalog cache BEFORE addCustomModels below
                    // triggers customModelListener → rebuildRawModels. Without
                    // this, rebuildRawModels would use a stale cache and the
                    // connection filter would exclude newly-added models or
                    // fail to exclude disconnected providers.
                    if (catalog.isNotEmpty()) {
                        val applyProviders = runCatching { service.availableProviders() }.getOrElse { emptyList() }
                        val applyDisconnected = applyProviders.filter { !it.hasAuth }.map { it.id }.toSet()
                        val safeCatalog = if (applyDisconnected.isNotEmpty()) {
                            catalog.filter { it.providerId !in applyDisconnected }
                        } else {
                            catalog
                        }
                        modelStore.cacheCatalog(safeCatalog)
                    }
                    for (connect in connects) {
                        if (connect.apiKey != null) {
                            log.info("Apply: re-storing API key for ${connect.providerId} after reload")
                            runCatching { service.storeApiKey(connect.providerId, connect.apiKey) }
                                .onFailure { log.warn("Apply: re-store API key failed for ${connect.providerId}", it) }
                        }
                    }
                    // Re-fetch the catalog AFTER re-storing API keys. The
                    // pollUntilStable catalog was fetched BEFORE storeApiKey,
                    // so it may not include models from providers whose auth
                    // was lost during reload (CliTokenBridge overwrite) and
                    // only re-appeared after the PUT /auth above. Without this,
                    // the cached catalog is stale and rebuildRawModels' catalog
                    // filter hides the newly-added models from the dropdown.
                    val refreshedCatalog = runCatching { service.modelCatalog() }.getOrElse { emptyList() }
                    if (refreshedCatalog.isNotEmpty()) {
                        val rp = runCatching { service.availableProviders() }.getOrElse { emptyList() }
                        val rd = rp.filter { !it.hasAuth }.map { it.id }.toSet()
                        catalog = if (rd.isNotEmpty()) refreshedCatalog.filter { it.providerId !in rd } else refreshedCatalog
                        modelStore.cacheCatalog(catalog)
                    }
                }
                for (provider in adds) {
                    val providerInCatalog = catalog.any { it.providerId == provider.id }
                    // Always register custom models in the store — the
                    // provider definition is in the config; models should
                    // be visible in the dropdown even if the provider is
                    // not yet connected (no API key). updateModels() merges
                    // modelStore.getCustomModels() into the dropdown.
                    modelStore.addCustomModels(provider.models.map {
                        SessionModelStore.CustomModelEntry(provider.id, provider.name, it.id, it.name)
                    })
                    if (!providerInCatalog && !provider.apiKey.isNullOrBlank()) {
                        errors.add("Provider '${provider.name}': not found in catalog after apply (backend may not have reloaded)")
                    }
                }
                for (connect in connects) {
                    val providerInCatalog = catalog.any { it.providerId == connect.providerId }
                    if (providerInCatalog) {
                        modelStore.addCustomModels(connect.models.map {
                            SessionModelStore.CustomModelEntry(connect.providerId, connect.providerName, it.id, it.name)
                        })
                    } else {
                        val reason = if (connect.apiKey == null)
                            "API key not found in backend - please re-enter the API key for this provider"
                        else
                            "provider may not be connected"
                        errors.add("Provider '${connect.providerName}': $reason")
                    }
                }
                for (edit in edits) {
                    val providerInCatalog = catalog.any { it.providerId == edit.newProvider.id }
                    // Only update the custom models registry when the provider is
                    // connected (in catalog) OR is a "manual" type provider whose
                    // API key is optional — keyless manual providers don't appear
                    // in the catalog, but their edited models must still be
                    // registered so the settings page and dropdown reflect the edit.
                    if (providerInCatalog || modelStore.getProviderType(edit.newProvider.id) == "manual") {
                        for (oldId in edit.oldModelIds) {
                            modelStore.removeCustomModel(edit.oldProviderId, oldId)
                        }
                        modelStore.addCustomModels(edit.newProvider.models.map {
                            SessionModelStore.CustomModelEntry(edit.newProvider.id, edit.newProvider.name, it.id, it.name)
                        })
                    }
                }
                // Process pending checkbox toggles — sync to backend config
                // so the backend's model Select choices match the checked state.
                applyCheckboxToggles(checks, unchecks, errors)
                // Commit the pending toggle overlay to the local blacklist now
                // that the backend sync has run. Until here the overlay was
                // render-only (rebuildTree showed committed ∪ pendingUnchecks −
                // pendingChecks) and modelStore held the pre-Apply state, so the
                // chat dropdown and a Cancel/reopen showed committed state.
                // Skip toggles for models this same Apply deleted/renamed
                // (fileDeletes, deleted/disconnected providers, edited-away
                // models) so we don't re-create stale blacklist entries the
                // delete/edit paths just cleaned up.
                val skipProviderIds = (providerDeletes + authRemovals +
                    edits.filter { it.oldProviderId != it.newProvider.id }.map { it.oldProviderId }).toSet()
                val skipModelKeys = fileDeletes.toMutableSet().apply {
                    for (edit in edits) {
                        if (edit.oldProviderId == edit.newProvider.id) {
                            val newModelIds = edit.newProvider.models.map { it.id }.toSet()
                            for (oldId in edit.oldModelIds) {
                                if (oldId !in newModelIds) add(edit.oldProviderId to oldId)
                            }
                        }
                    }
                }
                for ((pid, mids) in checks) {
                    if (pid in skipProviderIds) continue
                    for (mid in mids) {
                        if ((pid to mid) in skipModelKeys) continue
                        modelStore.removeFromBlacklist(pid, mid)
                    }
                }
                for ((pid, mids) in unchecks) {
                    if (pid in skipProviderIds) continue
                    for (mid in mids) {
                        if ((pid to mid) in skipModelKeys) continue
                        modelStore.addToBlacklist(pid, mid)
                    }
                }
                if (preferred != null) modelStore.setGlobalModelId(preferred.ifBlank { null })
                // Migrate modelId-keyed state when a single model's id was
                // renamed (editModel). oldSingleModelId carries the pre-edit
                // id; the new id is the one model in newProvider.models absent
                // from oldModelIds. editProvider batch renames carry no
                // oldSingleModelId and skip — falling through to updateModels'
                // global-expired clear (current behavior) instead of guessing
                // a pairing. Runs after preferred is applied so a preferred
                // value still pointing at oldId is migrated too.
                for (edit in edits) {
                    val oldId = edit.oldSingleModelId ?: continue
                    if (edit.oldProviderId != edit.newProvider.id) continue
                    val newId = edit.newProvider.models.firstOrNull { it.id !in edit.oldModelIds }?.id ?: continue
                    if (newId == oldId) continue
                    if (modelStore.getGlobalModelId() == oldId) {
                        modelStore.setGlobalModelId(newId)
                    }
                    modelStore.migrateModelId(edit.oldProviderId, oldId, newId)
                    log.info("Apply: migrated modelId $oldId -> $newId for provider ${edit.oldProviderId}")
                }
                project.messageBus.syncPublisher(SESSION_REFRESH_TOPIC).onSessionsChanged()
                ApplicationManager.getApplication().invokeLater {
                    pendingAdds.clear(); pendingConnects.clear(); pendingFileDeletes.clear()
                    pendingProviderDeletes.clear(); pendingAuthRemovals.clear(); pendingEdits.clear(); pendingPreferred = null; pendingChecks.clear(); pendingUnchecks.clear()
                    // Filter out models for deleted/disconnected providers and
                    // individually deleted models. deleteProvider only adds the
                    // provider to disabled_providers (doesn't remove the
                    // definition), and deleteProviderModel may fail silently.
                    // The backend catalog may therefore still include them.
                    val deletedProviderIds = (providerDeletes + authRemovals).toSet()
                    // Collect stale model IDs from edits (models whose ID
                    // changed) in addition to individually deleted models.
                    // If deleteProviderModel fails for these, the catalog
                    // would still include them — filter them out here.
                    val staleFromEdits = mutableSetOf<Pair<String, String>>()
                    for (edit in edits) {
                        if (edit.oldProviderId == edit.newProvider.id) {
                            val newModelIds = edit.newProvider.models.map { it.id }.toSet()
                            for (oldId in edit.oldModelIds) {
                                if (oldId !in newModelIds) {
                                    staleFromEdits.add(edit.oldProviderId to oldId)
                                }
                            }
                        }
                    }
                    val deletedModelKeys = fileDeletes.toSet() + staleFromEdits
                    // Don't overwrite committedModels/cache with empty when
                    // the backend is still restarting (pollUntilStable may
                    // return empty). Fall back to the previous list filtered
                    // by deletions so the UI doesn't go blank.
                    val filtered = if (catalog.isNotEmpty()) {
                        catalog.filter { model ->
                            model.providerId !in deletedProviderIds &&
                                (model.providerId to model.modelId) !in deletedModelKeys
                        }
                    } else {
                        committedModels.filter { model ->
                            model.providerId !in deletedProviderIds &&
                                (model.providerId to model.modelId) !in deletedModelKeys
                        }
                    }
                    committedModels = mergeCustomModels(filtered)
                    committedPreferred = modelStore.getGlobalModelId()
                    preferredInitialized = true
                    modelStore.cacheCatalog(committedModels)
                    rebuildTree()
                    if (errors.isNotEmpty()) {
                        Messages.showErrorDialog(
                            project,
                            errors.joinToString("\n"),
                            msg("settings.models.applyErrors"),
                        )
                    }
                    tree.isEnabled = true
                }
            } catch (e: Exception) {
                log.warn("Apply failed", e)
                // Full rollback: re-apply pre-Apply provider definitions
                if (rollbackSnapshots.isNotEmpty()) {
                    log.info("Rolling back ${rollbackSnapshots.size} provider definitions")
                    for ((_, provider) in rollbackSnapshots) {
                        runCatching { service.addCustomProvider(provider) }
                            .onFailure { log.warn("Rollback failed for ${provider.id}", it) }
                    }
                    runCatching { service.refreshInstance() }
                }
                ApplicationManager.getApplication().invokeLater {
                    Messages.showErrorDialog(project, e.message ?: "Apply failed", "Models")
                    tree.isEnabled = true
                }
            }
        }
    }

    override fun reset() {
        pendingAdds.clear(); pendingConnects.clear(); pendingFileDeletes.clear()
        pendingProviderDeletes.clear(); pendingAuthRemovals.clear(); pendingEdits.clear(); pendingPreferred = null; pendingChecks.clear(); pendingUnchecks.clear()
        reload()
    }

    // --- staging actions ---

    private fun addCustomProvider() {
        val bl = modelStore.getBlacklist().map { it.providerId to it.modelId }.toSet()
        val dialog = AddModelDialog(project, projectedAllModelInfos(), bl)
        if (!dialog.showAndGet()) {
            // Even on Cancel, if resetApiKey mutated the backend, reload
            // so the settings page reflects the deleted auth state.
            if (dialog.backendMutated) reload()
            return
        }
        when (val r = dialog.result) {
            is AddModelResult.AddCustom -> {
                pendingAdds.add(r.provider)
                rebuildTree()
                apply()
            }
            is AddModelResult.ConnectExisting -> {
                pendingConnects.removeAll { it.providerId == r.providerId }
                // Disconnection: key was reset (provider.hasAuth=false in the
                // dialog) and no new key was entered. Use the disconnected flag
                // set by validateTab1's disconnect branch — NOT apiKey==null,
                // which is also true when the prefill placeholder is showing
                // for a provider that still has auth (user unchecked all
                // models but didn't reset the key).
                val isDisconnecting = r.disconnected
                if (r.allModels.isNotEmpty() && !isDisconnecting) {
                    pendingConnects.add(PendingConnect(r.providerId, r.providerName, r.apiKey, r.allModels))
                }
                val pendingAddIdx = pendingAdds.indexOfFirst { it.id == r.providerId }
                if (pendingAddIdx >= 0) {
                    val provider = pendingAdds[pendingAddIdx]
                    val deleteIds = r.toDelete.map { it.id }.toSet()
                    val remaining = provider.models.filter { it.id !in deleteIds }
                    if (remaining.isEmpty()) pendingAdds.removeAt(pendingAddIdx)
                    else pendingAdds[pendingAddIdx] = provider.copy(models = remaining)
                }
                for (model in r.models) {
                    modelStore.removeFromBlacklist(r.providerId, model.id)
                }
                for (model in r.unselectedModels) {
                    modelStore.addToBlacklist(r.providerId, model.id)
                }
                for (model in r.toDelete) {
                    modelStore.addToBlacklist(r.providerId, model.id)
                    modelStore.removeCustomModel(r.providerId, model.id)
                    if (isDisconnecting) {
                        pendingFileDeletes.add(r.providerId to model.id)
                    }
                }
                if (isDisconnecting) {
                    pendingAuthRemovals.add(r.providerId)
                }
                // Do NOT publish SESSION_REFRESH_TOPIC here - the connection
                // (API key + model registration) is staged in pendingConnects
                // and not yet applied to the backend. Publishing now would
                // make the model selector refresh and show models the backend
                // can't actually serve (no API key stored yet). The topic is
                // published in apply() after the connection is established.
                rebuildTree()
                apply()
            }
            null -> {}
        }
    }

    private fun handleProviderClick(e: MouseEvent, group: ProviderGroupNode): Boolean {
        if (group.type != "manual") return false
        val w = tree.width
        val actionCount = 2
        val btnWidth = 28
        val actionStart = w - actionCount * btnWidth - 4
        if (e.x < actionStart) return false
        val idx = (e.x - actionStart) / btnWidth
        when (idx) {
            0 -> editProvider(group)
            1 -> deleteProvider(group)
        }
        return true
    }

    private fun handleModelClick(e: MouseEvent, m: DevEcoHttpApi.ModelInfo, rowIndent: Int) {
        val w = tree.width
        val type = typeCache[m.providerId] ?: "provider"
        val relX = e.x - rowIndent
        // Checkbox: only "builtin" is view-only (no toggle).
        // "provider" and "manual" support checkbox toggle.
        if (type != "builtin" && relX in 0..20) {
            toggleBlacklist(m)
            return
        }
        // Action buttons (edit/delete) only for "manual" type, laid out right-to-left.
        val actionCount = when (type) {
            "manual" -> 2 // edit, delete
            else -> 0 // builtin and provider: no action buttons
        }
        if (actionCount == 0) return
        val btnWidth = 28
        val actionStart = w - actionCount * btnWidth - 4
        if (e.x < actionStart) return
        val idx = (e.x - actionStart) / btnWidth
        when (type) {
            "manual" -> when (idx) {
                0 -> editModel(m)
                1 -> deleteModel(m)
            }
        }
    }

    private fun toggleBlacklist(m: DevEcoHttpApi.ModelInfo) {
        val key = m.providerId to m.modelId
        val committedBlacklisted = modelStore.isBlacklisted(m.providerId, m.modelId)
        val pendingCheck = pendingChecks[m.providerId]?.contains(m.modelId) ?: false
        val pendingUncheck = pendingUnchecks[m.providerId]?.contains(m.modelId) ?: false
        val effectivelyBlacklisted = (committedBlacklisted || pendingUncheck) && !pendingCheck
        if (effectivelyBlacklisted) {
            // Currently unchecked → user wants to check it. Do NOT write the
            // model-store blacklist here; flip the pending overlay instead so
            // the change stays discardable until Apply.
            if (committedBlacklisted) {
                pendingChecks.getOrPut(m.providerId) { mutableSetOf() }.add(m.modelId)
            } else {
                removePendingToggle(pendingUnchecks, m.providerId, m.modelId)
            }
            blacklistCache = blacklistCache - key
        } else {
            // Currently checked → user wants to uncheck it.
            if (committedBlacklisted) {
                removePendingToggle(pendingChecks, m.providerId, m.modelId)
            } else {
                pendingUnchecks.getOrPut(m.providerId) { mutableSetOf() }.add(m.modelId)
            }
            blacklistCache = blacklistCache + key
        }
        // Do NOT publish SESSION_REFRESH_TOPIC here — neither the backend
        // config nor the committed blacklist has changed. The topic is
        // published in apply() after the backend sync + blacklist commit.
        rebuildTree()
    }

    // Drop one model from a pending-toggle map; remove the provider entry
    // when its id set empties so isModified()/apply() don't see stale keys.
    private fun removePendingToggle(map: MutableMap<String, MutableSet<String>>, providerId: String, modelId: String) {
        val ids = map[providerId] ?: return
        ids.remove(modelId)
        if (ids.isEmpty()) map.remove(providerId)
    }

    private fun deleteProvider(group: ProviderGroupNode) {
        val confirm = Messages.showOkCancelDialog(
            project,
            MyMessageBundle.message("settings.models.deleteProviderConfirm", group.providerName),
            msg("settings.models.delete"),
            msg("settings.models.delete"),
            Messages.getCancelButton(),
            Messages.getWarningIcon(),
        )
        if (confirm != Messages.OK) return
        stageProviderDeletion(group.providerId)
        rebuildTree()
        apply()
    }

    private fun stageProviderDeletion(providerId: String) {
        pendingProviderDeletes.add(providerId)
        pendingAdds.removeAll { it.id == providerId }
        pendingConnects.removeAll { it.providerId == providerId }
        pendingEdits.removeAll { it.oldProviderId == providerId }
        pendingFileDeletes.removeAll { it.first == providerId }
        pendingAuthRemovals.removeAll { it == providerId }
        cleanupProviderState(providerId)
        val modelsToRemove = committedModels.filter { it.providerId == providerId }
        // Update cache BEFORE removeCustomModel so rebuildRawModels (triggered
        // by customModelListener) uses fresh cache and excludes the deleted
        // provider's models from connectedBackend. Without this, the dropdown
        // would still show the provider's models until the async
        // refreshModels() completes (~500ms later).
        committedModels = committedModels.filterNot { it.providerId == providerId }
        modelStore.cacheCatalog(committedModels)
        for (m in modelsToRemove) {
            modelStore.removeCustomModel(providerId, m.modelId)
        }
        modelStore.removeProviderType(providerId)
    }

    private fun deleteModel(m: DevEcoHttpApi.ModelInfo) {
        val providerModels = projectedAllModelInfos().filter { it.providerId == m.providerId }
        val isLastModel = providerModels.size == 1
        val confirm = Messages.showOkCancelDialog(
            project,
            if (isLastModel) MyMessageBundle.message("settings.models.deleteLastModelConfirm", m.providerName)
            else MyMessageBundle.message("settings.models.deleteConfirm", m.modelName),
            msg("settings.models.delete"),
            msg("settings.models.delete"),
            Messages.getCancelButton(),
            if (isLastModel) Messages.getWarningIcon() else Messages.getQuestionIcon(),
        )
        if (confirm != Messages.OK) return
        if (isLastModel) {
            stageProviderDeletion(m.providerId)
        } else {
            // For manual type, stage a provider edit to replace the
            // definition via addCustomProvider. deleteProviderModel alone
            // may not reliably remove the model from the backend config.
            // Compute oldModelIds/remainingModels BEFORE the cache update
            // below so oldModelIds includes the deleted model (needed by
            // apply()'s edit loop for stale-model cleanup).
            val type = typeCache[m.providerId] ?: "provider"
            val manualOldModelIds = if (type == "manual") {
                committedModels.filter { it.providerId == m.providerId }
                    .map { it.modelId }.toSet()
            } else emptySet()
            val manualRemaining = if (type == "manual") {
                committedModels.filter { it.providerId == m.providerId && it.modelId != m.modelId }
                    .map { DevEcoHttpApi.CustomModel(it.modelId, it.modelName) }
            } else emptyList()
            // Remove from any pending adds/connects that reference this model.
            val stagedInAdds = pendingAdds.indexOfFirst { p ->
                p.id == m.providerId && p.models.any { it.id == m.modelId }
            }
            if (stagedInAdds >= 0) {
                val provider = pendingAdds[stagedInAdds]
                val remaining = provider.models.filter { it.id != m.modelId }
                if (remaining.isEmpty()) pendingAdds.removeAt(stagedInAdds)
                else pendingAdds[stagedInAdds] = provider.copy(models = remaining)
            }
            val stagedInConnects = pendingConnects.indexOfFirst { c ->
                c.providerId == m.providerId && c.models.any { it.id == m.modelId }
            }
            if (stagedInConnects >= 0) {
                val connect = pendingConnects[stagedInConnects]
                val remaining = connect.models.filter { it.id != m.modelId }
                if (remaining.isEmpty()) pendingConnects.removeAt(stagedInConnects)
                else pendingConnects[stagedInConnects] = connect.copy(models = remaining)
            }
            // Update cache BEFORE removeCustomModel/removeFromBlacklist so
            // rebuildRawModels (triggered by listeners) uses fresh cache and
            // excludes the deleted model from connectedBackend.
            committedModels = committedModels.filterNot {
                it.providerId == m.providerId && it.modelId == m.modelId
            }
            modelStore.cacheCatalog(committedModels)
            modelStore.removeCustomModel(m.providerId, m.modelId)
            // Clean up stale blacklist/favorite entries for the deleted model.
            modelStore.removeFromBlacklist(m.providerId, m.modelId)
            modelStore.removeFavorite(m.providerId, m.modelId)
            pendingFileDeletes.add(m.providerId to m.modelId)
            if (type == "manual" && manualRemaining.isNotEmpty()) {
                val providerName = m.providerName
                val baseUrl = providerBaseUrls[m.providerId] ?: ""
                if (baseUrl.isNotEmpty()) {
                    val updated = DevEcoHttpApi.CustomProvider(
                        m.providerId, providerName, baseUrl, null, emptyMap(), manualRemaining,
                    )
                    pendingEdits.removeAll { it.oldProviderId == m.providerId }
                    pendingEdits.add(PendingEdit(m.providerId, updated, manualOldModelIds))
                }
            }
        }
        rebuildTree()
        apply()
    }

    private fun editProvider(group: ProviderGroupNode) {
        val providerId = group.providerId
        val providerName = group.providerName
        openEditDialog(providerId, providerName, singleModel = false)
    }

    private fun editModel(m: DevEcoHttpApi.ModelInfo) {
        openEditDialog(m.providerId, m.providerName, singleModel = true, modelId = m.modelId, modelName = m.modelName)
    }

    private fun openEditDialog(
        providerId: String,
        providerName: String,
        singleModel: Boolean,
        modelId: String? = null,
        modelName: String? = null,
    ) {
        val allModels = committedModels.filter { it.providerId == providerId }
        val allModelInfos = allModels.map { DevEcoHttpApi.ProviderModelInfo(it.modelId, it.modelName) }
        val editModels = if (singleModel && modelId != null) {
            listOf(DevEcoHttpApi.ProviderModelInfo(modelId, modelName ?: modelId))
        } else {
            allModelInfos
        }
        val baseUrl = providerBaseUrls[providerId] ?: ""
        val hasAuth = providerAuthMap[providerId] ?: committedModels.any { it.providerId == providerId && it.source != "manual" }
        val dialog = AddModelDialog(
            project,
            projectedAllModelInfos(),
            modelStore.getBlacklist().map { it.providerId to it.modelId }.toSet(),
            editProviderId = providerId,
            editProviderName = providerName,
            editBaseUrl = baseUrl,
            editModels = editModels,
            editSingleModelId = if (singleModel) modelId else null,
            editAllModels = allModelInfos,
            editHasAuth = hasAuth,
        )
        if (!dialog.showAndGet()) {
            if (dialog.backendMutated) reload()
            return
        }
        val r = dialog.result as? AddModelResult.AddCustom ?: return
        val oldModelIds = allModelInfos.map { it.id }.toSet()
        pendingEdits.removeAll { it.oldProviderId == providerId }
        pendingEdits.add(PendingEdit(providerId, r.provider, oldModelIds, oldSingleModelId = if (singleModel) modelId else null))
        rebuildTree()
        apply()
    }

    private fun getModelType(providerId: String): String {
        if (providerId.equals("deveco", ignoreCase = true)) return "builtin"
        if (pendingAdds.any { it.id == providerId }) return "manual"
        if (pendingConnects.any { it.providerId == providerId }) return "provider"
        // For providers added before the type registry existed, default to
        // "provider" - this is the safe choice: provider-added models get
        // favorite-only (correct), and manually-added models lose delete/edit
        // until re-added through the dialog (acceptable migration cost).
        return modelStore.getProviderType(providerId) ?: "provider"
    }

    private fun cleanupProviderState(providerId: String) {
        // Remove all blacklist and favorite entries for the old provider in
        // a single batch operation each - avoids N individual file writes.
        modelStore.removeBlacklistForProvider(providerId)
        modelStore.removeFavoritesForProvider(providerId)
    }

    private fun openConfigFile() {
        ApplicationManager.getApplication().invokeLater {
            val path = opencodeConfigDir.resolve("deveco.json")
            try {
                if (!Files.exists(path)) {
                    Files.createDirectories(path.parent)
                    Files.writeString(path, "{}")
                }
                val pathStr = path.toString().replace('\\', '/')
                var vfile = LocalFileSystem.getInstance().findFileByPath(pathStr)
                if (vfile == null) vfile = LocalFileSystem.getInstance().refreshAndFindFileByPath(pathStr)
                if (vfile != null) {
                    FileEditorManager.getInstance(project).openFile(vfile, true)
                    SwingUtilities.getWindowAncestor(mainPanel)?.dispose()
                } else {
                    Messages.showErrorDialog(project, "Cannot locate: $pathStr", msg("settings.models.openConfig"))
                }
            } catch (e: Exception) {
                log.warn("Open config file failed", e)
                Messages.showErrorDialog(project, e.message ?: "failed", msg("settings.models.openConfig"))
            }
        }
    }

    // --- data + rendering ---

    private fun mergeCustomModels(catalog: List<DevEcoHttpApi.ModelInfo>): List<DevEcoHttpApi.ModelInfo> {
        // Merge registry models for providers that are either:
        // 1. IN the catalog (connected — has API key or is builtin deveco), or
        // 2. Type "manual" — the user intentionally added them without an
        //    API key (Tab 2's API key is optional). These providers may work
        //    without auth (e.g., local model servers) and must remain visible.
        // Providers whose key was reset (type "provider", not in catalog)
        // are excluded — they're genuinely disconnected.
        val catalogProviderIds = catalog.map { it.providerId }.toSet()
        val customModels = modelStore.getCustomModels()
            .filter { it.providerId in catalogProviderIds || modelStore.getProviderType(it.providerId) == "manual" }
        val customProviderIds = customModels.map { it.providerId }.toSet()
        val registryModels = customModels.map {
            DevEcoHttpApi.ModelInfo(it.providerId, it.providerName, it.modelId, it.modelName, "config")
        }
        val catalogModels = catalog.filter { it.providerId !in customProviderIds }
        return catalogModels + registryModels
    }

    private fun reload() {
        val cached = modelStore.getCachedCatalog()
        if (cached.isNotEmpty()) {
            committedModels = mergeCustomModels(cached)
            committedPreferred = modelStore.getGlobalModelId()
            preferredInitialized = true
            rebuildTree()
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            if (!service.isConnected()) service.connect()
            var models = runCatching { service.modelCatalog() }.getOrElse { emptyList() }
            var attempts = 0
            while (models.isEmpty() && attempts < 10 && service.isConnected()) {
                try { Thread.sleep(300) } catch (_: InterruptedException) {}
                models = runCatching { service.modelCatalog() }.getOrElse { emptyList() }
                attempts++
            }
            val providers = runCatching { service.availableProviders() }.getOrElse { emptyList() }
            val baseUrls = providers.associate { it.id to (it.baseUrl ?: "") }
            val authStates = providers.associate { it.id to it.hasAuth }
            // Filter out models from providers whose API key was removed
            // (hasAuth=false). modelCatalog() already checks the "key" field,
            // but if the backend hasn't fully restarted after
            // resetApiKey's refreshInstance, it may serve stale data from
            // the old instance. availableProviders() reads the same payload
            // but the hasAuth check is an independent safety net.
            val disconnectedIds = providers.filter { !it.hasAuth }.map { it.id }.toSet()
            val filteredModels = if (models.isNotEmpty() && disconnectedIds.isNotEmpty()) {
                models.filter { it.providerId !in disconnectedIds }
            } else {
                models
            }
            ApplicationManager.getApplication().invokeLater {
                // Don't overwrite committedModels/cache with empty when the
                // backend is still restarting after refreshInstance(). Keep
                // the previously-cached list visible until a real fetch
                // succeeds. This prevents the "second open shows nothing"
                // symptom.
                if (filteredModels.isNotEmpty() || committedModels.isEmpty()) {
                    committedModels = mergeCustomModels(filteredModels)
                    modelStore.cacheCatalog(committedModels)
                }
                providerBaseUrls = baseUrls
                providerAuthMap = authStates
                committedPreferred = modelStore.getGlobalModelId()
                preferredInitialized = true
                rebuildTree()
            }
        }
    }

    private fun pollUntilStable(): List<DevEcoHttpApi.ModelInfo> {
        var current = runCatching { service.modelCatalog() }.getOrElse { emptyList() }
        var prevKeys = current.map { it.providerId to it.modelId }.toSet()
        var attempts = 0
        while (attempts < 8) {
            try { Thread.sleep(300) } catch (_: InterruptedException) {}
            val next = runCatching { service.modelCatalog() }.getOrElse { emptyList() }
            val nextKeys = next.map { it.providerId to it.modelId }.toSet()
            current = next
            // Don't break on empty-empty: the backend is likely still
            // restarting after refreshInstance(). Two consecutive empty
            // reads do NOT mean "stable" — they mean "not ready yet".
            // Only break when we have a non-empty stable result, or after
            // exhausting all attempts.
            if (nextKeys == prevKeys && nextKeys.isNotEmpty()) break
            prevKeys = nextKeys
            attempts++
        }
        return current
    }

    // Snapshot a provider's current definition for rollback. For manual type,
    // reconstructs the CustomProvider from committedModels + providerBaseUrls.
    // For provider type, uses availableProviderModels + connectProvider's
    // model list format.
    private fun snapshotProviderForRollback(
        providerId: String,
        snapshots: MutableMap<String, DevEcoHttpApi.CustomProvider>,
    ) {
        if (providerId in snapshots) return
        val type = typeCache[providerId] ?: modelStore.getProviderType(providerId) ?: "provider"
        val models = committedModels.filter { it.providerId == providerId }
            .map { DevEcoHttpApi.CustomModel(it.modelId, it.modelName) }
        if (models.isEmpty()) return
        val providerName = models.firstOrNull()?.let { committedModels.firstOrNull { m -> m.providerId == providerId }?.providerName }
            ?: providerId
        val baseUrl = providerBaseUrls[providerId] ?: ""
        if (type == "manual" && baseUrl.isNotEmpty()) {
            snapshots[providerId] = DevEcoHttpApi.CustomProvider(providerId, providerName, baseUrl, null, emptyMap(), models)
        } else {
            // Provider type — use connectProvider format (id, name, models)
            // Reconstruct as CustomProvider for uniform rollback via addCustomProvider
            if (baseUrl.isNotEmpty()) {
                snapshots[providerId] = DevEcoHttpApi.CustomProvider(providerId, providerName, baseUrl, null, emptyMap(), models)
            }
        }
    }

    // Sync pending checkbox toggles to backend config. For each affected
    // provider, compute the updated model list (add checked, remove unchecked)
    // and call connectProvider (provider type) or addCustomProvider (manual
    // type). connectProvider with apiKey=null preserves the existing API key
    // and only patches the model list.
    private fun applyCheckboxToggles(
        checks: Map<String, Set<String>>,
        unchecks: Map<String, Set<String>>,
        errors: MutableList<String>,
    ) {
        if (checks.isEmpty() && unchecks.isEmpty()) return
        // checks/unchecks are already grouped providerId → modelIds.
        // toggleBlacklist removes a model from the opposite side on each flip,
        // so a given (providerId, modelId) lives in at most one of them —
        // merge per provider: add checked ids, drop unchecked ids.
        for (providerId in checks.keys + unchecks.keys) {
            val type = typeCache[providerId] ?: modelStore.getProviderType(providerId) ?: "provider"
            val currentModels = committedModels.filter { it.providerId == providerId }
                .map { DevEcoHttpApi.ProviderModelInfo(it.modelId, it.modelName) }
            val currentIds = currentModels.map { it.id }.toMutableSet()
            checks[providerId]?.forEach { currentIds.add(it) }
            unchecks[providerId]?.forEach { currentIds.remove(it) }
            val updatedModels = currentModels.filter { it.id in currentIds }
            val providerName = committedModels.firstOrNull { it.providerId == providerId }?.providerName ?: providerId
            try {
                if (type == "manual") {
                    val baseUrl = providerBaseUrls[providerId] ?: ""
                    if (baseUrl.isNotEmpty()) {
                        val customModels = updatedModels.map { DevEcoHttpApi.CustomModel(it.id, it.name) }
                        service.addCustomProvider(
                            DevEcoHttpApi.CustomProvider(providerId, providerName, baseUrl, null, emptyMap(), customModels),
                        )
                    }
                } else {
                    // Provider type — connectProvider with apiKey=null preserves
                    // the existing API key and patches the model list.
                    service.connectProvider(providerId, null, updatedModels)
                }
                log.info("Checkbox toggle applied for $providerId: ${updatedModels.size} models")
            } catch (e: Exception) {
                log.warn("Checkbox toggle failed for $providerId", e)
                errors.add("Provider '$providerName': ${e.message ?: "failed to update models"}")
            }
        }
    }

    private fun projectedAllModelInfos(): List<DevEcoHttpApi.ModelInfo> {
        val deleteKeys = pendingFileDeletes.toSet()
        val providerDeletes = pendingProviderDeletes.toSet()
        // Exclude committedModels for providers with pending edits — the
        // edited data from pendingEdits replaces the old data.
        val editedProviderIds = pendingEdits.map { it.oldProviderId }.toSet()
        val combined = committedModels.filter { it.providerId !in providerDeletes && it.providerId !in editedProviderIds } +
            pendingAdds.flatMap { p ->
                p.models.map { DevEcoHttpApi.ModelInfo(p.id, p.name, it.id, it.name, "config") }
            } + pendingConnects.flatMap { c ->
                c.models.map { DevEcoHttpApi.ModelInfo(c.providerId, c.providerName, it.id, it.name, "config") }
            } + pendingEdits.flatMap { e ->
                e.newProvider.models.map { DevEcoHttpApi.ModelInfo(e.newProvider.id, e.newProvider.name, it.id, it.name, "config") }
            }
        val seen = mutableSetOf<Pair<String, String>>()
        return combined
            .filter { it.providerId !in providerDeletes }
            .filter { (it.providerId to it.modelId) !in deleteKeys }
            .filter { seen.add(it.providerId to it.modelId) }
    }

    private var treeRebuildPending = false

    private fun rebuildTree() {
        if (treeRebuildPending) return
        treeRebuildPending = true
        SwingUtilities.invokeLater {
            treeRebuildPending = false
            // Preserve expansion state across rebuilds so toggling a checkbox
            // in one provider doesn't expand/collapse other providers.
            val expandedProviderIds = mutableSetOf<String>()
            for (row in 0 until tree.rowCount) {
                if (tree.isExpanded(row)) {
                    val path = tree.getPathForRow(row)
                    val node = path?.lastPathComponent as? DefaultMutableTreeNode
                    val groupNode = node?.userObject as? ProviderGroupNode
                    if (groupNode != null) expandedProviderIds.add(groupNode.providerId)
                }
            }

            // Build cached lookup maps so the renderer doesn't do O(n)
            // scans per row per repaint.
            val allModels = projectedAllModelInfos()
            typeCache = allModels.map { it.providerId }.distinct().associateWith { getModelType(it) }
            val committedBlacklist = modelStore.getBlacklist().map { it.providerId to it.modelId }.toSet()
            // Effective rendered blacklist = committed ∪ pendingUnchecks − pendingChecks.
            blacklistCache = buildSet {
                addAll(committedBlacklist)
                for ((pid, mids) in pendingUnchecks) for (mid in mids) add(pid to mid)
                for ((pid, mids) in pendingChecks) for (mid in mids) remove(pid to mid)
            }

            val root = DefaultMutableTreeNode("root")
            val filter = searchField.text.trim().lowercase()

            val filteredModels = allModels.let { all ->
                if (filter.isEmpty()) all else all.filter {
                    it.modelName.lowercase().contains(filter) || it.modelId.lowercase().contains(filter) ||
                        it.providerName.lowercase().contains(filter) || it.providerId.lowercase().contains(filter)
                }
            }

            val grouped = filteredModels.groupBy { it.providerId }
                .toList()
                .sortedWith(compareBy { providerDisplayName(it.first).lowercase() })

            for ((providerId, models) in grouped) {
                val providerName = models.firstOrNull()?.providerName ?: providerDisplayName(providerId)
                val type = typeCache[providerId] ?: "provider"
                val groupNode = ProviderGroupNode(providerId, providerName, type, models.size)
                val node = DefaultMutableTreeNode(groupNode)
                models.sortedWith(compareBy({ it.modelName.lowercase() }, { it.modelId.lowercase() }))
                    .forEach { node.add(DefaultMutableTreeNode(it)) }
                root.add(node)
            }

            treeModel.setRoot(root)
            hoveredRow = -1
            // Restore expansion state. On first load (empty set), expand all.
            if (expandedProviderIds.isEmpty()) {
                for (i in 0 until tree.rowCount) {
                    tree.expandRow(i)
                }
            } else {
                for (row in 0 until tree.rowCount) {
                    val path = tree.getPathForRow(row)
                    val node = path?.lastPathComponent as? DefaultMutableTreeNode
                    val groupNode = node?.userObject as? ProviderGroupNode
                    if (groupNode != null && groupNode.providerId in expandedProviderIds) {
                        tree.expandRow(row)
                    }
                }
            }
        }
    }

    private fun providerDisplayName(providerId: String): String {
        committedModels.firstOrNull { it.providerId == providerId }?.let { return it.providerName }
        modelStore.getProviderTypes().firstOrNull { it.providerId == providerId }?.let { return it.providerName }
        return providerId
    }

    // --- Apply helpers ---

    private fun msg(key: String): String = MyMessageBundle.message(key)

    private val LINK_COLOR: Color = JBColor(0x2476E0, 0x5893F5)
    private val HOVER_BG: Color = JBColor.namedColor("Table.hoverBackground", 0xEDF3FF)

    private fun repaintTree() = tree.repaint()

    // --- tree node types ---

    private data class ProviderGroupNode(
        val providerId: String,
        val providerName: String,
        val type: String,
        val count: Int,
    )

    private data class PendingConnect(val providerId: String, val providerName: String, val apiKey: String?, val models: List<DevEcoHttpApi.ProviderModelInfo>)

    private data class PendingEdit(val oldProviderId: String, val newProvider: DevEcoHttpApi.CustomProvider, val oldModelIds: Set<String> = emptySet(), val oldSingleModelId: String? = null)

    // --- tree cell renderer ---

    private inner class ModelTreeCellRenderer : javax.swing.tree.TreeCellRenderer {
        override fun getTreeCellRendererComponent(tree: JTree, value: Any?, sel: Boolean, expanded: Boolean, leaf: Boolean, row: Int, hasFocus: Boolean): Component {
            val node = value as? DefaultMutableTreeNode
            val userObject = node?.userObject

            if (userObject is ProviderGroupNode) {
                val panel = JPanel().apply {
                    layout = BoxLayout(this, BoxLayout.X_AXIS)
                    isOpaque = false
                    border = EmptyBorder(0, 0, 0, 0)
                    preferredSize = Dimension(Integer.MAX_VALUE, 28)
                }
                val chevronIcon = if (expanded) AllIcons.General.ChevronDown else AllIcons.General.ChevronRight
                panel.add(JLabel(chevronIcon).apply { isOpaque = false; preferredSize = Dimension(16, 16) })
                panel.add(Box.createHorizontalStrut(4))
                panel.add(JLabel(userObject.providerName).apply {
                    isOpaque = false
                    font = font.deriveFont(Font.BOLD, 12f)
                    foreground = UIUtil.getLabelForeground()
                })
                panel.add(Box.createHorizontalStrut(4))
                panel.add(JLabel("(${userObject.count})").apply {
                    isOpaque = false
                    font = font.deriveFont(Font.PLAIN, 11f)
                    foreground = UIUtil.getContextHelpForeground()
                })
                panel.add(Box.createHorizontalGlue())
                // Action buttons for "manual" type providers, on hover or selection.
                if (userObject.type == "manual" && (sel || row == hoveredRow)) {
                    panel.add(JLabel(AllIcons.Actions.Edit).apply {
                        isOpaque = false
                        toolTipText = msg("settings.models.edit")
                        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                        preferredSize = Dimension(28, 28)
                        horizontalAlignment = SwingConstants.CENTER
                        verticalAlignment = SwingConstants.CENTER
                    })
                    panel.add(JLabel(AllIcons.Actions.GC).apply {
                        isOpaque = false
                        toolTipText = msg("settings.models.delete")
                        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                        preferredSize = Dimension(28, 28)
                        horizontalAlignment = SwingConstants.CENTER
                        verticalAlignment = SwingConstants.CENTER
                    })
                }
                panel.add(Box.createHorizontalStrut(4))
                return panel
            } else if (userObject is DevEcoHttpApi.ModelInfo) {
                val fg = if (sel) UIUtil.getTableSelectionForeground() else null
                val panel = JPanel().apply {
                    layout = BoxLayout(this, BoxLayout.X_AXIS)
                    isOpaque = false
                    border = EmptyBorder(0, 0, 0, 0)
                    preferredSize = Dimension(Integer.MAX_VALUE, 28)
                }
                val key = userObject.providerId to userObject.modelId
                val isBlacklisted = key in blacklistCache
                val type = typeCache[userObject.providerId] ?: "provider"

                // Checkbox: "builtin" = no checkbox (view only).
                // "provider" and "manual" = has checkbox (blacklist toggle).
                if (type == "builtin") {
                    panel.add(Box.createHorizontalStrut(20))
                } else {
                    panel.add(JCheckBox().apply {
                        isOpaque = false
                        isFocusPainted = false
                        border = EmptyBorder(0, 0, 0, 0)
                        margin = Insets(0, 0, 0, 0)
                        isSelected = !isBlacklisted
                        preferredSize = Dimension(20, 20)
                        horizontalAlignment = SwingConstants.CENTER
                    })
                }

                // Model name
                panel.add(Box.createHorizontalStrut(4))
                panel.add(JLabel(userObject.modelName).apply {
                    isOpaque = false
                    font = font.deriveFont(Font.PLAIN, 12f)
                    if (fg != null) foreground = fg
                    preferredSize = Dimension(240, 28)
                    verticalTextPosition = SwingConstants.CENTER
                    verticalAlignment = SwingConstants.CENTER
                })

                // Model ID
                panel.add(Box.createHorizontalStrut(8))
                panel.add(JLabel(userObject.modelId).apply {
                    isOpaque = false
                    font = font.deriveFont(Font.PLAIN, 11f)
                    if (fg != null) foreground = fg else foreground = UIUtil.getContextHelpForeground()
                    preferredSize = Dimension(200, 28)
                    verticalTextPosition = SwingConstants.CENTER
                    verticalAlignment = SwingConstants.CENTER
                })

                panel.add(Box.createHorizontalGlue())

                // Action buttons: only for "manual" type, only on hover or selection.
                // Edit (pencil) and Delete (trash) using platform icons.
                if (type == "manual" && (sel || row == hoveredRow)) {
                    panel.add(JLabel(AllIcons.Actions.Edit).apply {
                        isOpaque = false
                        toolTipText = msg("settings.models.edit")
                        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                        preferredSize = Dimension(28, 28)
                        horizontalAlignment = SwingConstants.CENTER
                        verticalAlignment = SwingConstants.CENTER
                    })
                    panel.add(JLabel(AllIcons.Actions.GC).apply {
                        isOpaque = false
                        toolTipText = msg("settings.models.delete")
                        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                        preferredSize = Dimension(28, 28)
                        horizontalAlignment = SwingConstants.CENTER
                        verticalAlignment = SwingConstants.CENTER
                    })
                }
                panel.add(Box.createHorizontalStrut(4))
                return panel
            }

            return JLabel(value?.toString() ?: "")
        }
    }
}
