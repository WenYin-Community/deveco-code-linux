package org.deveco.code.session.editor

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.colors.EditorColorsListener
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.OnePixelSplitter
import org.deveco.code.MyMessageBundle
import org.deveco.code.acp.AcpClientService
import org.deveco.code.action.DevEcoSessionActions
import org.deveco.code.action.PendingChatHandoff
import org.deveco.code.platform.devEcoComposePanel
import org.deveco.code.session.SessionController
import org.deveco.code.session.SessionControllerRegistry
import org.deveco.code.session.SessionModelStore
import org.deveco.code.session.SessionViewStateStore
import org.deveco.code.session.TokenUsageStore
import org.deveco.code.session.editor.SessionEditorPreview
import org.deveco.code.session.editor.SessionVirtualFile
import org.deveco.code.session.model.ChatItem
import org.deveco.code.session.model.ChatRole
import org.deveco.code.session.model.FileReference
import org.deveco.code.session.model.SessionViewState
import org.deveco.code.session.model.SessionViewportState
import org.deveco.code.session.model.ToolFileLocation
import org.deveco.code.session.ui.SessionScreen
import org.deveco.code.session.ui.messages.LocalPreviewedFilePath
import java.awt.BorderLayout
import java.awt.Dimension
import java.beans.PropertyChangeListener
import javax.swing.JComponent
import javax.swing.JPanel

