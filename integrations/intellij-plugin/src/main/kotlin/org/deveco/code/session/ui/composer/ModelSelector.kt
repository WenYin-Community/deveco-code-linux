package org.deveco.code.session.ui.composer

import androidx.compose.foundation.ScrollbarStyle
import androidx.compose.foundation.VerticalScrollbar
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.rememberScrollbarAdapter
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import kotlinx.coroutines.launch
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.SessionController
import org.deveco.code.session.ui.messages.DropdownIconKey
import org.deveco.code.util.openProductSettings
import org.jetbrains.jewel.bridge.toComposeColor
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text

private val ATTACHMENT_LIST_MAX_HEIGHT = 300.dp
private val DROPDOWN_ITEM_HEIGHT = 24.dp
private const val POPUP_ANCHOR_GAP = 2 // px gap between the anchor and the popup

@Composable
internal fun ModelSelector(
    controller: SessionController,
    muted: Color,
    project: Project,
    inputFocusRequester: FocusRequester,
) {
    var expanded by remember { mutableStateOf(false) }
    var buttonWidthPx by remember { mutableStateOf(0) }
    val density = LocalDensity.current
    val buttonWidth = with(density) { buttonWidthPx.toDp() } + 20.dp
    val interactionSource = remember { MutableInteractionSource() }
    val hovered by interactionSource.collectIsHoveredAsState()
    val enabled = controller.models.isNotEmpty()
    val label = controller.selectedModel?.name ?: MyMessageBundle.message("composer.model.auto")

    // Focus is restored to the prompt input only after the popup has fully
    // left composition. Requesting it synchronously while the popup window is
    // still being disposed loses the request (or strands the AWT input method
    // on the dying popup window), after which the prompt input's IME — the
    // Chinese/English toggle — stops engaging until the field regains focus.
    var pendingRefocus by remember { mutableStateOf(false) }
    LaunchedEffect(expanded) {
        if (!expanded && pendingRefocus) {
            pendingRefocus = false
            withFrameNanos { }
            withFrameNanos { }
            inputFocusRequester.requestFocus()
        }
    }

    // The "add model" row defers opening the settings dialog until the popup
    // window has fully left composition (same two-frame settling as the refocus
    // path above): the dialog builds the whole configurable tree on the EDT
    // and then enters a modal event pump, which must not interleave with the
    // popup's disposal and focus handoff. The pendingOpenSettings guard makes
    // the deferral single-flight: a second trigger before recomposition (double
    // click, double Enter) sees expanded == false and does nothing. If this
    // composable is unmounted during the wait (session switch, tool window
    // teardown), the click is dropped by design — a modal dialog popping over
    // an in-progress teardown would be worse than a lost click.
    var pendingOpenSettings by remember { mutableStateOf(false) }
    LaunchedEffect(expanded) {
        if (!expanded && pendingOpenSettings) {
            pendingOpenSettings = false
            withFrameNanos { }
            withFrameNanos { }
            project.openProductSettings("ai.coding.models")
        }
    }

    Box {
        Row(
            Modifier.clip(RoundedCornerShape(7.dp))
                .background(if (hovered || expanded) DevEcoTheme.pressedAccentSoft else Color.Transparent)
                .clickable(
                    enabled = enabled,
                    interactionSource = interactionSource,
                    indication = null,
                ) { expanded = true }
                .padding(horizontal = 10.dp, vertical = 5.dp)
                .onSizeChanged { buttonWidthPx = it.width },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                label,
                color = if (enabled) Color.Unspecified else muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 180.dp),
            )
            Spacer(Modifier.width(6.dp))
            Icon(
                key = DropdownIconKey,
                contentDescription = MyMessageBundle.message("session.model.selector"),
                modifier = Modifier.size(12.dp).rotate(if (expanded) 180f else 0f),
            )
        }

        if (expanded && enabled) {
            // String overload of BasicTextField (the TextFieldValue one breaks CJK
            // composition on the second keystroke, CMP-9380); onValueChange still
            // reports the in-flight composition text, so the filter tracks what the
            // user actually sees.
            var queryValue by remember { mutableStateOf("") }
            val scrollState = rememberScrollState()
            fun filterFor(query: String) =
                if (query.isBlank()) controller.models
                else {
                    val q = query.trim().lowercase()
                    controller.models.filter { it.name.lowercase().contains(q) || it.id.lowercase().contains(q) }
                }
            val filteredModels = remember(queryValue, controller.models) { filterFor(queryValue) }
            // Track the measured list height so the scrollbar can be sized to it
            // explicitly. fillMaxHeight() would receive Infinity here because the
            // popup Column has no bounded height, throwing
            // "Size(6 x 2147483647) is out of range" during measure.
            var listHeightPx by remember { mutableStateOf(0) }
            val searchFocusRequester = remember { FocusRequester() }
            val openModelSettings = {
                if (expanded) {
                    expanded = false
                    pendingOpenSettings = true
                }
            }

            // Keyboard navigation over filteredModels plus the pinned "add
            // model" row. The highlight starts on the selected model (first row
            // when it isn't listed), so Enter right after opening keeps the
            // current selection. Recomputed on filter change and clamped on
            // read so an async model-list refresh can't leave it out of range.
            var highlightIndex by remember {
                mutableStateOf(controller.models.indexOfFirst { it.id == controller.selectedModel?.id }.takeIf { it >= 0 } ?: 0)
            }
            val navigableCount = filteredModels.size + 1
            val highlight = highlightIndex.coerceIn(0, navigableCount - 1)
            val scope = rememberCoroutineScope()
            val itemHeightPx = with(density) { DROPDOWN_ITEM_HEIGHT.roundToPx() }
            var viewportHeightPx by remember { mutableStateOf(0) }

            // Keep the highlighted model row inside the visible viewport. The
            // add-model row is pinned below the scroll area, so it needs no
            // scrolling. Rows have a fixed height, so the pixel math is exact.
            fun ensureHighlightVisible(index: Int) {
                // viewportHeightPx == 0 before the list Box is measured (first
                // frame after the popup opens). Scrolling then would mis-target
                // and push the top row out of view, so wait for measurement.
                if (index >= filteredModels.size || viewportHeightPx == 0) return
                val top = index * itemHeightPx
                val bottom = top + itemHeightPx
                val target = when {
                    top < scrollState.value -> top
                    bottom > scrollState.value + viewportHeightPx -> bottom - viewportHeightPx
                    else -> return
                }
                scope.launch { scrollState.scrollTo(target.coerceIn(0, scrollState.maxValue)) }
            }

            fun commitHighlight() {
                if (highlight < filteredModels.size) {
                    val model = filteredModels[highlight]
                    expanded = false
                    if (model.id != controller.selectedModel?.id) controller.selectModel(model.id)
                    pendingRefocus = true
                } else {
                    openModelSettings()
                }
            }

            // Same interception pattern as the prompt input (ComposerContent):
            // plain arrow keys and Enter only. Keys pass through whenever a modifier
            // is held; the prompt input's keys never reach this handler at all.
            // (No composition check: unavailable on the String overload, and on
            // Windows the IME consumes navigation keys while composing.)
            val handleSearchKeyEvent = { event: KeyEvent ->
                if (event.type != KeyEventType.KeyDown ||
                    event.isCtrlPressed || event.isMetaPressed || event.isAltPressed || event.isShiftPressed
                ) {
                    false
                } else {
                    when (event.key) {
                        Key.DirectionUp -> {
                            val next = (highlight - 1 + navigableCount) % navigableCount
                            highlightIndex = next
                            ensureHighlightVisible(next)
                            true
                        }
                        Key.DirectionDown -> {
                            val next = (highlight + 1) % navigableCount
                            highlightIndex = next
                            ensureHighlightVisible(next)
                            true
                        }
                        Key.Enter, Key.NumPadEnter -> {
                            commitHighlight()
                            true
                        }
                        Key.Escape -> {
                            expanded = false
                            pendingRefocus = true
                            true
                        }
                        else -> false
                    }
                }
            }

            // Grab keyboard focus for the search box one frame after the popup
            // shows, once the BasicTextField is attached, so typing works without
            // a click.
            LaunchedEffect(Unit) {
                withFrameNanos { }
                searchFocusRequester.requestFocus()
            }

            Popup(
                popupPositionProvider = DropdownPositionProvider(endAligned = false, flipOnOverflow = true),
                onDismissRequest = {
                    expanded = false
                    // Same refocus path as selecting a model: clicking outside or
                    // pressing Back dismisses the popup, and the prompt input must
                    // regain focus or its IME stops engaging.
                    pendingRefocus = true
                },
                properties = PopupProperties(focusable = true, dismissOnBackPress = true, dismissOnClickOutside = true),
            ) {
                Column(
                    Modifier.width(IntrinsicSize.Max)
                        .widthIn(min = buttonWidth)
                        .background(DevEcoTheme.popupBackground, RoundedCornerShape(6.dp))
                        .border(1.dp, DevEcoTheme.popupBorder, RoundedCornerShape(6.dp))
                        .padding(vertical = 4.dp),
                ) {
                    ModelSearchField(
                        query = queryValue,
                        onQueryChange = { newValue ->
                            queryValue = newValue
                            // Stay on the selected model when it still matches
                            // the filter, else land back on the first row.
                            highlightIndex = filterFor(newValue)
                                .indexOfFirst { it.id == controller.selectedModel?.id }
                                .takeIf { it >= 0 } ?: 0
                        },
                        focusRequester = searchFocusRequester,
                        muted = muted,
                        onPreviewKey = handleSearchKeyEvent,
                    )
                    Box(
                        Modifier.fillMaxWidth().height(1.dp).background(DevEcoTheme.popupBorder)
                    )
                    Box(
                        Modifier.heightIn(max = ATTACHMENT_LIST_MAX_HEIGHT)
                            .onSizeChanged { viewportHeightPx = it.height },
                    ) {
                        Column(
                            Modifier
                                .verticalScroll(scrollState)
                                .onSizeChanged { listHeightPx = it.height }
                        ) {
                            if (filteredModels.isEmpty()) {
                                val emptyText = if (controller.models.isEmpty()) {
                                    MyMessageBundle.message("composer.model.empty")
                                } else {
                                    MyMessageBundle.message("composer.model.search.empty")
                                }
                                Text(
                                    emptyText,
                                    color = DevEcoTheme.muted,
                                    fontSize = 13.sp,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = 12.dp, vertical = 8.dp),
                                )
                            } else {
                                filteredModels.forEachIndexed { index, model ->
                                    ModelDropdownItem(
                                        text = model.name,
                                        selected = model.id == controller.selectedModel?.id,
                                        highlighted = index == highlight,
                                        onHoverChange = { hovered -> if (hovered) highlightIndex = index },
                                        onClick = {
                                            expanded = false
                                            controller.selectModel(model.id)
                                            pendingRefocus = true
                                        },
                                    )
                                }
                            }
                        }
                        // Only draw the thumb when the list actually overflows;
                        // otherwise it would render as a full-height gray bar.
                        if (scrollState.maxValue > 0) {
                            VerticalScrollbar(
                                adapter = rememberScrollbarAdapter(scrollState),
                                modifier = Modifier
                                    .align(Alignment.CenterEnd)
                                    .height(with(density) { listHeightPx.toDp() })
                                    .padding(end = 2.dp),
                                style = ScrollbarStyle(
                                    minimalHeight = 16.dp,
                                    thickness = 6.dp,
                                    shape = RoundedCornerShape(3.dp),
                                    hoverDurationMillis = 300,
                                    unhoverColor = JBColor(0x33000000, 0x33FFFFFF).toComposeColor(),
                                    hoverColor = JBColor(0x66000000, 0x66FFFFFF).toComposeColor(),
                                ),
                            )
                        }
                    }
                    Box(
                        Modifier.fillMaxWidth().height(1.dp).background(DevEcoTheme.popupBorder)
                    )
                    ModelDropdownItem(
                        text = MyMessageBundle.message("composer.addModel"),
                        highlighted = highlight == filteredModels.size,
                        onHoverChange = { hovered -> if (hovered) highlightIndex = filteredModels.size },
                        onClick = openModelSettings,
                    )
                }
            }
        }
    }
}

