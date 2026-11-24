package org.deveco.code.announcement

import com.intellij.openapi.util.text.StringUtil
import org.intellij.markdown.flavours.commonmark.CommonMarkFlavourDescriptor
import org.intellij.markdown.html.HtmlGenerator
import org.intellij.markdown.parser.MarkdownParser
import java.io.StringReader
import java.net.URI
import javax.swing.text.MutableAttributeSet
import javax.swing.text.html.HTML.Attribute
import javax.swing.text.html.HTML.Tag
import javax.swing.text.html.HTMLEditorKit
import javax.swing.text.html.parser.ParserDelegator

private val announcementTags = setOf(
    Tag.H1, Tag.H2, Tag.H3, Tag.H4, Tag.H5, Tag.H6,
    Tag.P, Tag.BR, Tag.B, Tag.STRONG, Tag.I, Tag.EM, Tag.U, Tag.CODE, Tag.PRE, Tag.BLOCKQUOTE, Tag.OL, Tag.UL, Tag.LI,
    Tag.DIV, Tag.TABLE, Tag.CAPTION, Tag.TR, Tag.TH, Tag.TD,
)
private val announcementMarkup = Regex(
    (announcementTags.map(Tag::toString) + listOf("a", "span", "font", "thead", "tbody", "tfoot"))
        .joinToString("|", prefix = "</?(?:", postfix = ")(?=[\\s/>])"),
    RegexOption.IGNORE_CASE,
)
private val markdownStyles = Regex("<(?:h[1-6]|strong|em|pre|code|blockquote|[ou]l|a)(?=[\\s>])")

internal fun announcementLink(href: String?): URI? {
    if (href == null) return null
    return runCatching { URI(href) }.getOrNull()?.takeIf {
        (it.scheme.equals("http", ignoreCase = true) || it.scheme.equals("https", ignoreCase = true)) &&
            it.host != null && it.rawUserInfo == null
    }
}

internal fun announcementBalloonHtml(content: String): String {
    val flavour = CommonMarkFlavourDescriptor()
    val tree = MarkdownParser(flavour).buildMarkdownTreeFromString(content)
    val html = HtmlGenerator(content, tree, flavour).generateHtml()
    if (!announcementMarkup.containsMatchIn(content) && !markdownStyles.containsMatchIn(html)) {
        return StringUtil.escapeXmlEntities(content)
            .replace("\r\n", "\n").replace('\r', '\n').replace("\n", "<br>")
    }
    return buildString {
        // Rebuild the fragment from text and supported tags. Announcement attributes and resources are untrusted.
        ParserDelegator().parse(
            StringReader(html),
            object : HTMLEditorKit.ParserCallback() {
                private var linkOpen = false

                override fun handleText(data: CharArray, pos: Int) {
                    append(StringUtil.escapeXmlEntities(String(data)))
                }

                override fun handleStartTag(tag: Tag, attributes: MutableAttributeSet, pos: Int) {
                    if (tag == Tag.A) {
                        val href = announcementLink(attributes.getAttribute(Attribute.HREF) as? String)
                        linkOpen = href != null
                        if (href != null) append("<a href=\"${StringUtil.escapeXmlEntities(href.toASCIIString())}\">")
                        return
                    }
                    if (tag in announcementTags) append("<$tag>")
                }

                override fun handleEndTag(tag: Tag, pos: Int) {
                    if (tag == Tag.A && linkOpen) {
                        append("</a>")
                        linkOpen = false
                    }
                    if (tag in announcementTags) append("</$tag>")
                }

                override fun handleSimpleTag(tag: Tag, attributes: MutableAttributeSet, pos: Int) {
                    if (tag == Tag.BR) append("<br>")
                }
            },
            true,
        )
    }
}
