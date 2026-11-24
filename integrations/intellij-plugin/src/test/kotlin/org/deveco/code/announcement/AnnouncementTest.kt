package org.deveco.code.announcement

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.sun.net.httpserver.HttpServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.StringReader
import java.net.InetSocketAddress
import java.net.URI
import java.net.URLDecoder
import java.nio.file.Files
import java.util.concurrent.Executors
import javax.swing.text.html.HTML
import javax.swing.text.html.HTMLDocument
import javax.swing.text.html.HTMLEditorKit

class AnnouncementTest {
    private val first = Announcement("新功能上线", "欢迎体验", 1763059200000)
    private fun payload(item: Announcement) = JsonObject().apply {
        addProperty("title", item.title)
        addProperty("content", item.content)
        addProperty("publishTime", item.publishTime)
    }.toString()
    private fun response(body: String) = AnnouncementResponse.parse("""{"code":"200","body":$body}""")

    @Test fun `object and array responses deduplicate by title and publish time`() {
        val second = first.copy(publishTime = first.publishTime + 1)
        val sameTime = first.copy(title = "测试公告")
        assertEquals(listOf(second, first), response(payload(second)).merge(listOf(first)))
        val repeated = first.copy(content = "ignored")
        val repeatedSecond = second.copy(content = "duplicate in response")
        val batch =
            response("[${payload(repeated)},${payload(second)},${payload(repeatedSecond)},${payload(sameTime)}]")
        assertEquals(listOf(second, first, sameTime), batch.merge(listOf(first)))
        assertEquals(listOf(first), response("[]").merge(listOf(first)))
        assertEquals(listOf(first, sameTime), response("[${payload(sameTime)},${payload(first)}]").merge(emptyList()))
    }

    @Test fun `malformed bodies fail without producing an empty result`() {
        listOf("null", "true", "42", "{}", "[{}]", "\"bad\"").forEach { body ->
            assertThrows(Exception::class.java) { response(body) }
        }
        listOf("{}", "{", """{"code":500,"body":[]}""", """{"code":200}""").forEach { json ->
            assertThrows(Exception::class.java) { AnnouncementResponse.parse(json) }
        }
    }

    @Test fun `only the current signed product agreement enables announcements`() {
        val file = Files.createTempDirectory("announcement-agreement").resolve("product-agreement.json")
        assertFalse(hasAcceptedProductAgreement(file, "2"))
        for (unsigned in listOf("{", "{}", """{"version":"0"}""", """{"version":2}""")) {
            Files.writeString(file, unsigned)
            assertFalse(unsigned, hasAcceptedProductAgreement(file, "2"))
        }
        Files.writeString(file, """{"version":"1","acceptedAt":1763059200000}""")
        assertFalse(hasAcceptedProductAgreement(file, "2"))
        assertTrue(hasAcceptedProductAgreement(file, "1"))
    }

