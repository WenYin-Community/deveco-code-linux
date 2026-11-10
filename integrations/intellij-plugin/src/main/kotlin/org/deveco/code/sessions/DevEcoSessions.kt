package org.deveco.code.sessions

import org.deveco.code.acp.AcpClientService
import org.deveco.code.action.DevEcoSessionActions
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.util.errorMessage
import org.deveco.code.util.hoverable
import org.deveco.code.util.runInEdt
import com.agentclientprotocol.annotations.UnstableApi
import com.agentclientprotocol.model.SessionId
import com.agentclientprotocol.model.SessionInfo
import com.agentclientprotocol.model.SessionUpdate
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.impl.FileEditorManagerImpl
import com.intellij.ide.actions.ShowSettingsUtilImpl
import com.intellij.openapi.project.Project
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.deveco.code.session.SessionStorage
import org.deveco.code.session.SessionControllerRegistry
import org.deveco.code.session.SessionTitlePolicy
import org.deveco.code.session.SESSION_REFRESH_TOPIC
import org.deveco.code.session.SessionRefreshListener
import org.deveco.code.session.SessionViewStateStore
import org.deveco.code.acp.AcpSessionUpdate
import org.deveco.code.session.editor.SessionFileEditor
import org.deveco.code.session.editor.SessionVirtualFile
import org.deveco.code.session.editor.SessionEditorRegistry
import org.deveco.code.session.editor.SessionTabPolicy
import org.deveco.code.session.editor.placeChatTabFirst
import org.deveco.code.session.editor.revealChatTab
import org.deveco.code.session.model.FileReference
import org.deveco.code.sessions.ui.CollapsibleMenu
import org.deveco.code.sessions.ui.ConfigTab
import org.deveco.code.sessions.ui.SessionDisplayData
import org.deveco.code.sessions.ui.SessionItem
import org.deveco.code.sessions.ui.SessionListCallbacks
import org.deveco.code.sessions.ui.SessionsSection
import org.deveco.code.sessions.ui.SessionsUiState
import org.deveco.code.sessions.ui.showRenameDialog
import org.jetbrains.jewel.ui.component.Text

@Composable
private fun rememberSelectedSessionId(project: Project): MutableState<String?> {
    val state = remember {
        mutableStateOf(
            (FileEditorManager.getInstance(project).selectedFiles.firstOrNull {
                it is SessionVirtualFile
            } as? SessionVirtualFile)?.sessionId,
        )
    }
    DisposableEffect(project) {
        val connection = project.messageBus.connect()
        connection.subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) {
                    val sid = (event.newFile as? SessionVirtualFile)?.sessionId
                    // Splitting the chat closes the cloned editor it created, which empties that
                    // group and nulls the current selection; the surviving editor still shows the
                    // conversation, so keep it selected instead of dropping the sidebar highlight.
                    // A real close detaches the closing editor first, so an attached editor is
                    // what tells the two apart.
                    if (event.newFile == null && SessionEditorRegistry.getInstance(project).hasAttachedEditor()) {
                        return
                    }
                    state.value = sid
                    if (sid != null) {
                        SessionStorage.setLastActiveSessionId(project, sid)
                        if (sid in SessionStorage.unreadIds(project)) {
                            SessionStorage.markRead(project, sid)
                            project.messageBus.syncPublisher(SESSION_REFRESH_TOPIC).onSessionsChanged()
                            val mgr = event.manager
                            val file = SessionEditorRegistry.getInstance(project).chatEditor()?.sessionFile
                            if (file != null && file.isValid && mgr is FileEditorManagerImpl) {
                                mgr.updateFilePresentation(file)
                            }
                        }
                    }
                }
            },
        )
        onDispose { connection.disconnect() }
    }
    return state
}

