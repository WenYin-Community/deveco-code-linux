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
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.codeStyle.MinusculeMatcher
import com.intellij.psi.codeStyle.NameUtil
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.JBColor
import com.intellij.ui.SearchTextField
import com.intellij.ui.SimpleColoredComponent
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.ActionLink
import com.intellij.ui.components.JBLabel
import com.intellij.ui.scale.DerivedScaleType
import com.intellij.ui.scale.ScaleContext
import com.intellij.ui.speedSearch.SpeedSearchUtil
import com.intellij.ui.tree.ui.DefaultTreeUI
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import org.deveco.code.MyMessageBundle
import org.deveco.code.acp.AcpClientService
import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.session.SessionModelStore
import org.deveco.code.session.SESSION_REFRESH_TOPIC
import org.deveco.code.util.opencodeConfigDir
import java.awt.AlphaComposite
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import java.awt.event.ActionEvent
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.awt.image.BufferedImage
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicBoolean
import javax.swing.AbstractAction
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
import javax.swing.KeyStroke
import javax.swing.ListSelectionModel
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
import javax.swing.border.EmptyBorder
import javax.swing.event.DocumentEvent
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeCellRenderer
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreePath

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
    // npm id per custom provider, read from the backend's global config —
    // the authoritative protocol, reflecting hand edits of the config that
    // the plugin's own registry cannot see. Fetched on the pooled thread by
    // reload()/apply() and read via providerApiNpm; values outside the
    // dialog's known protocols must be preserved, not rewritten.
    private var configProviderNpms: Map<String, String> = emptyMap()
    private var committedPreferred: String? = null
    private var preferredInitialized = false
    // True once disposeUIResources() has run. reload()/apply() schedule work
    // on pooled threads that can't be cancelled; without this guard their
    // trailing invokeLater(ModalityState.any()) would touch disposed UI
    // (tree, searchField, error dialogs) after the Settings dialog closed.
    // any() is required while the dialog is open (see reload/apply comments),
    // so the natural disposed-skip from ModalityState.default() is unavailable.
    @Volatile private var disposed = false
    private var hoveredRow = -1

    // The tree clears its selection while painting (see the paint override in
    // init) so that the default tree UI paints no selection of its own; the
    // renderer's `sel` parameter is therefore always false, and the selected
    // row is handed to the renderer through this field instead (valid only
    // while painting).
    private var selectedRow = -1
    // Reuses AcpClientService.backendMutationLock — the same lock
    // AddModelDialog.resetApiKey uses — so backend mutations from the
    // dialog (deleteAuthentication + refreshInstance) cannot race with
    // apply()'s deleteProviderModel + refreshInstance flow.
    private val applyDeletesLock get() = service.backendMutationLock

    // Re-entrancy guard: apply() must stay single-flight. While one apply is
    // running, a second trigger (only the dialog's own Apply/OK button is
    // reachable then — every in-page entry is gated by the busy state)
    // carries no new pendings and must be dropped: re-submitting would run a
    // duplicate backend pass, and whichever callback finished first would
    // re-enable the UI while the other still runs — re-opening the
    // lost-update window the busy state exists to close.
    private val applyInFlight = AtomicBoolean(false)

    // Click-debounce state (EDT-only: mouse handlers run on the EDT).
    // CLICK_QUIET_NANOS sits in the measured gap between input noise and
    // intent: bounce/double-press chains re-fire ≤94ms after their
    // predecessor, while deliberate clicks — even the fastest observed
    // cross-target run — are ≥272ms apart.
    private var lastTreeClickAt = 0L
    private var pressedRow = -1

    // Cached lookup maps rebuilt in rebuildTree() to avoid O(n) per-row
    // scans in the cell renderer (which fires for every visible row on
    // every repaint).
    private var typeCache: Map<String, String> = emptyMap()
    // Effective rendered blacklist = committed (modelStore) ∪ pendingUnchecks −
    // pendingChecks. Computed in rebuildTree; toggleBlacklist updates it
    // synchronously (± the toggled key) so rapid toggles paint correctly before
    // the deferred rebuildTree runs.
    private var blacklistCache: Set<Pair<String, String>> = emptySet()
    private val ROW_LEFT_PAD = 16

    private val mainPanel = JPanel(BorderLayout())
    private val searchField = SearchTextField()
    // Status panel shown in the NORTH area below searchField while the tree
    // has nothing to render: LOADING (backend spinning up), EMPTY (catalog
    // genuinely empty), or ERROR (unreachable / catalog GET failed). Hidden
    // once renderReady() runs. retryLink re-runs reload(); EMPTY and ERROR
    // both expose it because the backend may have warmed up by the retry.
    private val statusLabel = JBLabel()
    private val retryLink = ActionLink(MyMessageBundle.message("settings.models.retry")).apply {
        isVisible = false
        addActionListener { reload() }
    }
    private val statusPane = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
        isOpaque = false
        isVisible = false
        add(statusLabel)
        add(Box.createHorizontalStrut(8))
        add(retryLink)
    }
    private val treeModel = DefaultTreeModel(DefaultMutableTreeNode("root"))
    private val tree: JTree

    // Header/footer controls gated by the same apply() busy state as the
    // tree: addCustomProvider() would stage and trigger a second concurrent
    // apply while the pooled one is still running.
    private var addIconLabel: JLabel? = null
    private var addTextLabel: JLabel? = null
    private var openConfigLabel: JBLabel? = null

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
                selectedRow = getSelectionRows()?.firstOrNull() ?: -1
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
                        // No hover highlight while apply() has the tree in its busy state.
                        isEnabled && row == hoveredRow -> {
                            g.color = HOVER_BG
                            g.fillRect(rect.x, rect.y, rect.width, rect.height)
                        }
                    }
                }
                super.paint(g)
                selectionPath = savedPath
                selectedRow = -1
            }
        }.apply {
            isOpaque = false
            border = EmptyBorder(0, ROW_LEFT_PAD, 0, 0)
            isRootVisible = false
            showsRootHandles = false
            rowHeight = 28
            toggleClickCount = 0
            putClientProperty("JTree.lineStyle", "None")
            selectionModel.selectionMode = ListSelectionModel.SINGLE_SELECTION
            setCellRenderer(ModelTreeCellRenderer())
            addMouseListener(object : MouseAdapter() {
                // Rows are 28px high and every action in this tree toggles on a
                // single mouse click, so two input artifacts made clicks feel
                // dead (diagnosed from instrumented logs):
                //
                // 1. Bounce: a physical mouse press rebounds into a second
                //    press ~40-70ms later. Both fire a toggle (expand/collapse,
                //    checkbox, button) and the pair cancels out — net-zero,
                //    perceived as "click does nothing". AWT's clickCount is
                //    component-wide, so it cannot gate this without also
                //    eating rapid clicks on different rows; a quiet period
                //    measured from the previous click absorbs the bounce
                //    (observed ≤94ms) while deliberate clicks (observed ≥272ms
                //    cross-target) always pass. Refreshed on every click
                //    candidate — absorbed or not — because a bounce chain can
                //    re-trigger ~94ms after its predecessor.
                // 2. Drift: AWT only posts mouseClicked when press and release
                //    land at (pixel-) the same spot; a finger/contact that
                //    slides even a few pixels produces a press with NO click —
                //    the toggle silently never runs. Handling mouseReleased
                //    instead and requiring release-row == press-row widens
                //    the acceptance from pixel equality to row equality, and
                //    keeps real drags (row changed) inert.
                override fun mousePressed(e: MouseEvent) {
                    pressedRow = getClosestRowForLocation(e.x, e.y)
                }
                override fun mouseReleased(e: MouseEvent) {
                    // A disabled JTree still delivers mouse events to its
                    // listeners, so the apply() guard needs an explicit check.
                    if (!isEnabled) return
                    val now = System.nanoTime()
                    val absorbed = now - lastTreeClickAt < CLICK_QUIET_NANOS
                    lastTreeClickAt = now
                    if (absorbed) return
                    val row = getClosestRowForLocation(e.x, e.y)
                    // Press elsewhere and drag in, or scrub across rows: the
                    // gesture is not a click on this row.
                    if (row != pressedRow) return
                    if (row < 0) return
                    val bounds = getRowBounds(row)
                    if (bounds == null || e.y < bounds.y || e.y >= bounds.y + bounds.height) return
                    val path = getPathForRow(row) ?: return
                    val node = path.lastPathComponent as? DefaultMutableTreeNode ?: return
                    val userObject = node.userObject
                    when (userObject) {
                        is ProviderGroupNode -> {
                            if (!handleProviderClick(e, userObject)) {
                                // DefaultTreeUI toggles expansion on mousePressed when the
                                // click lands in its expand-control region, which overlaps
                                // our painted chevron. Toggling again on mouseReleased would
                                // make one click expand the row and immediately re-collapse
                                // it, so leave those clicks to the UI.
                                val toggledByUi = (tree.ui as? DefaultTreeUI)
                                    ?.isLocationInExpandControl(e.point) == true
                                if (!toggledByUi) {
                                    if (isExpanded(row)) collapseRow(row) else expandRow(row)
                                }
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
                    // Busy (apply in flight): drop hover tracking so rows paint
                    // their disabled style, and clear any stale highlight.
                    if (!isEnabled) {
                        if (hoveredRow != -1) {
                            hoveredRow = -1
                            repaintTree()
                        }
                        return
                    }
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
        disposed = false
        // Instance reuse (createComponent can run again after the Settings
        // dialog closed): an apply whose callbacks were skipped by the
        // disposed guard must not pin the re-entrancy guard for this session.
        applyInFlight.set(false)
        mainPanel.removeAll()
        pendingAdds.clear(); pendingConnects.clear(); pendingFileDeletes.clear(); pendingProviderDeletes.clear(); pendingAuthRemovals.clear(); pendingEdits.clear()
        pendingPreferred = null; preferredInitialized = false; pendingChecks.clear(); pendingUnchecks.clear()
        // Reset search-expansion snapshot state so a reused Configurable
        // instance doesn't carry stale lastFilter/preSearchExpansion from a
        // previous visit — which would falsely trigger searchJustCleared and
        // restore an outdated snapshot on the first rebuild. Safe here because
        // searchField.text = "" is set below, keeping the three in sync.
        lastFilter = ""
        preSearchExpansion = emptySet()
        searchMatcher = null

        val openLink = JBLabel(msg("settings.models.openConfig")).apply {
            foreground = LINK_COLOR
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        }
        openLink.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (openLink.isEnabled) openConfigFile()
            }
        })
        openConfigLabel = openLink

        searchField.textEditor.emptyText.text = msg("settings.models.search")
        searchField.text = ""
        searchField.textEditor.document.addDocumentListener(object : DocumentAdapter() {
            override fun textChanged(e: DocumentEvent) = rebuildTree()
        })
        // Consume Enter so it does not reach the Settings dialog's default OK
        // button, which would close the page (and run apply() if there are
        // pending edits). Re-runs the filter so the key still has an effect.
        searchField.textEditor.getInputMap(JComponent.WHEN_FOCUSED)
            .put(KeyStroke.getKeyStroke(KeyEvent.VK_ENTER, 0), "consumeEnter")
        searchField.textEditor.actionMap.put("consumeEnter", object : AbstractAction() {
            override fun actionPerformed(e: ActionEvent) = rebuildTree()
        })

        // NORTH: search field above the table (where the old title was)
        val north = JPanel().apply { layout = BoxLayout(this, BoxLayout.Y_AXIS) }
        north.add(searchField)
        north.add(Box.createVerticalStrut(4))
        north.add(statusPane)
        mainPanel.add(north, BorderLayout.NORTH)

        // CENTER: rounded card wrapping the [+ Add Model] header and the tree.
        val centerPanel = RoundedCardPanel(BorderLayout())

        // Table header row: [+ Add Model] left-aligned with tree chevrons below
        val headerRow = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            isOpaque = true
            background = ADD_MODEL_BG
            border = javax.swing.BorderFactory.createMatteBorder(0, 0, 1, 0, JBColor.border())
            preferredSize = Dimension(Integer.MAX_VALUE, 32)
            maximumSize = Dimension(Integer.MAX_VALUE, 32)
        }
        // Left padding shares ROW_LEFT_PAD with the tree's left border so the +
        // icon stays aligned with the provider-row chevron below.
        headerRow.add(Box.createHorizontalStrut(ROW_LEFT_PAD))
        val addIcon = JLabel(AllIcons.General.Add).apply {
            isOpaque = false
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            preferredSize = Dimension(16, 20)
            horizontalAlignment = SwingConstants.CENTER
            // JLabel only auto-grays ImageIcon-based icons; the IntelliJ SVG
            // icon needs an explicit disabled variant for the busy state.
            disabledIcon = TintedIcon(AllIcons.General.Add, UIUtil.getContextHelpForeground())
        }
        val addLabel = JLabel(msg("settings.models.add")).apply {
            isOpaque = false
            font = font.deriveFont(Font.BOLD, 12f)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        }
        addIcon.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (addIcon.isEnabled) addCustomProvider()
            }
        })
        addLabel.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (addLabel.isEnabled) addCustomProvider()
            }
        })
        addIconLabel = addIcon
        addTextLabel = addLabel
        headerRow.add(addIcon)
        headerRow.add(Box.createHorizontalStrut(4))
        headerRow.add(addLabel)
        headerRow.add(Box.createHorizontalGlue())
        centerPanel.add(headerRow, BorderLayout.NORTH)

        // Tree below header; the card supplies the outline and the corner clip
        centerPanel.add(JScrollPane(tree).apply { border = EmptyBorder(0, 0, 0, 0) }, BorderLayout.CENTER)
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

    // Single-flight wrapper: while one apply is in flight, a second trigger
    // (only the dialog's own Apply/OK button is reachable then) is dropped —
    // see applyInFlight. The prologue catch releases the guard if anything
    // throws before the pooled dispatch, so later applies still run.
    override fun apply() {
        if (!applyInFlight.compareAndSet(false, true)) return
        try {
            applyLocked()
        } catch (e: Throwable) {
            applyInFlight.set(false)
            throw e
        }
    }

    private fun applyLocked() {
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
        // Provider base URLs / auth states re-read on the pooled thread after
        // the backend writes, then applied on the EDT in the success callback.
        // providerBaseUrls is otherwise only populated by reload() when the
        // settings page is created, so a provider added earlier in this same
        // session would otherwise edit with an empty Base URL and fail
        // addCustomProvider's require on the next Apply.
        var refreshedBaseUrls: Map<String, String>? = null
        var refreshedAuthStates: Map<String, Boolean>? = null
        // Fast path: a pure checkbox-toggle Apply changes nothing in the
        // backend (toggles persist in the local blacklist only — see the
        // commit below), so skip every backend write, refreshInstance, and
        // the stability polling. Toggle-only applies stay instant and,
        // critically, do not dispose the backend instance (which aborts
        // in-flight sessions).
        val backendMutating = adds.isNotEmpty() || connects.isNotEmpty() || fileDeletes.isNotEmpty() ||
            providerDeletes.isNotEmpty() || authRemovals.isNotEmpty() || edits.isNotEmpty()
        // Visible busy state while apply runs on the pooled thread: the tree,
        // the add-model header and the config link are disabled — clicks in
        // that window would race the pending snapshot/clear and the rollback
        // baseline — and rows paint their disabled style so the wait is
        // visible instead of silently dead clicks.
        setBusyUi(true)
        ApplicationManager.getApplication().executeOnPooledThread {
            val errors = mutableListOf<String>()
            // Deletes the backend rejected. The delete loops record failures
            // here and skip their local cleanup, and the success callback
            // keeps failed ids out of its hide-filters — so rows whose delete
            // failed stay visible exactly as the backend still has them, with
            // the error dialog explaining why. Otherwise the row would vanish
            // here and silently reappear on the next reload.
            val failedProviderDeletes = mutableSetOf<String>()
            val failedModelDeletes = mutableSetOf<Pair<String, String>>()
            var catalog: List<DevEcoHttpApi.ModelInfo> = emptyList()
            // Snapshot provider definitions for rollback. If any operation
            // fails, re-apply the original definitions to restore the
            // pre-Apply state (full rollback, not partial).
            val rollbackSnapshots = mutableMapOf<String, ProviderRollbackSnapshot>()
            try {
                if (backendMutating) synchronized(applyDeletesLock) {
                    // Pre-snapshot all affected providers for rollback
                    val affectedProviderIds = (checks.keys + unchecks.keys).toSet()
                    for (pid in affectedProviderIds) {
                        runCatching { snapshotProviderForRollback(pid, rollbackSnapshots) }
                    }
                    if (fileDeletes.isNotEmpty()) {
                        for ((pid, mid) in fileDeletes) {
                            runCatching { service.deleteProviderModel(pid, mid) }
                                .onFailure {
                                    log.warn("Apply: deleteProviderModel $pid/$mid failed", it)
                                    failedModelDeletes.add(pid to mid)
                                    val modelName = committedModels
                                        .firstOrNull { m -> m.providerId == pid && m.modelId == mid }?.modelName ?: mid
                                    errors.add("Delete model '$modelName': ${it.message ?: "unknown error"}")
                                }
                        }
                    }
                    for (providerId in providerDeletes) {
                        log.debug("Apply: deleteProvider $providerId")
                        val deleteFailed = runCatching { service.deleteProvider(providerId) }
                            .onFailure {
                                log.warn("Apply: deleteProvider $providerId failed", it)
                                errors.add("Delete provider '${providerDisplayName(providerId)}': ${it.message ?: "unknown error"}")
                            }
                            .isFailure
                        if (deleteFailed) {
                            // Backend still has the provider — leave the local
                            // registry/store untouched so they keep matching.
                            failedProviderDeletes.add(providerId)
                            continue
                        }
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
                                modelStore.addProviderType(provider.id, provider.name, "manual", provider.apiNpm)
                                log.debug("Apply: addCustomProvider ${provider.id} succeeded")
                            }
                    }
                    for (connect in connects) {
                        log.debug("Apply: connectProvider ${connect.providerId} apiKey=${if (connect.apiKey != null) "(set)" else "null"} models=${connect.models.size}")
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
                                modelStore.addProviderType(edit.newProvider.id, edit.newProvider.name, "manual", edit.newProvider.apiNpm)
                            }
                    }
                    // Delete auth for disconnected providers BEFORE
                    // refreshInstance — this ensures the backend reads
                    // the updated auth state when it restarts.
                    for (providerId in authRemovals) {
                        log.debug("Apply: deleteAuthentication $providerId")
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
                            log.debug("Apply: re-storing API key for ${connect.providerId} after reload")
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
                if (backendMutating) {
                    // Refresh provider base URLs / auth states so providers added,
                    // edited, or connected by this Apply are visible to the edit
                    // dialog without reopening the page.
                    val refreshedProviders = runCatching { service.availableProviders() }.getOrElse { emptyList() }
                    if (refreshedProviders.isNotEmpty()) {
                        refreshedBaseUrls = refreshedProviders.associate { it.id to (it.baseUrl ?: "") }
                        refreshedAuthStates = refreshedProviders.associate { it.id to it.hasAuth }
                    }
                    // Refresh the config npm map after the adds/edits/connects
                    // above so providerApiNpm — used by the next edit dialog —
                    // resolves the protocols the just-applied writes (and any
                    // hand edits) actually produced.
                    runCatching { service.customProviderNpms() }.onSuccess { configProviderNpms = it }
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
                // Checkbox toggles are local-only: the blacklist commit below
                // IS their persistence. The backend config keeps every model
                // (only the add/edit/delete flows write it); the settings tree
                // and the chat dropdown both filter by the blacklist, and
                // unchecking every model of a provider neither errors (manual
                // providers) nor removes its rows from the tree.
                // Commit the pending toggle overlay to the local blacklist.
                // Until here the overlay was render-only (rebuildTree showed
                // committed ∪ pendingUnchecks − pendingChecks) and modelStore
                // held the pre-Apply state, so the chat dropdown and a
                // Cancel/reopen showed committed state.
                // Skip toggles for models this same Apply deleted/renamed
                // (fileDeletes, deleted/disconnected providers, edited-away
                // models) so we don't re-create stale blacklist entries the
                // delete/edit paths just cleaned up. Failed deletes are
                // excluded: those rows survive in the backend, so their
                // toggles must commit like any other.
                val skipProviderIds = (providerDeletes + authRemovals +
                    edits.filter { it.oldProviderId != it.newProvider.id }.map { it.oldProviderId }).toSet() -
                    failedProviderDeletes
                val skipModelKeys = (fileDeletes - failedModelDeletes).toMutableSet().apply {
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
                    // The stored preference is a qualified "providerId/modelId"
                    // id; compare the qualified form first, then the legacy
                    // bare model name written by older plugin versions, so old
                    // preferences still migrate on rename.
                    val stored = modelStore.getGlobalModelId()
                    if (stored == "${edit.oldProviderId}/$oldId" || stored == oldId) {
                        modelStore.setGlobalModelId("${edit.newProvider.id}/$newId")
                    }
                    modelStore.migrateModelId(edit.oldProviderId, oldId, newId)
                    log.debug("Apply: migrated modelId $oldId -> $newId for provider ${edit.oldProviderId}")
                }
                project.messageBus.syncPublisher(SESSION_REFRESH_TOPIC).onSessionsChanged()
                // The Settings dialog is modal: a plain invokeLater from this
                // pooled thread is queued in a non-modal state and only runs
                // after the dialog closes, so pending state stays uncommitted
                // and committedModels/providerBaseUrls stay stale for the
                // rest of the session. any() lets the callback run while the
                // dialog is still open.
                edtRender {
                    // Restore interactivity before anything that could throw
                    // (rebuildTree, error dialog): an exception further down
                    // must not leave the page stuck in the busy state.
                    setBusyUi(false)
                    applyInFlight.set(false)
                    pendingAdds.clear(); pendingConnects.clear(); pendingFileDeletes.clear()
                    pendingProviderDeletes.clear(); pendingAuthRemovals.clear(); pendingEdits.clear(); pendingPreferred = null; pendingChecks.clear(); pendingUnchecks.clear()
                    refreshedBaseUrls?.let { providerBaseUrls = it }
                    refreshedAuthStates?.let { providerAuthMap = it }
                    if (backendMutating) {
                        // Filter out models for deleted/disconnected providers and
                        // individually deleted models. deleteProvider only adds the
                        // provider to disabled_providers (doesn't remove the
                        // definition), so the backend catalog may still include
                        // them. Deletes the backend rejected are excluded — those
                        // rows stay visible, matching what the backend still has.
                        val deletedProviderIds = (providerDeletes + authRemovals).toSet() - failedProviderDeletes
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
                        val deletedModelKeys = (fileDeletes.toSet() - failedModelDeletes) + staleFromEdits
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
                        modelStore.cacheCatalog(committedModels)
                    }
                    committedPreferred = modelStore.getGlobalModelId()
                    preferredInitialized = true
                    rebuildTree()
                    if (errors.isNotEmpty()) {
                        Messages.showErrorDialog(
                            project,
                            errors.joinToString("\n"),
                            msg("settings.models.applyErrors"),
                        )
                    }
                }
            } catch (e: Throwable) {
                log.warn("Apply failed", e)
                // Full rollback: re-apply pre-Apply provider definitions
                if (rollbackSnapshots.isNotEmpty()) {
                    log.info("Rolling back ${rollbackSnapshots.size} provider definitions")
                    for (snapshot in rollbackSnapshots.values) {
                        when (snapshot) {
                            is ProviderRollbackSnapshot.Manual -> runCatching { service.addCustomProvider(snapshot.provider) }
                                .onSuccess {
                                    // Re-register the restored protocol so the registry doesn't
                                    // keep the failed Apply's value — otherwise the next edit dialog
                                    // pre-fills a protocol the config no longer has.
                                    modelStore.addProviderType(
                                        snapshot.provider.id, snapshot.provider.name, "manual", snapshot.provider.apiNpm,
                                    )
                                }
                                .onFailure { log.warn("Rollback failed for ${snapshot.provider.id}", it) }
                            is ProviderRollbackSnapshot.Catalog -> runCatching {
                                service.connectProvider(snapshot.providerId, null, snapshot.models)
                            }
                                .onSuccess {
                                    modelStore.addProviderType(snapshot.providerId, snapshot.providerName, "provider")
                                }
                                .onFailure { log.warn("Rollback failed for ${snapshot.providerId}", it) }
                        }
                    }
                    runCatching { service.refreshInstance() }
                }
                edtRender {
                    setBusyUi(false)
                    applyInFlight.set(false)
                    Messages.showErrorDialog(project, e.message ?: "Apply failed", "Models")
                }
            }
        }
    }

    override fun reset() {
        pendingAdds.clear(); pendingConnects.clear(); pendingFileDeletes.clear()
        pendingProviderDeletes.clear(); pendingAuthRemovals.clear(); pendingEdits.clear(); pendingPreferred = null; pendingChecks.clear(); pendingUnchecks.clear()
        reload()
    }

    // Called by the Settings dialog on close. Configurable is not Disposable,
    // so this is the only disposal hook; pooled reload()/apply() tails read
    // `disposed` to skip touching the now-dead UI tree.
    override fun disposeUIResources() {
        disposed = true
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

    // Geometry shared by the renderer and the click handlers: buttons are
    // ACTION_BTN_SIZE px wide, laid out left-to-right ending ACTION_GUTTER px
    // from the row's right edge — exactly the renderer's glue + buttons +
    // trailing strut. Both sides derive from one RowAction list, so the
    // destructive click targets can never drift from what is painted.
    private val ACTION_BTN_SIZE = 28
    private val ACTION_GUTTER = 4

    // Bounce/double-press quiet period for the tree's click handling; see the
    // mouse listener comment for the measured noise/intent bands it separates.
    private val CLICK_QUIET_NANOS = 150_000_000L

    private class RowAction(val icon: Icon, val tooltip: String, val onClick: () -> Unit)

    private fun actionStart(treeWidth: Int, count: Int) = treeWidth - count * ACTION_BTN_SIZE - ACTION_GUTTER

    // A provider is locally managed when the plugin recorded it in its type
    // registry (added via the dialog or connected via the wizard) or it is
    // staged in this session. Catalog providers authenticated through env
    // vars / auth.json have no registry entry and no deveco.json models for
    // the backend delete calls to remove — offering delete there would be a
    // silent no-op whose row reappears on the next reload, so such providers
    // stay view-only (checkbox semantics unchanged).
    private fun isLocallyManaged(providerId: String): Boolean =
        pendingAdds.any { it.id == providerId } ||
            pendingConnects.any { it.providerId == providerId } ||
            modelStore.getProviderType(providerId) != null

    private fun providerActions(group: ProviderGroupNode): List<RowAction> = when {
        group.type == "manual" -> listOf(
            RowAction(AllIcons.Actions.Edit, msg("settings.models.edit")) { editProvider(group) },
            RowAction(AllIcons.Actions.GC, msg("settings.models.delete")) { deleteProvider(group) },
        )
        group.type == "provider" && isLocallyManaged(group.providerId) -> listOf(
            RowAction(AllIcons.Actions.GC, msg("settings.models.delete")) { deleteProvider(group) },
        )
        // "builtin" (deveco), unmanaged providers, and unknown types are
        // view-only: no destructive default branch.
        else -> emptyList()
    }

    private fun modelActions(m: DevEcoHttpApi.ModelInfo): List<RowAction> {
        val type = typeCache[m.providerId] ?: "provider"
        if (type != "manual") return emptyList()
        return listOf(
            RowAction(AllIcons.Actions.Edit, msg("settings.models.edit")) { editModel(m) },
            RowAction(AllIcons.Actions.GC, msg("settings.models.delete")) { deleteModel(m) },
        )
    }

    private fun handleProviderClick(e: MouseEvent, group: ProviderGroupNode): Boolean {
        val actions = providerActions(group)
        if (actions.isEmpty()) return false
        val start = actionStart(tree.width, actions.size)
        if (e.x < start) return false
        val idx = (e.x - start) / ACTION_BTN_SIZE
        if (idx in actions.indices) actions[idx].onClick()
        return true
    }

    private fun handleModelClick(e: MouseEvent, m: DevEcoHttpApi.ModelInfo, rowIndent: Int) {
        val type = typeCache[m.providerId] ?: "provider"
        val relX = e.x - rowIndent
        // Checkbox: only "builtin" is view-only (no toggle).
        // "provider" and "manual" support checkbox toggle.
        if (type != "builtin" && relX in 0..20) {
            toggleBlacklist(m)
            return
        }
        val actions = modelActions(m)
        if (actions.isEmpty()) return
        val start = actionStart(tree.width, actions.size)
        if (e.x < start) return
        val idx = (e.x - start) / ACTION_BTN_SIZE
        if (idx in actions.indices) actions[idx].onClick()
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
                val baseUrl = providerBaseUrl(m.providerId)
                if (baseUrl.isNotEmpty()) {
                    val updated = DevEcoHttpApi.CustomProvider(
                        m.providerId, providerName, baseUrl, null, emptyMap(), manualRemaining, providerApiNpm(m.providerId),
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

    // Resolve a provider's Base URL. providerBaseUrls is only refreshed by
    // reload() and a successful apply(), so providers added or edited in this
    // session may be missing — fall back to their staged definitions so a
    // follow-up edit or toggle doesn't send an empty Base URL (rejected by
    // addCustomProvider's require).
    private fun providerBaseUrl(providerId: String): String {
        val known = providerBaseUrls[providerId]
        if (!known.isNullOrBlank()) return known
        return pendingAdds.firstOrNull { it.id == providerId }?.baseUrl
            ?: pendingEdits.firstOrNull { it.oldProviderId == providerId }?.newProvider?.baseUrl
            ?: ""
    }

    // Resolve a manual provider's API protocol (the `npm` SDK id). Staged
    // adds/edits carry the freshest intent; otherwise the backend config is
    // the source of truth (it reflects hand edits the registry can't see,
    // including npm values outside the dialog's known protocols, e.g. a
    // hand-edited @ai-sdk/groq), then the persisted registry, then the
    // default. Passing the raw config value through keeps hand-edited
    // protocols intact across edit/rebuild paths instead of silently
    // rewriting them to OpenAI Compatible.
    private fun providerApiNpm(providerId: String): String =
        pendingAdds.firstOrNull { it.id == providerId }?.apiNpm
            ?: pendingEdits.firstOrNull { it.oldProviderId == providerId }?.newProvider?.apiNpm
            ?: configProviderNpms[providerId]
            ?: modelStore.getProviderProtocol(providerId)
            ?: DevEcoHttpApi.CustomProvider.DEFAULT_API_NPM

    private fun openEditDialog(
        providerId: String,
        providerName: String,
        singleModel: Boolean,
        modelId: String? = null,
        modelName: String? = null,
    ) {
        // Use the projected view (committed + pending adds/connects/edits), not
        // committedModels: for a provider added moments ago whose apply()
        // callback hasn't committed yet, committedModels is empty and the
        // rename would reconstruct an empty model list.
        val allModelInfos = projectedAllModelInfos()
            .filter { it.providerId == providerId }
            .map { DevEcoHttpApi.ProviderModelInfo(it.modelId, it.modelName) }
        val editModels = if (singleModel && modelId != null) {
            listOf(DevEcoHttpApi.ProviderModelInfo(modelId, modelName ?: modelId))
        } else {
            allModelInfos
        }
        val baseUrl = providerBaseUrl(providerId)
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
            editApiNpm = providerApiNpm(providerId),
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
        // Unregistered providers also get no group delete button: with no
        // registry entry there is nothing in deveco.json for the backend
        // delete to remove (see isLocallyManaged).
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
            // Mirror the backend's global config selection (globalConfigFile in
            // packages/opencode/src/config/config.ts): deveco.jsonc wins over
            // deveco.json / config.json. Creating deveco.json here would fork a
            // second file whose keys the backend's jsonc overrides at load time.
            try {
                Files.createDirectories(opencodeConfigDir)
                val path = listOf("deveco.jsonc", "deveco.json", "config.json")
                    .map(opencodeConfigDir::resolve)
                    .firstOrNull(Files::exists)
                    ?: opencodeConfigDir.resolve("deveco.jsonc").also { file ->
                        // Same seed content the backend writes on first startup.
                        Files.writeString(file, "{\n  \"\$schema\": \"https://opencode.ai/config.json\"\n}")
                    }
                val pathStr = path.toString().replace('\\', '/')
                var vfile = LocalFileSystem.getInstance().findFileByPath(pathStr)
                if (vfile == null) {
                    // Synchronous VFS refresh requires the write-intent lock on the EDT
                    vfile = ApplicationManager.getApplication()
                        .runWriteIntentReadAction<VirtualFile?, Exception> {
                            LocalFileSystem.getInstance().refreshAndFindFileByPath(pathStr)
                        }
                }
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

    // Dispatches `block` on the EDT under ModalityState.any() (the Settings
    // dialog is modal — a non-modal invokeLater would queue behind it and
    // leave state stale for the whole session). Double-checks `disposed`
    // before enqueueing and again inside the callback, so a close between
    // the two checks cannot reach disposed UI. Covers reload()/apply() tails
    // scheduled from pooled threads that can't be cancelled.
    private fun edtRender(block: () -> Unit) {
        if (disposed) return
        ApplicationManager.getApplication().invokeLater({
            if (disposed) return@invokeLater
            block()
        }, ModalityState.any())
    }

    /** The shared apply() busy state: the tree plus the gated header/footer controls. */
    private fun setBusyUi(busy: Boolean) {
        tree.isEnabled = !busy
        if (busy) hoveredRow = -1
        addIconLabel?.isEnabled = !busy
        addTextLabel?.isEnabled = !busy
        openConfigLabel?.isEnabled = !busy
    }

    private fun reload() {
        val cached = modelStore.getCachedCatalog()
        if (cached.isNotEmpty()) {
            committedModels = mergeCustomModels(cached)
            committedPreferred = modelStore.getGlobalModelId()
            preferredInitialized = true
            rebuildTree()
            renderReady()
        } else {
            renderLoading()
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            // ① Settings page drives the backend itself; first open spawns
            // the subprocess + CLI extraction, which blocks here.
            if (!service.isConnected() && !service.connect()) {
                edtRender { renderError(service.statusText()) }
                return@executeOnPooledThread
            }
            var healthy = false
            var attempts = 0
            while (!healthy && attempts < 3 && service.isConnected()) {
                healthy = service.isHealthy()
                attempts++
                if (!healthy && attempts < 3 && service.isConnected()) {
                    try { Thread.sleep(500) } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt()
                        return@executeOnPooledThread
                    }
                }
            }
            if (!healthy) {
                edtRender { renderError(MyMessageBundle.message("settings.models.error.health")) }
                return@executeOnPooledThread
            }
            // ③ One real catalog fetch. Health only proves the port is up;
            // the per-directory instance bootstrap may still be running, so
            // this GET's 10s timeout absorbs that. Catch Exception (not just
            // IOException) so non-IO failures — malformed JSON parsing,
            // HttpClient IllegalStateException — also land in ERROR with a
            // retry link, instead of escaping the pooled thread and leaving
            // the page stuck in LOADING forever. runCatching{}.getOrElse{
            // emptyList()} would still swallow into EMPTY, defeating the
            // health gate and rendering an "add provider" empty page for a
            // broken backend.
            val models = try {
                service.modelCatalog()
            } catch (e: Exception) {
                log.warn("reload: modelCatalog failed after health check passed", e)
                null
            }
            if (models == null) {
                edtRender { renderError(MyMessageBundle.message("settings.models.error.fetch")) }
                return@executeOnPooledThread
            }
            val providers = runCatching { service.availableProviders() }.getOrElse { emptyList() }
            val baseUrls = providers.associate { it.id to (it.baseUrl ?: "") }
            val authStates = providers.associate { it.id to it.hasAuth }
            val configNpms = runCatching { service.customProviderNpms() }.getOrElse { emptyMap() }
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
            // edtRender (not plain invokeLater) so the modal Settings dialog
            // stays interactive during the callback AND the disposed guard
            // skips the tail if the dialog closed mid-fetch.
            edtRender {
                if (filteredModels.isNotEmpty() || committedModels.isEmpty()) {
                    committedModels = mergeCustomModels(filteredModels)
                    modelStore.cacheCatalog(committedModels)
                }
                providerBaseUrls = baseUrls
                providerAuthMap = authStates
                configProviderNpms = configNpms
                committedPreferred = modelStore.getGlobalModelId()
                preferredInitialized = true
                rebuildTree()
                // show "No models" status under a fully-populated cached tree.
                when {
                    committedModels.isNotEmpty() -> renderReady()
                    service.isConnected() -> renderEmpty()
                    else -> renderError(service.statusText())
                }
            }
        }
    }

    // --- reload status renderers ---
    // LOADING: catalog fetch in progress. Tree stays empty (no cache-first
    // render), search disabled, statusPane shows the loading text. Retry
    // hidden — there's nothing to retry yet, the page is actively driving
    // the backend.
    private fun renderLoading() {
        statusLabel.text = MyMessageBundle.message("settings.models.loading")
        retryLink.isVisible = false
        statusPane.isVisible = true
        searchField.isEnabled = false
    }

    // READY: catalog rendered (rebuildTree already called by reload). Hide
    // status, restore search.
    private fun renderReady() {
        statusPane.isVisible = false
        searchField.isEnabled = true
    }

    // EMPTY: backend connected and healthy, catalog is genuinely empty (no
    // providers configured). Status + retry shown; controls restored because
    // adding a provider is the natural next step here.
    private fun renderEmpty() {
        statusLabel.text = MyMessageBundle.message("settings.models.empty")
        retryLink.isVisible = true
        statusPane.isVisible = true
        searchField.isEnabled = true
    }

    // ERROR: backend unreachable, health never confirmed, or catalog GET
    // threw IOException. Status shows statusText(); retry link re-runs
    // reload(); search disabled (filtering an empty tree is pointless).
    private fun renderError(text: String) {
        statusLabel.text = text
        retryLink.isVisible = true
        statusPane.isVisible = true
        searchField.isEnabled = false
    }

    private fun pollUntilStable(): List<DevEcoHttpApi.ModelInfo> {
        var current = runCatching { service.modelCatalog() }
            .onFailure { log.warn("pollUntilStable: initial modelCatalog failed", it) }
            .getOrNull()
            .orEmpty()
        var prevKeys = current.map { it.providerId to it.modelId }.toSet()
        var attempts = 0
        while (attempts < 8) {
            try { Thread.sleep(300) } catch (_: InterruptedException) {
                // Restore the interrupt flag (see reload()'s health loop for
                // rationale) before bailing.
                Thread.currentThread().interrupt()
                return current
            }
            val next = runCatching { service.modelCatalog() }
                .onFailure { log.warn("pollUntilStable: modelCatalog attempt ${attempts + 1} failed", it) }
                .getOrNull()
                .orEmpty()
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

    // Snapshot a provider's current definition for rollback. Manual providers
    // restore their full CustomProvider (reconstructed from committedModels +
    // providerBaseUrls, protocol from the committed registry); provider-type
    // providers restore only their model list via connectProvider, which
    // writes no `npm` into the config and thus leaves the catalog SDK intact.
    private fun snapshotProviderForRollback(
        providerId: String,
        snapshots: MutableMap<String, ProviderRollbackSnapshot>,
    ) {
        if (providerId in snapshots) return
        val type = typeCache[providerId] ?: modelStore.getProviderType(providerId) ?: "provider"
        val models = committedModels.filter { it.providerId == providerId }
            .map { DevEcoHttpApi.CustomModel(it.modelId, it.modelName) }
        if (models.isEmpty()) return
        val providerName = models.firstOrNull()?.let { committedModels.firstOrNull { m -> m.providerId == providerId }?.providerName }
            ?: providerId
        val baseUrl = providerBaseUrls[providerId] ?: ""
        if (baseUrl.isEmpty()) return
        if (type == "manual") {
            // Rollback must restore the last APPLIED protocol. providerApiNpm
            // prefers staged edits, which carry the not-yet-applied protocol a
            // rollback is reverting, so resolve from the committed registry
            // directly (providers snapshotted here always have committed
            // models; pre-feature entries predate the registry and were
            // always openai-compatible).
            snapshots[providerId] = ProviderRollbackSnapshot.Manual(
                DevEcoHttpApi.CustomProvider(
                    providerId, providerName, baseUrl, null, emptyMap(), models,
                    modelStore.getProviderProtocol(providerId) ?: DevEcoHttpApi.CustomProvider.DEFAULT_API_NPM,
                ),
            )
        } else {
            snapshots[providerId] = ProviderRollbackSnapshot.Catalog(
                providerId, providerName,
                models.map { DevEcoHttpApi.ProviderModelInfo(it.id, it.name) },
            )
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
    // Last filter seen by rebuildTree; used to detect a search→cleared
    // transition (see rebuildTree) so the expansion snapshot below can be
    // restored instead of the stale partial capture from the filtered tree.
    private var lastFilter = ""
    // Expansion state of the unfiltered tree. Captured whenever rebuildTree
    // runs on a tree built without a filter (so manual expand/collapse since
    // the last rebuild is included), frozen while a search is active, and
    // restored when the search is cleared.
    private var preSearchExpansion: Set<String> = emptySet()
    // Platform speed-search matcher for the current filter text, built exactly
    // like the IDE's SpeedSearch.updatePattern ("*" + text, case-insensitive,
    // camel-hump aware). rebuildTree filters with it and the cell renderer
    // highlights matched fragments through SpeedSearchUtil — the same search
    // semantics and highlighting the base IDE uses.
    private var searchMatcher: MinusculeMatcher? = null

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
            val filter = searchField.text.trim()
            // Build the matcher the same way the platform's SpeedSearch does
            // (see com.intellij.ui.speedSearch.SpeedSearch.updatePattern) so
            // filtering and highlighting share the IDE's search semantics,
            // including camel-hump matching ("ds" finds "DeepSeek"). The
            // builder defaults to case-insensitive on both 243 (NONE) and 261
            // (IGNORE_CASE); the explicit withCaseSensitivity call is already
            // deprecated on 261, so rely on the default.
            val matcher = if (filter.isEmpty()) {
                null
            } else {
                NameUtil.MatcherBuilder("*$filter")
                    .withSeparators(SpeedSearchUtil.getDefaultHardSeparators())
                    .build()
            }
            searchMatcher = matcher
            // A search→cleared transition: the capture above came from the
            // filtered tree, which lost the pre-search state of providers
            // without matches — restore the snapshot instead of using it.
            val searchJustCleared = filter.isEmpty() && lastFilter.isNotEmpty()
            // Snapshot the capture whenever the tree being replaced was built
            // without a filter: on empty-filter rebuilds (stays fresh) and on
            // the first keystroke of a search (grabs manual expand/collapse
            // done since the last rebuild). Mid-search rebuilds keep the
            // snapshot frozen.
            if (lastFilter.isEmpty()) {
                preSearchExpansion = expandedProviderIds
            }
            lastFilter = filter

            // Two-level search match: a provider group appears when any of
            // its models matches (the group then lists ONLY the matched
            // models) or when the provider itself matches (the group keeps
            // its full model list so the collapsed row stays explorable).
            // Providers with no match at either level are hidden entirely.
            val providerBuckets = allModels.groupBy { it.providerId }
            val modelMatchesByProvider: Map<String, List<DevEcoHttpApi.ModelInfo>> =
                if (matcher == null) {
                    emptyMap()
                } else {
                    providerBuckets.mapValues { (_, models) ->
                        models.filter {
                            matcher.matches(it.modelName) || matcher.matches(it.modelId)
                        }
                    }
                }
            val unsortedGroups = if (matcher == null) {
                providerBuckets.toList()
            } else {
                providerBuckets.entries.mapNotNull { (providerId, models) ->
                    val modelMatches = modelMatchesByProvider[providerId].orEmpty()
                    when {
                        modelMatches.isNotEmpty() -> providerId to modelMatches
                        models.any {
                            matcher.matches(it.providerName) ||
                                matcher.matches(it.providerId)
                        } -> providerId to models
                        else -> null
                    }
                }
            }
            val grouped = unsortedGroups.sortedWith(compareBy { providerDisplayName(it.first).lowercase() })

            for ((providerId, models) in grouped) {
                val providerName = models.firstOrNull()?.providerName ?: providerDisplayName(providerId)
                val type = typeCache[providerId] ?: "provider"
                // Counts are provider-wide, never search-filtered: the
                // denominator is the provider's full projected model list
                // and the numerator counts checked models across that same
                // list, so "selected/total" keeps its meaning while a search
                // narrows the visible rows. The explicit lambda parameter
                // avoids a body starting with a parenthesized expression,
                // which K2 misparses as a destructured parameter list.
                val fullModels = providerBuckets[providerId].orEmpty()
                val selectedCount = fullModels.count { model -> (model.providerId to model.modelId) !in blacklistCache }
                val groupNode = ProviderGroupNode(providerId, providerName, type, selectedCount, fullModels.size)
                val node = DefaultMutableTreeNode(groupNode)
                models.sortedWith(compareBy({ it.modelName.lowercase() }, { it.modelId.lowercase() }))
                    .forEach { node.add(DefaultMutableTreeNode(it)) }
                root.add(node)
            }

            treeModel.setRoot(root)
            hoveredRow = -1
            // Expand by TreePath, not expandRow: expanding a row inserts its
            // child rows below and shifts later providers' row indices, so a
            // forward expandRow loop only reaches the first provider. While
            // searching, expand only groups with model hits — provider-only
            // hits stay collapsed; after a cleared search, restore the
            // pre-search snapshot; otherwise keep each provider's captured
            // state (a fresh page's empty capture leaves everything
            // collapsed, the intended default).
            val modelHitProviderIds = modelMatchesByProvider.filterValues { it.isNotEmpty() }.keys
            for (i in 0 until root.childCount) {
                val groupNode = root.getChildAt(i) as? DefaultMutableTreeNode ?: continue
                val group = groupNode.userObject as? ProviderGroupNode ?: continue
                val shouldExpand = when {
                    filter.isNotEmpty() -> group.providerId in modelHitProviderIds
                    searchJustCleared -> group.providerId in preSearchExpansion
                    else -> group.providerId in expandedProviderIds
                }
                if (shouldExpand) tree.expandPath(TreePath(groupNode.path))
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

    // Dark-aware fallback: classic dark themes define no Table.hoverBackground
    // key, so a light-only default would leak a light blue hover into dark UI.
    // Values mirror JBUI's DefaultRendererHoverBackground pair.
    private val HOVER_BG: Color = JBColor.namedColor("Table.hoverBackground", JBColor(0xEDF5FC, 0x464A4D))

    // The "+ Add Model" header strip per the design: light grey #DFE1E6 on
    // light themes, dark grey #43454A on dark ones. Text and icon keep their
    // themed foregrounds, which contrast with either shade.
    private val ADD_MODEL_BG: Color = JBColor(0xDFE1E6, 0x43454A)

    private fun repaintTree() = tree.repaint()

    // --- tree node types ---

    private data class ProviderGroupNode(
        val providerId: String,
        val providerName: String,
        val type: String,
        val selectedCount: Int,
        val totalCount: Int,
    )

    private data class PendingConnect(val providerId: String, val providerName: String, val apiKey: String?, val models: List<DevEcoHttpApi.ProviderModelInfo>)

    private data class PendingEdit(val oldProviderId: String, val newProvider: DevEcoHttpApi.CustomProvider, val oldModelIds: Set<String> = emptySet(), val oldSingleModelId: String? = null)

    // Rollback snapshot of a provider's pre-Apply state. Manual providers
    // restore their full custom definition (including protocol) via
    // addCustomProvider; provider-type (catalog) providers restore only their
    // model list via connectProvider, which writes no `npm` into the config —
    // writing one would override the catalog SDK (see connectProvider) and
    // corrupt the customProviderIds() custom/built-in discriminator.
    private sealed interface ProviderRollbackSnapshot {
        data class Manual(val provider: DevEcoHttpApi.CustomProvider) : ProviderRollbackSnapshot
        data class Catalog(
            val providerId: String,
            val providerName: String,
            val models: List<DevEcoHttpApi.ProviderModelInfo>,
        ) : ProviderRollbackSnapshot
    }

    // --- tree cell renderer ---

    private inner class ModelTreeCellRenderer : javax.swing.tree.TreeCellRenderer {
        override fun getTreeCellRendererComponent(tree: JTree, value: Any?, sel: Boolean, expanded: Boolean, leaf: Boolean, row: Int, hasFocus: Boolean): Component {
            val node = value as? DefaultMutableTreeNode
            val userObject = node?.userObject
            // Selected rows are painted with Table.selectionBackground, which is
            // a saturated blue in the classic light theme — text and icons must
            // switch to the selection foreground to stay readable on it.
            // `sel` is always false here (the tree clears its selection before
            // painting rows, see the paint override), so the selected row
            // arrives via the selectedRow field set around super.paint().
            val rowSelected = sel || row == selectedRow
            val selFg: Color? = if (rowSelected) UIUtil.getTableSelectionForeground() else null
            // Whole-row disabled visual while apply() runs: the click handlers
            // drop events in that window (see the tree's mouse listener), so
            // rows must look inert — gray text/icons, inert checkbox, gray
            // action icons, no hand cursor.
            val busy = !tree.isEnabled
            val rowFg = selFg ?: if (busy) UIUtil.getContextHelpForeground() else UIUtil.getLabelForeground()
            // Gray new-UI icons have no contrast on the saturated selection; tint
            // them into silhouettes of the selection foreground (hover rows keep
            // the original icons — the hover background is pale in every theme).
            fun iconOnSelection(icon: Icon): Icon = when {
                selFg != null -> TintedIcon(icon, selFg)
                busy -> TintedIcon(icon, UIUtil.getContextHelpForeground())
                else -> icon
            }
            // Hover action buttons painted from the same RowAction lists the
            // click handlers dispatch through — no separate layout logic here.
            fun actionLabel(action: RowAction): JLabel = JLabel(iconOnSelection(action.icon)).apply {
                isOpaque = false
                toolTipText = action.tooltip
                if (!busy) cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                preferredSize = Dimension(ACTION_BTN_SIZE, ACTION_BTN_SIZE)
                horizontalAlignment = SwingConstants.CENTER
                verticalAlignment = SwingConstants.CENTER
            }

            if (userObject is ProviderGroupNode) {
                val panel = JPanel().apply {
                    layout = BoxLayout(this, BoxLayout.X_AXIS)
                    isOpaque = false
                    border = EmptyBorder(0, 0, 0, 0)
                    preferredSize = Dimension(Integer.MAX_VALUE, 28)
                }
                val chevronIcon = if (expanded) AllIcons.General.ChevronDown else AllIcons.General.ChevronRight
                panel.add(JLabel(iconOnSelection(chevronIcon)).apply { isOpaque = false; preferredSize = Dimension(16, 16) })
                panel.add(Box.createHorizontalStrut(4))
                panel.add(searchableText(
                    userObject.providerName,
                    SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, rowFg),
                    UIUtil.getLabelFont().deriveFont(Font.PLAIN, 12f),
                    selected = rowSelected,
                ))
                panel.add(Box.createHorizontalStrut(6))
                // Builtin providers are view-only (their models carry no
                // checkbox), so the selected count would always equal the
                // total — keep their plain (N) form.
                val countText = if (userObject.type == "builtin") {
                    "(${userObject.totalCount})"
                } else {
                    "(${userObject.selectedCount}/${userObject.totalCount})"
                }
                panel.add(JLabel(countText).apply {
                    isOpaque = false
                    font = font.deriveFont(Font.PLAIN, 11f)
                    foreground = selFg ?: UIUtil.getContextHelpForeground()
                })
                panel.add(Box.createHorizontalGlue())
                // Action buttons on hover or selection; providerActions() is
                // the single source of truth shared with handleProviderClick.
                if (rowSelected || row == hoveredRow) {
                    for (action in providerActions(userObject)) panel.add(actionLabel(action))
                }
                panel.add(Box.createHorizontalStrut(ACTION_GUTTER))
                return panel
            } else if (userObject is DevEcoHttpApi.ModelInfo) {
                val fg = selFg
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
                        isEnabled = !busy
                        border = EmptyBorder(0, 0, 0, 0)
                        margin = Insets(0, 0, 0, 0)
                        isSelected = !isBlacklisted
                        preferredSize = Dimension(20, 20)
                        horizontalAlignment = SwingConstants.CENTER
                    })
                }

                // Model name
                panel.add(Box.createHorizontalStrut(4))
                panel.add(searchableText(
                    userObject.modelName,
                    SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, rowFg),
                    UIUtil.getLabelFont().deriveFont(Font.PLAIN, 12f),
                    selected = rowSelected,
                ))

                // Model ID
                panel.add(Box.createHorizontalStrut(6))
                panel.add(searchableText(
                    userObject.modelId,
                    SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, fg ?: UIUtil.getContextHelpForeground()),
                    UIUtil.getLabelFont().deriveFont(Font.PLAIN, 11f),
                    selected = rowSelected,
                ))

                panel.add(Box.createHorizontalGlue())

                // Action buttons on hover or selection; modelActions() is the
                // single source of truth shared with handleModelClick.
                if (rowSelected || row == hoveredRow) {
                    for (action in modelActions(userObject)) panel.add(actionLabel(action))
                }
                panel.add(Box.createHorizontalStrut(ACTION_GUTTER))
                return panel
            }

            return JLabel(value?.toString() ?: "")
        }
    }

    // Text cell backed by SimpleColoredComponent, the component the platform's
    // speed-search highlighting is designed for: while a search is active,
    // SpeedSearchUtil.appendColoredFragmentForMatcher splits the text into
    // matched/unmatched fragments and SimpleColoredComponent paints matches
    // with the IDE's standard search-match highlight.
    // SimpleColoredComponent.getPreferredSize ignores setPreferredSize, so size
    // behavior is expressed via overrides/min: max pinned to preferred (never
    // grows into the glue's slack) and min opened to 0 (shrinkable under space
    // pressure so long names clip instead of pushing later cells out of the row).
    private fun searchableText(
        text: String,
        attributes: SimpleTextAttributes,
        font: Font,
        selected: Boolean,
    ): SimpleColoredComponent {
        val component = object : SimpleColoredComponent() {
            override fun getMaximumSize(): Dimension = getPreferredSize()
        }
        component.isOpaque = false
        component.setIpad(JBUI.emptyInsets())
        component.setMyBorder(JBUI.Borders.empty())
        component.font = font
        val matcher = searchMatcher
        if (matcher != null) {
            // Force `selected = true` to bypass the platform's
            // "ide.highlight.match.in.selected.only" gate (default true on
            // 261, see misc/registry.properties): with selected=false,
            // appendColoredFragmentForMatcher appends the whole text as a
            // single plain fragment and never emits STYLE_SEARCH_MATCH, so no
            // match is ever highlighted. This tree paints rows with the
            // selection cleared (selectedRow=-1 during paint), so almost every
            // row would otherwise pass selected=false and get no highlight.
            // The `background` param still tracks the real row-selected state
            // so the matched fragment's base matches the row; the highlight
            // itself is painted by SimpleColoredComponent via
            // STYLE_SEARCH_MATCH using UIUtil.getSearchMatchGradient* colors.
            SpeedSearchUtil.appendColoredFragmentForMatcher(
                text, component, attributes, matcher,
                UIUtil.getTreeBackground(selected, true), true,
            )
        } else {
            component.append(text, attributes)
        }
        component.minimumSize = Dimension(0, component.preferredSize.height)
        return component
    }

    /**
     * Paints [original] as a flat silhouette in [tint]: the glyph's alpha is
     * kept, every pixel color is replaced. Used for inline action icons on
     * selected rows, where the gray platform icon palette has no contrast
     * against the selection background.
     */
    private class TintedIcon(private val original: Icon, private val tint: Color) : Icon {
        private var cachedImage: BufferedImage? = null
        private var cachedScale = -1f

        override fun getIconWidth(): Int = original.iconWidth

        override fun getIconHeight(): Int = original.iconHeight

        override fun paintIcon(c: Component?, g: Graphics, x: Int, y: Int) {
            val scale = if (g is Graphics2D) ScaleContext.create(g).getScale(DerivedScaleType.PIX_SCALE).toFloat() else 1f
            var image = cachedImage
            if (image == null || scale != cachedScale) {
                image = render(scale)
                cachedImage = image
                cachedScale = scale
            }
            g.drawImage(image, x, y, iconWidth, iconHeight, null)
        }

        private fun render(scale: Float): BufferedImage {
            val image = BufferedImage(
                maxOf(1, (iconWidth * scale).toInt()),
                maxOf(1, (iconHeight * scale).toInt()),
                BufferedImage.TYPE_INT_ARGB,
            )
            val g = image.createGraphics()
            g.scale(scale.toDouble(), scale.toDouble())
            original.paintIcon(null, g, 0, 0)
            // SrcIn keeps the glyph's alpha and fills it with the tint color.
            g.composite = AlphaComposite.SrcIn
            g.color = tint
            g.fillRect(0, 0, image.width, image.height)
            g.dispose()
            return image
        }
    }
}
