package org.deveco.code.session.ui

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
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
import org.deveco.code.DevEcoTheme
import org.jetbrains.jewel.bridge.theme.retrieveEditorTextStyle
import org.jetbrains.jewel.bridge.toComposeColor
import org.jetbrains.jewel.foundation.theme.JewelTheme
import org.jetbrains.jewel.intui.markdown.bridge.create as createBlockRenderer
import org.jetbrains.jewel.intui.markdown.bridge.ProvideMarkdownStyling
import org.jetbrains.jewel.intui.markdown.bridge.styling.create
import org.jetbrains.jewel.markdown.rendering.InlinesStyling
import org.jetbrains.jewel.markdown.rendering.MarkdownBlockRenderer
import org.jetbrains.jewel.markdown.rendering.MarkdownStyling
import org.jetbrains.jewel.markdown.rendering.MarkdownStyling.Code

// Mirrors SessionMarkdownTheme261 so both platforms render chat markdown with the
// same typography. Jewel 0.27.0 (the 243 line) lacks the GFM tables extension —
// no maven artifact exists — so tables keep the default processor/renderer there.
@Composable
internal fun SessionMarkdownTheme(project: Project, content: @Composable () -> Unit) {
    // Use JBColor to adapt text colors to both light and dark IDE themes.
    // JBColor(light, dark) — first arg is light-theme color, second is dark-theme color.
    // 6-digit hex (0xRRGGBB) is already opaque in java.awt.Color(int).
    val textColor = JBColor(0x1E1F22, 0xE1E4E8).toComposeColor()
    val accentColor = JBColor.namedColor("Link.activeForeground", 0x589DF6).toComposeColor()

    // Use IDE editor colors for code blocks to match the editor theme
    val codeTextColor = JBColor.namedColor("Editor.foreground", 0x000000).toComposeColor()

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
    // Jewel 0.27.0 exposes no inline rendering hooks, so the 243 line approximates
    // the 261 chip look with flat SpanStyle backgrounds: a neutral fill for inline
    // code (the 1px outline is not expressible) and a filled chip for links.
    val inlineCodeSpan = SpanStyle(
        color = textColor,
        background = DevEcoTheme.lightOverlay,
        fontFamily = codeTextStyle.fontFamily,
    )
    val linkSpan = SpanStyle(
        color = accentColor,
        background = DevEcoTheme.linkChipBg,
    )
    val inlinesStyling = InlinesStyling.create(
        textStyle = baseTextStyle,
        inlineCode = inlineCodeSpan,
        link = linkSpan,
    )
    // Custom heading styles with smaller font sizes for chat context. Headings get
    // the same inline code/link spans so chips stay consistent inside them.
    val heading = MarkdownStyling.Heading(
        h1 = MarkdownStyling.Heading.H1(
            inlinesStyling = InlinesStyling.create(
                textStyle = baseTextStyle.copy(fontSize = 18.sp, fontWeight = FontWeight.Bold),
                inlineCode = inlineCodeSpan,
                link = linkSpan,
            ),
            underlineWidth = 0.dp,
            underlineColor = Color.Unspecified,
            underlineGap = 0.dp,
            padding = PaddingValues(top = 16.dp, bottom = 8.dp),
        ),
        h2 = MarkdownStyling.Heading.H2(
            inlinesStyling = InlinesStyling.create(
                textStyle = baseTextStyle.copy(fontSize = 16.sp, fontWeight = FontWeight.Bold),
                inlineCode = inlineCodeSpan,
                link = linkSpan,
            ),
            underlineWidth = 0.dp,
            underlineColor = Color.Unspecified,
            underlineGap = 0.dp,
            padding = PaddingValues(top = 12.dp, bottom = 6.dp),
        ),
        h3 = MarkdownStyling.Heading.H3(
            inlinesStyling = InlinesStyling.create(
                textStyle = baseTextStyle.copy(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                inlineCode = inlineCodeSpan,
                link = linkSpan,
            ),
            underlineWidth = 0.dp,
            underlineColor = Color.Unspecified,
            underlineGap = 0.dp,
            padding = PaddingValues(top = 10.dp, bottom = 4.dp),
        ),
        h4 = MarkdownStyling.Heading.H4(
            inlinesStyling = InlinesStyling.create(
                textStyle = baseTextStyle.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                inlineCode = inlineCodeSpan,
                link = linkSpan,
            ),
            underlineWidth = 0.dp,
            underlineColor = Color.Unspecified,
            underlineGap = 0.dp,
            padding = PaddingValues(top = 8.dp, bottom = 4.dp),
        ),
        h5 = MarkdownStyling.Heading.H5(
            inlinesStyling = InlinesStyling.create(
                textStyle = baseTextStyle.copy(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                inlineCode = inlineCodeSpan,
                link = linkSpan,
            ),
            underlineWidth = 0.dp,
            underlineColor = Color.Unspecified,
            underlineGap = 0.dp,
            padding = PaddingValues(top = 8.dp, bottom = 4.dp),
        ),
        h6 = MarkdownStyling.Heading.H6(
            inlinesStyling = InlinesStyling.create(
                textStyle = baseTextStyle.copy(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                inlineCode = inlineCodeSpan,
                link = linkSpan,
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
        // 0.27.0's Code.create names its first parameter differently from the
        // bundled 261 Jewel, so pass it positionally.
        code = Code.create(
            codeTextStyle,
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
    val blockRenderer = MarkdownBlockRenderer.createBlockRenderer(styling = markdownStyling)
    // Resolve the selection color from the Compose theme state, not JBColor: a
    // remembered JBColor snapshot freezes whichever LaF branch was active at
    // first composition and shipped the light blue into dark mode.
    val isLightTheme = !JewelTheme.isDark
    val selectionColors = remember(isLightTheme) {
        val bg = if (isLightTheme) Color(0xFFA6D2FF) else Color(0xFF2F5FB0).copy(alpha = 0.85f)
        TextSelectionColors(handleColor = bg, backgroundColor = bg)
    }
    CompositionLocalProvider(LocalTextSelectionColors provides selectionColors) {
        ProvideMarkdownStyling(
            project = project,
            markdownStyling = markdownStyling,
            markdownBlockRenderer = blockRenderer,
        ) {
            content()
        }
    }
}
