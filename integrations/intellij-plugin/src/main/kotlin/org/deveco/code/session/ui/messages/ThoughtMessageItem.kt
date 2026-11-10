package org.deveco.code.session.ui.messages

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.model.ChatItem
import org.jetbrains.jewel.foundation.code.highlighting.NoOpCodeHighlighter
import org.jetbrains.jewel.intui.markdown.bridge.ProvideMarkdownStyling
import org.jetbrains.jewel.intui.markdown.bridge.styling.create as createStyling
import org.jetbrains.jewel.markdown.Markdown
import org.jetbrains.jewel.markdown.extensions.LocalMarkdownBlockRenderer
import org.jetbrains.jewel.markdown.rendering.InlinesStyling
import org.jetbrains.jewel.markdown.rendering.MarkdownStyling
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icon.PathIconKey
import org.jetbrains.jewel.ui.icons.AllIconsKeys

internal val DropdownIconKey = PathIconKey("/icons/dropdown.svg", DevEcoTheme::class.java)

internal val StopIconKey = PathIconKey("/icons/stop.svg", DevEcoTheme::class.java)

@Composable
@OptIn(ExperimentalComposeUiApi::class)
internal fun ThoughtItem(
    item: ChatItem,
    muted: Color,
    expandedThoughts: MutableMap<String, Boolean>,
    preserveScroll: ((() -> Unit) -> Unit),
    showHeader: Boolean = true,
    showTreeLine: Boolean = true,
) {
    val expanded = expandedThoughts[item.id] ?: false
    Column(Modifier.fillMaxWidth()) {
        if (showHeader) {
            // Header row
            Row(
                Modifier.fillMaxWidth().clickable {
                    preserveScroll { expandedThoughts[item.id] = !expanded }
                },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(14.dp), contentAlignment = Alignment.Center) {
                    Icon(
                        key = if (expanded) AllIconsKeys.General.ChevronDown else AllIconsKeys.General.ChevronRight,
                        contentDescription = if (expanded) "Collapse thinking" else "Expand thinking",
                        modifier = Modifier.size(12.dp),
                    )
                }
                Spacer(Modifier.width(6.dp))
                Text(
                    "Thinking",
                    color = DevEcoTheme.thoughtTextColor,
                    fontSize = DevEcoTheme.thoughtLabelSize.sp,
                )
            }
        }
        // Content - no indent here when showHeader is false (parent handles layout)
        if (expanded || !showHeader) {
            val contentModifier = Modifier
                .fillMaxWidth()
                .then(
                    if (showTreeLine) {
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
                )
            Box(contentModifier) {
                Box(Modifier.padding(start = DevEcoTheme.thoughtIndent.dp)) {
                    // Override markdown styling to match the "Thinking" title
                    val thoughtTextStyle = TextStyle(
                        color = DevEcoTheme.thoughtTextColor,
                        fontSize = DevEcoTheme.thoughtLabelSize.sp,
                    )
                    val thoughtInlinesStyling = InlinesStyling.createStyling(
                        textStyle = thoughtTextStyle,
                        inlineCode = SpanStyle(
                            color = DevEcoTheme.thoughtTextColor,
                            fontSize = DevEcoTheme.thoughtLabelSize.sp,
                        ),
                        link = SpanStyle(
                            color = DevEcoTheme.thoughtTextColor,
                            fontSize = DevEcoTheme.thoughtLabelSize.sp,
                        ),
                    )
                    val thoughtMarkdownStyling = MarkdownStyling.createStyling(
                        baseTextStyle = thoughtTextStyle,
                        inlinesStyling = thoughtInlinesStyling,
                    )
                    org.jetbrains.jewel.intui.markdown.bridge.ProvideMarkdownStyling(
                        codeHighlighter = NoOpCodeHighlighter,
                        markdownStyling = thoughtMarkdownStyling,
                    ) {
                        MarkdownWithCodeBlocks(
                            text = item.text,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }
    }
}