@Composable
private fun ModelSearchField(
    query: String,
    onQueryChange: (String) -> Unit,
    focusRequester: FocusRequester,
    muted: Color,
    onPreviewKey: (KeyEvent) -> Boolean = { false },
) {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 6.dp, vertical = 4.dp)
            .background(DevEcoTheme.inputBackground, RoundedCornerShape(4.dp))
            .border(1.dp, DevEcoTheme.popupBorder, RoundedCornerShape(4.dp))
            .padding(horizontal = 8.dp, vertical = 4.dp),
    ) {
        BasicTextField(
            value = query,
            onValueChange = onQueryChange,
            singleLine = true,
            textStyle = TextStyle(color = DevEcoTheme.foreground, fontSize = 13.sp),
            cursorBrush = SolidColor(DevEcoTheme.accent),
            // focusRequester sits on the focusable BasicTextField itself (not the
            // outer Box, where it would bind to nothing), so requestFocus() works.
            modifier = Modifier.fillMaxWidth().focusRequester(focusRequester).onPreviewKeyEvent(onPreviewKey),
            decorationBox = { innerTextField ->
                Box(Modifier.fillMaxWidth()) {
                    if (query.isEmpty()) {
                        Text(
                            MyMessageBundle.message("composer.model.search.placeholder"),
                            color = muted,
                            fontSize = 13.sp,
                        )
                    }
                    innerTextField()
                }
            },
        )
    }
}

