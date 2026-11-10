package org.deveco.code.session.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ScrollbarStyle
import androidx.compose.foundation.VerticalScrollbar
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.runtime.*
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import kotlin.math.roundToInt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.deveco.code.DevEcoIcons
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.SessionController
import org.deveco.code.session.parseTodoDockItems
import org.deveco.code.session.model.ChatItem
import org.deveco.code.session.model.ChatRole
import org.deveco.code.session.model.MessageGroup
import org.deveco.code.session.model.TurnFooterAnchors
import org.deveco.code.util.hoverable
import org.deveco.code.session.model.PermissionChoice
import org.deveco.code.session.model.groupMessages
import org.deveco.code.session.model.isTodoTool
import org.deveco.code.session.model.isToolItemEmpty
import org.deveco.code.session.model.isToolChildEmpty
import org.deveco.code.session.model.turnFooterAnchors
import org.deveco.code.session.ui.composer.SessionComposer
import org.deveco.code.session.ui.composer.TodoDock
import org.deveco.code.session.ui.messages.ElicitationDialog
import org.deveco.code.session.ui.messages.TurnFooter
import org.deveco.code.session.ui.messages.toolItemRendersNothing
import org.deveco.code.session.model.SessionViewState
import org.deveco.code.session.model.SessionViewportState
import org.jetbrains.jewel.bridge.toComposeColor
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icons.AllIconsKeys

private val WIDE_WIDTH_THRESHOLD = 924.dp

@Composable
internal fun SessionScreen(
    project: Project,
    controller: SessionController,
    restoredStateProvider: () -> SessionViewState?,
    currentDraft: String,
    onOpenFile: (ChatItem) -> Unit,
    onViewportChanged: (SessionViewportState) -> Unit,
    onDraftChanged: (String) -> Unit,
) {
    // Tab switches dispose the Compose composition and rebuild it from scratch.
    // Reading the provider here (instead of a construction-time snapshot) makes
    // the rebuilt session resume from the live viewport captured before the
    // switch; remember {} keeps it fixed for the lifetime of one composition.
    val restoredState = remember { restoredStateProvider() }
    SessionMarkdownTheme(project) {
        SessionContent(project, controller, restoredState, currentDraft, onOpenFile, onViewportChanged, onDraftChanged)
    }
}

