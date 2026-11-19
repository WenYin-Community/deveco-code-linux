import { TextAttributes, type RGBA } from "@opentui/core"
import { Parser } from "htmlparser2"
import { Marked } from "marked"

const headings = ["h1", "h2", "h3", "h4", "h5", "h6"] as const
const attributes = new Map([
  ...headings.map((tag) => [tag, TextAttributes.BOLD] as const),
  ["b", TextAttributes.BOLD],
  ["strong", TextAttributes.BOLD],
  ["i", TextAttributes.ITALIC],
  ["em", TextAttributes.ITALIC],
  ["u", TextAttributes.UNDERLINE],
])
const blocks = new Map([
  ...headings.map((tag) => [tag, 2] as const),
  ["p", 2],
  ["pre", 2],
  ["blockquote", 2],
  ["ol", 1],
  ["ul", 1],
  ["li", 1],
  ["div", 1],
  ["table", 2],
  ["caption", 1],
  ["tr", 1],
])
const extraMarkupTags = ["code", "br", "a", "span", "font", "td", "th", "thead", "tbody", "tfoot"]
const markup = new RegExp(
  `</?(?:${[...attributes.keys(), ...blocks.keys(), ...extraMarkupTags].join("|")})(?=[\\s/>])`,
  "i",
)
const hidden = new Set(["script", "style", "noscript", "template", "head", "iframe", "object", "embed", "svg", "math"])
const markdown = new Marked({ gfm: false })
const markdownStyles = /<(?:h[1-6]|strong|em|pre|code|blockquote|[ou]l|a)(?=[\s>])/

type AnnouncementText = { text: string; attributes?: number; fg?: RGBA; href?: string }

function announcementHref(href: string | undefined) {
  if (!href || !/^https?:\/\/[^/]/i.test(href) || /[\\\s\x00-\x1f\x7f-\x9f]/.test(href)) return
  const url = URL.parse(href)
  if (url && !url.username && !url.password) return url.href
}

export function announcementBody(content: string, codeColor: RGBA): AnnouncementText[] {
  const html = markdown.parse(content, { async: false })
  if (!markup.test(content) && !markdownStyles.test(html)) return [{ text: content }]

  const chunks: AnnouncementText[] = []
  const styles: { attributes: number; code: boolean; pre: boolean; href?: string }[] = [
    { attributes: TextAttributes.NONE, code: false, pre: false },
  ]
  const lists: { ordered: boolean; next: number }[] = []
  const tableRows: { cells: number }[] = []
  let hiddenDepth = 0
  let quoteDepth = 0
  let breaks = 0
  let space = false
  let listMarker = ""

  function separate(lines: number) {
    if (!lines) return
    breaks = Math.max(breaks, lines)
    space = false
  }

  function append(text: string) {
    if (!text) return
    const style = styles[styles.length - 1]
    if (breaks && chunks.length) chunks.push({ text: "\n".repeat(breaks) })
    if (breaks || !chunks.length) {
      if (quoteDepth) chunks.push({ text: "│ ".repeat(quoteDepth) })
    } else if (space) {
      chunks.push(
        style.href && chunks.at(-1)?.href === style.href
          ? { text: " ", attributes: TextAttributes.UNDERLINE, href: style.href }
          : { text: " " },
      )
    }
    if (listMarker) chunks.push({ text: listMarker })
    listMarker = ""
    breaks = 0
    space = false
    chunks.push({ text, attributes: style.attributes, fg: style.code ? codeColor : undefined, href: style.href })
  }

  new Parser({
    onopentag(tag, attrs) {
      if (hiddenDepth || hidden.has(tag)) {
        hiddenDepth++
        return
      }
      const parent = styles[styles.length - 1]
      const href = tag === "a" ? announcementHref(attrs.href) : parent.href
      styles.push({
        attributes:
          parent.attributes | (attributes.get(tag) ?? TextAttributes.NONE) | (href ? TextAttributes.UNDERLINE : 0),
        code: parent.code || tag === "code" || tag === "pre",
        pre: parent.pre || tag === "pre",
        href,
      })
      separate(blocks.get(tag) ?? 0)
      if (tag === "br") separate(breaks + 1)
      if (tag === "blockquote") quoteDepth++
      if (tag === "ol" || tag === "ul") lists.push({ ordered: tag === "ol", next: 1 })
      if (tag === "tr") tableRows.push({ cells: 0 })
      if (tag === "td" || tag === "th") {
        const row = tableRows.at(-1)
        if (row && row.cells++ > 0) {
          space = false
          append(" | ")
        }
      }
      if (tag === "li") {
        const list = lists.at(-1)
        listMarker = "  ".repeat(Math.max(0, lists.length - 1)) + (list?.ordered ? `${list.next++}. ` : "• ")
      }
    },
    ontext(text) {
      if (hiddenDepth) return
      const clean = text.replace(/[\x00-\x08\x0b\x0e-\x1f\x7f-\x9f]/g, "")
      if (styles[styles.length - 1].pre) {
        append(clean.replace(/\r\n?/g, "\n"))
        return
      }
      const normalized = clean.replace(/[\t\n\f\r ]+/g, " ")
      if (normalized.startsWith(" ")) space = true
      append(normalized.replace(/^ | $/g, ""))
      if (normalized.endsWith(" ")) space = true
    },
    onclosetag(tag) {
      if (hiddenDepth) {
        hiddenDepth--
        return
      }
      styles.pop()
      separate(blocks.get(tag) ?? 0)
      if (tag === "blockquote") quoteDepth--
      if (tag === "ol" || tag === "ul") lists.pop()
      if (tag === "tr") tableRows.pop()
      if (tag === "li") listMarker = ""
    },
  }).end(html)

  return chunks
}