class SessionFileEditor(private val project: Project, private val file: SessionVirtualFile) :
    UserDataHolderBase(),
    FileEditor {
    private val log = Logger.getInstance(SessionFileEditor::class.java)

    companion object {
        private const val DEFAULT_PREVIEW_PROPORTION = 0.62f
        private const val MIN_PREVIEW_PROPORTION = 0.2f
        private const val MAX_PREVIEW_PROPORTION = 0.85f
        private const val SPLIT_ANIM_FRAME_MS = 15
        private const val SPLIT_ANIM_DURATION_MS = 180
        private const val COMPOSE_PANEL_MIN_WIDTH = 800
    }

    private val service = project.getService(AcpClientService::class.java)
    private val viewStateStore = project.getService(SessionViewStateStore::class.java)
    private val actions = project.getService(DevEcoSessionActions::class.java)
    private var disposed = false

    // Conversation this editor currently renders. The chat is a single tab, so a
    // session switch re-binds this editor instead of closing and reopening the tab.
    private var boundSessionId = file.sessionId

    // The handoff this editor took over, before restoredViewState is read: its draft and
    // file reference are already merged into the view state, its prompt delivery and mode
    // mirror apply when the controller attaches.
    private var pendingHandoff: PendingChatHandoff? = null

    init {
        pendingHandoff = consumePending()
    }

    private var restoredViewState = viewStateStore.get(boundSessionId)

    // Live mirror of the saved viewport for Compose composition rebuilds. Tab
    // switches dispose the ComposePanel composition; a rebuilt SessionScreen
    // reads this provider instead of the stale restoredViewState snapshot that
    // was captured once at editor construction, so it resumes from the actual
    // pre-switch position and followTail instead of jumping back in time.
    // Only the four viewport fields (anchorMessageId, firstVisibleItemIndex,
    // firstVisibleItemOffset, followTail) are kept live; every other field
    // (draft, expandedThoughts, fileReferences, preview*) remains the
    // construction-time snapshot. The Compose side reads viewport fields only
    // — do not start reading draft & co. from here without making them live.
    // Plain @Volatile field, not snapshot state: the only reader is the remember {}
    // initializer of a freshly rebuilt composition, and a snapshot-backed write per
    // scrolled pixel would invalidate that composition's scope on every scroll step.
    @Volatile
    private var composeRestoredState: SessionViewState? = restoredViewState
    private val modelStore = SessionModelStore.getInstance(project)
    private val tokenUsageStore = TokenUsageStore.getInstance(project)

    // Owned by the registry so it survives its tab closing mid-stream; reopening the tab
    // re-attaches to the same controller.
    internal var controller = SessionControllerRegistry.getInstance(project).acquire(boundSessionId) {
        createController(boundSessionId, restoredViewState)
    }
        private set

    /** The chat file this editor renders; the single tab re-binds it to other sessions. */
    internal val sessionFile: SessionVirtualFile get() = file

    @Volatile
    private var viewportState = SessionViewportState(
        restoredViewState?.anchorMessageId,
        restoredViewState?.firstVisibleItemIndex ?: 0,
        restoredViewState?.firstVisibleItemOffset ?: 0,
        restoredViewState?.followTail ?: true,
    )

    private val draftText = mutableStateOf(restoredViewState?.draft.orEmpty())
    private var previewOpen = false
    private var previewProportion = restoredViewState?.previewProportion ?: DEFAULT_PREVIEW_PROPORTION
    private var splitAnimation: javax.swing.Timer? = null
    private var animatingSplit = false

    // Session the Compose content is keyed by: changing it disposes the old screen and
    // rebuilds SessionScreen (and all its remembered state) for the new controller.
    private val currentSession = mutableStateOf(boundSessionId)

    // Bumped when an older editor's live viewport is handed over after this panel may have
    // composed already; the key change rebuilds the screen from the copied state instead of
    // keeping the stale snapshot the first composition remembered.
    private val contentGeneration = mutableStateOf(0)

    private fun editorBg(): java.awt.Color =
        com.intellij.openapi.editor.colors.EditorColorsManager.getInstance().globalScheme.defaultBackground

    private val previewedFilePath = mutableStateOf<String?>(null)
    private val composePanel = devEcoComposePanel {
        key(currentSession.value, contentGeneration.value) {
            CompositionLocalProvider(LocalPreviewedFilePath provides previewedFilePath.value) {
                SessionScreen(
                    project = project,
                    controller = controller,
                    restoredStateProvider = { composeRestoredState },
                    currentDraft = draftText.value,
                    onOpenFile = ::openFilePreview,
                    onViewportChanged = { viewport ->
                        viewportState = viewport
                        composeRestoredState = (composeRestoredState ?: SessionViewState.initial()).copy(
                            anchorMessageId = viewport.anchorMessageId,
                            firstVisibleItemIndex = viewport.firstVisibleItemIndex,
                            firstVisibleItemOffset = viewport.firstVisibleItemOffset,
                            followTail = viewport.followTail,
                        )
                    },
                    onDraftChanged = { newText ->
                        draftText.value = newText
                        viewStateStore.update(boundSessionId) { existing ->
                            if (existing != null) {
                                existing.copy(draft = newText)
                            } else {
                                SessionViewState.initial().copy(
                                    draft = newText,
                                    fileReferences = controller.fileReferences.toList(),
                                )
                            }
                        }
                    },
                )
            }
        }
    }.apply {
        background = editorBg()
    }
    private val composeHost = JPanel(object : java.awt.LayoutManager {
        override fun addLayoutComponent(name: String?, comp: java.awt.Component?) = Unit
        override fun removeLayoutComponent(comp: java.awt.Component?) = Unit
        override fun preferredLayoutSize(parent: java.awt.Container) =
            Dimension(COMPOSE_PANEL_MIN_WIDTH, parent.components.firstOrNull()?.preferredSize?.height ?: 0)

        override fun minimumLayoutSize(parent: java.awt.Container) = Dimension(0, 0)
        override fun layoutContainer(parent: java.awt.Container) {
            if (parent.componentCount > 0) {
                val w = COMPOSE_PANEL_MIN_WIDTH.coerceAtLeast(parent.width)
                parent.getComponent(0).setBounds(0, 0, w, parent.height)
            }
        }
    }).apply {
        isOpaque = true
        background = editorBg()
        minimumSize = Dimension(0, 0)
        add(composePanel)
    }
    private val previewHost = JPanel(BorderLayout()).apply {
        isOpaque = true
        background = editorBg()
        minimumSize = Dimension(0, 0)
    }
    private val editorPreview = SessionEditorPreview(
        project,
        previewHost,
        ::closeFilePreview,
        onPreviewChanged = { path -> previewedFilePath.value = path },
        // Called on EDT after the preview mounts; file checks are async in SessionEditorPreview.open().
        onMounted = {
            val wasOpen = previewOpen
            previewOpen = true
            setPreviewSplitterVisible(true)
            if (!wasOpen) animateSplitTo(previewProportion)
        },
    )
    private val splitter = OnePixelSplitter(false, 0.999f).apply {
        setHonorComponentsMinimumSize(true)
        firstComponent = composeHost
        secondComponent = previewHost
        background = editorBg()
        setResizeEnabled(false)
        divider.isVisible = false
        addPropertyChangeListener("proportion") {
            if (previewOpen && !animatingSplit) previewProportion = proportion
        }
    }

    // Wrapper panel that forces the editor background as the base layer
    private val component: JComponent = object : JPanel(java.awt.BorderLayout()) {
        override fun paintComponent(g: java.awt.Graphics) {
            g.color = editorBg()
            g.fillRect(0, 0, width, height)
        }
    }.apply {
        isOpaque = true
        background = editorBg()
        add(splitter, java.awt.BorderLayout.CENTER)
        addMouseWheelListener { e -> e.consume() }
    }

    private val colorsListener = EditorColorsListener {
        val bg = editorBg()
        composePanel.background = bg
        previewHost.background = bg
        splitter.background = bg
        component.background = bg
        component.repaint()
        previewHost.repaint()
    }
    private val colorsConnection = project.messageBus.connect().also {
        it.subscribe(EditorColorsManager.TOPIC, colorsListener)
    }

    init {
        attachController()
        // Splitting the editor area (or docking the chat) makes the platform open a second
        // editor for the same file. The chat is one tab: the editor that opens last takes
        // the conversation over and closes the older one, together with the group the older
        // one was the only tab of.
        if (project.getService(SessionEditorRegistry::class.java).register(this)) {
            ApplicationManager.getApplication().invokeLater { takeOverFromOlderEditors() }
        }
    }

    private fun takeOverFromOlderEditors(attempt: Int = 0) {
        if (disposed || project.isDisposed) return
        val older = project.getService(SessionEditorRegistry::class.java).others(this)
            .filterIsInstance<SessionFileEditor>()
            .mapNotNull { editor -> editorWindowOf(editor)?.let { editor to it } }
        if (older.isEmpty()) {
            // The other tab may still be mounting; try again before giving up.
            if (attempt < 2) {
                ApplicationManager.getApplication().invokeLater { takeOverFromOlderEditors(attempt + 1) }
            } else {
                log.warn("chat-tab: no window for the previous chat editor")
            }
            return
        }
        // The old editor's scroll position is live in memory, not yet in the store. This
        // editor may have composed before the hand-off runs, and SessionScreen remembers its
        // restored state once, so copy the viewport and force the screen to rebuild from it.
        older.lastOrNull()?.first?.let { previous ->
            composeRestoredState = previous.composeRestoredState
            viewportState = previous.viewportState
            contentGeneration.value++
        }
        // disposeIfNeeded = true also drops the group that only held an old tab, so the
        // split folds back instead of leaving a blank pane next to the chat.
        older.forEach { (editor, window) -> window.closeFile(editor.file, disposeIfNeeded = true) }
    }

    /**
     * Re-binds this editor to [sessionId] without closing its tab. The outgoing
     * conversation is persisted and handed to the controller cache (callers mark the
     * controller as switch-closed), the Compose content is keyed by the session so it
     * is disposed and rebuilt for the new one.
     */
    fun switchTo(sessionId: String) {
        if (!SessionTabPolicy.requiresRebind(boundSessionId, sessionId)) return
        persistViewState()
        SessionControllerRegistry.getInstance(project).release(controller)
        boundSessionId = sessionId
        file.sessionId = sessionId
        pendingHandoff = consumePending()
        restoredViewState = viewStateStore.get(sessionId)
        composeRestoredState = restoredViewState
        draftText.value = restoredViewState?.draft.orEmpty()
        viewportState = SessionViewportState(
            restoredViewState?.anchorMessageId,
            restoredViewState?.firstVisibleItemIndex ?: 0,
            restoredViewState?.firstVisibleItemOffset ?: 0,
            restoredViewState?.followTail ?: true,
        )
        resetPreview()
        previewProportion = restoredViewState?.previewProportion ?: DEFAULT_PREVIEW_PROPORTION
        controller = SessionControllerRegistry.getInstance(project).acquire(sessionId) {
            createController(sessionId, restoredViewState)
        }
        attachController()
        // Set last: the key change rebuilds SessionScreen against the new controller.
        currentSession.value = sessionId
    }

    private fun createController(sessionId: String, restored: SessionViewState?): SessionController =
        SessionController(sessionId, service, modelStore, tokenUsageStore, restored, project) {
            restoreFilePreview()
        }

    /**
     * Atomically takes the handoff staged for the bound session (the next-session slot as
     * fallback) and merges its draft and file reference into the session's view state —
     * called before [restoredViewState] is read so a jump sees its pending input. The
     * handoff's prompt delivery and mode mirror are applied when the controller attaches;
     * the take is what makes the whole consumption atomic, so a writer replacing another
     * session's handoff can never tear fields into this one.
     */
    private fun consumePending(): PendingChatHandoff? {
        val handoff = actions.takeHandoff(boundSessionId) ?: return null
        // The bridge holds the creation guard until its delivery is consumed.
        if (handoff.releaseBusyOnConsume) actions.busy = false
        // Record this session as the last jump target for sticky reuse
        if (handoff.fileReference != null) {
            actions.lastJumpSessionId = boundSessionId
        }
        if (handoff.draft == null && handoff.fileReference == null) return handoff
        // Atomic merge-write like every other SessionViewState writer: a
        // plain get+save pair could drop a concurrent field update.
        viewStateStore.update(boundSessionId) { existing ->
            (existing ?: SessionViewState.initial()).copy(
                draft = handoff.draft ?: (existing?.draft ?: ""),
                fileReferences = if (handoff.fileReference != null) {
                    (existing?.fileReferences ?: emptyList()) + handoff.fileReference
                } else {
                    existing?.fileReferences ?: emptyList()
                },
            )
        }
        return handoff
    }

    private fun attachController() {
        pendingHandoff?.let { handoff ->
            handoff.fullPrompt?.let { controller.pendingPrompt = it }
            handoff.autoSendPrompt?.let { controller.autoSendOnReady = it }
            handoff.mode?.let { mode ->
                // A headless-reused controller is already past load-complete, where the
                // ready hook never fires again — mirror immediately in that case.
                if (controller.ready) {
                    controller.mirrorModeSelection(mode)
                } else {
                    controller.onReady = { controller.mirrorModeSelection(mode) }
                }
            }
        }
        pendingHandoff = null
        // A headless-reused controller skips loadSession()/onLoaded, so restore the
        // saved file preview here instead (deferred: openFilePreview may read disk).
        // Fresh controllers restore via onLoaded after loadSession().
        if (controller.isStarted) {
            ApplicationManager.getApplication().invokeLater { if (!disposed) restoreFilePreview() }
        }
        controller.start()
    }

    /**
     * Remove @path text from draft for file references that are already stored as chips.
     * This prevents showing both the chip and the @path text after a tab switch.
     */
    private fun cleanDraftForFileRefs(draft: String, fileRefs: List<FileReference>): String {
        if (fileRefs.isEmpty() || !draft.contains('@')) return draft
        var result = draft
        for (ref in fileRefs) {
            val atPath = "@${ref.path}"
            if (result.contains(atPath)) {
                result = result.replace(atPath, "").trim()
            }
        }
        return result
    }

    private fun restoreFilePreview() {
        val state = restoredViewState ?: return
        val path = state.previewFilePath ?: return
        openFilePreview(
            ChatItem(
                id = "restored-preview",
                role = ChatRole.TOOL,
                title = path,
                text = "",
                toolPath = path,
                toolLine = state.previewLine,
                toolOffset = state.previewOffset,
                toolLimit = state.previewLimit,
            ),
        )
    }

    private fun openFilePreview(item: ChatItem) {
        val location = ToolFileLocation(
            item.toolPath.orEmpty(),
            item.toolLine,
            item.toolOffset,
            item.toolLimit,
        )
        splitAnimation?.stop()
        animatingSplit = false
        try {
            if (!editorPreview.open(location)) return
        } catch (e: Throwable) {
            log.error("openFilePreview: exception while opening '${location.path.substringAfterLast('/')}'", e)
            return
        }
    }

    private fun closeFilePreview() {
        if (!previewOpen && editorPreview.location == null) return
        previewProportion = splitter.proportion.coerceIn(MIN_PREVIEW_PROPORTION, MAX_PREVIEW_PROPORTION)
        animateSplitTo(0.999f) {
            previewOpen = false
            setPreviewSplitterVisible(false)
            editorPreview.close()
        }
    }

    private fun setPreviewSplitterVisible(visible: Boolean) {
        splitter.setResizeEnabled(visible)
        splitter.divider.isVisible = visible
    }

    private fun animateSplitTo(target: Float, after: (() -> Unit)? = null) {
        splitAnimation?.stop()
        val start = splitter.proportion
        val startedAt = System.nanoTime()
        animatingSplit = true
        splitAnimation = javax.swing.Timer(SPLIT_ANIM_FRAME_MS, null).apply {
            addActionListener {
                val progress = (((System.nanoTime() - startedAt) / 1_000_000f) / SPLIT_ANIM_DURATION_MS.toFloat())
                    .coerceIn(0f, 1f)
                val eased = 1f - (1f - progress) * (1f - progress)
                splitter.proportion = start + (target - start) * eased
                if (progress >= 1f) {
                    stop()
                    animatingSplit = false
                    after?.invoke()
                }
            }
            start()
        }
    }

    private fun resetPreview() {
        splitAnimation?.stop()
        animatingSplit = false
        previewOpen = false
        splitter.proportion = 0.999f
        setPreviewSplitterVisible(false)
        editorPreview.close()
    }

    override fun getComponent(): JComponent = component
    override fun getFile(): VirtualFile = file
    override fun getPreferredFocusedComponent(): JComponent = component
    override fun getName(): String = MyMessageBundle.message("session.editor.name")
    override fun setState(state: FileEditorState) = Unit
    override fun isModified() = false
    override fun isValid() = !disposed && file.isValid
    override fun addPropertyChangeListener(listener: PropertyChangeListener) = Unit
    override fun removePropertyChangeListener(listener: PropertyChangeListener) = Unit

    // This editor may have been constructed against a stale file.sessionId: the chat tab
    // opens without waiting for the async editor load (waitForCompositeOpen = false), so
    // openSession can re-bind the tab — file.sessionId = id — while this editor is still
    // materializing, and construction took whatever value it found at that moment. The
    // platform calls selectNotify on the EDT right after applying the editor, and again on
    // every tab selection, so re-checking here converges the binding to the session the
    // tab actually renders. No cross-thread ordering is involved: file.sessionId's writers
    // all run on the EDT, like this callback.
    override fun selectNotify() {
        if (!disposed && file.sessionId != boundSessionId) switchTo(file.sessionId)
    }

    override fun dispose() {
        colorsConnection.disconnect()
        disposed = true
        persistViewState()
        splitAnimation?.stop()
        editorPreview.dispose()
        project.getService(SessionEditorRegistry::class.java).unregister(this)
        // Release, not dispose: stays headless in the registry while still generating.
        // Null-safe lookup: during a plugin unload/disable the registry service may already
        // be unregistered when this editor is disposed — its own dispose() then owns the
        // controller, and an unguarded lookup would abort the editor's disposal here.
        project.getService(SessionControllerRegistry::class.java)?.release(controller)
    }

    private fun persistViewState() {
        val viewport = viewportState
        // Clean up draft: remove @path text for file references that are already stored as chips,
        // so we don't show both the chip and the @path text after a tab switch.
        val cleanedDraft = cleanDraftForFileRefs(draftText.value, controller.fileReferences)
        // Merge into the existing state instead of constructing a fresh one —
        // fields this snapshot does not own (e.g. selectedModelId) must
        // survive the editor's disposal, or a model picked without a prompt
        // is lost the moment the user switches sessions.
        viewStateStore.update(boundSessionId) { existing ->
            (existing ?: SessionViewState.initial()).copy(
                anchorMessageId = viewport.anchorMessageId,
                firstVisibleItemIndex = viewport.firstVisibleItemIndex,
                firstVisibleItemOffset = viewport.firstVisibleItemOffset,
                followTail = viewport.followTail,
                expandedThoughts = controller.expandedThoughts.toMap(),
                expandedTools = controller.expandedTools.toMap(),
                previewFilePath = editorPreview.location?.path,
                previewLine = editorPreview.location?.line,
                previewOffset = editorPreview.location?.offset,
                previewLimit = editorPreview.location?.limit,
                previewProportion = if (previewOpen) splitter.proportion else previewProportion,
                draft = cleanedDraft,
                fileReferences = controller.fileReferences.toList(),
                attachments = controller.attachments.map {
                    it.copy(thumbnail = null, originalBytes = null, optimizedBytes = null, optimizedMime = null)
                },
            )
        }
    }
}
