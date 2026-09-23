package org.deveco.code.sessions.ui

import com.agentclientprotocol.annotations.UnstableApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentclientprotocol.model.SessionInfo
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.jetbrains.jewel.ui.component.Text
import java.time.LocalDate

@OptIn(UnstableApi::class)
internal data class SessionItem(
    val info: SessionInfo,
    val favorite: Boolean = false,
)

@OptIn(UnstableApi::class)
internal data class SessionsUiState(
    val sessions: List<SessionItem> = emptyList(),
    val status: String = MyMessageBundle.message("toolwindow.deveco.status.loading"),
    val busy: Boolean = true,
    val error: String? = null,
)

internal data class SessionDisplayData(
    val runningIds: Set<String>,
    val startedAtMap: Map<String, Long>,
    val lastDurationMap: Map<String, Long>,
    val activityMap: Map<String, String>,
    val newSessionIds: Set<String>,
    val abnormalIds: Set<String>,
    val unreadIds: Set<String>,
)

internal data class SessionInteraction(
    val selectedSessionId: String?,
    val hoveredId: String?,
    val menuOpenId: String?,
    val onHoveredIdChange: (String?) -> Unit,
    val onMenuOpenIdChange: (String?) -> Unit,
)

internal data class SessionListCallbacks(
    val onOpen: (SessionInfo) -> Unit,
    val onStop: (SessionInfo) -> Unit,
    val onStopAndDelete: (SessionInfo) -> Unit,
    val onDelete: (SessionInfo) -> Unit,
    val onArchive: (SessionInfo) -> Unit,
    val onToggleFavorite: (SessionInfo) -> Unit,
    val onRename: (SessionInfo) -> Unit,
)

internal data class SessionExtraCallbacks(
    val onStopAndDelete: (SessionInfo) -> Unit,
    val onArchive: (SessionInfo) -> Unit,
    val onToggleFavorite: (SessionInfo) -> Unit,
    val onRename: (SessionInfo) -> Unit,
)

private fun partitionSessions(
    sessions: List<SessionItem>,
    newSessionIds: Set<String>,
): Triple<List<SessionItem>, List<SessionItem>, List<SessionItem>> {
    val newOnes = sessions.filter { it.info.sessionId.value in newSessionIds }
    val rest = sessions.filter { it.info.sessionId.value !in newSessionIds }
    val favorites = rest.filter { it.favorite }.sortedByDescending { it.info.updatedAt ?: "" }
    val others = rest.filter { !it.favorite }.sortedByDescending { it.info.updatedAt ?: "" }
    return Triple(favorites, newOnes, others)
}

@Composable
@OptIn(UnstableApi::class)
internal fun SessionsSection(
    state: SessionsUiState,
    selectedSessionId: String?,
    displayData: SessionDisplayData,
    callbacks: SessionListCallbacks,
    newSessionIds: Set<String>,
    modifier: Modifier = Modifier,
) {
    val panel = DevEcoTheme.panel
    val muted = DevEcoTheme.muted
    val accent = DevEcoTheme.accent
    val hover = DevEcoTheme.hover
    val titleFg = DevEcoTheme.titleFg
    val scrollState = rememberScrollState()
    LaunchedEffect(selectedSessionId) {
        if (selectedSessionId != null && selectedSessionId in newSessionIds) {
            scrollState.animateScrollBy(-scrollState.value.toFloat())
        }
    }
    var hoveredId by remember { mutableStateOf<String?>(null) }
    var menuOpenId by remember { mutableStateOf<String?>(null) }
    var favoriteCollapsed by remember { mutableStateOf(false) }
    val cardColors = SessionCardColors(hover = hover, muted = muted, accent = accent)
    val cardActions = SessionCardActions(onOpen = callbacks.onOpen, onStop = callbacks.onStop, onDelete = callbacks.onDelete)
    val extraCallbacks = SessionExtraCallbacks(
        onStopAndDelete = callbacks.onStopAndDelete,
        onArchive = callbacks.onArchive,
        onToggleFavorite = callbacks.onToggleFavorite,
        onRename = callbacks.onRename,
    )
    val interaction = SessionInteraction(
        selectedSessionId = selectedSessionId,
        hoveredId = hoveredId,
        menuOpenId = menuOpenId,
        onHoveredIdChange = { hoveredId = it },
        onMenuOpenIdChange = { menuOpenId = it },
    )

    Box(
        modifier = modifier.fillMaxSize().background(panel).clipToBounds(),
        contentAlignment = Alignment.TopStart,
    ) {
        Column(
            modifier = Modifier.fillMaxSize()
                .verticalScroll(scrollState).padding(start = 16.dp, end = 16.dp, top = 16.dp),
        ) {
            val (favoriteSessions, newSessions, otherSessions) = remember(state.sessions, newSessionIds) { partitionSessions(state.sessions, newSessionIds) }

            if (state.error != null) {
                Text(state.error, color = androidx.compose.ui.graphics.Color(0xFFD65A5A), fontSize = 13.sp,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp))
            }
            if (state.busy && state.sessions.isEmpty()) {
                SessionLoadingState(state.status, muted)
            } else if (state.sessions.isEmpty() && state.error == null) {
                SessionEmptyState(muted)
            } else {
                SessionListContent(
                    favoriteSessions, newSessions, otherSessions, titleFg, muted,
                    favoriteCollapsed, { favoriteCollapsed = !favoriteCollapsed },
                    displayData, interaction, cardColors, cardActions, extraCallbacks,
                )
            }
        }
    }
}

