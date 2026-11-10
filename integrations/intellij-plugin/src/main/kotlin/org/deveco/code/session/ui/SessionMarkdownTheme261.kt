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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.runtime.*
import androidx.compose.runtime.withFrameNanos
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.Canvas
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
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.colors.EditorColorsListener
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.SessionController
import org.deveco.code.session.model.ChatItem
import org.deveco.code.session.model.ChatRole
import org.deveco.code.session.model.MessageGroup
import org.deveco.code.session.model.PermissionChoice
import org.deveco.code.session.model.groupMessages
import org.deveco.code.session.model.isToolItemEmpty
import org.deveco.code.session.model.isToolChildEmpty
import org.deveco.code.session.ui.composer.SessionComposer
import org.deveco.code.session.ui.composer.TodoDock
import org.deveco.code.session.model.SessionViewState
import org.deveco.code.session.model.SessionViewportState
import org.jetbrains.jewel.bridge.theme.retrieveEditorTextStyle
import org.jetbrains.jewel.bridge.toComposeColor
import org.jetbrains.jewel.intui.markdown.bridge.ProvideMarkdownStyling
import org.jetbrains.jewel.intui.markdown.bridge.styling.create
import org.jetbrains.jewel.markdown.MarkdownBlock
import org.jetbrains.jewel.markdown.extensions.MarkdownRendererExtension
import org.jetbrains.jewel.markdown.extensions.github.tables.GfmTableColors
import org.jetbrains.jewel.markdown.extensions.github.tables.GfmTableMetrics
import org.jetbrains.jewel.markdown.extensions.github.tables.GfmTableStyling
import org.jetbrains.jewel.markdown.extensions.github.tables.GitHubTableProcessorExtension
import org.jetbrains.jewel.markdown.extensions.github.tables.GitHubTableRendererExtension
import org.jetbrains.jewel.markdown.extensions.github.tables.RowBackgroundStyle
import org.jetbrains.jewel.markdown.processing.MarkdownProcessor
import org.jetbrains.jewel.markdown.rendering.DefaultMarkdownBlockRenderer
import org.jetbrains.jewel.markdown.rendering.InlinesStyling
import org.jetbrains.jewel.markdown.rendering.MarkdownStyling
import org.jetbrains.jewel.markdown.rendering.MarkdownStyling.Code
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icons.AllIconsKeys