    @Test fun `HTTP sends an unauthenticated GET with the installed client version`() {
        assertEquals(
            URI.create("https://cn.devecostudio.huawei.com/sse/codeGenie/announcement"),
            AnnouncementHttp.endpoint(),
        )
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        var query = emptyList<String>()
        var method: String? = null
        var authorization: String? = null
        server.createContext("/sse/codeGenie/announcement") { exchange ->
            query = exchange.requestURI.rawQuery.orEmpty().split('&').map { URLDecoder.decode(it, Charsets.UTF_8) }
            method = exchange.requestMethod
            authorization = exchange.requestHeaders.getFirst("Authorization")
            val bytes = """{"code":200,"body":${payload(first)}}""".toByteArray()
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        val http = AnnouncementHttp(
            { URI.create("http://127.0.0.1:${server.address.port}/sse/codeGenie/announcement") },
            { "1.2.3+test" },
        )
        try {
            assertEquals(listOf(first), http.fetch().items)
            assertEquals("GET", method)
            assertEquals(listOf("clientName=deveco-code", "clientVersion=1.2.3+test"), query.sorted())
            assertNull(authorization)
        } finally {
            http.cancel()
            server.stop(0)
        }
    }

    @Test fun `a repeated title and time keeps the cached body and its read state`() {
        val directory = Files.createTempDirectory("announcement-test")
        val store = AnnouncementStore(directory)
        val v2 = first.copy(content = "新版")
        store.save(AnnouncementResponse(listOf(first)))
        store.markRead(first.key)
        store.save(AnnouncementResponse(listOf(v2)))
        val loaded = AnnouncementStore(directory).load()
        assertEquals(listOf(first.copy(read = true)), loaded.items)
        assertTrue(loaded.unread.isEmpty())
        val saved = JsonParser.parseString(Files.readString(directory.resolve("announcements.json"))).asJsonArray
        assertEquals(setOf("title", "content", "publishTime", "read"), saved.single().asJsonObject.keySet())
    }

    @Test fun `concurrent reads and queries preserve all items and their read flags`() {
        val directory = Files.createTempDirectory("announcement-test")
        val items = (1..12).map { first.copy(publishTime = first.publishTime + it) }
        AnnouncementStore(directory).save(AnnouncementResponse(items))
        val pool = Executors.newFixedThreadPool(4)
        try {
            val tasks = items.map { item ->
                pool.submit { AnnouncementStore(directory).markRead(item.key) }
            } + pool.submit { AnnouncementStore(directory).save(AnnouncementResponse(listOf(first))) }
            tasks.forEach { it.get() }
            val loaded = AnnouncementStore(directory).load()
            assertEquals(items.map { it.key }.toSet(), loaded.items.filter { it.read }.map { it.key }.toSet())
            assertEquals(listOf(first), loaded.unread.values.toList())
        } finally {
            pool.shutdownNow()
        }
    }

    @Test fun `corrupt or old cache is replaced on the next successful response`() {
        val directory = Files.createTempDirectory("announcement-test")
        val store = AnnouncementStore(directory)
        val oldItem = JsonParser.parseString(payload(first)).asJsonObject.apply {
            addProperty("announcementId", "old")
            addProperty("read", true)
        }
        for (oldCache in listOf("{", """{"items":[$oldItem]}""")) {
            Files.writeString(directory.resolve("announcements.json"), oldCache)
            assertTrue(store.load().items.isEmpty())
            store.save(AnnouncementResponse(listOf(first)))
            assertEquals(listOf(first), store.load().items)
        }
    }

    @Test fun `failed HTTP and invalid responses are rejected before a cache write`() {
        val directory = Files.createTempDirectory("announcement-test")
        val store = AnnouncementStore(directory)
        store.save(AnnouncementResponse(listOf(first)))
        store.markRead(first.key)
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        var status = 200
        var response = "{"
        server.createContext("/") { exchange ->
            val bytes = response.toByteArray()
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        val http = AnnouncementHttp({ URI.create("http://127.0.0.1:${server.address.port}/") }, { "1.2.3" })
        try {
            listOf(200 to "{", 500 to "{}", 200 to """{"code":500,"body":[]}""", 200 to """{"code":200}""").forEach {
                status = it.first
                response = it.second
                assertThrows(Exception::class.java) { store.save(http.fetch()) }
                assertEquals(listOf(first.copy(read = true)), store.load().items)
                assertTrue(store.load().unread.isEmpty())
            }
        } finally {
            http.cancel()
            server.stop(0)
        }
    }

    @Test fun `incremental and empty responses preserve a cached HTML announcement`() {
        val directory = Files.createTempDirectory("announcement-test")
        val cached = first.copy(publishTime = first.publishTime - 1, content = "<p><strong>HTML</strong></p>")
        AnnouncementStore(directory).save(AnnouncementResponse(listOf(cached)))
        val poller = AnnouncementStore(directory)
        poller.save(response("[]"))
        poller.save(response("[${payload(first)}]"))
        val loaded = AnnouncementStore(directory).load()
        assertEquals(listOf(first, cached), loaded.items)
        assertEquals(listOf(first, cached), loaded.unread.values.toList())
    }

    @Test
    fun `marking one announcement as read leaves the others unread`() {
        val second = first.copy(publishTime = first.publishTime + 1)
        val third = first.copy(title = "第三条公告")
        val store = AnnouncementStore(Files.createTempDirectory("announcement-test"))
        val saved = store.save(AnnouncementResponse(listOf(first, second, third)))
        assertEquals(listOf(second, first, third), saved.unread.values.toList())
        assertEquals(listOf(first.copy(read = true)), store.markRead(first.key).items.filter { it.read })
        assertEquals(listOf(second, third), store.load().unread.values.toList())
    }

    @Test
    fun `balloon renders HTML that uses only wrapper tags`() {
        for (tag in listOf("div", "span", "font")) {
            val html = announcementBalloonHtml("""<$tag style="color:red">Update &amp; news</$tag>""")
            val editor = HTMLEditorKit()
            val document = editor.createDefaultDocument() as HTMLDocument
            editor.read(StringReader(html), document, 0)
            assertEquals(tag, "Update & news", document.getText(0, document.length).trim())
            assertFalse(tag, html.contains("style="))
        }
    }

    @Test
    fun `balloon keeps HTML table rows and cells distinct`() {
        val html = announcementBalloonHtml(
            """<table style="width:900px"><thead><tr><th>Title</th><th>Status</th></tr></thead>""" +
                "<tbody><tr><td>Release</td><td>Ready</td></tr></tbody></table>",
        )
        assertTrue(html.contains("<table>"))
        assertTrue(html.contains("<tr><th>Title</th><th>Status</th></tr>"))
        assertTrue(html.contains("<tr><td>Release</td><td>Ready</td></tr>"))
        assertFalse(html.contains("style="))
    }

    @Test
    fun `balloon markup keeps emphasis code lists and quotes`() {
        val html = first.copy(
            content = "<p><strong>公告</strong> <em>本地验证</em></p>" +
                "<ol><li><code>GUI</code></li><li>检查换行</li></ol><blockquote>引用</blockquote>",
        ).balloonHtml
        assertTrue(html.contains("<ol><li><code>GUI</code></li><li>检查换行</li></ol>"))
        assertTrue(html.contains("<blockquote>引用</blockquote>"))
        val editor = HTMLEditorKit()
        val document = editor.createDefaultDocument() as HTMLDocument
        editor.read(StringReader(html), document, 0)
        assertTrue(document.getIterator(HTML.Tag.STRONG).isValid)
        assertTrue(document.getIterator(HTML.Tag.EM).isValid)
        assertTrue(document.getIterator(HTML.Tag.CODE).isValid)
        assertFalse(document.getText(0, document.length).contains("<strong>"))
    }

    @Test
    fun `balloon markup keeps web links and strips other attributes scripts and remote resources`() {
        val html = first.copy(
            content = """<p style="font-size: 80pt"><b onclick="blocked">A &amp; B</b>""" +
                """<img src="https://example.invalid/image.png">""" +
                """<a href="https://example.invalid/?a=1&amp;b=2" onclick="blocked">链接文字</a>""" +
                """<a href="jav&#x61;script:alert(1)">脚本</a><a href="file:///tmp/a">文件</a>""" +
                """<a href="//example.invalid">相对地址</a><a href="https://user@example.invalid">凭据</a>""" +
                "<script>script body</script></p>",
        ).balloonHtml
        assertTrue(html.contains("<b>A &amp; B</b>"))
        assertTrue(html.contains("""<a href="https://example.invalid/?a=1&amp;b=2">链接文字</a>"""))
        assertTrue(html.contains("脚本文件相对地址凭据"))
        for (blocked in listOf("style=", "onclick=", "<img", "javascript:", "file:", "user@", "script body")) {
            assertFalse(blocked, html.contains(blocked))
        }
        val editor = HTMLEditorKit()
        val document = editor.createDefaultDocument() as HTMLDocument
        editor.read(StringReader(html), document, 0)
        val links = document.getIterator(HTML.Tag.A)
        assertEquals("https://example.invalid/?a=1&b=2", links.attributes.getAttribute(HTML.Attribute.HREF))
        links.next()
        assertFalse(links.isValid)
    }

    @Test
    fun `balloon converts Markdown formatting to native HTML`() {
        val html = first.copy(
            content = "## Markdown 标题\n\n**加粗** 和 *斜体*，以及 `<strong>`。\n\n" +
                "1. 第一项\n2. 第二项\n\n> [引用](http://example.invalid/doc)",
        ).balloonHtml
        assertTrue(html.contains("<h2>Markdown 标题</h2>"))
        assertTrue(html.contains("<strong>加粗</strong>"))
        assertTrue(html.contains("<em>斜体</em>"))
        assertTrue(html.contains("<code>&lt;strong&gt;</code>"))
        assertTrue(html.contains("<ol>"))
        assertTrue(html.contains("<li>第一项</li>"))
        assertTrue(html.contains("<blockquote>"))
        assertTrue(html.contains("""<a href="http://example.invalid/doc">引用</a>"""))
    }

    @Test
    fun `balloon plain text preserves line breaks and angle brackets`() {
        val html = first.copy(content = "第一行 < 10\r\n第二行 List<String>\r末行 & 正文").balloonHtml
        assertEquals("第一行 &lt; 10<br>第二行 List&lt;String&gt;<br>末行 &amp; 正文", html)
    }
}