@Composable
private fun SessionLoadingState(status: String, muted: Color) {
    Box(Modifier.fillMaxWidth().padding(vertical = 16.dp), contentAlignment = Alignment.Center) {
        Text(status, color = muted, fontSize = 13.sp)
    }
}

@Composable
private fun SessionEmptyState(muted: Color) {
    Box(Modifier.fillMaxWidth().padding(vertical = 16.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                MyMessageBundle.message("toolwindow.deveco.empty"),
                fontSize = 16.sp,
                fontWeight = FontWeight.Medium,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                MyMessageBundle.message("sessions.empty.hint"),
                color = muted,
                fontSize = 12.sp,
            )
        }
    }
}

@Composable
@OptIn(UnstableApi::class)
private fun SessionListContent(
    favoriteSessions: List<SessionItem>,
    newSessions: List<SessionItem>,
    otherSessions: List<SessionItem>,
    titleFg: Color,
    muted: Color,
    favoriteCollapsed: Boolean,
    onToggleFavorite: () -> Unit,
    displayData: SessionDisplayData,
    interaction: SessionInteraction,
    cardColors: SessionCardColors,
    cardActions: SessionCardActions,
    extraCallbacks: SessionExtraCallbacks,
) {
    SectionTitle(MyMessageBundle.message("sessions.section.title"), titleFg)
    Spacer(Modifier.height(8.dp))
    if (favoriteSessions.isNotEmpty()) {
        SectionTitle(
            MyMessageBundle.message("sessions.section.favorite"), titleFg,
            showArrow = true,
            collapsed = favoriteCollapsed,
            onToggle = onToggleFavorite,
        )
        Spacer(Modifier.height(8.dp))
        if (!favoriteCollapsed) {
            favoriteSessions.forEach { item ->
                SessionListRow(item, displayData, interaction, cardColors, cardActions, extraCallbacks)
            }
        }
    }
    if (otherSessions.isEmpty() && newSessions.isEmpty()) {
        Text(
            MyMessageBundle.message("sessions.noConversations"),
            color = muted, fontSize = 11.sp,
            modifier = Modifier.padding(start = 12.dp, top = 4.dp, bottom = 4.dp),
        )
    } else {
        val newIds = newSessions.map { it.info.sessionId.value }.toSet()
        val todayLabel = MyMessageBundle.message("sessions.time.today")
        val combined = (newSessions + otherSessions).sortedWith(
            compareByDescending<SessionItem> { it.info.sessionId.value in newIds }
                .thenByDescending { it.info.updatedAt ?: "" }
        )
        val grouped = combined.groupBy {
            if (it.info.sessionId.value in newIds) todayLabel
            else timeGroupLabel(it.info.updatedAt)
        }
        grouped.forEach { (label, list) ->
            Spacer(Modifier.height(8.dp))
            SectionTitle(label, titleFg)
            Spacer(Modifier.height(8.dp))
            list.filter { it.info.sessionId.value in newIds }.forEach { item ->
                SessionListRow(item, displayData, interaction, cardColors, cardActions, extraCallbacks)
            }
            list.filter { it.info.sessionId.value !in newIds }.forEach { item ->
                SessionListRow(item, displayData, interaction, cardColors, cardActions, extraCallbacks)
            }
        }
    }
}