@Composable
private fun rememberSessionActivityTracking(
    project: Project,
    service: AcpClientService,
    activityMap: MutableMap<String, String>,
    onRunningChanged: () -> Unit,
    onSessionDone: (String) -> Unit,
    onAbnormalChanged: (String) -> Unit,
) {
    DisposableEffect(project) {
        val runningChanged: () -> Unit = { project.runInEdt { onRunningChanged() } }
        val sessionDone: (String) -> Unit = { id -> project.runInEdt { onSessionDone(id) } }
        val abnormalChanged: (String) -> Unit = { id -> project.runInEdt { onAbnormalChanged(id) } }
        service.addOnRunningChanged(runningChanged)
        service.addOnSessionDone(sessionDone)
        service.addOnAbnormalChanged(abnormalChanged)
        val listener: (AcpSessionUpdate) -> Unit = { notification ->
            val id = notification.sessionId.value
            when (val u = notification.update) {
                is SessionUpdate.AgentMessageChunk -> activityMap[id] = "generating"
                is SessionUpdate.ToolCall, is SessionUpdate.ToolCallUpdate -> activityMap[id] = "executing"
                else -> {}
            }
        }
        service.addSessionListener(listener)
        onDispose {
            service.removeSessionListener(listener)
            service.removeOnRunningChanged(runningChanged)
            service.removeOnSessionDone(sessionDone)
            service.removeOnAbnormalChanged(abnormalChanged)
        }
    }
}

@Composable
private fun rememberRefreshTrigger(project: Project, onRefresh: () -> Unit) {
    DisposableEffect(project) {
        val bus = project.messageBus.connect()
        bus.subscribe(SESSION_REFRESH_TOPIC, SessionRefreshListener {
            project.runInEdt { onRefresh() }
        })
        onDispose { bus.disconnect() }
    }
}

@Composable
private fun rememberSessionHandlers(
    actions: DevEcoSessionActions,
    onStateChange: ((SessionsUiState) -> SessionsUiState) -> Unit,
    onRefresh: () -> Unit,
) {
    // The action handlers live at project level (DevEcoSessionActions registers them in
    // init) so /new works while the tool window is hidden; the sidebar only lends them
    // its list state while composed, and takes it back on dispose.
    DisposableEffect(actions) {
        actions.uiOnStateChange = onStateChange
        actions.uiOnRefresh = onRefresh
        onDispose {
            actions.uiOnStateChange = null
            actions.uiOnRefresh = null
        }
    }
}

@Composable
@OptIn(UnstableApi::class)
fun DevEcoSessions(project: Project) {
    AuthenticatedDevEcoSessions(project)
}

