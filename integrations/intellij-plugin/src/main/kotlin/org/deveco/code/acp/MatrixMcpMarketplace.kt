package org.deveco.code.acp

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.IOException
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration

/**
 * Client and configuration adapter for the public OpenHarmony Matrix MCP registry.
 *
 * Ported from DevEcoGenie's `MatrixMcpMarketplaceClient` so the JetBrains plugin
 * can browse and one-click add marketplace MCP servers through the HTTP layer.
 */
internal object MatrixMcpMarketplace {
    private val LIST_URI = URI.create("https://matrix.openharmony.cn/api/registry/mcp/list")
    private const val DETAILS_URL = "https://matrix.openharmony.cn/api/registry/mcp/details/"
    private val client: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    data class Item(
        val id: String,
        val name: String,
        val configuredName: String,
        val description: String,
        val deployType: String,
        val repository: String,
        val configuration: String,
    )

    data class Page(val count: Int, val items: List<Item>)

    data class InstalledMcp(val name: String, val config: JsonObject)

    fun list(page: Int, pageSize: Int, keyword: String?): Page {
        val body = buildJsonObject {
            put("pageNum", maxOf(1, page))
            put("pageSize", maxOf(1, pageSize))
            put("keyword", keyword?.trim() ?: "")
            put("categoryId", "")
            put("orgId", "")
            put("tagIds", JsonArray(emptyList()))
            put("deployType", "")
            put("statusList", JsonArray(listOf(JsonPrimitive("2"), JsonPrimitive("3"))))
        }
        val request = HttpRequest.newBuilder(LIST_URI)
            .timeout(Duration.ofSeconds(20))
            .header("Content-Type", "application/json")
            .header("x-language", "zh_CN")
            .header("User-Agent", "DevEcoCode")
            .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
            .build()
        return parsePage(send(request, "MCP marketplace list"))
    }

    fun details(id: String): Item {
        require(id.isNotBlank()) { "Marketplace MCP ID is required" }
        val request = HttpRequest.newBuilder(URI.create(DETAILS_URL + encodeId(id)))
            .timeout(Duration.ofSeconds(20))
            .header("Accept", "application/json")
            .header("x-language", "zh_CN")
            .header("User-Agent", "DevEcoCode")
            .GET()
            .build()
        val root = send(request, "MCP marketplace details")
        val data = businessData(root, "MCP marketplace details")
        return item(data)
    }

    fun configuration(item: Item): InstalledMcp {
        val raw = item.configuration
        require(raw.isNotBlank()) { "This marketplace entry does not provide an MCP configuration" }
        val parsed = try {
            Json.parseToJsonElement(raw)
        } catch (e: Exception) {
            throw IOException("The marketplace MCP configuration is not valid JSON", e)
        }
        require(parsed is JsonObject) { "The marketplace MCP configuration must be a JSON object" }
        val servers = parsed.obj("mcpServers")
            ?: throw IOException("The marketplace entry has no mcpServers configuration")
        require(servers.isNotEmpty()) { "The marketplace entry has no mcpServers configuration" }
        val entry = servers.entries.first()
        val source = entry.value as? JsonObject
            ?: throw IOException("The MCP server configuration is invalid")
        val name = entry.key.ifBlank { item.name }
        val type = source.str("type")?.lowercase() ?: ""
        val config = buildJsonObject {
            val url = source.str("url")
            if (url != null || type.contains("http") || type == "sse") {
                require(url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
                    "The remote MCP configuration has no valid HTTP URL"
                }
                put("type", "remote")
                put("url", url)
                source.obj("headers")?.let { put("headers", it) }
                source["oauth"]?.let { put("oauth", it) }
            } else {
                val command = source.str("command")
                    ?: throw IOException("The local MCP configuration has no command")
                put("type", "local")
                val commandLine = JsonArray(listOf(JsonPrimitive(command)) + source.array("args").orEmpty())
                put("command", commandLine)
                source.str("cwd")?.let { put("cwd", it) }
                source.obj("env")?.let { put("environment", it) }
                source.obj("environment")?.let { put("environment", it) }
            }
            put("enabled", !source.bool("disabled", false))
            source["timeout"]?.let { t ->
                if (t is JsonPrimitive && t.intOrNull != null) put("timeout", t)
            }
        }
        return InstalledMcp(name, config)
    }

    private fun send(request: HttpRequest, operation: String): JsonObject {
        val response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
        if (response.statusCode() !in 200..299) {
            throw IOException("$operation returned HTTP ${response.statusCode()}")
        }
        val parsed = try {
            Json.parseToJsonElement(response.body())
        } catch (e: Exception) {
            throw IOException("$operation returned invalid JSON", e)
        }
        if (parsed !is JsonObject) throw IOException("$operation returned an invalid response")
        return parsed
    }

    private fun parsePage(root: JsonObject): Page {
        val data = businessData(root, "MCP marketplace list")
        val count = data.int("count") ?: 0
        val list = data.array("list").orEmpty().mapNotNull { if (it is JsonObject) item(it) else null }
        return Page(count, list)
    }

    private fun businessData(root: JsonObject, operation: String): JsonObject {
        if (root.str("code") != "20000") {
            throw IOException("$operation failed: ${root.str("message") ?: "unknown error"}")
        }
        return root.obj("data") ?: throw IOException("$operation returned no data")
    }

    private fun item(value: JsonObject): Item {
        val name = value.str("name") ?: "Unnamed MCP"
        val configuration = configurationString(value["mcpServerConfiguration"])
        return Item(
            id = value.str("id") ?: "",
            name = name,
            configuredName = configuredName(configuration, name),
            description = value.str("description") ?: "",
            deployType = value.str("deployType") ?: "",
            repository = value.str("repository") ?: "",
            configuration = configuration,
        )
    }

    private fun configuredName(configuration: String, fallback: String): String {
        if (configuration.isBlank()) return fallback
        val parsed = runCatching { Json.parseToJsonElement(configuration).jsonObject }.getOrNull() ?: return fallback
        val servers = parsed.obj("mcpServers")
        return if (servers.isNullOrEmpty()) fallback else servers.keys.first()
    }

    private fun configurationString(value: JsonElement?): String = when (value) {
        null, is JsonPrimitive -> value?.contentOrNull ?: ""
        else -> value.toString()
    }

    private fun encodeId(id: String): String = URLEncoder.encode(id, StandardCharsets.UTF_8).replace("+", "%20")

    private fun JsonObject.str(key: String): String? = this[key]
        ?.takeIf { it is JsonPrimitive }?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }

    private fun JsonObject.int(key: String): Int? = this[key]
        ?.takeIf { it is JsonPrimitive }?.jsonPrimitive?.intOrNull

    private fun JsonObject.bool(key: String, fallback: Boolean): Boolean = this[key]
        ?.takeIf { it is JsonPrimitive }?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull() ?: fallback

    private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

    private fun JsonObject.array(key: String): JsonArray? = this[key] as? JsonArray
}
