package org.deveco.code.session.ui

import androidx.compose.runtime.State
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.max
import kotlin.math.min
import org.deveco.code.DevEcoTheme
import org.jetbrains.jewel.markdown.InlineMarkdown
import org.jetbrains.jewel.markdown.extensions.MarkdownRendererExtension
import org.jetbrains.jewel.markdown.rendering.DefaultInlineMarkdownRenderer
import org.jetbrains.jewel.markdown.rendering.InlinesStyling

// Tags inline code and link ranges in the paragraph AnnotatedString so the block
// renderer can draw chips behind them from the laid-out text geometry.
internal const val CHIP_ANNOTATION_TAG = "devecoChip"
internal const val CHIP_KIND_CODE = "code"
internal const val CHIP_KIND_LINK = "link"

internal class ChipInlineMarkdownRenderer(
    rendererExtensions: List<MarkdownRendererExtension>,
    private val chipCodeSpan: SpanStyle,
) : DefaultInlineMarkdownRenderer(rendererExtensions) {
    // Kotlin cannot call a superclass member extension (the per-node render hooks),
    // so tag ranges here instead: every top-level node is rendered by super on its
    // own and code/link results get wrapped in a chip annotation.
    override fun renderAsAnnotatedString(
        inlineMarkdown: Iterable<InlineMarkdown>,
        styling: InlinesStyling,
        enabled: Boolean,
        onUrlClicked: ((String) -> Unit)?,
    ): AnnotatedString {
        // Headings and the thought area reuse this renderer but draw no chips, so
        // tagging them would insert gap spaces with no outline to show for it.
        // Only the styling carrying the chip code span instance gets chips.
        if (styling.inlineCode !== chipCodeSpan) {
            return super.renderAsAnnotatedString(inlineMarkdown, styling, enabled, onUrlClicked)
        }
        return renderTagged(inlineMarkdown.toList(), styling, enabled, onUrlClicked)
    }

    private fun renderTagged(
        inlines: List<InlineMarkdown>,
        styling: InlinesStyling,
        enabled: Boolean,
        onUrlClicked: ((String) -> Unit)?,
    ): AnnotatedString = buildAnnotatedString {
        val kinds = inlines.map(::chipKind)
        val parts = inlines.map { inline ->
            when (inline) {
                // Emphasis wrappers are re-rendered here so code/links nested in
                // bold/italic still get their chips; code inside a link stays
                // inside the link chip on purpose (no nested outlines).
                is InlineMarkdown.StrongEmphasis -> buildAnnotatedString {
                    pushStyle(styling.strongEmphasis)
                    append(renderTagged(inline.inlineContent, styling, enabled, onUrlClicked))
                    pop()
                }
                is InlineMarkdown.Emphasis -> buildAnnotatedString {
                    pushStyle(styling.emphasis)
                    append(renderTagged(inline.inlineContent, styling, enabled, onUrlClicked))
                    pop()
                }
                else -> {
                    val kind = chipKind(inline)
                        ?: return@map super.renderAsAnnotatedString(listOf(inline), styling, enabled, onUrlClicked)
                    buildAnnotatedString {
                        pushStringAnnotation(CHIP_ANNOTATION_TAG, kind)
                        append(super.renderAsAnnotatedString(listOf(inline), styling, enabled, onUrlClicked))
                        pop()
                    }
                }
            }
        }
        // Chips need ~8dp of room per side (4dp inner padding + 4dp outer gap). A
        // plain inter-word space only carries ~4dp and the inner padding would eat
        // it, leaving the border glued to the previous word, so an existing space
        // next to a chip is replaced by the widened gap space instead of kept.
        // Line breaks are structural: never trim or replace them.
        val trimmed = parts.toMutableList()
        val gaps = BooleanArray(parts.size)
        for (index in 0 until parts.lastIndex) {
            val leftIsChip = kinds[index] != null
            val rightIsChip = kinds[index + 1] != null
            if (!leftIsChip && !rightIsChip) continue
            if (rightIsChip) {
                when (val neighbour = parts[index].text.lastOrNull()) {
                    null, '\n' -> Unit
                    in LEFT_HUG_NEIGHBOURS -> Unit
                    ' ', '\t' -> {
                        trimmed[index] = trimmed[index].trimTrailingSpaces()
                        gaps[index] = true
                    }
                    else -> gaps[index] = true
                }
            } else {
                when (val neighbour = parts[index + 1].text.firstOrNull()) {
                    null, '\n' -> Unit
                    in RIGHT_HUG_NEIGHBOURS -> Unit
                    ' ', '\t' -> {
                        trimmed[index + 1] = trimmed[index + 1].trimLeadingSpaces()
                        gaps[index] = true
                    }
                    else -> gaps[index] = true
                }
            }
        }
        for (index in trimmed.indices) {
            append(trimmed[index])
            if (index < trimmed.lastIndex && gaps[index]) {
                pushStyle(CHIP_GAP_STYLE)
                append(CHIP_GAP_TEXT)
                pop()
            }
        }
    }
}

// A widened space: its advance (~8dp at 14sp) holds the chip's 4dp inner padding
// plus a 4dp gap to the neighbouring text on each side.
private const val CHIP_GAP_TEXT = " "
private val CHIP_GAP_STYLE = SpanStyle(letterSpacing = 4.sp)

// Openers and punctuation (ASCII + full-width) that must stay glued to what
// follows them.
private const val LEFT_HUG_NEIGHBOURS = "([{\"'（《「『【、。，,；;：:！!？?…"
// Closers and punctuation (ASCII + full-width) that must stay glued to what
// precedes them.
private const val RIGHT_HUG_NEIGHBOURS = ")]}\"'）》」』】、。，,；;：:！!？?…%"