@Composable
@OptIn(UnstableApi::class)
private fun AuthenticatedDevEcoSessions(project: Project) {
    val service = remember(project) { project.getService(AcpClientService::class.java) }
    val actions = remember(project) { DevEcoSessionActions.forProject(project) }
    var state by remember { mutableStateOf(SessionsUiState()) }
    var refreshKey by remember { mutableStateOf(0) }
    var selectedSessionId by rememberSelectedSessionId(project)
    var firstLoad by remember { mutableStateOf(true) }

    var menuCollapsed by remember { mutableStateOf(false) }

    var runTick by remember { mutableStateOf(0) }
    val startedAtMap = remember(runTick, refreshKey) { service.runningSnapshot() }
    val lastDurationMap = remember(runTick, refreshKey) {
        SessionStorage.loadLastDurations(project) + service.lastDurationSnapshot()
    }
    // Aggregate: a session stays running while it, a background subagent, or a
    // notice-triggered server-side turn works — its stop action (which the
    // backend cascades to the subagents) stays reachable the whole time.
    val runningIds: Set<String> = remember(runTick, refreshKey) {
        startedAtMap.keys + service.extraRunningIds()
    }
    val activityMap = remember { mutableStateMapOf<String, String>() }

    val panel = DevEcoTheme.panel
    val muted = DevEcoTheme.muted
    val hoverColor = DevEcoTheme.hover
    val ops = actions.ops
    // A single chat tab is re-bound on every switch, so switching content does not fire
    // a FileEditorManager selection event; the ops reports the new session explicitly.
    // Assigned after composition so a state write during composition cannot loop.
    SideEffect { ops.onSessionActivated = { id -> selectedSessionId = id } }
    val onStateChange: ((SessionsUiState) -> SessionsUiState) -> Unit = { f -> state = f(state) }
    val onRefresh: () -> Unit = { refreshKey++ }

    rememberSessionActivityTracking(
        project, service, activityMap,
        onRunningChanged = {
            runTick++
        },
        onSessionDone = { sessionId ->
            runTick++
            onRefresh()
            if (sessionId == selectedSessionId) SessionStorage.markRead(project, sessionId)
            else SessionStorage.markUnread(project, sessionId)
        },
        onAbnormalChanged = { _ ->
        },
    )
    rememberRefreshTrigger(project, onRefresh)
    rememberSessionHandlers(actions, onStateChange, onRefresh)

    LaunchedEffect(refreshKey) {
        ops.loadSessions(onStateChange)
        // On the first list load, reopen the session the user last interacted
        // with (DevEcoGenie restores lastActiveSessionId on connect).
        if (firstLoad) {
            firstLoad = false
            val last = SessionStorage.lastActiveSessionId(project)
            if (last != null) {
                project.runInEdt {
                    val item = state.sessions.firstOrNull { it.info.sessionId.value == last }
                    if (item != null) ops.openSession(last, item.info.title ?: last, focusEditor = false)
                }
            }
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().background(panel)
            .pointerInput(Unit) { detectTapGestures(onTap = { selectedSessionId = null }) },
    ) {
        Spacer(Modifier.height(with(LocalDensity.current) { 12.toDp() }))
        NewSessionRow(
            onNew = { actions.newSession() },
            enabled = !state.busy,
            muted = muted,
        )
        CollapsibleMenu(
            menuCollapsed = menuCollapsed,
            onToggleMenu = { menuCollapsed = !menuCollapsed },
            onToggleTab = { tab ->
                when (tab) {
                    ConfigTab.Skill -> ShowSettingsUtilImpl.showSettingsDialog(project, "ai.coding.skill", null)
                    ConfigTab.Models -> ShowSettingsUtilImpl.showSettingsDialog(project, "ai.coding.models", null)
                }
            },
        )
        org.deveco.code.migration.MigrationPromptBar(project)
        SessionsSection(
            state = state,
            selectedSessionId = selectedSessionId,
            newSessionIds = SessionStorage.newSessionIds(project),
            displayData = SessionDisplayData(
                runningIds = runningIds,
                startedAtMap = startedAtMap,
                lastDurationMap = lastDurationMap,
                activityMap = activityMap,
                newSessionIds = SessionStorage.newSessionIds(project),
                abnormalIds = SessionStorage.abnormalIds(project),
                unreadIds = SessionStorage.unreadIds(project),
            ),
            callbacks = SessionListCallbacks(
                onOpen = { session ->
                    selectedSessionId = session.sessionId.value
                    ops.openSession(session.sessionId.value, session.title ?: session.sessionId.value, focusEditor = false)
                },
                onStop = { session ->
                    val id = session.sessionId.value
                    SessionStorage.markRead(project, id)
                    ops.stopSession(id)
                },
                onStopAndDelete = { session ->
                    SessionStorage.markRead(project, session.sessionId.value)
                    ops.deleteSession(session.sessionId.value, cancelFirst = true, onStateChange = onStateChange, onRefresh = onRefresh)
                },
                onDelete = { session ->
                    SessionStorage.markRead(project, session.sessionId.value)
                    ops.deleteSession(session.sessionId.value, cancelFirst = false, onStateChange = onStateChange, onRefresh = onRefresh)
                },
                onArchive = { session ->
                    val id = session.sessionId.value
                    SessionStorage.markRead(project, id)
                    SessionStorage.markInteracted(project, id)
                    SessionStorage.archive(project, session)
                    if (id == actions.lastJumpSessionId) {
                        actions.lastJumpSessionId = null
                    }
                    val mgr = FileEditorManager.getInstance(project)
                    // Close the chat tab only if it is the one rendering this session.
                    mgr.openFiles.filterIsInstance<SessionVirtualFile>()
                        .filter { it.sessionId == id }
                        .forEach { mgr.closeFile(it) }
                    // Archived sessions leave the visible list; drop any cached controller
                    // so it is not re-attached with stale content later.
                    SessionControllerRegistry.getInstance(project).evict(id)
                    state = state.copy(
                        sessions = state.sessions.filter { it.info.sessionId.value != id },
                        status = MyMessageBundle.message("toolwindow.deveco.status.connected", state.sessions.size - 1),
                    )
                    // Persist the archive on the server so it survives restarts and
                    // other clients; the optimistic local hide above covers the UI.
                    ApplicationManager.getApplication().executeOnPooledThread {
                        try {
                            service.archiveSession(id)
                        } catch (e: Exception) {
                            log.warn("Server-side archive failed for $id", e)
                        }
                    }
                },
                onToggleFavorite = { session ->
                    val id = session.sessionId.value
                    SessionStorage.markRead(project, id)
                    val current = state.sessions.firstOrNull { it.info.sessionId.value == id }?.favorite ?: false
                    val nowFavorite = !current
                    SessionStorage.toggleFavorite(project, session, favorite = nowFavorite)
                    state = state.copy(sessions = state.sessions.map { item ->
                        if (item.info.sessionId.value == id) item.copy(favorite = nowFavorite) else item
                    })
                },
                onRename = { session ->
                    val id = session.sessionId.value
                    showRenameDialog(project, session.title, java.awt.Color(hoverColor.toArgb())) { newName ->
                        SessionStorage.setCustomTitle(project, id, newName)
                        state = state.copy(sessions = state.sessions.map { item ->
                            if (item.info.sessionId.value == id) item.copy(info = item.info.copy(title = newName)) else item
                        })
                        onRefresh()
                    }
                },
            ),
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
@OptIn(ExperimentalComposeUiApi::class)
private fun NewSessionRow(
    onNew: () -> Unit,
    enabled: Boolean,
    muted: Color,
) {
    var hovered by remember { mutableStateOf(false) }
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val bg = when {
        pressed -> DevEcoTheme.pressedAccentSoft
        hovered -> DevEcoTheme.pressedAccentSoft
        else -> DevEcoTheme.subtleOverlay
    }
    val iconOverlay = when {
        pressed -> DevEcoTheme.pressedAccent.copy(alpha = 0.05f)
        hovered -> DevEcoTheme.accent.copy(alpha = 0.05f)
        else -> DevEcoTheme.cardFg.copy(alpha = 0.05f)
    }
    val borderColor = DevEcoTheme.lightOverlay
    Row(
        modifier = Modifier
            .padding(start = 16.dp, end = 16.dp)
            .fillMaxWidth().height(42.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(bg)
            .border(1.dp, borderColor, RoundedCornerShape(12.dp))
            .clickable(interactionSource = interactionSource, indication = null, enabled = enabled) { onNew() }
            .hoverable { hovered = it }
            .padding(start = 12.dp, end = 12.dp, top = 11.dp, bottom = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(20.dp).clip(RoundedCornerShape(4.dp))
                .background(iconOverlay),
            contentAlignment = Alignment.Center,
        ) {
            Text("+", color = if (enabled) DevEcoTheme.cardFg else muted, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        }
        Spacer(Modifier.width(8.dp))
        Text(MyMessageBundle.message("toolwindow.deveco.new.title"), color = if (enabled) DevEcoTheme.cardFg else muted, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}

private val log = com.intellij.openapi.diagnostic.Logger.getInstance("DevEcoSessions")

internal class SessionOps(
    private val project: Project,
    private val service: AcpClientService,
    private val viewStateStore: SessionViewStateStore,
    private val sessionActions: DevEcoSessionActions,
    private val workingDir: String,
) {
    // One chat tab per project: a session switch re-binds this tab instead of opening a
    // tab per session, so the tab keeps its position (and its placement) across switches.
    private var sessionFile: SessionVirtualFile? = null

    // Reports the conversation the chat tab now renders; the sidebar cannot rely on
    // FileEditorManager selection events because the tab itself never changes.
    var onSessionActivated: ((String) -> Unit)? = null

    fun openSession(id: String, title: String, focusEditor: Boolean = true) {
        val mgr = FileEditorManager.getInstance(project)
        val normalized = if (SessionTitlePolicy.isUntitled(title)) MyMessageBundle.message("session.new.title") else title
        val registry = SessionEditorRegistry.getInstance(project)
        val live = registry.editors()
        val currentEditor = registry.chatEditor()
        // The registry is the only reliable "is the chat open" answer: the file editor
        // manager lists the editors of a single window, so a chat living in another split
        // or docked window looked closed and was reopened at the end of the tab bar.
        val file = SessionTabPolicy.pickChatFile(
            liveFile = currentEditor?.sessionFile,
            listedFiles = mgr.openFiles.filterIsInstance<SessionVirtualFile>(),
            rememberedFile = sessionFile,
        ) ?: SessionVirtualFile(id, normalized, project)
        sessionFile = file
        if (SessionTitlePolicy.isUntitled(file.getName())) file.updateTitle(normalized)
        if (SessionTabPolicy.requiresRebind(file.sessionId, id)) {
            // Re-binding the open tab is a switch, not a dismiss: cache the outgoing
            // controller so switching back reuses it instead of replaying the conversation.
            if (live.isNotEmpty()) {
                SessionControllerRegistry.getInstance(project).markSwitchCloses(listOf(file.sessionId))
            }
            live.forEach { it.switchTo(id) }
            file.sessionId = id
        }
        if (live.isEmpty()) {
            // Opening (or reopening) the chat always starts at the first tab of the
            // leftmost group; selecting it later keeps whatever position it has.
            placeChatTabFirst(project, file, focusEditor)
        } else {
            val revealTarget = registry.attachedChatEditor() ?: currentEditor
            if (revealTarget != null) revealChatTab(project, file, revealTarget, focusEditor)
        }
        SessionStorage.setLastActiveSessionId(project, id)
        if (id in SessionStorage.unreadIds(project)) {
            SessionStorage.markRead(project, id)
            if (mgr is FileEditorManagerImpl) mgr.updateFilePresentation(file)
            project.messageBus.syncPublisher(SESSION_REFRESH_TOPIC).onSessionsChanged()
        }
        onSessionActivated?.invoke(id)
    }

    /**
     * Jump to (reuse) an existing session: bind the chat tab to it and update the file
     * reference. If the tab is open, updates the live SessionController directly (fast
     * path, no IO). If the tab was closed, checks the ACP server and reopens it or
     * creates a new session.
     */
    fun jumpToSession(
        sessionId: String,
        fileRef: FileReference,
        onStateChange: ((SessionsUiState) -> SessionsUiState) -> Unit,
        onRefresh: () -> Unit,
    ) {
        val existingEditor = SessionEditorRegistry.getInstance(project).chatEditor()

        if (existingEditor != null) {
            // Fast path: the chat tab is open → bind it to this session and update the
            // live controller directly (no server round-trip, no IO).
            openSession(sessionId, MyMessageBundle.message("toolwindow.deveco.new.title"))
            existingEditor.controller.addFileReference(fileRef)
            sessionActions.lastJumpSessionId = sessionId
            return
        }

        // Slow path: tab is closed → check if session is still alive on the server
        ApplicationManager.getApplication().executeOnPooledThread {
            val alive = runCatching {
                service.isConnected() || service.connect()
                service.listSessions().any { it.sessionId.value == sessionId }
            }.getOrDefault(false)

            project.runInEdt {
                if (alive) {
                    // Reopen the tab; SessionFileEditor.init will consume pendingFileReference
                    // and set lastJumpSessionId
                    sessionActions.pendingFileReference = fileRef
                    openSession(sessionId, MyMessageBundle.message("toolwindow.deveco.new.title"))
                } else {
                    // Session was deleted → create a new one
                    sessionActions.lastJumpSessionId = null
                    sessionActions.pendingFileReference = fileRef
                    createNewSession(onStateChange = onStateChange, onRefresh = onRefresh)
                }
            }
        }
    }

    fun markInteracted(sessionId: String) {
        SessionStorage.markInteracted(project, sessionId)
    }

    fun stopSession(id: String) {
        ApplicationManager.getApplication().executeOnPooledThread { service.cancelSession(id) }
    }

    private fun reportFailure(
        key: String,
        e: Throwable,
        onStateChange: ((SessionsUiState) -> SessionsUiState) -> Unit,
    ) {
        val message = MyMessageBundle.message(key, errorMessage(e))
        onStateChange { it.copy(status = message, error = message, busy = false) }
    }

    fun deleteSession(
        sessionId: String,
        cancelFirst: Boolean,
        onStateChange: ((SessionsUiState) -> SessionsUiState) -> Unit,
        onRefresh: () -> Unit,
    ) {
        onStateChange {
            it.copy(status = MyMessageBundle.message("toolwindow.deveco.status.deleting"), busy = true, error = null)
        }
        if (sessionId == sessionActions.lastJumpSessionId) {
            sessionActions.lastJumpSessionId = null
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                if (cancelFirst) runCatching { service.cancelSession(sessionId) }
                service.deleteSession(sessionId)
                finalizeLocalDeletion(sessionId, onStateChange, onRefresh)
            } catch (e: Exception) {
                log.warn("deleteSession: server-side delete failed for $sessionId", e)
                if (e.message?.contains("404") == true) {
                    finalizeLocalDeletion(sessionId, onStateChange, onRefresh)
                } else {
                    project.runInEdt { reportFailure("toolwindow.deveco.status.delete.failed", e, onStateChange) }
                }
            }
        }
    }

    private fun finalizeLocalDeletion(
        sessionId: String,
        onStateChange: ((SessionsUiState) -> SessionsUiState) -> Unit,
        onRefresh: () -> Unit,
    ) {
        SessionStorage.deleteLocalSession(project, sessionId)
        project.runInEdt {
            val mgr = FileEditorManager.getInstance(project)
            // Close the chat tab only if it is the one rendering the deleted session.
            mgr.openFiles.filterIsInstance<SessionVirtualFile>()
                .filter { it.sessionId == sessionId }
                .forEach { mgr.closeFile(it) }
            // Drop the cached controller so a deleted session is never re-attached.
            SessionControllerRegistry.getInstance(project).evict(sessionId)
            onStateChange {
                it.copy(
                    sessions = it.sessions.filter { item -> item.info.sessionId.value != sessionId },
                    busy = false,
                )
            }
            onRefresh()
        }
    }

    fun createNewSession(
        onStateChange: ((SessionsUiState) -> SessionsUiState) -> Unit,
        onRefresh: () -> Unit,
    ): Boolean {
        onStateChange {
            it.copy(status = MyMessageBundle.message("toolwindow.deveco.status.creating"), busy = true, error = null)
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            var beforeIds: Set<String> = emptySet()
            try {
                if (!service.isConnected() && !service.connect()) {
                    error(service.statusText())
                }
                // Backend IO, including reuse of an unsent session, must stay off the EDT.
                val listed = service.listSessions()
                beforeIds = listed.map { it.sessionId.value }.toSet()
                val existing = SessionStorage.newSessionIds(project).firstOrNull()
                if (existing != null && existing in beforeIds) {
                    project.runInEdt {
                        onStateChange { it.copy(busy = false, error = null) }
                        openSession(existing, MyMessageBundle.message("toolwindow.deveco.new.title"), focusEditor = false)
                        onRefresh()
                    }
                    return@executeOnPooledThread
                }
                if (existing != null) SessionStorage.removeNewSession(project, existing)
                val id = service.newSession()
                SessionStorage.addNewSession(project, id)
                project.runInEdt {
                    val optimistic = SessionItem(
                        info = SessionInfo(
                            sessionId = SessionId(id),
                            cwd = workingDir,
                            title = MyMessageBundle.message("toolwindow.deveco.new.title"),
                            updatedAt = java.time.LocalDateTime.now().toString(),
                            additionalDirectories = emptyList(),
                            _meta = null,
                        ),
                        favorite = false,
                    )
                    onStateChange { current ->
                        current.copy(
                            sessions = listOf(optimistic) + current.sessions.filter { it.info.sessionId.value != id },
                            status = MyMessageBundle.message("toolwindow.deveco.status.connected", current.sessions.size + 1),
                            busy = false,
                            error = null,
                        )
                    }
                    openSession(id, MyMessageBundle.message("toolwindow.deveco.new.title"), focusEditor = false)
                    onRefresh()
                }
            } catch (e: LinkageError) {
                log.warn("newSession: incompatible runtime", e)
                project.runInEdt { reportFailure("toolwindow.deveco.status.create.failed", e, onStateChange) }
            } catch (e: Exception) {
                log.warn("newSession: failed", e)
                val orphan = runCatching { service.listSessions() }.getOrDefault(emptyList())
                    .firstOrNull { it.sessionId.value !in beforeIds }
                if (orphan != null) {
                    SessionStorage.addNewSession(project, orphan.sessionId.value)
                    project.runInEdt {
                        onStateChange { it.copy(busy = false, error = null) }
                        openSession(orphan.sessionId.value, MyMessageBundle.message("toolwindow.deveco.new.title"), focusEditor = false)
                        onRefresh()
                    }
                } else {
                    project.runInEdt { reportFailure("toolwindow.deveco.status.create.failed", e, onStateChange) }
                }
            }
        }
        return false
    }

    suspend fun loadSessions(
        onStateChange: ((SessionsUiState) -> SessionsUiState) -> Unit,
    ) {
        onStateChange {
            it.copy(status = MyMessageBundle.message("toolwindow.deveco.status.loading"), busy = true, error = null)
        }
        try {
            val favIds = SessionStorage.favoriteIds(project)
            val archivedIds = SessionStorage.archivedIds(project)
            val listed = withContext(Dispatchers.IO) {
                if (!service.isConnected() && !service.connect()) {
                    error(service.statusText())
                }
                service.listSessions()
            }
            val items = listed
                .filter { it.sessionId.value !in archivedIds }
                .map { SessionItem(it, favorite = it.sessionId.value in favIds) }
            val liveIds = items.map { it.info.sessionId.value }.toSet()
            val interacted = SessionStorage.interactedIds(project)
            val toBackfill = items
                .filter { it.info.sessionId.value !in interacted && !org.deveco.code.session.SessionTitlePolicy.isUntitled(it.info.title) }
                .map { it.info.sessionId.value }
                .toSet()
            SessionStorage.markInteractedBatch(project, toBackfill)
            SessionStorage.pruneInteractedIds(project, liveIds)
            SessionStorage.pruneAbnormalIds(project, liveIds)
            SessionStorage.pruneUnreadIds(project, liveIds)
            SessionStorage.rebuildNewSessionIds(project, liveIds)
            val customTitles = SessionStorage.customTitles(project)
            onStateChange { current ->
                val existingTitles = current.sessions
                    .filter { !it.info.title.isNullOrBlank() }
                    .associate { it.info.sessionId.value to it.info.title }
                val mergedItems = items.map { item ->
                    val id = item.info.sessionId.value
                    val backendTitle = item.info.title
                    val customTitle = customTitles[id]
                    when {
                        !customTitle.isNullOrBlank() ->
                            item.copy(info = item.info.copy(title = customTitle))
                        backendTitle.isNullOrBlank() ->
                            existingTitles[id]?.let { inMemoryTitle ->
                                item.copy(info = item.info.copy(title = inMemoryTitle))
                            } ?: item
                        else -> item
                    }
                }
                val loadedIds = items.map { it.info.sessionId.value }.toSet()
                val preserved = current.sessions
                    .filter { it.info.sessionId.value !in loadedIds }
                    .map { item ->
                        val id = item.info.sessionId.value
                        val customTitle = customTitles[id]
                        if (!customTitle.isNullOrBlank()) {
                            item.copy(info = item.info.copy(title = customTitle))
                        } else {
                            item
                        }
                    }
                val allItems = (preserved + mergedItems).distinctBy { it.info.sessionId.value }
                SessionsUiState(
                    sessions = allItems,
                    status = MyMessageBundle.message("toolwindow.deveco.status.connected", allItems.size),
                    busy = false,
                )
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: LinkageError) {
            log.warn("Session initialization is incompatible with the IDE runtime", e)
            reportFailure("toolwindow.deveco.status.load.failed", e, onStateChange)
        } catch (e: Exception) {
            reportFailure("toolwindow.deveco.status.load.failed", e, onStateChange)
        } finally {
            onStateChange { it.copy(busy = false) }
        }
    }
}
