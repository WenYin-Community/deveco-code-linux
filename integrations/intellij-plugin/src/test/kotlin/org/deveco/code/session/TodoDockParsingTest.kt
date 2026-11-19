package org.deveco.code.session

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the file-scope todo-dock parsing helpers of
 * SessionController.kt: [parseTodoDockItems] over the three accepted raw
 * input shapes (JsonObject / Map / JSON string) and [TodoDockStatus.fromString].
 */
class TodoDockParsingTest {

    private fun jsonTodos(vararg items: JsonObject): JsonObject = buildJsonObject {
        put("todos", buildJsonArray { items.forEach { add(it) } })
    }

    private fun item(content: String, status: String? = null): JsonObject = buildJsonObject {
        put("content", content)
        if (status != null) put("status", status)
    }

    // --- TodoDockStatus.fromString ---

    @Test
    fun todoStatusParsesCompletedSynonyms() {
        assertEquals(TodoDockStatus.COMPLETED, TodoDockStatus.fromString("completed"))
        assertEquals(TodoDockStatus.COMPLETED, TodoDockStatus.fromString("Done"))
    }

    @Test
    fun todoStatusParsesInProgressSynonyms() {
        assertEquals(TodoDockStatus.IN_PROGRESS, TodoDockStatus.fromString("in_progress"))
        assertEquals(TodoDockStatus.IN_PROGRESS, TodoDockStatus.fromString("inprogress"))
        assertEquals(TodoDockStatus.IN_PROGRESS, TodoDockStatus.fromString("in-progress"))
        assertEquals(TodoDockStatus.IN_PROGRESS, TodoDockStatus.fromString("RUNNING"))
        assertEquals(TodoDockStatus.IN_PROGRESS, TodoDockStatus.fromString("active"))
    }

    @Test
    fun todoStatusParsesCancelledSynonyms() {
        assertEquals(TodoDockStatus.CANCELLED, TodoDockStatus.fromString("cancelled"))
        assertEquals(TodoDockStatus.CANCELLED, TodoDockStatus.fromString("canceled"))
    }

    @Test
    fun todoStatusFallsBackToPending() {
        assertEquals(TodoDockStatus.PENDING, TodoDockStatus.fromString("pending"))
        assertEquals(TodoDockStatus.PENDING, TodoDockStatus.fromString("whatever"))
        assertEquals(TodoDockStatus.PENDING, TodoDockStatus.fromString(null))
    }

    // --- parseTodoDockItems ---

    @Test
    fun parseReadsTodosFromJsonObject() {
        val parsed = parseTodoDockItems(jsonTodos(item("a", "completed"), item("b", "in_progress")), "tool-1")
        assertEquals(
            listOf(
                TodoDockItem("a", TodoDockStatus.COMPLETED, "tool-1"),
                TodoDockItem("b", TodoDockStatus.IN_PROGRESS, "tool-1"),
            ),
            parsed,
        )
    }

    @Test
    fun parseReadsTasksKeyFromPlainMap() {
        val input = mapOf(
            "tasks" to listOf(
                mapOf("task" to "do stuff", "state" to "running"),
            ),
        )
        val parsed = parseTodoDockItems(input, "t")
        assertEquals(listOf(TodoDockItem("do stuff", TodoDockStatus.IN_PROGRESS, "t")), parsed)
    }

    @Test
    fun parseReadsItemsKeyFromJsonString() {
        val raw = """{"items":[{"description":"step one"},{"description":"step two","status":"done"}]}"""
        val parsed = parseTodoDockItems(raw, "t")
        assertEquals(
            listOf(
                TodoDockItem("step one", TodoDockStatus.PENDING, "t"),
                TodoDockItem("step two", TodoDockStatus.COMPLETED, "t"),
            ),
            parsed,
        )
    }

    @Test
    fun parseSkipsItemsWithoutContent() {
        val input = mapOf(
            "todos" to listOf(
                mapOf("status" to "completed"),
                mapOf("content" to "ok"),
                "not a map",
            ),
        )
        val parsed = parseTodoDockItems(input, "t")
        assertEquals(listOf(TodoDockItem("ok", TodoDockStatus.PENDING, "t")), parsed)
    }

    @Test
    fun parseReturnsEmptyForUnrecognizedInput() {
        assertTrue(parseTodoDockItems(null, "t").isEmpty())
        assertTrue(parseTodoDockItems(42, "t").isEmpty())
        assertTrue(parseTodoDockItems("not json {", "t").isEmpty())
        assertTrue(parseTodoDockItems(emptyMap<String, Any>(), "t").isEmpty())
        assertTrue(parseTodoDockItems(mapOf("todos" to "not-a-list"), "t").isEmpty())
    }

    @Test
    fun parseHandlesJsonPrimitiveContentAndMissingStatus() {
        val input = buildJsonObject {
            put("todos", Json.parseToJsonElement("""[{"content":"from json"}]"""))
        }
        val parsed = parseTodoDockItems(input, "t")
        assertEquals(listOf(TodoDockItem("from json", TodoDockStatus.PENDING, "t")), parsed)
    }

    @Test
    fun parseSkipsItemsWithNullContent() {
        val input = """{"todos":[{"content":null},{"content":"valid","status":"done"}]}"""
        val parsed = parseTodoDockItems(input, "t")
        assertEquals(listOf(TodoDockItem("valid", TodoDockStatus.COMPLETED, "t")), parsed)
    }

    @Test
    fun parseReadsStateKeyAsStatusAlias() {
        val input = mapOf("todos" to listOf(mapOf("content" to "task one", "state" to "cancelled")))
        val parsed = parseTodoDockItems(input, "t")
        assertEquals(listOf(TodoDockItem("task one", TodoDockStatus.CANCELLED, "t")), parsed)
    }
}
