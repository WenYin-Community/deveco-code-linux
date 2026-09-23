package org.deveco.code.session.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollbarAdapter
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
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
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.SessionController
import org.deveco.code.session.model.ChatItem
import org.deveco.code.session.model.ChatRole
import org.deveco.code.session.model.MessageGroup
import org.deveco.code.util.hoverable
import org.deveco.code.session.model.PermissionChoice
import org.deveco.code.session.model.groupMessages
import org.deveco.code.session.model.isToolItemEmpty
import org.deveco.code.session.model.isToolChildEmpty
import org.deveco.code.session.ui.composer.SessionComposer
import org.deveco.code.session.ui.composer.TodoDock
import org.deveco.code.session.model.SessionViewState
import org.deveco.code.session.model.SessionViewportState
import org.jetbrains.jewel.bridge.toComposeColor
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icons.AllIconsKeys

private val COMPACT_WIDTH_THRESHOLD = 500.dp
private val WIDE_WIDTH_THRESHOLD = 924.dp

@Composable
internal fun SessionScreen(
    project: Project,
    controller: SessionController,
    restoredState: SessionViewState?,
    onOpenFile: (ChatItem) -> Unit,
    onViewportChanged: (SessionViewportState) -> Unit,
    onDraftChanged: (String) -> Unit,
) {
    SessionMarkdownTheme(project) {
        SessionContent(project, controller, restoredState, onOpenFile, onViewportChanged, onDraftChanged)
    }
}

@Composable
private fun SessionContent(
    project: Project,
    controller: SessionController,
    restoredState: SessionViewState?,
    onOpenFile: (ChatItem) -> Unit,
    onViewportChanged: (SessionViewportState) -> Unit,
    onDraftChanged: (String) -> Unit,
) {
    val messages = controller.messages
    val listState = rememberLazyListState()
    val horizontalScrollState = rememberScrollState()
    val scope = rememberCoroutineScope()
    var followTail by remember { mutableStateOf(restoredState?.followTail ?: true) }
    var restoringPosition by remember { mutableStateOf(restoredState != null) }
    var autoScrolling by remember { mutableStateOf(false) }
    var contentLayoutVersion by remember { mutableIntStateOf(0) }
    val editorBackground = com.intellij.openapi.editor.colors.EditorColorsManager.getInstance().globalScheme.defaultBackground.toComposeColor()
    val conversationBackground = editorBackground
    val card = JBColor.namedColor("Editor.SearchField.background", 0x27282C).toComposeColor()
    val inputBackground = DevEcoTheme.inputBackground
    val muted = JBColor.namedColor("Label.infoForeground", 0x868A91).toComposeColor()
    val accent = DevEcoTheme.accent

    SessionViewportTrackingEffect(listState, messages, followTail, onViewportChanged)
    SessionFollowTailViewportEffect(listState, messages, followTail, onViewportChanged)
    SessionScrollTrackingEffect(listState, autoScrolling) { followTail = it }
    SessionCanScrollForwardEffect(listState, autoScrolling) { followTail = it }
    SessionTailAutoScrollEffect(
        listState, messages, followTail, restoringPosition, contentLayoutVersion,
    ) { autoScrolling = it }
    SessionRestorePositionEffect(
        listState, messages, controller.ready, restoredState, restoringPosition,
        onRestoringPositionChanged = { restoringPosition = it },
        onAutoScrollingChanged = { autoScrolling = it },
    )

    // Force scroll-to-tail whenever the user explicitly submits a prompt (clicking Send,
    // pressing Enter, or auto-prompt from build errors). This overrides the followTail lock
    // that may have been set when the user scrolled up to read previous messages.
    LaunchedEffect(controller.sendTick) {
        if (controller.sendTick == 0 || messages.isEmpty()) return@LaunchedEffect
        followTail = true
        // Wait two frames so the newly added ChatItem completes layout before we scroll.
        withFrameNanos { }
        withFrameNanos { }
        autoScrolling = true
        listState.animateScrollToItem(messages.size)
    }

    // --- Scrollbar visibility control ---
    // Polls every 50ms to update scrollbar display state and length info.
    // Rules:
    //   1. Content doesn't overflow viewport → never show
    //   2. Content overflows + idle → hidden (300ms hide delay after last scroll)
    //   3. Content overflows + user scrolling → visible
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
            } else if (scrolling) {
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
        BoxWithConstraints(
            Modifier.fillMaxSize().padding(top = 12.dp, bottom = 12.dp).clipToBounds(),
            contentAlignment = Alignment.TopCenter,
        ) {
            Column(
                (if (maxWidth < COMPACT_WIDTH_THRESHOLD) {
                    Modifier.requiredWidth(COMPACT_WIDTH_THRESHOLD).horizontalScroll(horizontalScrollState)
                } else {
                    Modifier.widthIn(max = WIDE_WIDTH_THRESHOLD).fillMaxWidth()
                }).fillMaxHeight().background(conversationBackground),
            ) {
                Box(Modifier.fillMaxWidth().weight(1f)) {
                    MessageList(
                        messages = messages,
                        listState = listState,
                        card = card,
                        muted = muted,
                        accent = accent,
                        conversationBackground = conversationBackground,
                        controller = controller,
                        onOpenFile = onOpenFile,
                        onContentLayoutChanged = { contentLayoutVersion++ },
                        onFollowTailChanged = { followTail = it },
                        scope = scope,
                    )
                    VerticalScrollbar(
                        adapter = rememberScrollbarAdapter(listState),
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
                    BottomGradientOverlay(Modifier.align(Alignment.BottomCenter), conversationBackground)
                    if (listState.canScrollForward) {
                        ScrollToBottomButton(
                            modifier = Modifier.align(Alignment.BottomCenter),
                            listState = listState,
                            messages = messages,
                            card = card,
                            muted = muted,
                            onFollowTailChanged = { followTail = it },
                            onAutoScrollingChanged = { autoScrolling = it },
                            scope = scope,
                        )
                    }
                }
                TodoDock(
                    items = controller.todoDockItems,
                    onJumpToTool = { toolItemId ->
                        val index = messages.indexOfFirst { it.id == toolItemId }
                        if (index >= 0) scope.launch { listState.animateScrollToItem(index) }
                    },
                )
                if (controller.isAttachmentLimitReached) {
                    AttachmentLimitWarning(
                        modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp),
                        muted = muted,
                    )
                }
                SessionComposer(
                    controller = controller,
                    project = project,
                    background = inputBackground,
                    muted = muted,
                    accent = accent,
                    initialDraft = restoredState?.draft.orEmpty(),
                    onDraftChanged = onDraftChanged,
                )
            }
        }
    }
}