@Composable
private fun SectionTitle(
    text: String,
    color: Color,
    showArrow: Boolean = false,
    collapsed: Boolean = false,
    onToggle: (() -> Unit)? = null,
) {
    val base = Modifier.fillMaxWidth().height(20.dp)
    val mod = if (onToggle != null) base.clickable { onToggle() } else base
    Row(
        modifier = mod.padding(start = 0.dp, end = 12.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (showArrow) {
            Chevron(if (collapsed) ChevronDirection.RIGHT else ChevronDirection.DOWN)
            Spacer(Modifier.width(2.dp))
        }
        Text(text, color = color, fontSize = 13.sp, fontWeight = FontWeight.Medium, lineHeight = 16.sp)
    }
}

@Composable
private fun SessionListItem(
    item: SessionItem,
    displayData: SessionDisplayData,
    interaction: SessionInteraction,
    colors: SessionCardColors,
    actions: SessionCardActions,
    extraCallbacks: SessionExtraCallbacks,
) {
    val id = item.info.sessionId.value
    val running = id in displayData.runningIds
    val isNew = id in displayData.newSessionIds
    val isNormal = id !in displayData.abnormalIds
    val isUnread = id in displayData.unreadIds
    SessionCard(
        state = SessionCardState(
            item = item, isRunning = running, isNew = isNew, isNormal = isNormal, isUnread = isUnread,
            startedAt = displayData.startedAtMap[id], activity = displayData.activityMap[id],
            selected = interaction.selectedSessionId == id && interaction.menuOpenId == null,
            hovered = (interaction.hoveredId == id && interaction.menuOpenId == null) || interaction.menuOpenId == id,
            lastDuration = displayData.lastDurationMap[id],
        ),
        colors = colors,
        actions = actions,
        onHoverChange = { v ->
            if (interaction.menuOpenId == null) {
                interaction.onHoveredIdChange(if (v) id else if (interaction.hoveredId == id) null else interaction.hoveredId)
            }
        },
        onContextMenu = {
            interaction.onMenuOpenIdChange(id)
            showNativeSessionContextMenu(
                isRunning = running, favorite = item.favorite,
                isEmpty = isEmptyConversation(item.info.title),
                actions = SessionContextActions(
                    onRename = { extraCallbacks.onRename(item.info) },
                    onStopAndDelete = { extraCallbacks.onStopAndDelete(item.info) },
                    onDelete = { actions.onDelete(item.info) },
                    onArchive = { extraCallbacks.onArchive(item.info) },
                    onToggleFavorite = { extraCallbacks.onToggleFavorite(item.info) },
                ),
                onDismiss = { interaction.onMenuOpenIdChange(null); interaction.onHoveredIdChange(null) },
            )
        },
    )
}

private fun timeGroupLabel(updatedAt: String?): String {
    if (updatedAt.isNullOrBlank()) return MyMessageBundle.message("sessions.time.earlier")
    return try {
        val date = LocalDate.parse(updatedAt.substring(0, 10))
        if (date == LocalDate.now()) MyMessageBundle.message("sessions.time.today") else "${date.year}/${date.monthValue}/${date.dayOfMonth}"
    } catch (e: Exception) {
        MyMessageBundle.message("sessions.time.earlier")
    }
}

@Composable
@OptIn(UnstableApi::class)
private fun SessionListRow(
    item: SessionItem,
    displayData: SessionDisplayData,
    interaction: SessionInteraction,
    colors: SessionCardColors,
    actions: SessionCardActions,
    extraCallbacks: SessionExtraCallbacks,
) {
    val id = item.info.sessionId.value
    key(id) {
        SessionListItem(item, displayData, interaction, colors, actions, extraCallbacks)
    }
}
