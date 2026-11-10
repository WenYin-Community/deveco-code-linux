package org.deveco.code.session.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import org.jetbrains.jewel.markdown.InlineMarkdown
import org.jetbrains.jewel.markdown.rendering.InlinesStyling
import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownChipRendererTest {

    // Built positionally: the intui bridge create() factories read JewelTheme,
    // which is unavailable outside a composition.
    private val styling = InlinesStyling(
        TextStyle.Default,
        SpanStyle(),
        SpanStyle(),
        SpanStyle(),
        SpanStyle(),
        SpanStyle(),
        SpanStyle(),
        SpanStyle(),
        SpanStyle(),
        SpanStyle(),
        SpanStyle(),
    )
    private val renderer = ChipInlineMarkdownRenderer(emptyList(), styling.inlineCode)

    @Test
    fun `code and link spans are tagged with chip annotations`() {
        val rendered = renderer.renderAsAnnotatedString(
            listOf(
                InlineMarkdown.Text("a "),
                InlineMarkdown.Code("foo"),
                InlineMarkdown.Text(" b "),
                InlineMarkdown.Link("https://example.com", null, listOf(InlineMarkdown.Text("link"))),
            ),
            styling,
            false,
        ) { }
        assertEquals("a foo b link", rendered.text)
        val chips = rendered.getStringAnnotations(CHIP_ANNOTATION_TAG, 0, rendered.text.length)
        assertEquals(2, chips.size)
        assertEquals(CHIP_KIND_CODE, chips[0].item)
        assertEquals("foo", rendered.text.substring(chips[0].start, chips[0].end))
        assertEquals(CHIP_KIND_LINK, chips[1].item)
        assertEquals("link", rendered.text.substring(chips[1].start, chips[1].end))
    }

    @Test
    fun `plain and emphasized text carry no chip annotation`() {
        val rendered = renderer.renderAsAnnotatedString(
            listOf(
                InlineMarkdown.Text("plain "),
                InlineMarkdown.Emphasis("*", listOf(InlineMarkdown.Text("em"))),
                InlineMarkdown.Text(" "),
                InlineMarkdown.StrongEmphasis("**", listOf(InlineMarkdown.Text("strong"))),
            ),
            styling,
            false,
        ) { }
        assertEquals("plain em strong", rendered.text)
        assertEquals(0, rendered.getStringAnnotations(CHIP_ANNOTATION_TAG, 0, rendered.text.length).size)
    }

    @Test
    fun `code nested in a link is tagged as a link chip`() {
        val rendered = renderer.renderAsAnnotatedString(
            listOf(
                InlineMarkdown.Link("https://example.com", null, listOf(InlineMarkdown.Code("bar"))),
            ),
            styling,
            false,
        ) { }
        assertEquals("bar", rendered.text)
        val chips = rendered.getStringAnnotations(CHIP_ANNOTATION_TAG, 0, rendered.text.length)
        assertEquals(1, chips.size)
        assertEquals(CHIP_KIND_LINK, chips[0].item)
    }

    @Test
    fun `chip next to CJK text gets gap spaces and existing spaces are replaced`() {
        val rendered = renderer.renderAsAnnotatedString(
            listOf(
                InlineMarkdown.Text("仅"),
                InlineMarkdown.Code("Index.ets"),
                InlineMarkdown.Text("使用 "),
                InlineMarkdown.Code("next"),
            ),
            styling,
            false,
        ) { }
        assertEquals("仅 Index.ets 使用 next", rendered.text)
        val chips = rendered.getStringAnnotations(CHIP_ANNOTATION_TAG, 0, rendered.text.length)
        assertEquals(2, chips.size)
        assertEquals("Index.ets", rendered.text.substring(chips[0].start, chips[0].end))
        assertEquals("next", rendered.text.substring(chips[1].start, chips[1].end))
    }

    @Test
    fun `hugging punctuation gets no gap space`() {
        val rendered = renderer.renderAsAnnotatedString(
            listOf(
                InlineMarkdown.Text("with ("),
                InlineMarkdown.Code("Agent"),
                InlineMarkdown.Text(", in parallel)"),
            ),
            styling,
            false,
        ) { }
        assertEquals("with (Agent, in parallel)", rendered.text)
    }

    @Test
    fun `space separated chip keeps a single space in the copied text`() {
        val rendered = renderer.renderAsAnnotatedString(
            listOf(
                InlineMarkdown.Text("Treated "),
                InlineMarkdown.Code("is.message"),
                InlineMarkdown.Text(" as a typo"),
            ),
            styling,
            false,
        ) { }
        assertEquals("Treated is.message as a typo", rendered.text)
        val chips = rendered.getStringAnnotations(CHIP_ANNOTATION_TAG, 0, rendered.text.length)
        assertEquals(1, chips.size)
        assertEquals("is.message", rendered.text.substring(chips[0].start, chips[0].end))
    }

    @Test
    fun `hard line break next to a chip is preserved`() {
        val rendered = renderer.renderAsAnnotatedString(
            listOf(
                InlineMarkdown.Text("before"),
                InlineMarkdown.HardLineBreak,
                InlineMarkdown.Code("after"),
            ),
            styling,
            false,
        ) { }
        assertEquals("before\nafter", rendered.text)
        val chips = rendered.getStringAnnotations(CHIP_ANNOTATION_TAG, 0, rendered.text.length)
        assertEquals(1, chips.size)
        assertEquals("after", rendered.text.substring(chips[0].start, chips[0].end))
    }

    @Test
    fun `full-width punctuation hugs the chip`() {
        val rendered = renderer.renderAsAnnotatedString(
            listOf(
                InlineMarkdown.Text("调用（"),
                InlineMarkdown.Code("Agent"),
                InlineMarkdown.Text("），继续"),
            ),
            styling,
            false,
        ) { }
        assertEquals("调用（Agent），继续", rendered.text)
    }

    @Test
    fun `code inside strong emphasis gets a chip`() {
        val rendered = renderer.renderAsAnnotatedString(
            listOf(
                InlineMarkdown.StrongEmphasis("**", listOf(InlineMarkdown.Code("Agent"))),
            ),
            styling,
            false,
        ) { }
        assertEquals("Agent", rendered.text)
        val chips = rendered.getStringAnnotations(CHIP_ANNOTATION_TAG, 0, rendered.text.length)
        assertEquals(1, chips.size)
        assertEquals(CHIP_KIND_CODE, chips[0].item)
    }

    @Test
    fun `stylings without the chip code span render plain`() {
        val plain = InlinesStyling(
            TextStyle.Default,
            SpanStyle(color = Color.Red),
            SpanStyle(),
            SpanStyle(),
            SpanStyle(),
            SpanStyle(),
            SpanStyle(),
            SpanStyle(),
            SpanStyle(),
            SpanStyle(),
            SpanStyle(),
        )
        val rendered = renderer.renderAsAnnotatedString(
            listOf(InlineMarkdown.Text("a "), InlineMarkdown.Code("x")),
            plain,
            false,
        ) { }
        assertEquals("a x", rendered.text)
        assertEquals(0, rendered.getStringAnnotations(CHIP_ANNOTATION_TAG, 0, rendered.text.length).size)
    }
}
