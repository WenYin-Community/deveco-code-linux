package org.deveco.code.session.editor

import androidx.compose.runtime.CompositionLocalProvider
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
import org.deveco.code.session.SessionController
import org.deveco.code.session.SessionControllerRegistry
import org.deveco.code.session.SessionMessageStore
import org.deveco.code.session.SessionModelStore
import org.deveco.code.session.SessionViewStateStore
import org.deveco.code.session.TokenUsageStore
import org.deveco.code.session.editor.SessionEditorPreview
import org.deveco.code.session.editor.SessionVirtualFile
import org.deveco.code.session.model.ChatItem
import org.deveco.code.session.model.ChatRole
import org.deveco.code.session.model.SessionViewState
import org.deveco.code.session.model.SessionViewportState
import org.deveco.code.session.model.ToolFileLocation
import org.deveco.code.session.ui.SessionScreen
import org.deveco.code.session.ui.messages.LocalPreviewedFilePath
import org.jetbrains.jewel.bridge.JewelComposePanel
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
        private const val COMPOSE_PANEL_MIN_WIDTH = 500
    }

    private val service = project.getService(AcpClientService::class.java)
    private val viewStateStore = project.getService(SessionViewStateStore::class.java)
    private var disposed = false

    // Consume pending draft from "Jump to Chat" action before reading restoredViewState
    init {
        val actions = project.getService(DevEcoSessionActions::class.java)
        val pending = actions.pendingDraft
        val pendingFileRef = actions.pendingFileReference
        if (pending != null || pendingFileRef != null) {
            actions.pendingDraft = null
            actions.pendingFileReference = null
            // Record this session as the last jump target for sticky reuse
            if (pendingFileRef != null) {
                actions.lastJumpSessionId = file.sessionId
            }
            val existing = viewStateStore.get(file.sessionId)
            if (existing != null) {
                viewStateStore.save(
                    file.sessionId,
                    existing.copy(
                        draft = pending ?: existing.draft,
                        fileReferences = if (pendingFileRef !=
                            null
                        ) {
                            existing.fileReferences + pendingFileRef
                        } else {
                            existing.fileReferences
                        },
                    ),
                )
            } else {
                viewStateStore.save(
                    file.sessionId,
                    SessionViewState(
                        anchorMessageId = null,
                        firstVisibleItemIndex = 0,
                        firstVisibleItemOffset = 0,
                        followTail = true,
                        expandedThoughts = emptyMap(),
                        expandedTools = emptyMap(),
                        previewFilePath = null,
                        previewLine = null,
                        previewOffset = null,
                        previewLimit = null,
                        previewProportion = 0f,
                        draft = pending.orEmpty(),
                        fileReferences = listOfNotNull(pendingFileRef),
                    ),
                )
            }
        }
    }

    private val restoredViewState = viewStateStore.get(file.sessionId)
    private val modelStore = SessionModelStore.getInstance(project)
    private val tokenUsageStore = TokenUsageStore.getInstance(project)
    private val messageStore = SessionMessageStore.getInstance(project)

    // Owned by the registry so it survives its tab closing mid-stream (switching
    // sessions closes other session tabs); reopening re-attaches to the same controller.
    internal val controller = SessionControllerRegistry.getInstance(project).acquire(file.sessionId) {
        SessionController(
            file.sessionId,
            service,
            modelStore,
            tokenUsageStore,
            messageStore,
            restoredViewState,
            project,
        ) {
            restoreFilePreview()
        }
    }

    @Volatile
    private var viewportState = SessionViewportState(
        restoredViewState?.anchorMessageId,
        restoredViewState?.firstVisibleItemIndex ?: 0,
        restoredViewState?.firstVisibleItemOffset ?: 0,
        restoredViewState?.followTail ?: true,
    )

    @Volatile
    private var draftText = restoredViewState?.draft.orEmpty()
    private var previewOpen = false
    private var previewProportion = restoredViewState?.previewProportion ?: DEFAULT_PREVIEW_PROPORTION
    private var splitAnimation: javax.swing.Timer? = null
    private var animatingSplit = false

    private fun editorBg(): java.awt.Color =
        com.intellij.openapi.editor.colors.EditorColorsManager.getInstance().globalScheme.defaultBackground
    private val previewedFilePath = mutableStateOf<String?>(null)
    private val composePanel = JewelComposePanel {
        CompositionLocalProvider(LocalPreviewedFilePath provides previewedFilePath.value) {
            SessionScreen(
                project = project,
                controller = controller,
                restoredState = restoredViewState,
                onOpenFile = ::openFilePreview,
                onViewportChanged = { viewportState = it },
                onDraftChanged = { draftText = it },
            )
        }
    }.apply {
        minimumSize = Dimension(COMPOSE_PANEL_MIN_WIDTH, 0)
        background = editorBg()
    }
    private val previewHost = JPanel(BorderLayout()).apply {
        isOpaque = true
        background = editorBg()
        minimumSize = Dimension(0, 0)
    }
    private val editorPreview = SessionEditorPreview(project, previewHost, ::closeFilePreview) { path ->
        previewedFilePath.value = path
    }
    private val splitter = OnePixelSplitter(false, 0.999f).apply {
        setHonorComponentsMinimumSize(false)
        firstComponent = composePanel
        secondComponent = previewHost
        background = editorBg()
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
    }

    private val colorsListener = EditorColorsListener {
        val bg = editorBg()
        composePanel.background = bg
        previewHost.background = bg
        splitter.background = bg
        component.background = bg
        component.repaint()
    }
    private val colorsConnection = project.messageBus.connect().also {
        it.subscribe(EditorColorsManager.TOPIC, colorsListener)
    }

    init {
        // A headless-reused controller skips loadSession()/onLoaded, so restore the
        // saved file preview here instead (deferred: openFilePreview may read disk).
        // Fresh controllers restore via onLoaded after loadSession().
        if (controller.isStarted) {
            ApplicationManager.getApplication().invokeLater { if (!disposed) restoreFilePreview() }
        }
        controller.start()
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
        // Synchronously validate file exists and is not a directory before opening preview panel
        val virtualFile = editorPreview.resolveFile(location.path)
        if (virtualFile == null) {
            log.warn("openFilePreview: file not found, skipping preview '${location.path}'")
            return
        }
        if (virtualFile.isDirectory) {
            log.warn("openFilePreview: skipping directory '${location.path}'")
            return
        }
        val wasOpen = previewOpen
        splitAnimation?.stop()
        animatingSplit = false
        try {
            if (!editorPreview.open(location)) return
        } catch (e: Throwable) {
            log.error("openFilePreview: exception while opening '${location.path}'", e)
            return
        }
        previewOpen = true
        splitter.setHonorComponentsMinimumSize(true)
        if (!wasOpen) animateSplitTo(previewProportion)
    }

    private fun closeFilePreview() {
        if (!previewOpen && editorPreview.location == null) return
        previewProportion = splitter.proportion.coerceIn(MIN_PREVIEW_PROPORTION, MAX_PREVIEW_PROPORTION)
        animateSplitTo(0.999f) {
            previewOpen = false
            splitter.setHonorComponentsMinimumSize(false)
            editorPreview.close()
        }
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

    override fun getComponent(): JComponent = component
    override fun getFile(): VirtualFile = file
    override fun getPreferredFocusedComponent(): JComponent = component
    override fun getName(): String = MyMessageBundle.message("session.editor.name")
    override fun setState(state: FileEditorState) = Unit
    override fun isModified() = false
    override fun isValid() = !disposed && file.isValid
    override fun addPropertyChangeListener(listener: PropertyChangeListener) = Unit
    override fun removePropertyChangeListener(listener: PropertyChangeListener) = Unit

    override fun dispose() {
        colorsConnection.disconnect()
        disposed = true
        val viewport = viewportState
        viewStateStore.save(
            file.sessionId,
            SessionViewState(
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
                draft = draftText,
                fileReferences = controller.fileReferences.toList(),
            ),
        )
        splitAnimation?.stop()
        editorPreview.dispose()
        // Release, not dispose: stays headless in the registry while still generating.
        SessionControllerRegistry.getInstance(project).release(controller)
    }
}