@Composable
private fun SessionContent(
    project: Project,
    controller: SessionController,
    restoredState: SessionViewState?,
    currentDraft: String,
    onOpenFile: (ChatItem) -> Unit,
    onViewportChanged: (SessionViewportState) -> Unit,
    onDraftChanged: (String) -> Unit,
) {
    val messages = controller.messages
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    var followTail by remember { mutableStateOf(restoredState?.followTail ?: true) }
    var restoringPosition by remember { mutableStateOf(restoredState != null) }
    // In-flight programmatic scroll count. Programmatic scrolls can overlap (e.g. the
    // send animation while a streaming chunk triggers tail auto-scroll); with a plain
    // boolean the first finisher's reset would unprotect the other's in-flight scroll,
    // letting it be misread as a user scroll and disabling follow-tail. Writers
    // increment/decrement around their scroll; readers test for zero.
    val autoScrolling = remember { mutableIntStateOf(0) }
    var contentLayoutVersion by remember { mutableIntStateOf(0) }
    val anchorGroups by remember {
        derivedStateOf {
            groupMessages(messages.toList())
                // Server-injected model-facing messages (background task notifications)
                // must not occupy a row at all, else their padding shows as a blank band.
                .filter { group ->
                    group.parent.turnBoundary || !group.parent.internalOnly
                }
                // Keep abnormal blank AGENT placeholders in the anchor stream so the
                // turn-level terminal state can be derived; they are removed from the
                // rendered group list below.
                .filter { group ->
                    group.parent.role != ChatRole.AGENT ||
                        group.parent.text.isNotBlank() ||
                        group.parent.interrupted ||
                        group.parent.errorText != null
                }
                // Filter out TOOL parent items that have no meaningful content
                .filter { group ->
                    group.parent.role != ChatRole.TOOL || !isToolItemEmpty(group.parent)
                }
                // Todo calls live in the dock; drop the whole group so no empty slot remains.
                .filter { group ->
                    group.parent.role != ChatRole.TOOL || !isTodoDockSource(group.parent)
                }
                // Filter children to remove empty TOOL items within each group
                .map { group ->
                    if (group.children.isEmpty()) group
                    else group.copy(
                        children = group.children.filter { child ->
                            child.role != ChatRole.TOOL || !isToolChildEmpty(child)
                        }
                    )
                }
        }
    }
    // Turn boundaries participate in footer/status/copy grouping but are invisible;
    // the compaction divider is the one boundary that renders (TUI parity).
    val anchors = remember(anchorGroups) { turnFooterAnchors(anchorGroups) }
    val terminalAnchorIds = remember(anchors) {
        anchors.terminalStatusByAnchorId.keys
    }
    val anchorItemsById = remember(anchorGroups) {
        anchorGroups.associate { it.parent.id to it.parent }
    }
    // Blank AGENT placeholders only contribute terminal status and never render a row.
    val groups = anchorGroups.filterNot {
        (it.parent.turnBoundary && !it.parent.compactionDivider) ||
            (it.parent.role == ChatRole.AGENT &&
                it.parent.text.isBlank() &&
                it.parent.id !in terminalAnchorIds)
    }
    // Item keys in LazyColumn content order, feeding the scrollbar's persistent height cache.
    val itemKeys by remember {
        derivedStateOf {
            buildList<Any> {
                groups.forEach { add(it.parent.id) }
                if (controller.responding || controller.serverTurn) add("loading-indicator")
                add("conversation-bottom-anchor")
            }
        }
    }
    val editorBackground = com.intellij.openapi.editor.colors.EditorColorsManager.getInstance().globalScheme.defaultBackground.toComposeColor()
    val conversationBackground = editorBackground
    val card = JBColor.namedColor("Editor.SearchField.background", 0x27282C).toComposeColor()
    val inputBackground = DevEcoTheme.inputBackground
    val muted = JBColor.namedColor("Label.infoForeground", 0x868A91).toComposeColor()
    val accent = DevEcoTheme.accent

    // Created before the scroll effects so the tail auto-scroll can ask the adapter
    // whether the user is currently interacting with the scrollbar.
    val scrollbarAdapter = rememberCachedScrollbarAdapter(listState, itemKeys)

    SessionViewportTrackingEffect(listState, groups, followTail, onViewportChanged)
    SessionFollowTailViewportEffect(listState, groups, followTail, onViewportChanged)
    SessionScrollTrackingEffect(listState, autoScrolling) { followTail = it }
    SessionCanScrollForwardEffect(listState, autoScrolling, restoringPosition) { followTail = it }
    SessionTailAutoScrollEffect(
        listState, messages, followTail, restoringPosition, contentLayoutVersion, autoScrolling,
        isScrollbarInteracting = { scrollbarAdapter.scrollbarInteracting },
    )
    SessionRestorePositionEffect(
        // A running prompt clears controller.ready, so gating on ready alone
        // would strand restoringPosition=true after a mid-turn tab switch
        // (the composition rebuild) and block tail-follow for the rest of the
        // turn. responding means the message list is live, so restoring now
        // is safe even while ready is false. A server-side turn streams too,
        // so it keeps the list live the same way.
        listState, messages, groups, controller.ready || controller.responding || controller.serverTurn, controller.sessionLoading, restoredState, restoringPosition,
        onRestoringPositionChanged = { restoringPosition = it },
        autoScrolling = autoScrolling,
    )

    // Force scroll-to-tail whenever the user explicitly submits a prompt (clicking Send,
    // pressing Enter, or auto-prompt from build errors). This overrides the followTail lock
    // that may have been set when the user scrolled up to read previous messages.
    // seenSendTick skips the initial launch: tab switches rebuild the composition, and
    // re-running this with a stale non-zero sendTick would yank the restored view back
    // to the bottom on every switch back.
    var seenSendTick by remember { mutableStateOf(controller.sendTick) }
    LaunchedEffect(controller.sendTick) {
        if (controller.sendTick == 0 || controller.sendTick == seenSendTick || messages.isEmpty()) return@LaunchedEffect
        seenSendTick = controller.sendTick
        followTail = true
        // Wait two frames so the newly added ChatItem completes layout before we scroll.
        withFrameNanos { }
        withFrameNanos { }
        autoScrolling.value += 1
        try {
            listState.animateScrollToItem(messages.size)
        } finally {
            autoScrolling.value -= 1
        }
    }

    // --- Scrollbar visibility control ---
    // Polls every 50ms to update scrollbar display state and length info.
    // Rules:
    //   1. Content doesn't overflow viewport → never show
    //   2. Content overflows + idle → hidden (300ms hide delay after last scroll)
    //   3. Content overflows + user scrolling or scrollbar drag → visible
    //      (adapter-driven scrolls are instantaneous, so isScrollInProgress alone
    //      gaps between drag events and would fade the bar mid-drag)
    val scrollbarVisible = remember { mutableStateOf(false) }
    val scrollbarHovered = remember { mutableStateOf(false) }
    val lastScrollTime = remember { mutableStateOf(0L) }
    LaunchedEffect(listState) {
        while (true) {
            delay(50)
            val overflows = listState.canScrollForward || listState.canScrollBackward
            val scrolling = listState.isScrollInProgress
            val now = System.currentTimeMillis()
            if (!overflows) {
                scrollbarVisible.value = false
            } else if (scrolling || scrollbarAdapter.scrollbarInteracting) {
                lastScrollTime.value = now
                scrollbarVisible.value = true
            } else if (scrollbarHovered.value) {
                scrollbarVisible.value = true
            } else if (now - lastScrollTime.value > 300) {
                scrollbarVisible.value = false
            }
        }
    }
    val scrollbarAlpha by animateFloatAsState(
        targetValue = if (scrollbarVisible.value) 1f else 0f,
        animationSpec = tween(durationMillis = 200),
        label = "scrollbar-alpha",
    )

    Column(Modifier.fillMaxSize().background(editorBackground)) {
        Box(
            Modifier.fillMaxSize().padding(top = 12.dp, bottom = 12.dp).clipToBounds(),
            contentAlignment = Alignment.TopCenter,
        ) {
            Box(
                Modifier.widthIn(max = WIDE_WIDTH_THRESHOLD).fillMaxWidth()
                    .fillMaxHeight().background(conversationBackground),
            ) {
                // On a fresh session the hero and the composer form one vertically
                // centered block; the first sent prompt animates the composer down
                // to the bottom. welcomeAnim drives the equal top/bottom spacer
                // weights, the conversation box's inverse weight, the hero's fade,
                // and the dot matrix, so all of it moves as one relayout. The
                // composer keeps one call site, so its state and focus survive the
                // transition.
                val welcomeMode = messages.isEmpty() && !controller.responding
                val welcomeAnim = remember { Animatable(if (welcomeMode) 1f else 0f) }
                // Only a real send animates: sendPrompt bumps sendTick in the same
                // synchronous step that flips welcomeMode, so a changed tick
                // separates "user submitted" from "messages arrived in a load".
                // History loads, tab switches, and new tabs snap both directions.
                var sendTickAtWelcome by remember { mutableStateOf(controller.sendTick) }
                LaunchedEffect(welcomeMode) {
                    if (welcomeMode) {
                        sendTickAtWelcome = controller.sendTick
                        welcomeAnim.snapTo(1f)
                    } else if (controller.sendTick != sendTickAtWelcome && welcomeAnim.value > 0f) {
                        welcomeAnim.animateTo(0f, tween(durationMillis = 250))
                    } else {
                        welcomeAnim.snapTo(0f)
                    }
                }
                DotMatrixBackground(
                    Modifier.matchParentSize().graphicsLayer { alpha = welcomeAnim.value },
                    DevEcoTheme.muted,
                )
                Column(
                    Modifier.fillMaxSize(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    // Column weight must stay > 0 (it throws at 0); a vanishing
                    // share still collapses the element to a sub-pixel height.
                    Spacer(Modifier.fillMaxWidth().weight(welcomeAnim.value.coerceAtLeast(0.001f)))
                    Box(
                        Modifier
                            .graphicsLayer { alpha = welcomeAnim.value }
                            .clipToBounds()
                            .layout { measurable, constraints ->
                                // Collapse the reserved height with the animation; the
                                // text stays full-size and fades out, clipped from below.
                                val placeable = measurable.measure(constraints)
                                layout(
                                    placeable.width,
                                    (placeable.height * welcomeAnim.value).roundToInt(),
                                ) { placeable.place(0, 0) }
                            },
                    ) {
                        SessionWelcomeHeroText(Modifier.padding(bottom = 32.dp))
                    }
                    Box(Modifier.fillMaxWidth().weight((1f - welcomeAnim.value).coerceAtLeast(0.001f))) {
                        MessageList(
                            groups = groups,
                            anchors = anchors,
                            anchorItemsById = anchorItemsById,
                            listState = listState,
                            card = card,
                            muted = muted,
                            accent = accent,
                            conversationBackground = conversationBackground,
                            controller = controller,
                            onOpenFile = onOpenFile,
                            onContentLayoutChanged = { contentLayoutVersion++ },
                            onFollowTailChanged = { followTail = it },
                            autoScrolling = autoScrolling,
                            scope = scope,
                        )
                        VerticalScrollbar(
                            adapter = scrollbarAdapter,
                            modifier = Modifier
                                .align(Alignment.CenterEnd)
                                .fillMaxHeight()
                                .padding(end = 2.dp)
                                .hoverable { scrollbarHovered.value = it }
                                .graphicsLayer { alpha = scrollbarAlpha },
                            style = ScrollbarStyle(
                                minimalHeight = 16.dp,
                                thickness = 6.dp,
                                shape = RoundedCornerShape(3.dp),
                                hoverDurationMillis = 300,
                                unhoverColor = JBColor(0x33000000, 0x33FFFFFF).toComposeColor(),
                                hoverColor = JBColor(0x66000000, 0x66FFFFFF).toComposeColor(),
                            ),
                        )
                        if (!welcomeMode) {
                            BottomGradientOverlay(Modifier.align(Alignment.BottomCenter), conversationBackground)
                        }
                        if (listState.canScrollForward) {
                            ScrollToBottomButton(
                                modifier = Modifier.align(Alignment.BottomCenter),
                                listState = listState,
                                messages = messages,
                                card = card,
                                muted = muted,
                                onFollowTailChanged = { followTail = it },
                                autoScrolling = autoScrolling,
                                scope = scope,
                            )
                        }
                    }
                    TodoDock(
                        items = controller.todoDockItems,
                        turnActive = controller.responding || controller.serverTurn,
                        onJumpToTool = { toolItemId ->
                            // Resolve in group space: the list indexes grouped items, and a
                            // flat messages index would land past the target (tool children
                            // collapse the list). Rows filtered out of the list (todo dock
                            // sources) simply have no jump target — do nothing rather than
                            // scroll somewhere unrelated.
                            val index = groups.indexOfFirst { group ->
                                group.parent.id == toolItemId || group.children.any { it.id == toolItemId }
                            }
                            if (index >= 0) scope.launch { listState.animateScrollToItem(index) }
                        },
                    )
                    controller.pendingElicitation.value?.let { elicitationItem ->
                        ElicitationDialog(
                            item = elicitationItem,
                            onDismiss = { controller.dismissElicitation() },
                        )
                    }
                    QueueNoticeBar(notice = controller.retryNotice)
                    SessionComposer(
                        controller = controller,
                        project = project,
                        background = inputBackground,
                        muted = muted,
                        accent = accent,
                        initialDraft = currentDraft,
                        onDraftChanged = onDraftChanged,
                    )
                    Spacer(Modifier.fillMaxWidth().weight(welcomeAnim.value.coerceAtLeast(0.001f)))
                }
            }
        }
    }
}

@Composable
private fun SessionViewportTrackingEffect(
    listState: LazyListState,
    groups: List<MessageGroup>,
    followTail: Boolean,
    onViewportChanged: (SessionViewportState) -> Unit,
) {
    val currentFollowTail by rememberUpdatedState(followTail)
    // groups is a new list instance on every change; capture the latest for the
    // long-lived collector instead of the launch-time copy.
    val currentGroups by rememberUpdatedState(groups)
    LaunchedEffect(listState) {
        snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
            .collect { (index, offset) ->
                // The list renders grouped (and filtered) items, so the list index
                // must be mapped through groups; a flat messages index would drift
                // whenever tool children or filtered placeholders collapse the list.
                onViewportChanged(
                    SessionViewportState(currentGroups.getOrNull(index)?.parent?.id, index, offset, currentFollowTail),
                )
            }
    }
}

@Composable
private fun SessionFollowTailViewportEffect(
    listState: LazyListState,
    groups: List<MessageGroup>,
    followTail: Boolean,
    onViewportChanged: (SessionViewportState) -> Unit,
) {
    val currentGroups by rememberUpdatedState(groups)
    LaunchedEffect(followTail) {
        onViewportChanged(
            SessionViewportState(
                currentGroups.getOrNull(listState.firstVisibleItemIndex)?.parent?.id,
                listState.firstVisibleItemIndex,
                listState.firstVisibleItemScrollOffset,
                followTail,
            ),
        )
    }
}

@Composable
private fun SessionScrollTrackingEffect(
    listState: LazyListState,
    autoScrolling: MutableState<Int>,
    onFollowTailChanged: (Boolean) -> Unit,
) {
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
            if (scrolling && autoScrolling.value == 0) onFollowTailChanged(false)
        }
    }
}

