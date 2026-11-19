import { RGBA, TextAttributes } from "@opentui/core"
import { expect, test } from "bun:test"
import { announcementBody } from "../../src/announcements/html"

const codeColor = RGBA.fromHex("#11aa22")

test("renders HTML that uses only wrapper tags", () => {
  for (const tag of ["div", "span", "font"]) {
    const body = announcementBody(`<${tag} style="color:red">Update &amp; news</${tag}>`, codeColor)
    expect(body.map((chunk) => chunk.text).join("")).toBe("Update & news")
  }
  const blocks = announcementBody("<div>First</div><div>Second</div>", codeColor)
  expect(blocks.map((chunk) => chunk.text).join("")).toBe("First\nSecond")
})

test("keeps HTML table rows and cells distinct", () => {
  const body = announcementBody(
    "<table>\n<thead><tr><th>Title</th> <th>Status</th></tr></thead>\n" +
      "<tbody><tr><td>Release</td><td>Ready</td></tr><tr><td>Patch</td><td></td></tr></tbody></table>",
    codeColor,
  )
  expect(body.map((chunk) => chunk.text).join("")).toBe("Title | Status\nRelease | Ready\nPatch | ")
})

test("renders HTML as styled terminal text with ordered lists and quotes", () => {
  const body = announcementBody(
    "<p><strong>Bold</strong> and <em>italic</em> &amp; <code>code</code></p>" +
      "<ol><li><p>First</p></li><li>Second</li></ol><blockquote>One<br>Two</blockquote>",
    codeColor,
  )
  expect(body.map((chunk) => chunk.text).join("")).toBe(
    "Bold and italic & code\n\n1. First\n\n2. Second\n\n│ One\n│ Two",
  )
  expect(body.find((chunk) => chunk.text === "Bold")?.attributes).toBe(TextAttributes.BOLD)
  expect(body.find((chunk) => chunk.text === "italic")?.attributes).toBe(TextAttributes.ITALIC)
  expect(body.find((chunk) => chunk.text === "code")?.fg).toEqual(codeColor)
})

test("keeps nested styles and web links while dropping hidden elements and unsafe links", () => {
  const body = announcementBody(
    '<p><b onclick="ignored"><i>Both</i></b>' +
      '<script>hidden</script><style>also hidden</style><img src="https://example.invalid/a">' +
      ' <a href="https://example.invalid/b?x=1&amp;y=2"><em>Link label</em></a>' +
      ' <a href="jav&#x61;script:alert(1)">Script</a> <a href="//example.invalid">Relative</a>' +
      ' <a href="file:///tmp/a">File</a> <a href="https://user@example.invalid">User info</a></p><pre>A\n  B</pre>',
    codeColor,
  )
  expect(body.map((chunk) => chunk.text).join("")).toBe("Both Link label Script Relative File User info\n\nA\n  B")
  expect(body[0].attributes).toBe(TextAttributes.BOLD | TextAttributes.ITALIC)
  expect(body.filter((chunk) => chunk.href)).toEqual([
    {
      text: "Link label",
      attributes: TextAttributes.ITALIC | TextAttributes.UNDERLINE,
      fg: undefined,
      href: "https://example.invalid/b?x=1&y=2",
    },
  ])
})

test("renders Markdown headings, emphasis, code, lists, quotes, and links", () => {
  const body = announcementBody(
    "## Markdown\n\n**bold** and *italic* with `<strong>`\n\n1. First\n2. Second\n\n> [Quote](http://example.invalid/doc)",
    codeColor,
  )
  expect(body.map((chunk) => chunk.text).join("")).toBe(
    "Markdown\n\nbold and italic with <strong>\n\n1. First\n2. Second\n\n│ Quote",
  )
  expect(body.find((chunk) => chunk.text === "Markdown")?.attributes).toBe(TextAttributes.BOLD)
  expect(body.find((chunk) => chunk.text === "bold")?.attributes).toBe(TextAttributes.BOLD)
  expect(body.find((chunk) => chunk.text === "italic")?.attributes).toBe(TextAttributes.ITALIC)
  expect(body.find((chunk) => chunk.text === "Quote")?.href).toBe("http://example.invalid/doc")
  expect(
    body
      .filter((chunk) => chunk.fg === codeColor)
      .map((chunk) => chunk.text)
      .join(""),
  ).toBe("<strong>")
})

test("keeps line breaks and literal angle brackets in plain announcements", () => {
  const body = "Plain announcement\nList<String>\n1 < 2"
  expect(announcementBody(body, codeColor)).toEqual([{ text: body }])
})