@Composable
internal fun ModelDropdownItem(
    text: String,
    selected: Boolean = false,
    highlighted: Boolean = false,
    onHoverChange: (Boolean) -> Unit = {},
    onClick: () -> Unit = {},
) {
    val interactionSource = remember { MutableInteractionSource() }
    val isHovered by interactionSource.collectIsHoveredAsState()
    // Mirror hover into the caller's highlight index so the keyboard cursor
    // follows the mouse: Enter after hovering commits the hovered row, not a
    // stale keyboard position.
    LaunchedEffect(isHovered) { onHoverChange(isHovered) }
    val textColor = when {
        highlighted -> DevEcoTheme.foreground
        selected -> DevEcoTheme.onAccent
        else -> DevEcoTheme.mutedGray
    }

    Row(
        Modifier.fillMaxWidth()
            .height(DROPDOWN_ITEM_HEIGHT)
            .hoverable(interactionSource)
            .clickable(interactionSource = interactionSource, indication = null) { onClick() }
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxHeight()
                .then(
                    when {
                        // Keyboard highlight outranks the selected tint so the
                        // Enter target stays visible even on the current model.
                        highlighted -> Modifier
                            .background(DevEcoTheme.pressedAccentSoft, RoundedCornerShape(4.dp))
                        selected -> Modifier
                            .background(DevEcoTheme.accent.copy(alpha = 0.3f), RoundedCornerShape(4.dp))
                        isHovered -> Modifier
                            .background(DevEcoTheme.pressedAccentSoft, RoundedCornerShape(4.dp))
                        else -> Modifier
                    }
                ),
            contentAlignment = Alignment.CenterStart,
        ) {
            Text(
                text,
                color = textColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 200.dp).padding(start = 10.dp),
                fontSize = 13.sp,
            )
        }
    }
}

internal class DropdownPositionProvider(
    private val endAligned: Boolean = false,
    private val flipOnOverflow: Boolean = false,
) : PopupPositionProvider {
    override fun calculatePosition(
        anchorBounds: IntRect,
        windowSize: IntSize,
        layoutDirection: LayoutDirection,
        popupContentSize: IntSize,
    ): IntOffset {
        val x = if (endAligned) anchorBounds.right - popupContentSize.width else anchorBounds.left
        val aboveY = anchorBounds.top - popupContentSize.height - POPUP_ANCHOR_GAP
        if (!flipOnOverflow) {
            // Original behavior shared by the other composer dropdowns: open
            // above the anchor (may clip off-screen if there is no room above).
            return IntOffset(maxOf(0, x), aboveY)
        }
        // flipOnOverflow: open below when above would clip, and keep the whole
        // popup inside the window on every edge.
        val y = if (aboveY < 0) anchorBounds.bottom + POPUP_ANCHOR_GAP else aboveY
        return IntOffset(
            x.coerceIn(0, maxOf(0, windowSize.width - popupContentSize.width)),
            y.coerceIn(0, maxOf(0, windowSize.height - popupContentSize.height)),
        )
    }
}