@Composable
private fun SessionCanScrollForwardEffect(
    listState: LazyListState,
    autoScrolling: MutableState<Int>,
    restoringPosition: Boolean,
    onFollowTailChanged: (Boolean) -> Unit,
) {
    val currentRestoringPosition by rememberUpdatedState(restoringPosition)
    LaunchedEffect(listState) {
        // Combine canScrollForward and isScrollInProgress so the flow emits on either change.
        // followTail is only re-enabled when we're at the bottom AND the scroll has settled
        // (user released the drag). Without checking isScrollInProgress, dragging the scrollbar
        // at the bottom would immediately flip followTail back to true and cause a bounce.
        snapshotFlow { listState.canScrollForward to listState.isScrollInProgress }.collect { (canScroll, isScrolling) ->
            // A freshly rebuilt list reports canScrollForward=false until its content is
            // laid out; acting on that would spuriously re-enable follow-tail and override
            // the saved position restore, so stay muted until the restore has settled.
            if (currentRestoringPosition) return@collect
            if (!canScroll && !isScrolling && autoScrolling.value == 0) onFollowTailChanged(true)
        }
    }
}

@Composable
private fun SessionTailAutoScrollEffect(
    listState: LazyListState,
    messages: List<ChatItem>,
    followTail: Boolean,
    restoringPosition: Boolean,
    contentLayoutVersion: Int,
    autoScrolling: MutableState<Int>,
    isScrollbarInteracting: () -> Boolean,
) {
    val currentFollowTail by rememberUpdatedState(followTail)
    val currentRestoringPosition by rememberUpdatedState(restoringPosition)
    val currentLayoutVersion by rememberUpdatedState(contentLayoutVersion)
    // Long-lived collector: keying the effect on streaming values cancels the pending scroll on every chunk.
    LaunchedEffect(listState, messages) {
        snapshotFlow { Triple(messages.size, messages.lastOrNull()?.text, currentLayoutVersion) }
            .collect {
                if (currentRestoringPosition || !currentFollowTail || messages.isEmpty()) return@collect
                // Never preempt an in-flight user scroll: taking over the scroll MutatorMutex
                // cancels the user's drag and the list bounces back on their next move. The
                // scrollbar-interaction flag covers the gaps between scrollbar drag events,
                // where isScrollInProgress is momentarily false.
                if (listState.isScrollInProgress || isScrollbarInteracting()) return@collect
                withFrameNanos { }
                if (listState.isScrollInProgress || isScrollbarInteracting()) return@collect
                autoScrolling.value += 1
                try {
                    listState.scrollToItem(messages.size)
                    // Hold one frame so the instant scroll's isScrollInProgress isn't mistaken for a user scroll.
                    withFrameNanos { }
                } catch (e: CancellationException) {
                    // A user drag or another programmatic scroll preempted this scroll
                    // through the scroll MutatorMutex; that cancels only the mutation,
                    // not this collector. Without this catch the exception would kill
                    // the collector permanently (its keys never change again) and
                    // follow-tail could only be revived by rebuilding the composition
                    // (e.g. a tab switch). Rethrow only when this effect's own job was
                    // cancelled, i.e. the composition was disposed.
                    if (!currentCoroutineContext().isActive) throw e
                } finally {
                    autoScrolling.value -= 1
                }
            }
    }
}

