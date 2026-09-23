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
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.deveco.code.session.SessionStorage
import org.deveco.code.session.SessionTitlePolicy
import org.deveco.code.session.SESSION_REFRESH_TOPIC
import org.deveco.code.session.SessionRefreshListener
import org.deveco.code.session.SessionViewStateStore
import org.deveco.code.acp.AcpSessionUpdate
import org.deveco.code.session.editor.SessionVirtualFile
import org.deveco.code.session.editor.SessionFileEditor
import org.deveco.code.session.model.FileReference
import org.deveco.code.sessions.ui.CollapsibleMenu
import org.deveco.code.sessions.ui.ConfigTab
import org.deveco.code.sessions.ui.SessionDisplayData
import org.deveco.code.sessions.ui.SessionItem
import org.deveco.code.sessions.ui.SessionListCallbacks
import org.deveco.code.sessions.ui.SessionsSection
import org.deveco.code.sessions.ui.SessionsUiState
import org.deveco.code.sessions.ui.showRenameDialog
import org.deveco.code.sidebar.AgentInfo
import org.deveco.code.sidebar.McpServerInfo
import org.deveco.code.sidebar.SkillInfo
import org.jetbrains.jewel.ui.component.Text
import java.util.concurrent.ConcurrentHashMap

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
                    state.value = sid
                    if (sid != null) {
                        SessionStorage.setLastActiveSessionId(project, sid)
                        if (sid in SessionStorage.unreadIds(project)) {
                            SessionStorage.markRead(project, sid)
                            project.messageBus.syncPublisher(SESSION_REFRESH_TOPIC).onSessionsChanged()
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
        service.setOnRunningChanged {
            project.runInEdt { onRunningChanged() }
        }
        service.setOnSessionDone { id ->
            project.runInEdt { onSessionDone(id) }
        }
        service.setOnAbnormalChanged { id ->
            project.runInEdt { onAbnormalChanged(id) }
        }
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
            service.setOnRunningChanged {}
            service.setOnSessionDone {}
            service.setOnAbnormalChanged {}
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
    project: Project,
    actions: DevEcoSessionActions,
    ops: SessionOps,
    onStateChange: ((SessionsUiState) -> SessionsUiState) -> Unit,
    onRefresh: () -> Unit,
) {
    DisposableEffect(actions, ops) {
        actions.newSessionHandler = {
            val wrappedOnStateChange: ((SessionsUiState) -> SessionsUiState) -> Unit = { f ->
                onStateChange { current ->
                    val newState = f(current)
                    if (!newState.busy) actions.busy = false
                    newState
                }
            }
            val existingHandled = ops.createNewSession(onStateChange = wrappedOnStateChange, onRefresh = onRefresh)
            if (existingHandled) {
                // If the reused session's tab is already open, init didn't consume
                // pendingFileReference — add it directly to the live controller.
                val pendingRef = actions.pendingFileReference
                if (pendingRef != null) {
                    val mgr = FileEditorManager.getInstance(project)
                    val editor = mgr.openFiles.filterIsInstance<SessionVirtualFile>()
                        .flatMap { mgr.getEditors(it).toList() }
                        .filterIsInstance<SessionFileEditor>()
                        .firstOrNull()
                    if (editor != null) {
                        editor.controller.addFileReference(pendingRef)
                        actions.pendingFileReference = null
                    }
                }
                actions.busy = false
            }
        }
        actions.stopSessionHandler = { id -> ops.stopSession(id) }
        actions.jumpToSessionHandler = { sessionId, fileRef ->
            ops.jumpToSession(
                sessionId = sessionId,
                fileRef = fileRef,
                onStateChange = { f ->
                    onStateChange { current ->
                        val newState = f(current)
                        if (!newState.busy) actions.busy = false
                        newState
                    }
                },
                onRefresh = onRefresh,
            )
        }
        actions.promptSentHandler = { sessionId, title ->
            ops.markInteracted(sessionId)
            ops.refreshEditorIcon(sessionId)
            if (title != null) {
                SessionStorage.setCustomTitle(project, sessionId, title)
                ops.updateEditorTitle(sessionId, title)
            }
            val now = java.time.LocalDateTime.now().toString()
            onStateChange { current ->
                current.copy(
                    sessions = current.sessions.map { item ->
                        if (item.info.sessionId.value == sessionId)
                            SessionItem(
                                info = item.info.copy(
                                    title = title ?: item.info.title,
                                    updatedAt = now,
                                ),
                                favorite = item.favorite,
                            )
                        else item
                    },
                )
            }
        }
        onDispose {
            actions.newSessionHandler = null
            actions.stopSessionHandler = null
            actions.jumpToSessionHandler = null
            actions.promptSentHandler = null
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
    val viewStateStore = remember(project) { project.getService(SessionViewStateStore::class.java) }
    val actions = remember(project) { DevEcoSessionActions.forProject(project) }
    val sessionFiles = remember(project) { ConcurrentHashMap<String, SessionVirtualFile>() }
    var state by remember { mutableStateOf(SessionsUiState()) }
    var refreshKey by remember { mutableStateOf(0) }
    var selectedSessionId by rememberSelectedSessionId(project)
    var firstLoad by remember { mutableStateOf(true) }

    var menuCollapsed by remember { mutableStateOf(false) }
    var agents by remember { mutableStateOf<List<AgentInfo>>(emptyList()) }
    var mcps by remember { mutableStateOf<List<McpServerInfo>>(emptyList()) }
    var skills by remember { mutableStateOf<List<SkillInfo>>(emptyList()) }
    val mcpAllConnected = remember(mcps) { mcps.isNotEmpty() && mcps.all { it.enabled } }

    var runTick by remember { mutableStateOf(0) }
    val startedAtMap = remember(runTick, refreshKey) { service.runningSnapshot() }
    val lastDurationMap = remember(runTick, refreshKey) {
        SessionStorage.loadLastDurations(project) + service.lastDurationSnapshot()
    }
    val runningIds: Set<String> = startedAtMap.keys
    val activityMap = remember { mutableStateMapOf<String, String>() }

    val panel = DevEcoTheme.panel
    val muted = DevEcoTheme.muted
    val hoverColor = DevEcoTheme.hover
    val workingDir = remember(project) { project.basePath ?: "" }
    val ops = remember(project, service, viewStateStore, workingDir) {
        SessionOps(project, service, viewStateStore, actions, sessionFiles, workingDir)
    }
    val onStateChange: ((SessionsUiState) -> SessionsUiState) -> Unit = { f -> state = f(state) }
    val onRefresh: () -> Unit = { refreshKey++ }

    rememberSessionActivityTracking(
        project, service, activityMap,
        onRunningChanged = { runTick++ },
        onSessionDone = { sessionId ->
            runTick++
            onRefresh()
            if (sessionId == selectedSessionId) SessionStorage.markRead(project, sessionId)
            else SessionStorage.markUnread(project, sessionId)
            ops.refreshEditorIcon(sessionId)
        },
        onAbnormalChanged = { sessionId ->
            ops.refreshEditorIcon(sessionId)
        },
    )
    rememberRefreshTrigger(project, onRefresh)
    rememberSessionHandlers(project, actions, ops, onStateChange, onRefresh)

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

    LaunchedEffect(refreshKey) {
        val (a, m, s) = withContext(Dispatchers.IO) { service.loadSidebarData() }
        agents = a
        mcps = m
        skills = s
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
            agentCount = agents.size,
            skillCount = skills.size,
            mcpAllConnected = mcpAllConnected,
            onToggleMenu = { menuCollapsed = !menuCollapsed },
            onToggleTab = { tab ->
                when (tab) {
                    ConfigTab.Skill -> ShowSettingsUtil.getInstance().showSettingsDialog(project, MyMessageBundle.message("settings.skill.displayName"))
                    ConfigTab.Models -> ShowSettingsUtil.getInstance().showSettingsDialog(project, MyMessageBundle.message("settings.models.displayName"))
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
                    ops.refreshEditorIcon(id)
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
                    ops.refreshEditorIcon(id)
                    SessionStorage.archive(project, session)
                    if (id == actions.lastJumpSessionId) {
                        actions.lastJumpSessionId = null
                    }
                    val mgr = FileEditorManager.getInstance(project)
                    sessionFiles.remove(id)?.let { mgr.closeFile(it) }
                    mgr.openFiles.filterIsInstance<SessionVirtualFile>()
                        .filter { it.sessionId == id }
                        .forEach { mgr.closeFile(it) }
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
                    ops.refreshEditorIcon(id)
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
                        ops.updateEditorTitle(id, newName)
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

private class SessionOps(
    private val project: Project,
    private val service: AcpClientService,
    private val viewStateStore: SessionViewStateStore,
    private val sessionActions: DevEcoSessionActions,
    private val sessionFiles: ConcurrentHashMap<String, SessionVirtualFile>,
    private val workingDir: String,
) {
    fun openSession(id: String, title: String, focusEditor: Boolean = true) {
        val mgr = FileEditorManager.getInstance(project)
        mgr.openFiles.filterIsInstance<SessionVirtualFile>()
            .filter { it.sessionId != id }
            .forEach { mgr.closeFile(it) }
        val normalized = if (SessionTitlePolicy.isUntitled(title)) MyMessageBundle.message("session.new.title") else title
        val file = mgr.openFiles.filterIsInstance<SessionVirtualFile>().firstOrNull { it.sessionId == id }
            ?: sessionFiles.computeIfAbsent(id) { SessionVirtualFile(it, normalized, project) }
        if (SessionTitlePolicy.isUntitled(file.getName())) file.updateTitle(normalized)
        mgr.openFile(file, focusEditor)
    }

    /**
     * Jump to (reuse) an existing session: activate its tab and update the file reference.
     * If the tab is open, updates the live SessionController directly (fast path, no IO).
     * If the tab was closed, checks the ACP server and reopens it or creates a new session.
     */
    fun jumpToSession(
        sessionId: String,
        fileRef: FileReference,
        onStateChange: ((SessionsUiState) -> SessionsUiState) -> Unit,
        onRefresh: () -> Unit,
    ) {
        val mgr = FileEditorManager.getInstance(project)
        val file = mgr.openFiles.filterIsInstance<SessionVirtualFile>().firstOrNull { it.sessionId == sessionId }
            ?: sessionFiles[sessionId]
        val existingEditor = file?.let { f ->
            mgr.getEditors(f).filterIsInstance<SessionFileEditor>().firstOrNull()
        }

        if (existingEditor != null) {
            // Fast path: tab is open → update controller directly and activate
            existingEditor.controller.addFileReference(fileRef)
            mgr.openFile(file, true)
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

    fun updateEditorTitle(sessionId: String, title: String) {
        val mgr = FileEditorManager.getInstance(project)
        val file = mgr.openFiles.filterIsInstance<SessionVirtualFile>().firstOrNull { it.sessionId == sessionId }
            ?: sessionFiles[sessionId]
            ?: return
        file.updateTitle(title)
        if (mgr is com.intellij.openapi.fileEditor.impl.FileEditorManagerImpl) {
            ApplicationManager.getApplication().invokeLater {
                if (!file.isValid) return@invokeLater
                mgr.updateFilePresentation(file)
            }
        }
    }

    fun refreshEditorIcon(sessionId: String) {
        val file = sessionFiles[sessionId] ?: return
        ApplicationManager.getApplication().invokeLater {
            if (!file.isValid) return@invokeLater
            file.refresh(false, false)
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
            sessionFiles.remove(sessionId)?.let { mgr.closeFile(it) }
            mgr.openFiles.filterIsInstance<SessionVirtualFile>()
                .filter { it.sessionId == sessionId }
                .forEach { mgr.closeFile(it) }
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