@Composable
private fun SessionViewportTrackingEffect(
    listState: LazyListState,
    messages: List<ChatItem>,
    followTail: Boolean,
    onViewportChanged: (SessionViewportState) -> Unit,
) {
    val currentFollowTail by rememberUpdatedState(followTail)
    LaunchedEffect(listState) {
        snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
            .collect { (index, offset) ->
                onViewportChanged(
                    SessionViewportState(messages.getOrNull(index)?.id, index, offset, currentFollowTail),
                )
            }
    }
}

@Composable
private fun SessionFollowTailViewportEffect(
    listState: LazyListState,
    messages: List<ChatItem>,
    followTail: Boolean,
    onViewportChanged: (SessionViewportState) -> Unit,
) {
    LaunchedEffect(followTail) {
        onViewportChanged(
            SessionViewportState(
                messages.getOrNull(listState.firstVisibleItemIndex)?.id,
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
    autoScrolling: Boolean,
    onFollowTailChanged: (Boolean) -> Unit,
) {
    val currentAutoScrolling by rememberUpdatedState(autoScrolling)
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
            if (scrolling && !currentAutoScrolling) onFollowTailChanged(false)
        }
    }
}

@Composable
private fun SessionCanScrollForwardEffect(
    listState: LazyListState,
    autoScrolling: Boolean,
    onFollowTailChanged: (Boolean) -> Unit,
) {
    val currentAutoScrolling by rememberUpdatedState(autoScrolling)
    LaunchedEffect(listState) {
        // Combine canScrollForward and isScrollInProgress so the flow emits on either change.
        // followTail is only re-enabled when we're at the bottom AND the scroll has settled
        // (user released the drag). Without checking isScrollInProgress, dragging the scrollbar
        // at the bottom would immediately flip followTail back to true and cause a bounce.
        snapshotFlow { listState.canScrollForward to listState.isScrollInProgress }.collect { (canScroll, isScrolling) ->
            if (!canScroll && !isScrolling && !currentAutoScrolling) onFollowTailChanged(true)
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
    onAutoScrollingChanged: (Boolean) -> Unit,
) {
    LaunchedEffect(messages.size, messages.lastOrNull()?.text, contentLayoutVersion, followTail) {
        if (!restoringPosition && followTail && messages.isNotEmpty()) {
            withFrameNanos { }
            onAutoScrollingChanged(true)
            try {
                listState.scrollToItem(messages.size)
            } finally {
                onAutoScrollingChanged(false)
            }
        }
    }
}

@Composable
private fun SessionRestorePositionEffect(
    listState: LazyListState,
    messages: List<ChatItem>,
    controllerReady: Boolean,
    restoredState: SessionViewState?,
    restoringPosition: Boolean,
    onRestoringPositionChanged: (Boolean) -> Unit,
    onAutoScrollingChanged: (Boolean) -> Unit,
) {
    LaunchedEffect(controllerReady, messages.size) {
        val saved = restoredState
        if (!restoringPosition || !controllerReady || saved == null || messages.isEmpty()) {
            return@LaunchedEffect
        }
        withFrameNanos { }
        withFrameNanos { }
        onAutoScrollingChanged(true)
        try {
            if (saved.followTail) {
                listState.scrollToItem(messages.size)
            } else {
                val anchoredIndex = saved.anchorMessageId
                    ?.let { id -> messages.indexOfFirst { it.id == id }.takeIf { it >= 0 } }
                listState.scrollToItem(
                    (anchoredIndex ?: saved.firstVisibleItemIndex).coerceIn(0, messages.lastIndex),
                    saved.firstVisibleItemOffset,
                )
            }
        } finally {
            onRestoringPositionChanged(false)
            onAutoScrollingChanged(false)
        }
    }
}

@Composable
private fun MessageList(
    messages: List<ChatItem>,
    listState: LazyListState,
    card: Color,
    muted: Color,
    accent: Color,
    conversationBackground: Color,
    controller: SessionController,
    onOpenFile: (ChatItem) -> Unit,
    onContentLayoutChanged: () -> Unit,
    onFollowTailChanged: (Boolean) -> Unit,
    scope: CoroutineScope,
) {
    val groups by remember {
        derivedStateOf {
            groupMessages(messages.toList())
                // Filter out TOOL parent items that have no meaningful content
                .filter { group ->
                    group.parent.role != ChatRole.TOOL || !isToolItemEmpty(group.parent)
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
    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 30.dp),
    ) {
        itemsIndexed(groups, key = { _, group -> group.parent.id }) { groupIndex, group ->
            val isFirstGroup = groupIndex == 0
            val isLastGroup = groupIndex == groups.lastIndex
            Box(
                Modifier.fillMaxWidth().onSizeChanged { onContentLayoutChanged() }
                    .padding(
                        start = DevEcoTheme.messageHorizontalPadding.dp,
                        end = DevEcoTheme.messageHorizontalPadding.dp,
                        top = if (isFirstGroup) DevEcoTheme.firstMessageTop.dp else DevEcoTheme.messageSpacingTop.dp,
                        bottom = 0.dp,
                    ),
            ) {
                SelectionContainer {
                    Column {
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

                        // Check if parent is expanded (for showing children and tree lines)
                        val isParentExpanded = when (group.parent.role) {
                            ChatRole.THOUGHT -> controller.expandedThoughts[group.parent.id] ?: false
                            ChatRole.TOOL -> controller.expandedTools[group.parent.id] ?: false
                            else -> true
                        }

                        val hasChildren = separateChildren.isNotEmpty() || mergedChildren.isNotEmpty()

                        if (hasChildren) {
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
                                        { change: () -> Unit ->
                                            val indexBefore = listState.firstVisibleItemIndex
                                            val offsetBefore = listState.firstVisibleItemScrollOffset
                                            onFollowTailChanged(false)
                                            change()
                                            scope.launch {
                                                withFrameNanos { }
                                                listState.scrollToItem(indexBefore, offsetBefore)
                                                withFrameNanos { }
                                                onFollowTailChanged(!listState.canScrollForward)
                                            }
                                        },
                                        controller = controller,
                                        children = mergedChildren,
                                    )
                                }
                                // Children rows - only show when expanded
                                if (isParentExpanded && separateChildren.isNotEmpty()) {
                                    Spacer(Modifier.height(2.dp))
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
                                        separateChildren.forEach { child ->
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
                                                preserveScroll = { change: () -> Unit ->
                                                    val indexBefore = listState.firstVisibleItemIndex
                                                    val offsetBefore = listState.firstVisibleItemScrollOffset
                                                    onFollowTailChanged(false)
                                                    change()
                                                    scope.launch {
                                                        withFrameNanos { }
                                                        listState.scrollToItem(indexBefore, offsetBefore)
                                                        withFrameNanos { }
                                                        onFollowTailChanged(!listState.canScrollForward)
                                                    }
                                                },
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
                                { change: () -> Unit ->
                                    val indexBefore = listState.firstVisibleItemIndex
                                    val offsetBefore = listState.firstVisibleItemScrollOffset
                                    onFollowTailChanged(false)
                                    change()
                                    scope.launch {
                                        withFrameNanos { }
                                        listState.scrollToItem(indexBefore, offsetBefore)
                                        withFrameNanos { }
                                        onFollowTailChanged(!listState.canScrollForward)
                                    }
                                },
                                controller = controller,
                                children = mergedChildren,
                            )
                        }
                    }
                }
            }
        }
        if (controller.responding) {
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
                        MyMessageBundle.message("session.status.responding"),
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
                .padding(
                    top = 4.dp,
                    bottom = 4.dp,
                ),
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
                    .padding(
                        top = 4.dp,
                        bottom = 4.dp,
                    ),
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
                .padding(
                    top = 4.dp,
                    bottom = 4.dp,
                ),
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
    onAutoScrollingChanged: (Boolean) -> Unit,
    scope: CoroutineScope,
) {
    Box(
        modifier.padding(bottom = 8.dp).size(28.dp)
            .clip(CircleShape).background(card)
            .border(1.dp, muted.copy(alpha = 0.35f), CircleShape)
            .clickable {
                onFollowTailChanged(true)
                scope.launch {
                    onAutoScrollingChanged(true)
                    try {
                        listState.animateScrollToItem(messages.size)
                    } finally {
                        onAutoScrollingChanged(false)
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

@Composable
private fun OrbitingLoadingIndicator(
    modifier: Modifier = Modifier,
    ringColor: Color = Color(0x6C707E),
    ballColor: Color = Color(0x6C707E),
) {
    val transition = rememberInfiniteTransition(label = "orbit")
    val angle by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = androidx.compose.animation.core.tween(
                durationMillis = 900,
                easing = androidx.compose.animation.core.LinearEasing,
            ),
            repeatMode = RepeatMode.Restart,
        ),
        label = "orbit-angle",
    )
    Canvas(modifier = modifier) {
        val canvasWidth = size.width
        val canvasHeight = size.height
        val center = Offset(canvasWidth / 2f, canvasHeight / 2f)
        val radius = (canvasWidth / 2f) * 0.75f
        val strokeWidth = canvasWidth * 0.12f

        drawCircle(
            color = ringColor,
            radius = radius,
            center = center,
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
        )

        val ballRadius = strokeWidth * 0.8f
        val orbitRadius = radius + strokeWidth / 2f + ballRadius
        val rad = Math.toRadians(angle.toDouble())
        val ballX = center.x + (orbitRadius * kotlin.math.cos(rad)).toFloat()
        val ballY = center.y + (orbitRadius * kotlin.math.sin(rad)).toFloat()

        drawCircle(
            color = ballColor,
            radius = ballRadius,
            center = Offset(ballX, ballY),
        )
    }
}

@Composable
private fun AttachmentLimitWarning(
    modifier: Modifier = Modifier,
    muted: Color,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(DevEcoTheme.permissionWarningBg)
            .border(1.dp, DevEcoTheme.permissionWarningBorder, RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            key = AllIconsKeys.General.Warning,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            MyMessageBundle.message("attachment.limit.warning"),
            color = DevEcoTheme.warning,
            fontSize = 12.sp,
        )
    }
}