@Composable
private fun SessionRestorePositionEffect(
    listState: LazyListState,
    messages: List<ChatItem>,
    groups: List<MessageGroup>,
    controllerReady: Boolean,
    loadInProgress: Boolean,
    restoredState: SessionViewState?,
    restoringPosition: Boolean,
    onRestoringPositionChanged: (Boolean) -> Unit,
    autoScrolling: MutableState<Int>,
) {
    LaunchedEffect(controllerReady, loadInProgress, messages.size) {
        val saved = restoredState
        if (!restoringPosition || saved == null || messages.isEmpty()) {
            return@LaunchedEffect
        }
        if (!controllerReady) {
            // Wait while a load is still running. Once the load attempt has ended
            // without the session ever becoming ready (backend load failed), nothing
            // will ever perform the restore — clear the flag so the follow-tail
            // effects are not muted forever.
            if (!loadInProgress) onRestoringPositionChanged(false)
            return@LaunchedEffect
        }
        withFrameNanos { }
        withFrameNanos { }
        autoScrolling.value += 1
        try {
            if (saved.followTail) {
                listState.scrollToItem(groups.size)
            } else {
                // Resolve the anchor in group space: the list indexes grouped
                // items, so a flat messages index would land somewhere else
                // whenever tool children or filtered placeholders collapse it.
                val anchoredIndex = saved.anchorMessageId
                    ?.let { id -> groups.indexOfFirst { it.parent.id == id }.takeIf { it >= 0 } }
                listState.scrollToItem(
                    (anchoredIndex ?: saved.firstVisibleItemIndex).coerceIn(0, groups.size),
                    saved.firstVisibleItemOffset,
                )
            }
        } finally {
            onRestoringPositionChanged(false)
            autoScrolling.value -= 1
        }
    }
}

