package org.deveco.code.session.ui.messages

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import com.intellij.ui.JBColor
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.jetbrains.jewel.bridge.toComposeColor
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icon.PathIconKey

private val ExpandIconKey = PathIconKey("/icons/expand-light.svg", DevEcoTheme::class.java)
private val CollapseIconKey = PathIconKey("/icons/collapse-light.svg", DevEcoTheme::class.java)
private val CopyIconKey = PathIconKey("/icons/copy-light.svg", DevEcoTheme::class.java)
private val CheckmarkIconKey = PathIconKey("/icons/checkmark.svg", DevEcoTheme::class.java)

private const val DEFAULT_VISIBLE_LINES = 5
private const val EXPANDED_VISIBLE_LINES = 10
private const val CODE_BLOCK_PADDING_DP = 24f // Jewel fenced code block vertical padding (12dp top + 12dp bottom)

/**
 * CodeBlock UI wrapper - provides border and action buttons around Jewel-rendered code content
 */
@Composable
internal fun CodeBlockWrapper(
    code: String,
    isExpanded: Boolean,
    onExpandToggle: () -> Unit,
    needsExpand: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val clipboardManager = LocalClipboardManager.current
    var isCopied by remember { mutableStateOf(false) }
    var contentHeightPx by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current

    // Measure actual line height from rendered content, then calculate collapsed/expanded heights.
    // This avoids hardcoded line-height constants that don't match Jewel's actual rendering.
    val paddingDp = CODE_BLOCK_PADDING_DP.dp
    val contentHeightDp = with(density) { contentHeightPx.toDp() }
    val lineCount = code.lines().size
    val actualLineHeight = if (lineCount > 0 && contentHeightDp > paddingDp) {
        (contentHeightDp - paddingDp) / lineCount
    } else {
        19.5.dp // fallback default
    }
    val collapsedMaxHeight = actualLineHeight * DEFAULT_VISIBLE_LINES + paddingDp
    val expandedMaxHeight = actualLineHeight * EXPANDED_VISIBLE_LINES + paddingDp
    // When content not yet measured (0dp), fall back to expandedMaxHeight
    val collapsedHeight = if (contentHeightDp > 0.dp) minOf(contentHeightDp, collapsedMaxHeight) else collapsedMaxHeight
    val expandedHeight = if (contentHeightDp > 0.dp) minOf(contentHeightDp, expandedMaxHeight) else expandedMaxHeight
    val targetHeight = if (isExpanded) expandedHeight else collapsedHeight
    val boxHeight by animateDpAsState(
        targetValue = targetHeight,
        animationSpec = tween(durationMillis = 200),
        label = "codeBlockHeight",
    )

    Column(
        modifier = modifier.fillMaxWidth(),
    ) {
        val scrollState = rememberScrollState()
        LaunchedEffect(targetHeight) {
            scrollState.scrollTo(0)
        }

        // Use heightIn(max) so the Box shrinks to fit short content (measuring natural height),
        // but caps at boxHeight for tall content. This ensures accurate line-height measurement.
        val codeBlockModifier = Modifier.fillMaxWidth().heightIn(max = boxHeight)

        Box(
            modifier = codeBlockModifier,
        ) {
            // Code block content area with border and scrolling
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .border(3.dp, DevEcoTheme.codeBlockBorder, RoundedCornerShape(8.dp))
                    // Inset the scroll viewport inside the 3dp stroke: the border
                    // draws beneath the content, so without this inset scrolled code
                    // overlaps the semi-transparent stroke at the edges.
                    .padding(3.dp)
                    .verticalScroll(scrollState),
            ) {
                // Measure natural content height inside verticalScroll so it's not
                // affected by the outer Box's heightIn(max) constraint.
                Box(
                    modifier = Modifier.onGloballyPositioned { coordinates ->
                        contentHeightPx = coordinates.size.height
                    },
                ) {
                    content()
                }
            }

            // Scrollbar overlay aligned to the right edge
            // Use wrapContentHeight() so the scrollbar height matches the actual code content,
            // not the outer Box's maxHeight. This prevents the Box from being stretched to
            // maxHeight when code is short.
            VerticalScrollbar(
                adapter = rememberScrollbarAdapter(scrollState),
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .wrapContentHeight()
                    .padding(end = 4.dp),
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

        Row(
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (isCopied) {
                Text(
                    text = MyMessageBundle.message("codeblock.copied"),
                    color = DevEcoTheme.mutedGray,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(end = 8.dp),
                )
            }

            IconButton(
                onClick = {
                    clipboardManager.setText(AnnotatedString(code))
                    isCopied = true
                },
                tooltipText = MyMessageBundle.message("codeblock.copy"),
            ) {
                if (isCopied) {
                    Icon(
                        key = CheckmarkIconKey,
                        contentDescription = MyMessageBundle.message("codeblock.copied"),
                        tint = DevEcoTheme.green,
                        modifier = Modifier.size(16.dp),
                    )
                } else {
                    Icon(
                        key = CopyIconKey,
                        contentDescription = MyMessageBundle.message("codeblock.copy"),
                        modifier = Modifier.size(16.dp),
                    )
                }
            }

            if (needsExpand) {
                Spacer(Modifier.width(4.dp))

                val expandText = if (isExpanded)
                    MyMessageBundle.message("codeblock.collapse")
                else
                    MyMessageBundle.message("codeblock.expand")
                IconButton(
                    onClick = onExpandToggle,
                    tooltipText = expandText,
                ) {
                    Icon(
                        key = if (isExpanded) CollapseIconKey else ExpandIconKey,
                        contentDescription = expandText,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }
    }

    // Reset copy state after delay
    LaunchedEffect(isCopied) {
        if (isCopied) {
            delay(COPIED_INDICATOR_MS)
            isCopied = false
        }
    }
}

@Composable
private fun IconButton(
    onClick: () -> Unit,
    tooltipText: String,
    content: @Composable () -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val hovered by interactionSource.collectIsHoveredAsState()
    val bgColor = if (hovered) DevEcoTheme.popupBorder.copy(alpha = 0.2f) else Color.Transparent

    Box(
        modifier = Modifier
            .size(24.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(bgColor)
            .hoverable(interactionSource)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}