private fun AnnotatedString.trimTrailingSpaces(): AnnotatedString {
    val keep = text.length - text.takeLastWhile { it == ' ' || it == '\t' }.length
    return if (keep == text.length) this else subSequence(0, keep)
}

private fun AnnotatedString.trimLeadingSpaces(): AnnotatedString {
    val drop = text.takeWhile { it == ' ' || it == '\t' }.length
    return if (drop == 0) this else subSequence(drop, text.length)
}

private fun chipKind(inline: InlineMarkdown) = when (inline) {
    is InlineMarkdown.Code -> CHIP_KIND_CODE
    is InlineMarkdown.Link -> CHIP_KIND_LINK
    else -> null
}

// Draws a rounded chip behind every tagged span: an outlined one for inline code,
// a filled one for links. SpanStyle backgrounds wrap per line but can only paint
// square fills, so the border/radius come from drawing each wrapped line fragment's
// bounding box, inflated by the chip padding, behind the paragraph text.
internal fun Modifier.drawInlineChips(paragraphLayout: State<TextLayoutResult?>): Modifier = drawBehind {
    val layout = paragraphLayout.value ?: return@drawBehind
    val text = layout.layoutInput.text
    val chips = text.getStringAnnotations(CHIP_ANNOTATION_TAG, 0, text.length)
    if (chips.isEmpty()) return@drawBehind
    val horizontalPadding = 4.dp.toPx()
    val verticalPadding = 1.dp.toPx()
    val minOuterGap = 0.5.dp.toPx()
    val cornerRadius = CornerRadius(4.dp.toPx(), 4.dp.toPx())
    val borderWidth = 1.dp.toPx()
    for (chip in chips) {
        val start = chip.start.coerceIn(0, text.length)
        val end = chip.end.coerceIn(0, text.length)
        if (start >= end) continue
        val firstLine = layout.getLineForOffset(start)
        val lastLine = layout.getLineForOffset(end - 1)
        for (line in firstLine..lastLine) {
            val fragmentStart = start.coerceAtLeast(layout.getLineStart(line))
            val fragmentEnd = end.coerceAtMost(layout.getLineEnd(line))
            if (fragmentStart >= fragmentEnd) continue
            // This Compose build only exposes single-offset bounding boxes, so the
            // fragment rect spans from the first to the last character box on the line.
            val firstBox = layout.getBoundingBox(fragmentStart)
            val lastBox = layout.getBoundingBox(fragmentEnd - 1)
            // 4dp of inner padding when the surrounding text leaves room; in dense
            // CJK prose the gap around a code span is smaller than that, so shrink
            // the rect towards the code glyphs instead of drawing the border
            // across the neighbours.
            val chipRect = Rect(
                left = chipLeft(layout, text, line, fragmentStart, firstBox.left - horizontalPadding, minOuterGap),
                top = firstBox.top - verticalPadding,
                right = chipRight(layout, text, line, fragmentEnd, lastBox.right + horizontalPadding, minOuterGap),
                bottom = lastBox.bottom + verticalPadding,
            )
            val topLeft = Offset(chipRect.left, chipRect.top)
            val size = Size(chipRect.width, chipRect.height)
            if (chip.item == CHIP_KIND_CODE) {
                drawRoundRect(
                    color = DevEcoTheme.inlineCodeBorder,
                    topLeft = topLeft,
                    size = size,
                    cornerRadius = cornerRadius,
                    style = Stroke(width = borderWidth),
                )
            } else {
                drawRoundRect(
                    color = DevEcoTheme.linkChipBg,
                    topLeft = topLeft,
                    size = size,
                    cornerRadius = cornerRadius,
                )
            }
        }
    }
}

private fun chipLeft(
    layout: TextLayoutResult,
    text: AnnotatedString,
    line: Int,
    fragmentStart: Int,
    desiredLeft: Float,
    minOuterGap: Float,
): Float {
    val neighbour = previousInkOffset(layout, text, line, fragmentStart) ?: return desiredLeft
    val limit = layout.getBoundingBox(neighbour).right + minOuterGap
    return max(desiredLeft, limit).coerceAtMost(layout.getBoundingBox(fragmentStart).left)
}

private fun chipRight(
    layout: TextLayoutResult,
    text: AnnotatedString,
    line: Int,
    fragmentEnd: Int,
    desiredRight: Float,
    minOuterGap: Float,
): Float {
    val neighbour = nextInkOffset(layout, text, line, fragmentEnd) ?: return desiredRight
    val limit = layout.getBoundingBox(neighbour).left - minOuterGap
    return min(desiredRight, limit).coerceAtLeast(layout.getBoundingBox(fragmentEnd - 1).right)
}

private fun previousInkOffset(layout: TextLayoutResult, text: AnnotatedString, line: Int, from: Int): Int? {
    var index = from - 1
    while (index >= 0 && layout.getLineForOffset(index) == line && text[index].isWhitespace()) index--
    if (index < 0 || layout.getLineForOffset(index) != line) return null
    return index
}

private fun nextInkOffset(layout: TextLayoutResult, text: AnnotatedString, line: Int, from: Int): Int? {
    var index = from
    while (index < text.length && layout.getLineForOffset(index) == line && text[index].isWhitespace()) index++
    if (index >= text.length || layout.getLineForOffset(index) != line) return null
    return index
}