@Composable
private fun MessageList(
    groups: List<MessageGroup>,
    anchors: TurnFooterAnchors,
    anchorItemsById: Map<String, ChatItem>,
    listState: LazyListState,
    card: Color,
    muted: Color,
    accent: Color,
    conversationBackground: Color,
    controller: SessionController,
    onOpenFile: (ChatItem) -> Unit,
    onContentLayoutChanged: () -> Unit,
    onFollowTailChanged: (Boolean) -> Unit,
    autoScrolling: MutableState<Int>,
    scope: CoroutineScope,
) {
    // User-message hover overlays hang below their item's bounds; a lifted id draws
    // that item above its neighbors so the overlay isn't covered by the next message.
    val liftedOverlayIds = remember { mutableStateMapOf<String, Boolean>() }

    val preserveScroll: ((() -> Unit) -> Unit) = { change ->
        val indexBefore = listState.firstVisibleItemIndex
        val offsetBefore = listState.firstVisibleItemScrollOffset
        onFollowTailChanged(false)
        autoScrolling.value += 1
        change()
        scope.launch {
            try {
                withFrameNanos { }
                val item = listState.layoutInfo.visibleItemsInfo.find { it.index == indexBefore }
                val clampedOffset = if (item != null && offsetBefore <= item.size) offsetBefore else 0
                listState.scrollToItem(indexBefore, clampedOffset)
                withFrameNanos { }
            } finally {
                autoScrolling.value -= 1
            }
        }
    }

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 30.dp),
    ) {
        itemsIndexed(groups, key = { _, group -> group.parent.id }) { groupIndex, group ->
            val isFirstGroup = groupIndex == 0
            val isLastGroup = groupIndex == groups.lastIndex
            val footerAgent = anchors.agentByAnchorId[group.parent.id]?.let { agentId ->
                anchorItemsById[agentId]
            }
            val terminalStatus = anchors.terminalStatusByAnchorId[group.parent.id]
            val showTurnFooter = terminalStatus != null || footerAgent?.isComplete == true
            // Only in-turn nodes use the tight rhythm. USER bubbles and SYSTEM cards
            // take messageSpacingTop above and contribute no bottom inset, so the gap
            // below them is just the next node's own top inset.
            val isNode = group.parent.role == ChatRole.THOUGHT ||
                group.parent.role == ChatRole.TOOL ||
                group.parent.role == ChatRole.AGENT
            // Children that are merged into parent (same toolKind TOOLs) should not render separately
            val mergedChildren = if (group.parent.role == ChatRole.TOOL) {
                group.children.filter { child ->
                    child.role == ChatRole.TOOL && child.toolKind != null &&
                        (group.parent.toolKind == null || child.toolKind == group.parent.toolKind)
                }
            } else {
                emptyList()
            }
            val separateChildren = group.children.filter { it !in mergedChildren }
            // A parent can end up with nothing to render (e.g. a read whose path never
            // arrived, or a blank AGENT segment): its group slot must not reserve
            // vertical spacing (a blank band), and its children must render on their
            // own instead of being swallowed behind an invisible parent.
            val parentRendersNothing = remember(group, anchors) {
                when (group.parent.role) {
                    ChatRole.TOOL -> toolItemRendersNothing(group.parent, mergedChildren)
                    ChatRole.AGENT -> group.parent.text.isBlank()
                    else -> false
                }
            }
            // Children of an invisible parent render as standalone rows; children that
            // render nothing themselves are dropped so they leave no gap.
            val promotedChildren = if (parentRendersNothing) {
                remember(group) {
                    group.children.filter {
                        it.role != ChatRole.TOOL || !toolItemRendersNothing(it, emptyList())
                    }
                }
            } else {
                emptyList()
            }
            val groupRendersNothing = parentRendersNothing && promotedChildren.isEmpty()

            // Check if parent is expanded (for showing children and tree lines)
            val isParentExpanded = when (group.parent.role) {
                ChatRole.THOUGHT -> controller.expandedThoughts[group.parent.id] ?: false
                ChatRole.TOOL -> controller.expandedTools[group.parent.id] ?: false
                else -> true
            }

            val showsChildren = isParentExpanded && separateChildren.isNotEmpty()
            Box(
                Modifier.fillMaxWidth().onSizeChanged { onContentLayoutChanged() }
                    .zIndex(if (liftedOverlayIds[group.parent.id] == true) 1f else 0f)
                    .padding(
                        start = DevEcoTheme.messageHorizontalPadding.dp,
                        end = DevEcoTheme.messageHorizontalPadding.dp,
                        top = when {
                            isFirstGroup -> DevEcoTheme.firstMessageTop.dp
                            !isNode -> DevEcoTheme.messageSpacingTop.dp
                            groupRendersNothing -> 0.dp
                            else -> (DevEcoTheme.nodeGap + DevEcoTheme.nodePadding).dp
                        },
                        // The last child already carries the node inset, so an
                        // expanded group must not add a second one.
                        bottom = if (isNode && !showsChildren && !groupRendersNothing) DevEcoTheme.nodePadding.dp else 0.dp,
                    ),
            ) {
                SelectionContainer {
                    Column {
                        val hasChildren = separateChildren.isNotEmpty() || mergedChildren.isNotEmpty()

                        if (parentRendersNothing) {
                            // Invisible parent: render its children as standalone rows so
                            // every file row keeps its own title instead of orphaning
                            // under a parent that shows nothing.
                            promotedChildren.forEachIndexed { childIndex, child ->
                                if (childIndex > 0) {
                                    Spacer(Modifier.height((DevEcoTheme.nodeGap + 2 * DevEcoTheme.nodePadding).dp))
                                }
                                SessionMessageItem(
                                    child,
                                    card,
                                    muted,
                                    accent,
                                    conversationBackground,
                                    controller.expandedThoughts,
                                    controller.expandedTools,
                                    controller.permissionChoices,
                                    controller.permissionResults,
                                    controller.permissionDeniedIds,
                                    onOpenFile,
                                    preserveScroll,
                                    controller = controller,
                                )
                            }
                        } else if (hasChildren) {
                            // Draw vertical line for TOOL/THOUGHT parents to show scope
                            val hasTreeLine = group.parent.role == ChatRole.TOOL ||
                                group.parent.role == ChatRole.THOUGHT
                            Column(
                                Modifier.fillMaxWidth(),
                            ) {
                                // Parent row
                                Box(Modifier.fillMaxWidth()) {
                                    SessionMessageItem(
                                        group.parent,
                                        card,
                                        muted,
                                        accent,
                                        conversationBackground,
                                        controller.expandedThoughts,
                                        controller.expandedTools,
                                        controller.permissionChoices,
                                        controller.permissionResults,
                                        controller.permissionDeniedIds,
                                        onOpenFile,
                                        preserveScroll,
                                        controller = controller,
                                        children = mergedChildren,
                                        onOverlayLift = { lifted -> liftedOverlayIds[group.parent.id] = lifted },
                                    )
                                }
                                // Children rows - only show when expanded
                                if (showsChildren) {
                                    Spacer(Modifier.height((DevEcoTheme.nodeGap + DevEcoTheme.nodePadding).dp))
                                    Column(
                                        Modifier.fillMaxWidth()
                                            .then(
                                                if (hasTreeLine) {
                                                    Modifier.drawBehind {
                                                        val treeLineColor = Color(0xFF6F737A)
                                                        val lineX = 7.dp.toPx()
                                                        drawLine(
                                                            color = treeLineColor,
                                                            start = Offset(lineX, 0f),
                                                            end = Offset(lineX, size.height),
                                                            strokeWidth = 1f,
                                                        )
                                                    }
                                                } else {
                                                    Modifier
                                                },
                                            ),
                                    ) {
                                        separateChildren.forEachIndexed { childIndex, child ->
                                            if (childIndex > 0) Spacer(Modifier.height(DevEcoTheme.nodeGap.dp))
                                            GroupedChildItem(
                                                item = child,
                                                parentRole = group.parent.role,
                                                card = card,
                                                muted = muted,
                                                accent = accent,
                                                conversationBackground = conversationBackground,
                                                expandedThoughts = controller.expandedThoughts,
                                                expandedTools = controller.expandedTools,
                                                permissionChoices = controller.permissionChoices,
                                                permissionResults = controller.permissionResults,
                                                permissionDeniedIds = controller.permissionDeniedIds,
                                                onOpenFile = onOpenFile,
                                                preserveScroll = preserveScroll,
                                                controller = controller,
                                            )
                                        }
                                    }
                                }
                            }
                        } else {
                            // No children - render parent without indent
                            SessionMessageItem(
                                group.parent,
                                card,
                                muted,
                                accent,
                                conversationBackground,
                                controller.expandedThoughts,
                                controller.expandedTools,
                                controller.permissionChoices,
                                controller.permissionResults,
                                controller.permissionDeniedIds,
                                onOpenFile,
                                preserveScroll,
                                controller = controller,
                                children = mergedChildren,
                                onOverlayLift = { lifted -> liftedOverlayIds[group.parent.id] = lifted },
                            )
                        }
                        if (showTurnFooter) {
                            TurnFooter(
                                item = footerAgent,
                                controller = controller,
                                status = terminalStatus,
                                muted = muted,
                                modifier = Modifier.padding(top = DevEcoTheme.actionRowGap.dp),
                            )
                        }
                    }
                }
            }
        }
        if (controller.responding || controller.serverTurn) {
            item(key = "loading-indicator") {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(
                            start = DevEcoTheme.messageHorizontalPadding.dp,
                            end = DevEcoTheme.messageHorizontalPadding.dp,
                            top = DevEcoTheme.messageSpacingTop.dp,
                            bottom = DevEcoTheme.messageSpacingBottom.dp,
                        ),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OrbitingLoadingIndicator(
                        modifier = Modifier.size(DevEcoTheme.loadingIndicatorSize.dp),
                        ringColor = DevEcoTheme.loadingIndicatorColor,
                        ballColor = DevEcoTheme.loadingIndicatorColor,
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        MyMessageBundle.message(
                            if (controller.stopping) "session.status.stopping"
                            else "session.status.responding",
                        ),
                        color = DevEcoTheme.loadingIndicatorColor,
                        fontSize = DevEcoTheme.loadingTextSize.sp,
                    )
                }
            }
        }
        item(key = "conversation-bottom-anchor") {
            Spacer(Modifier.fillMaxWidth().height(1.dp))
        }
    }
}