@Composable
internal fun SessionMarkdownTheme(project: Project, content: @Composable () -> Unit) {
    // Use JBColor to adapt text colors to both light and dark IDE themes.
    // JBColor(light, dark) — first arg is light-theme color, second is dark-theme color.
    // 6-digit hex (0xRRGGBB) is already opaque in java.awt.Color(int).
    val textColor = JBColor(0x1E1F22, 0xE1E4E8).toComposeColor()
    val accentColor = JBColor.namedColor("Link.activeForeground", 0x589DF6).toComposeColor()

    // Use IDE editor colors for code blocks to match the editor theme
    val codeBg = JBColor.namedColor("Editor.background", 0xFFFFFF).toComposeColor()
    val codeTextColor = JBColor.namedColor("Editor.foreground", 0x000000).toComposeColor()
    val codeBorder = JBColor.namedColor("Group.separatorColor", 0xD0D7DE).toComposeColor()
    val inlineCodeBg = JBColor.namedColor("TextField.background", 0xECEFF1).toComposeColor()

    val baseTextStyle = TextStyle(
        color = textColor,
        fontSize = 14.sp,
    )
    // Re-read the IDE editor font when the editor color scheme changes (font size/family
    // edits in Settings → Editor → Font, or scheme switches) so code blocks stay in sync.
    var editorSchemeTick by remember { mutableStateOf(0) }
    DisposableEffect(Unit) {
        val connection = ApplicationManager.getApplication().messageBus.connect()
        connection.subscribe(EditorColorsManager.TOPIC, EditorColorsListener { editorSchemeTick++ })
        onDispose { connection.disconnect() }
    }
    // Use the IDE editor font family/size/ligatures so code blocks match the editor exactly.
    val codeTextStyle = remember(editorSchemeTick) { retrieveEditorTextStyle() }.copy(color = codeTextColor)
    val inlinesStyling = InlinesStyling.create(
        textStyle = baseTextStyle,
        inlineCode = SpanStyle(
            color = accentColor,
            background = inlineCodeBg.copy(alpha = 0.15f),
            fontFamily = codeTextStyle.fontFamily,
        ),
        link = SpanStyle(
            color = accentColor,
        ),
    )
    // Custom heading styles with smaller font sizes for chat context
    val heading = MarkdownStyling.Heading(
        h1 = MarkdownStyling.Heading.H1(
            inlinesStyling = InlinesStyling.create(
                textStyle = baseTextStyle.copy(fontSize = 18.sp, fontWeight = FontWeight.Bold),
            ),
            underlineWidth = 0.dp,
            underlineColor = Color.Unspecified,
            underlineGap = 0.dp,
            padding = PaddingValues(top = 16.dp, bottom = 8.dp),
        ),
        h2 = MarkdownStyling.Heading.H2(
            inlinesStyling = InlinesStyling.create(
                textStyle = baseTextStyle.copy(fontSize = 16.sp, fontWeight = FontWeight.Bold),
            ),
            underlineWidth = 0.dp,
            underlineColor = Color.Unspecified,
            underlineGap = 0.dp,
            padding = PaddingValues(top = 12.dp, bottom = 6.dp),
        ),
        h3 = MarkdownStyling.Heading.H3(
            inlinesStyling = InlinesStyling.create(
                textStyle = baseTextStyle.copy(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            ),
            underlineWidth = 0.dp,
            underlineColor = Color.Unspecified,
            underlineGap = 0.dp,
            padding = PaddingValues(top = 10.dp, bottom = 4.dp),
        ),
        h4 = MarkdownStyling.Heading.H4(
            inlinesStyling = InlinesStyling.create(
                textStyle = baseTextStyle.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            ),
            underlineWidth = 0.dp,
            underlineColor = Color.Unspecified,
            underlineGap = 0.dp,
            padding = PaddingValues(top = 8.dp, bottom = 4.dp),
        ),
        h5 = MarkdownStyling.Heading.H5(
            inlinesStyling = InlinesStyling.create(
                textStyle = baseTextStyle.copy(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
            ),
            underlineWidth = 0.dp,
            underlineColor = Color.Unspecified,
            underlineGap = 0.dp,
            padding = PaddingValues(top = 8.dp, bottom = 4.dp),
        ),
        h6 = MarkdownStyling.Heading.H6(
            inlinesStyling = InlinesStyling.create(
                textStyle = baseTextStyle.copy(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
            ),
            underlineWidth = 0.dp,
            underlineColor = Color.Unspecified,
            underlineGap = 0.dp,
            padding = PaddingValues(top = 8.dp, bottom = 4.dp),
        ),
    )
    val markdownStyling = MarkdownStyling.create(
        baseTextStyle = baseTextStyle,
        inlinesStyling = inlinesStyling,
        heading = heading,
        blockQuote = MarkdownStyling.BlockQuote.create(
            lineColor = accentColor.copy(alpha = 0.75f),
            textColor = textColor.copy(alpha = 0.92f),
        ),
        code = Code.create(
            editorTextStyle = codeTextStyle,
            fenced = Code.Fenced.create(
                textStyle = codeTextStyle,
                padding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                shape = RoundedCornerShape(8.dp),
                borderColor = Color.Transparent,
            ),
            indented = Code.Indented.create(
                textStyle = codeTextStyle,
                padding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                shape = RoundedCornerShape(8.dp),
                borderColor = Color.Transparent,
            ),
        ),
    )
    // Table styling with theme-adaptive colors.
    val tableBorderColor = JBColor(0xD0D7DE, 0x3C3C3C).toComposeColor()
    val tableRowBg = JBColor(0xF6F8FA, 0x2D2D2D).toComposeColor()
    val tableAltRowBg = JBColor(0xFFFFFF, 0x252525).toComposeColor()
    val tableStyling = GfmTableStyling(
        colors = GfmTableColors(
            borderColor = tableBorderColor,
            rowBackgroundColor = tableRowBg,
            alternateRowBackgroundColor = tableAltRowBg,
            rowBackgroundStyle = RowBackgroundStyle.Striped,
        ),
        metrics = GfmTableMetrics(
            borderWidth = 1.dp,
            cellPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            defaultCellContentAlignment = Alignment.Start,
            headerDefaultCellContentAlignment = Alignment.Start,
        ),
        headerBaseFontWeight = FontWeight.SemiBold,
    )
    val blockRenderer = SafeOrderedListMarkdownBlockRenderer(
        styling = markdownStyling,
        rendererExtensions = listOf(
            GitHubTableRendererExtension(tableStyling, markdownStyling),
        ),
    )
    val processor = MarkdownProcessor(
        extensions = listOf(GitHubTableProcessorExtension),
    )
    val selectionColors = remember {
        val bg = JBColor(0x3574F0, 0x2F5FB0).toComposeColor().copy(alpha = 0.85f)
        TextSelectionColors(handleColor = bg, backgroundColor = bg)
    }
    CompositionLocalProvider(LocalTextSelectionColors provides selectionColors) {
        ProvideMarkdownStyling(
            project = project,
            markdownStyling = markdownStyling,
            markdownProcessor = processor,
            markdownBlockRenderer = blockRenderer,
        ) {
            content()
        }
    }
}

// Jewel's Decimal.formatNumber throws "Input must be a positive integer" for an
// ordered list whose start number is not positive (model output such as "0. first",
// including "> 0. first" inside block quotes), crashing composition. Clamping at the
// renderer boundary covers every nesting level, because BlockQuote and list recursion
// virtually dispatch RenderOrderedList on this same renderer instance.
private class SafeOrderedListMarkdownBlockRenderer(
    styling: MarkdownStyling,
    rendererExtensions: List<MarkdownRendererExtension>,
) : DefaultMarkdownBlockRenderer(styling, rendererExtensions) {
    @Composable
    override fun RenderOrderedList(
        block: MarkdownBlock.ListBlock.OrderedList,
        styling: MarkdownStyling.List.Ordered,
        isInTightList: Boolean,
        onUrlClick: (String) -> Unit,
        modifier: Modifier,
    ) {
        super.RenderOrderedList(
            clampedOrderedListStart(block),
            styling,
            isInTightList,
            onUrlClick,
            modifier,
        )
    }
}

internal fun clampedOrderedListStart(block: MarkdownBlock.ListBlock.OrderedList) =
    if (block.startFrom > 0) {
        block
    } else {
        MarkdownBlock.ListBlock.OrderedList(
            children = block.children,
            isTight = block.isTight,
            startFrom = 1,
            delimiter = block.delimiter,
        )
    }
