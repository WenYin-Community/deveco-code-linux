package org.deveco.code.announcement

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

internal data class AnnouncementKey(val title: String, val publishTime: Long)

internal data class Announcement(
    val title: String,
    val content: String,
    val publishTime: Long,
    val read: Boolean = false,
) {
    val key = AnnouncementKey(title, publishTime)

    // Announcements are created while loading the response or cache on a worker thread.
    val balloonHtml = announcementBalloonHtml(content)
}

private val announcementGson = GsonBuilder().disableHtmlEscaping().create()
private val announcementOrder = compareByDescending<Announcement> { it.publishTime }.thenBy { it.title }

internal data class AnnouncementResponse(val items: List<Announcement>) {
    fun merge(previous: List<Announcement>): List<Announcement> {
        val known = previous.mapTo(mutableSetOf()) { it.key }
        return (previous + items.filter { known.add(it.key) }).sortedWith(announcementOrder)
    }

    companion object {
        fun parse(json: String): AnnouncementResponse {
            val root = JsonParser.parseString(json).asJsonObject
            require(root.get("code")?.asString == "200") { "Announcement request returned an unsuccessful status" }
            val body = requireNotNull(root.get("body")) { "Announcement response is missing its body" }
            val items = when {
                body.isJsonObject -> listOf(parseItem(body.asJsonObject))
                body.isJsonArray -> body.asJsonArray.map { parseItem(it.asJsonObject) }
                else -> error("Invalid announcement response body")
            }
            return AnnouncementResponse(items)
        }

        internal fun parseItem(obj: JsonObject, read: Boolean = false): Announcement {
            fun string(name: String): String {
                val value = requireNotNull(obj.get(name)) { "Announcement is missing $name" }
                require(value.isJsonPrimitive && value.asJsonPrimitive.isString) {
                    "Announcement field $name must be a string"
                }
                return value.asString
            }
            val time = requireNotNull(obj.get("publishTime"))
            require(time.isJsonPrimitive && time.asJsonPrimitive.isNumber)
            val timestamp = time.asBigDecimal.longValueExact()
            require(timestamp in 0..9007199254740991L)
            return Announcement(string("title"), string("content"), timestamp, read)
        }
    }
}

internal data class AnnouncementState(val items: List<Announcement> = emptyList()) {
    val unread = items.filterNot { it.read }.associateBy { it.key }
}

/** The file lock keeps incremental queries and read updates atomic across IDE processes. */
internal class AnnouncementStore(private val directory: Path) {
    companion object {
        private val monitor = Any()
    }
    private val file = directory.resolve("announcements.json")

    fun load(): AnnouncementState = transaction { read() }

    fun save(response: AnnouncementResponse): AnnouncementState = transaction {
        val disk = read()
        val next = AnnouncementState(response.merge(disk.items))
        write(next)
        next
    }

    fun markRead(key: AnnouncementKey): AnnouncementState = transaction {
        val disk = read()
        if (disk.items.none { it.key == key && !it.read }) return@transaction disk
        val next = disk.copy(items = disk.items.map { if (it.key == key && !it.read) it.copy(read = true) else it })
        write(next)
        next
    }

    private fun read(): AnnouncementState = try {
        readDocument()
    } catch (_: RuntimeException) {
        AnnouncementState()
    }

    private fun readDocument(): AnnouncementState {
        if (!Files.exists(file)) return AnnouncementState()
        val root = JsonParser.parseString(Files.readString(file)).asJsonArray
        val items = root.map {
            val obj = it.asJsonObject
            val read = obj.get("read")?.takeIf { value -> value.isJsonPrimitive && value.asJsonPrimitive.isBoolean }
                ?.asBoolean
            AnnouncementResponse.parseItem(obj, read == true)
        }
        return AnnouncementState(items.distinctBy { it.key }.sortedWith(announcementOrder))
    }

    private fun write(state: AnnouncementState) {
        val root = JsonArray(state.items.size)
        state.items.forEach { item ->
            root.add(
                JsonObject().apply {
                    addProperty("title", item.title)
                    addProperty("content", item.content)
                    addProperty("publishTime", item.publishTime)
                    addProperty("read", item.read)
                },
            )
        }
        val temporary = Files.createTempFile(directory, "announcements-", ".tmp")
        try {
            Files.writeString(temporary, announcementGson.toJson(root))
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally {
            Files.deleteIfExists(temporary)
        }
    }

    private fun <T> transaction(action: () -> T): T = synchronized(monitor) {
        Files.createDirectories(directory)
        FileChannel.open(
            directory.resolve("announcements.lock"),
            StandardOpenOption.CREATE,
            StandardOpenOption.WRITE,
        ).use { channel ->
            channel.lock().use { action() }
        }
    }
}