//  Grouped child item with tree connector line ────────────────────────────

private val TREE_INDENT_DP = 20

private fun isTodoDockSource(item: ChatItem): Boolean =
    isTodoTool(item) && parseTodoDockItems(item.toolRawInput, item.id).isNotEmpty()

@Composable
private fun QueueNoticeBar(notice: String?) {
    if (notice.isNullOrBlank()) return
    val bg = DevEcoTheme.permissionRequestBg
    val border = DevEcoTheme.permissionRequestBorder
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp, vertical = 6.dp)
            .clip(RoundedCornerShape(DevEcoTheme.systemCardRadius.dp))
            .background(bg)
            .border(1.dp, border, RoundedCornerShape(DevEcoTheme.systemCardRadius.dp))
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            key = DevEcoIcons.iconKey("migration-info"),
            contentDescription = null,
            modifier = Modifier.size(14.dp).padding(top = 2.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = notice,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            color = DevEcoTheme.foreground,
            softWrap = true,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun GroupedChildItem(
    item: ChatItem,
    parentRole: ChatRole,
    card: Color,
    muted: Color,
    accent: Color,
    conversationBackground: Color,
    expandedThoughts: MutableMap<String, Boolean>,
    expandedTools: MutableMap<String, Boolean>,
    permissionChoices: Map<String, List<PermissionChoice>>,
    permissionResults: Map<String, String> = emptyMap(),
    permissionDeniedIds: Set<String> = emptySet(),
    onOpenFile: (ChatItem) -> Unit,
    preserveScroll: ((() -> Unit) -> Unit),
    controller: SessionController? = null,
) {
    val isThought = item.role == ChatRole.THOUGHT
    // Only indent TOOL children when parent is TOOL (not THOUGHT)
    val shouldIndent = !isThought && parentRole == ChatRole.TOOL

    if (isThought) {
        // No tree indent for THOUGHT — align with parent
        Box(
            Modifier
                .fillMaxWidth()
                .padding(vertical = DevEcoTheme.nodePadding.dp),
        ) {
            SessionMessageItem(
                item,
                card,
                muted,
                accent,
                conversationBackground,
                expandedThoughts,
                expandedTools,
                permissionChoices,
                permissionResults,
                permissionDeniedIds,
                onOpenFile,
                preserveScroll,
                controller = controller,
                showHeader = false,
                isChild = true,
            )
        }
    } else if (shouldIndent) {
        // TOOL children indent when parent is TOOL
        Row(Modifier.fillMaxWidth()) {
            Spacer(Modifier.width(TREE_INDENT_DP.dp))
            Box(
                Modifier
                    .weight(1f)
                    .padding(vertical = DevEcoTheme.nodePadding.dp),
            ) {
                SessionMessageItem(
                    item,
                    card,
                    muted,
                    accent,
                    conversationBackground,
                    expandedThoughts,
                    expandedTools,
                    permissionChoices,
                    permissionResults,
                    permissionDeniedIds,
                    onOpenFile,
                    preserveScroll,
                    controller = controller,
                    showHeader = true,
                    isChild = true,
                )
            }
        }
    } else {
        // TOOL children render without indent when parent is not TOOL (e.g., THOUGHT or AGENT)
        Box(
            Modifier
                .fillMaxWidth()
                .padding(vertical = DevEcoTheme.nodePadding.dp),
        ) {
            SessionMessageItem(
                item,
                card,
                muted,
                accent,
                conversationBackground,
                expandedThoughts,
                expandedTools,
                permissionChoices,
                permissionResults,
                permissionDeniedIds,
                onOpenFile,
                preserveScroll,
                controller = controller,
                showHeader = true,
                isChild = true,
            )
        }
    }
}

@Composable
private fun BottomGradientOverlay(modifier: Modifier, background: Color) {
    Box(
        modifier.fillMaxWidth().height(18.dp)
            .background(Brush.verticalGradient(listOf(Color.Transparent, background))),
    )
}

@Composable
private fun ScrollToBottomButton(
    modifier: Modifier,
    listState: LazyListState,
    messages: List<ChatItem>,
    card: Color,
    muted: Color,
    onFollowTailChanged: (Boolean) -> Unit,
    autoScrolling: MutableState<Int>,
    scope: CoroutineScope,
) {
    Box(
        modifier.padding(bottom = 8.dp).size(28.dp)
            .clip(CircleShape).background(card)
            .border(1.dp, muted.copy(alpha = 0.35f), CircleShape)
            .clickable {
                onFollowTailChanged(true)
                scope.launch {
                    autoScrolling.value += 1
                    try {
                        listState.animateScrollToItem(messages.size)
                    } finally {
                        autoScrolling.value -= 1
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            key = AllIconsKeys.General.ChevronDown,
            contentDescription = "Scroll to latest message",
            modifier = Modifier.size(12.dp),
        )
    }
}

// Frame-stepped delay loop: discrete writes ~27 times per second in 15° steps
// keep the Compose surface quiet between steps on the IntelliJ EDT.
private const val ORBIT_CYCLE_MILLIS = 900L
private const val ORBIT_FRAMES = 24

@Composable
internal fun OrbitingLoadingIndicator(
    modifier: Modifier = Modifier,
    ringColor: Color = Color(0x6C707E),
    ballColor: Color = Color(0x6C707E),
) {
    val frame = remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(ORBIT_CYCLE_MILLIS / ORBIT_FRAMES)
            frame.intValue = (frame.intValue + 1) % ORBIT_FRAMES
        }
    }

    // Start at 135° (bottom-left), advance counter-clockwise toward top-right
    val angleDeg = 135.0 - frame.intValue * (360.0 / ORBIT_FRAMES)
    val angleRad = Math.toRadians(angleDeg)

    Canvas(modifier = modifier) {
        val canvasWidth = size.width
        val center = Offset(canvasWidth / 2f, size.height / 2f)
        val radius = (canvasWidth / 2f) * 0.75f
        val strokeWidth = canvasWidth * 0.12f
        val baseBallRadius = strokeWidth * 1.2f
        val orbitRadius = radius + strokeWidth / 2f + baseBallRadius

        // Tilted elliptical orbit: compress Y for perspective, then rotate -25°
        val perspectiveY = 0.35f
        val tiltRad = Math.toRadians(-25.0)
        val rotCos = Math.cos(tiltRad)
        val rotSin = Math.sin(tiltRad)

        fun orbitPos(angle: Double): Offset {
            val ex = Math.cos(angle)
            val ey = Math.sin(angle) * perspectiveY
            return Offset(
                center.x + (orbitRadius * (ex * rotCos - ey * rotSin)).toFloat(),
                center.y + (orbitRadius * (ex * rotSin + ey * rotCos)).toFloat(),
            )
        }

        fun ballScale(angle: Double): Float = (1.0 + 0.5 * Math.sin(angle)).toFloat()

        val ballPos = orbitPos(angleRad)
        val ballRadius = baseBallRadius * ballScale(angleRad)

        // Far side (sin < 0 = upper half): ball goes behind ring; near side: in front
        val isBehind = Math.sin(angleRad) < 0

        val trailCount = 8
        val trailStepRad = Math.toRadians(10.5)

        if (isBehind) {
            // Far side: trail and ball behind the ring
            for (i in trailCount downTo 1) {
                val tAngle = angleRad + i * trailStepRad
                if (Math.sin(tAngle) < 0) {
                    val tPos = orbitPos(tAngle)
                    val ratio = i.toFloat() / trailCount
                    drawCircle(
                        color = ballColor.copy(alpha = (1f - ratio) * 0.3f),
                        radius = baseBallRadius * ballScale(tAngle) * (1f - ratio * 0.6f),
                        center = tPos,
                    )
                }
            }
            drawCircle(
                color = ballColor.copy(alpha = 0.4f),
                radius = ballRadius * 0.6f,
                center = ballPos,
            )
            drawCircle(
                color = ringColor,
                radius = radius,
                center = center,
                style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
            )
        } else {
            // Near side: ring first, then trail and ball in front
            drawCircle(
                color = ringColor,
                radius = radius,
                center = center,
                style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
            )
            for (i in trailCount downTo 1) {
                val tAngle = angleRad + i * trailStepRad
                if (Math.sin(tAngle) >= 0) {
                    val tPos = orbitPos(tAngle)
                    val ratio = i.toFloat() / trailCount
                    drawCircle(
                        color = ballColor.copy(alpha = (1f - ratio) * 0.4f),
                        radius = baseBallRadius * ballScale(tAngle) * (1f - ratio * 0.6f),
                        center = tPos,
                    )
                }
            }
            drawCircle(
                color = ballColor,
                radius = ballRadius,
                center = ballPos,
            )
        }
    }
}
