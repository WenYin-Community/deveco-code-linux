package org.deveco.code.migration

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files

/**
 * Unit tests for [JsoncParser]: strict JSON first, then JSONC preprocessing
 * (line + block comments, trailing commas), then fail as a file-level error.
 */
class JsoncParserTest {

    @get:Rule
    val tmpFolder = TemporaryFolder()

    @Test
    fun parseStrictJsonWithoutPreprocessing() {
        val node = JsoncParser.parse("""{"mcp":{"k1":1,"k2":"v2"}}""")

        assertEquals(1, node.path("mcp").path("k1").asInt())
        assertEquals("v2", node.path("mcp").path("k2").asText())
    }

    @Test
    fun parseLineComments() {
        val jsonc = """
            {
                // line comment
                "key": "value", // trailing line comment
                // another one
                "count": 2
            }
        """.trimIndent()

        val node = JsoncParser.parse(jsonc)

        assertEquals("value", node.path("key").asText())
        assertEquals(2, node.path("count").asInt())
    }

    @Test
    fun parseBlockComments() {
        val jsonc = """{
            /* multi
               line block comment */
            "key": "value", /* inline block comment */ "count": 2
        }"""

        val node = JsoncParser.parse(jsonc)

        assertEquals("value", node.path("key").asText())
        assertEquals(2, node.path("count").asInt())
    }

    @Test
    fun parseTrailingCommas() {
        val jsonc = """{
            "list": [1, 2, 3,],
            "nested": {"inner": true,},
        }"""

        val node = JsoncParser.parse(jsonc)

        assertEquals(3, node.path("list").size())
        assertEquals(3, node.path("list").get(2).asInt())
        assertTrue(node.path("nested").path("inner").asBoolean())
    }

    @Test
    fun keepCommentMarkersInsideStrings() {
        val node = JsoncParser.parse("""{"url":"https://example.com","blob":"/* not a comment */"}""")

        assertEquals("https://example.com", node.path("url").asText())
        assertEquals("/* not a comment */", node.path("blob").asText())
    }

    @Test
    fun keepEscapedQuotesInsideStrings() {
        val node = JsoncParser.parse("""{"text":"she said \"hi\" // not a comment"}""")

        assertEquals("""she said "hi" // not a comment""", node.path("text").asText())
    }

    @Test
    fun parseCommentBetweenTrailingCommaAndClosingBrace() {
        // Regression guard for review P3-4: stripping commas before comments
        // used to produce `{"a":1, }` and the mcp section read as absent.
        val jsonc = "{\n  \"a\": 1, // note\n}"

        val node = JsoncParser.parse(jsonc)

        assertEquals(1, node.path("a").asInt())
        assertEquals(1, node.size())
    }

    @Test
    fun parseNestedStructuresWithComments() {
        val jsonc = """{
            "mcp": {
                "servers": {
                    // example entry
                    "fetch": {"command": "uvx", "args": ["mcp-server-fetch",],},
                },
            },
        }"""

        val node = JsoncParser.parse(jsonc)

        val fetch = node.path("mcp").path("servers").path("fetch")
        assertEquals("uvx", fetch.path("command").asText())
        assertEquals("mcp-server-fetch", fetch.path("args").get(0).asText())
    }

    @Test
    fun throwOnUnparseableInput() {
        val exception = assertThrows(JsoncParser.JsoncParseException::class.java) {
            JsoncParser.parse("this is neither JSON nor JSONC {broken")
        }

        assertEquals("Not parseable as JSON or JSONC", exception.message)
    }

    @Test
    fun readFileParsesFileContent() {
        val file = tmpFolder.newFile("deveco.jsonc")
        Files.writeString(file.toPath(), "{\n  // config\n  \"theme\": \"dark\",\n}")

        val node = JsoncParser.readFile(file.toPath())

        assertEquals("dark", node.path("theme").asText())
    }
}
