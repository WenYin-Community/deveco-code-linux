package org.deveco.code.acp

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.IOException
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.InvalidPathException
import java.nio.file.Path
import java.time.Duration
import java.util.Base64
import java.util.Comparator

/**
 * Minimal client for the DevEco Code HTTP endpoints that ACP does not expose:
 * session archive/diff, MCP server management, provider and model catalog, and
 * skill discovery with scope inference.
 *
 * Ported from DevEcoGenie's `DevEcoSessionHttpClient`. The ACP HTTP endpoint is
 * always loopback, so we never inherit the IDE's global HTTP proxy and force
 * HTTP/1.1 to work around DevEco Code 0.1.7's incomplete h2c Upgrade on PATCH.
 */
internal class DevEcoHttpApi(baseUrl: String, username: String?, password: String?) {
    private val baseUri: URI = URI.create(if (baseUrl.endsWith("/")) baseUrl else "$baseUrl/")
    private val authorization: String? = password?.takeIf { it.isNotBlank() }?.let {
        "Basic " + Base64.getEncoder().encodeToString(
            ("${username?.takeIf { it.isNotBlank() } ?: "deveco"}:$it").toByteArray(StandardCharsets.UTF_8),
        )
    }

    private val client: HttpClient = HttpClient.newBuilder()
        .version(HttpClient.Version.HTTP_1_1)
        .connectTimeout(Duration.ofSeconds(5))
        .proxy(NO_PROXY_SELECTOR)
        .build()

    enum class SkillScope { GLOBAL, PROJECT, BUILTIN }

    data class McpServerStatus(val name: String, val status: String, val error: String?)
    data class SkillEntry(
        val name: String,
        val description: String,
        val location: String,
        val scope: SkillScope,
        val enabled: Boolean,
    )
    data class CodePaths(
        val home: String?,
        val config: String?,
        val projectConfig: String?,
        val worktree: String?,
        val directory: String,
    )
    data class ModelInfo(
        val providerId: String,
        val providerName: String,
        val modelId: String,
        val modelName: String,
        val source: String,
    )
    data class ProviderInfo(
        val id: String,
        val name: String,
        val baseUrl: String?,
        val modelCount: Int,
        val hasAuth: Boolean = false,
    )
    data class ProviderModelInfo(val id: String, val name: String)
    data class CustomModel(val id: String, val name: String)
    data class CustomProvider(
        val id: String,
        val name: String,
        val baseUrl: String,
        val apiKey: String?,
        val headers: Map<String, String>,
        val models: List<CustomModel>,
    )
    data class FileEditDiff(
        val path: String,
        val additions: Int,
        val deletions: Int,
        val beforeText: String?,
        val afterText: String?,
    )

    fun archiveSession(sessionId: String, directory: String, archivedAt: Long) {
        val body = buildJsonObject {
            put("time", buildJsonObject { put("archived", archivedAt) })
        }
        val path = "session/${encode(sessionId)}?directory=${encQuery(directory)}"
        sendJson(path, "PATCH", body, "session archive")
    }

    fun unarchiveSession(sessionId: String, directory: String) {
        val body = buildJsonObject {
            put("time", buildJsonObject { put("archived", JsonNull) })
        }
        val path = "session/${encode(sessionId)}?directory=${encQuery(directory)}"
        sendJson(path, "PATCH", body, "session unarchive")
    }

    /** Deletes a session; true when the backend confirms the delete. */
    fun deleteSession(sessionId: String, directory: String): Boolean {
        val response = delete("session/${encode(sessionId)}?directory=${encQuery(directory)}")
        requireSuccess(response, "session deletion")
        return response.body()?.trim()?.toBooleanStrictOrNull() == true
    }

    fun sessionDiff(sessionId: String, directory: String): List<FileEditDiff> {
        val path = "session/${encode(sessionId)}/diff?directory=${encQuery(directory)}"
        val response = get(path)
        val parsed = Json.parseToJsonElement(response)
        if (parsed !is JsonArray) return emptyList()
        return parsed.mapNotNull { item ->
            val file = item as? JsonObject ?: return@mapNotNull null
            val pathValue = file.str("file") ?: return@mapNotNull null
            val additions = file["additions"]?.jsonPrimitive?.intOrNull ?: -1
            val deletions = file["deletions"]?.jsonPrimitive?.intOrNull ?: -1
            val patch = file.str("patch")
            val texts = patchTexts(patch)
            FileEditDiff(pathValue, additions, deletions, texts.first, texts.second)
        }
    }

    /** Server-authoritative non-archived root session ids for a workspace. */
    fun activeSessionIds(directory: String): Set<String> {
        val path = "session?directory=${encQuery(directory)}&roots=true&limit=1000"
        val response = get(path)
        val parsed = Json.parseToJsonElement(response)
        if (parsed !is JsonArray) return emptySet()
        val result = LinkedHashSet<String>()
        for (item in parsed) {
            val session = item as? JsonObject ?: continue
            val id = session.str("id") ?: continue
            val time = session.obj("time")
            if (time?.get("archived")?.jsonPrimitive?.contentOrNull != null) continue
            result.add(id)
        }
        return result
    }

    fun mcpServers(directory: String): List<McpServerStatus> {
        val path = "mcp?directory=${encQuery(directory)}"
        val response = get(path)
        val parsed = Json.parseToJsonElement(response)
        if (parsed !is JsonObject) return emptyList()
        return parsed.entries.mapNotNull { (name, value) ->
            val obj = value as? JsonObject ?: return@mapNotNull null
            McpServerStatus(name, obj.str("status") ?: "unknown", obj.str("error"))
        }
    }

    fun setMcpServerEnabled(name: String, directory: String, enabled: Boolean) {
        val action = if (enabled) "connect" else "disconnect"
        val path = "mcp/${encode(name)}/$action?directory=${encQuery(directory)}"
        postEmpty(path, "MCP $action")
    }

    fun addMcpServer(name: String, config: JsonObject, directory: String) {
        require(name.isNotBlank()) { "MCP server name is required" }
        val body = buildJsonObject {
            put("name", name)
            put("config", config)
        }
        val query = encQuery(directory)
        sendJson("mcp?directory=$query", "POST", body, "MCP server add")
        val persist = buildJsonObject {
            put("mcp", buildJsonObject { put(name, config) })
        }
        sendJson("config?directory=$query", "PATCH", persist, "MCP server configuration")
    }

    /**
     * Migration-only variant: persists an mcp section patch WITHOUT the runtime
     * registration POST — migrated servers must not be spawned, only restored.
     */
    fun addMcpConfigPatch(config: JsonObject, directory: String) {
        sendJson("config?directory=${encQuery(directory)}", "PATCH", config, "MCP server configuration")
    }

    /**
     * Persists config into the GLOBAL config file (`<config>/deveco.json(c)`)
     * via PATCH /global/config. Studio mode's PATCH /config always writes the
     * per-project deveco.json, so global-scope writes must use this endpoint.
     */
    fun updateGlobalConfig(config: JsonObject) {
        sendJson("global/config", "PATCH", config, "global config update")
    }

    fun skills(directory: String): List<SkillEntry> {
        val codePaths = paths(directory)
        val path = "skill/status?directory=${encQuery(directory)}"
        val response = get(path)
        val parsed = Json.parseToJsonElement(response)
        if (parsed !is JsonArray) return emptyList()
        return parsed.mapNotNull { item ->
            val value = item as? JsonObject ?: return@mapNotNull null
            val name = value.str("name") ?: return@mapNotNull null
            val location = value.str("location") ?: return@mapNotNull null
            val scope = when (value.str("scope")) {
                "project" -> SkillScope.PROJECT
                "global" -> SkillScope.GLOBAL
                "builtin" -> SkillScope.BUILTIN
                else -> skillScope(location, codePaths)
            }
            val enabled = value["enabled"]?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull() ?: true
            SkillEntry(name, value.str("description") ?: "", location, scope, enabled)
        }.sortedBy { it.name }
    }

    fun setSkillEnabled(name: String, scope: SkillScope, enabled: Boolean, directory: String) {
        val body = buildJsonObject {
            put("scope", scope.name.lowercase())
            put("enabled", enabled)
        }
        sendJson(
            "skill/${encode(name)}?directory=${encQuery(directory)}",
            "PATCH",
            body,
            "skill preference update",
        )
    }

    fun paths(directory: String): CodePaths {
        val path = "path?directory=${encQuery(directory)}"
        val response = get(path)
        val parsed = Json.parseToJsonElement(response)
        if (parsed !is JsonObject) throw IOException("DevEco Code workspace paths returned an invalid response")
        return CodePaths(
            home = parsed.str("home"),
            config = parsed.str("config"),
            projectConfig = parsed.str("projectConfig"),
            worktree = parsed.str("worktree") ?: directory,
            directory = directory,
        )
    }

    fun models(directory: String): List<ModelInfo> {
        val path = "provider?directory=${encQuery(directory)}"
        val response = get(path)
        val parsed = Json.parseToJsonElement(response)
        if (parsed !is JsonObject) return emptyList()
        val providers = parsed.array("all") ?: return emptyList()
        val connectedIds = parsed.array("connected").orEmpty()
            .mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            .toSet()
        if (connectedIds.isEmpty()) return emptyList()
        val result = providers.mapNotNull { item ->
            val provider = item as? JsonObject ?: return@mapNotNull null
            val providerId = provider.str("id") ?: return@mapNotNull null
            if (providerId !in connectedIds) return@mapNotNull null
            // Only show models from providers that actually have an API
            // key stored in auth.json. The "connected" array includes all
            // providers with config definitions regardless of auth — a
            // provider whose key was deleted (e.g. via resetApiKey) is
            // still in "connected" but has no "key" field. EXCEPTION: the
            // built-in deveco provider uses OAuth (not API key) and is
            // always connected — its models should always be shown even
            // if the "key" field is not present (e.g. during a backend
            // reload race where the OAuth token hasn't been refreshed).
            val isBuiltin = providerId.equals("deveco", ignoreCase = true)
            if (provider.str("key") == null && !isBuiltin) return@mapNotNull null
            val providerName = provider.str("name") ?: providerId
            val source = provider.str("source") ?: "custom"
            val models = provider.obj("models") ?: return@mapNotNull null
            // Group by the DevEco provider entry id (e.g. "deveco"), not the
            // model's upstream providerID field, otherwise built-in DevEco
            // models get misclassified as custom and vanish from the built-in group.
            models.entries.map { (key, value) ->
                val model = value as? JsonObject
                val modelId = model?.str("id") ?: key
                val modelName = model?.str("name") ?: modelId
                ModelInfo(providerId, providerName, modelId, modelName, source)
            }
        }.flatten()
        return result.sortedWith(
            compareBy<ModelInfo> { providerRank(it) }
                .thenBy(String.CASE_INSENSITIVE_ORDER) { it.providerName }
                .thenBy(String.CASE_INSENSITIVE_ORDER) { it.modelName }
                .thenBy(String.CASE_INSENSITIVE_ORDER) { it.modelId },
        )
    }

    fun availableProviders(directory: String): List<ProviderInfo> {
        val payload = providerPayload(directory)
        val providers = payload.array("all") ?: run {
            return emptyList()
        }
        val connected = payload.array("connected").orEmpty()
            .mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            .toSet()
        return providers.mapNotNull { item ->
            val provider = item as? JsonObject ?: return@mapNotNull null
            val id = provider.str("id") ?: return@mapNotNull null
            // Exclude the built-in deveco provider — it is always connected and
            // not something the user adds "via provider".
            if (id.equals("deveco", ignoreCase = true)) return@mapNotNull null
            val name = provider.str("name") ?: id
            val baseUrl = provider.obj("options")?.str("baseURL")
            val modelCount = provider.obj("models")?.size ?: 0
            // hasAuth must reflect whether an API key is actually stored in
            // auth.json, NOT just whether the provider has a config entry.
            // The backend's toPublicInfo masks the "key" field (e.g.
            // "mas****ed") when auth is present, or omits it entirely when
            // the provider has no stored key. The "connected" array only
            // reflects config presence (provider has models in config), so
            // checking id in connected alone would show providers as
            // "connected" even after their API key was deleted.
            val hasAuth = id in connected && provider.str("key") != null
            ProviderInfo(id, name, baseUrl, modelCount, hasAuth)
        }.sortedWith(
            compareBy<ProviderInfo> { it.name.lowercase() }
                .thenBy { it.id.lowercase() },
        )
    }

    fun availableProviderModels(providerId: String, directory: String): List<ProviderModelInfo> {
        val payload = providerPayload(directory)
        val providers = payload.array("all") ?: return emptyList()
        for (item in providers) {
            val provider = item as? JsonObject ?: continue
            if (provider.str("id") != providerId) continue
            val models = provider.obj("models") ?: return emptyList()
            return models.entries.mapNotNull { (key, value) ->
                val model = value as? JsonObject
                val modelId = model?.str("id") ?: key
                val modelName = model?.str("name") ?: modelId
                ProviderModelInfo(modelId, modelName)
            }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
        }
        return emptyList()
    }

    fun connectProvider(
        providerId: String,
        apiKey: String?,
        directory: String,
        models: List<ProviderModelInfo> = emptyList(),
    ) {
        require(providerId.isNotBlank()) { "Provider is required" }

        // Store the API key BEFORE updating config so the backend has it
        // when the instance reloads and builds provider state.
        if (apiKey != null) {
            require(apiKey.isNotBlank()) { "API key is required" }
            val auth = buildJsonObject {
                put("type", "api")
                put("key", apiKey)
            }
            sendJson("auth/${encode(providerId)}", "PUT", auth, "provider authentication")
        }

        // Send provider definition via PATCH global/config.
        // For built-in providers (in models.dev catalog), do NOT write npm —
        // the backend falls back to modelsDev[providerID].npm which is the
        // correct SDK (e.g. @ai-sdk/anthropic). Writing @ai-sdk/openai-compatible
        // would override the correct SDK and break non-OpenAI-compatible APIs.
        val modelsObj = buildJsonObject {
            for (model in models) {
                put(
                    model.id,
                    buildJsonObject {
                        put("id", model.id)
                        put("name", model.name)
                    },
                )
            }
        }
        val definition = buildJsonObject {
            put("models", modelsObj)
        }
        val currentDisabled = globalDisabledProviders()
        val disabledAgain = buildJsonArray {
            for (item in currentDisabled) {
                val name = (item as? JsonPrimitive)?.contentOrNull
                if (name != providerId) add(item)
            }
        }
        val config = buildJsonObject {
            put("provider", buildJsonObject { put(providerId, definition) })
            put("disabled_providers", disabledAgain)
        }
        sendJson("global/config", "PATCH", config, "provider configuration")

        disposeInstance(directory)

        // After disposing and recreating the instance, verify the auth
        // actually persisted. When apiKey=null, the PUT /auth was skipped,
        // but the auth might not be in the current auth.json (e.g., after
        // a mode switch from DEFAULT to DEVECO-STUDIO, the auth was stored
        // in the old path but the new path's auth.json doesn't have it).
        // This check catches that case and gives the user a clear error.
        if (apiKey == null) {
            val providers = availableProviders(directory)
            val provider = providers.firstOrNull { it.id == providerId }
            if (provider == null || !provider.hasAuth) {
                throw IOException(
                    "API key for '$providerId' was not found in the backend after reload. " +
                        "This can happen after an IDE restart if the auth storage path changed. " +
                        "Please re-enter the API key in the model settings dialog.",
                )
            }
        }
    }

    fun storeApiKey(providerId: String, apiKey: String) {
        require(providerId.isNotBlank() && apiKey.isNotBlank()) { "Provider and API key are required" }
        val auth = buildJsonObject {
            put("type", "api")
            put("key", apiKey)
        }
        sendJson("auth/${encode(providerId)}", "PUT", auth, "provider authentication (post-reload restore)")
    }

    fun deleteProviderModel(providerId: String, modelId: String, directory: String) {
        require(providerId.isNotBlank() && modelId.isNotBlank()) { "Provider and model ID are required" }
        val response = delete("provider/${encode(providerId)}/models/${encode(modelId)}?directory=${encQuery(directory)}")
        requireSuccess(response, "model deletion")
    }

    fun setOAuthToken(providerId: String, accessToken: String, expiresAt: Long, directory: String) {
        require(providerId.isNotBlank() && accessToken.isNotBlank()) { "Provider and access token are required" }
        val auth = buildJsonObject {
            put("type", "oauth")
            // DevEco Studio owns refresh. The plugin replaces the access token
            // after the host refreshes it, so no refresh credential crosses the boundary.
            put("refresh", "")
            put("access", accessToken)
            put("expires", expiresAt)
        }
        sendJson("auth/${encode(providerId)}", "PUT", auth, "DevEco Studio authentication sync")
        disposeInstance(directory)
    }

    fun removeAuthentication(providerId: String, directory: String) {
        require(providerId.isNotBlank()) { "Provider is required" }
        val response = delete("auth/${encode(providerId)}")
        requireSuccess(response, "authentication removal")
        disposeInstance(directory)
    }

    fun deleteAuthentication(providerId: String) {
        require(providerId.isNotBlank()) { "Provider is required" }
        val response = delete("auth/${encode(providerId)}")
        // 404 is OK — auth was already removed (e.g. by resetApiKey or a
        // previous apply). No need to throw or dispose the instance.
        if (response.statusCode() == 404) return
        requireSuccess(response, "authentication deletion")
    }

    fun addCustomProvider(provider: CustomProvider, directory: String) {
        require(
            provider.id.isNotBlank() && provider.name.isNotBlank() &&
                provider.baseUrl.isNotBlank() && provider.models.isNotEmpty(),
        ) {
            "Provider ID, name, Base URL, and at least one model are required"
        }
        var credential = provider.apiKey?.trim() ?: ""
        var environment: String? = null
        if (credential.startsWith("{env:") && credential.endsWith("}")) {
            environment = credential.substring(5, credential.length - 1).trim()
            credential = ""
        }
        if (credential.isNotBlank()) {
            val auth = buildJsonObject {
                put("type", "api")
                put("key", credential)
            }
            sendJson("auth/${encode(provider.id)}", "PUT", auth, "provider authentication")
        }
        val models = buildJsonObject {
            for (model in provider.models) put(model.id, buildJsonObject { put("name", model.name) })
        }
        val options = buildJsonObject {
            put("baseURL", provider.baseUrl)
            if (provider.headers.isNotEmpty()) {
                put("headers", buildJsonObject { provider.headers.forEach { (k, v) -> put(k, v) } })
            }
        }
        val definition = buildJsonObject {
            put("npm", "@ai-sdk/openai-compatible")
            put("name", provider.name)
            if (!environment.isNullOrBlank()) {
                put("env", buildJsonArray { add(JsonPrimitive(environment)) })
            }
            put("options", options)
            put("models", models)
        }
        val disabledAgain = buildJsonArray {
            for (item in globalDisabledProviders()) {
                val name = (item as? JsonPrimitive)?.contentOrNull
                if (name != provider.id) add(item)
            }
        }
        val config = buildJsonObject {
            put("provider", buildJsonObject { put(provider.id, definition) })
            put("disabled_providers", disabledAgain)
        }
        sendJson("global/config", "PATCH", config, "custom provider configuration")
        disposeInstance(directory)
    }

    fun deleteProvider(providerId: String, directory: String) {
        require(providerId.isNotBlank()) { "Provider is required" }

        // Delete auth
        val authResponse = delete("auth/${encode(providerId)}")
        if (authResponse.statusCode() != 404) {
            requireSuccess(authResponse, "provider auth removal")
        }

        // Delete the provider definition from config via the dedicated
        // DELETE endpoint. This directly removes the provider key from the
        // config file (no merge-patch null residue) and also cleans up
        // disabled_providers / enabled_providers entries.
        val deleteResponse = delete("provider/${encode(providerId)}?directory=${encQuery(directory)}")
        requireSuccess(deleteResponse, "provider deletion")
    }

    fun disposeInstance(directory: String) {
        postEmpty("instance/dispose?directory=${encQuery(directory)}", "project instance reload")
    }

    private fun providerPayload(directory: String): JsonObject {
        val path = "provider?directory=${encQuery(directory)}"
        val response = get(path)
        val parsed = Json.parseToJsonElement(response)
        return parsed as? JsonObject ?: buildJsonObject {}
    }

    private fun disabledProviders(directory: String): JsonArray {
        val path = "config?directory=${encQuery(directory)}"
        val response = get(path)
        val parsed = Json.parseToJsonElement(response)
        if (parsed !is JsonObject) return JsonArray(emptyList())
        return parsed["disabled_providers"] as? JsonArray ?: JsonArray(emptyList())
    }

    private fun globalDisabledProviders(): JsonArray {
        val response = get("global/config")
        val parsed = Json.parseToJsonElement(response)
        if (parsed !is JsonObject) return JsonArray(emptyList())
        return parsed["disabled_providers"] as? JsonArray ?: JsonArray(emptyList())
    }

    // Returns provider IDs that have an explicit "npm" field in the raw global
    // config — these are custom providers created via addCustomProvider (which
    // always writes npm="@ai-sdk/openai-compatible"). Built-in providers
    // connected via connectProvider only write "models" to the config; their
    // npm comes from the models.dev catalog at runtime, so it is absent from
    // the raw config. This is the single-source-of-truth way to distinguish
    // custom providers from built-in ones without a client-side registry.
    fun customProviderIds(): Set<String> {
        val response = get("global/config")
        val parsed = Json.parseToJsonElement(response) as? JsonObject ?: return emptySet()
        val providers = parsed.obj("provider") ?: return emptySet()
        return providers.entries.mapNotNull { (id, def) ->
            val defObj = def as? JsonObject ?: return@mapNotNull null
            if (defObj.str("npm") != null) id else null
        }.toSet()
    }

    /**
     * Single choke point for outgoing requests: the auth header is injected
     * here and nowhere else. The JDK HttpClient has no default-headers or
     * interceptor hook, so client-construction-time injection is not possible.
     */
    private fun newRequest(path: String, timeout: Duration): HttpRequest.Builder {
        val request = HttpRequest.newBuilder(baseUri.resolve(path))
            .timeout(timeout)
            .header("Accept", "application/json")
        authorization?.let { request.header("Authorization", it) }
        return request
    }

    private fun get(path: String): String {
        val request = newRequest(path, Duration.ofSeconds(10)).GET()
        val response = client.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
        requireSuccess(response, "DevEco Code request")
        return response.body()
    }

    private fun sendJson(path: String, method: String, body: JsonObject, operation: String) {
        val request = newRequest(path, Duration.ofSeconds(30))
            .header("Content-Type", "application/json")
            .method(method, HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
        val response = client.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
        requireSuccess(response, operation)
    }

    private fun postEmpty(path: String, operation: String) {
        val request = newRequest(path, Duration.ofSeconds(30))
            .POST(HttpRequest.BodyPublishers.noBody())
        val response = client.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
        requireSuccess(response, operation)
    }

    /** Raw DELETE; callers decide how to treat the status (deleteProvider tolerates 404). */
    private fun delete(path: String): HttpResponse<String> {
        val request = newRequest(path, Duration.ofSeconds(30)).DELETE()
        return client.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
    }

    private fun requireSuccess(response: HttpResponse<String>, operation: String) {
        if (response.statusCode() in 200..299) return
        var detail = response.body()?.trim() ?: ""
        if (detail.length > 500) detail = detail.substring(0, 500) + "…"
        throw IOException(
            "DevEco Code $operation returned HTTP ${response.statusCode()}" +
                (if (detail.isBlank()) "" else ": $detail"),
        )
    }

    private fun encQuery(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8)
    private fun encode(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20")

    private fun patchTexts(patch: String?): Pair<String?, String?> {
        if (patch.isNullOrBlank()) return null to null
        val before = StringBuilder()
        val after = StringBuilder()
        var hunk = false
        var previous = 0.toChar()
        for (line in patch.lines()) {
            if (line.startsWith("@@")) {
                hunk = true
                previous = 0.toChar()
                continue
            }
            if (!hunk) continue
            if (line == "\\ No newline at end of file") {
                if ((previous == ' ' || previous == '-') && before.isNotEmpty()) before.setLength(before.length - 1)
                if ((previous == ' ' || previous == '+') && after.isNotEmpty()) after.setLength(after.length - 1)
                continue
            }
            if (line.isEmpty()) continue
            previous = line[0]
            val text = line.substring(1)
            if (previous == ' ' || previous == '-') before.append(text).append('\n')
            if (previous == ' ' || previous == '+') after.append(text).append('\n')
        }
        if (!hunk) return null to null
        return before.toString() to after.toString()
    }

    private fun skillScope(location: String, paths: CodePaths): SkillScope {
        val skill = try {
            Path.of(location).toAbsolutePath().normalize()
        } catch (_: InvalidPathException) {
            return SkillScope.BUILTIN
        }
        val home = normalizedPath(paths.home)
        val config = normalizedPath(paths.config)
        // User-managed global skills live under <config>/skills; this is the
        // only path that stays manageable GLOBAL. Everything the previous
        // "global" scope matched is read-only built-in (see below).
        config?.resolve("skills")?.let { configSkills ->
            if (isWithin(skill, configSkills)) return SkillScope.GLOBAL
        }
        if (isWithin(skill, normalizedPath(paths.projectConfig))) return SkillScope.PROJECT
        // Built-in: the remaining paths the previous "global" scope matched.
        // Conditions are intentionally identical to before so the built-in set
        // neither expands into project paths nor shrinks (home/.claude/skills,
        // home/.agents/skills, the broad <config> fallback, and the CLI bundle).
        if (isWithin(skill, config)) return SkillScope.BUILTIN
        if (home != null) {
            if (skill.startsWith(home.resolve(".claude").resolve("skills")) ||
                skill.startsWith(home.resolve(".agents").resolve("skills"))
            ) {
                return SkillScope.BUILTIN
            }
        }
        // Project: unchanged from before — anything under the project working
        // directory or its worktree (which covers <worktree>/.deveco/skills).
        if (isWithin(skill, normalizedPath(paths.directory))) return SkillScope.PROJECT
        val worktree = normalizedPath(paths.worktree)
        if (worktree != null && worktree != home && skill.startsWith(worktree)) return SkillScope.PROJECT
        return SkillScope.BUILTIN
    }

    private fun isWithin(skill: Path, root: Path?): Boolean {
        if (root == null) return false
        return skill.startsWith(root)
    }

    private fun normalizedPath(value: String?): Path? {
        if (value.isNullOrBlank()) return null
        return runCatching { Path.of(value).toAbsolutePath().normalize() }.getOrNull()
    }

    private fun providerRank(model: ModelInfo): Int {
        val normalized = model.providerName.replace(" ", "").replace("-", "")
        return if (model.providerId.equals("opencode", ignoreCase = true) ||
            normalized.equals("devecocode", ignoreCase = true)
        ) {
            0
        } else {
            1
        }
    }

    private fun JsonObject.str(key: String): String? = this[key]
        ?.takeIf { it is JsonPrimitive }?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }

    private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
    private fun JsonObject.array(key: String): JsonArray? = this[key] as? JsonArray

    companion object {
        private val NO_PROXY_SELECTOR = object : ProxySelector() {
            override fun select(uri: URI): List<Proxy> = listOf(Proxy.NO_PROXY)
            override fun connectFailed(uri: URI, sa: SocketAddress, ioe: IOException) {}
        }
    }
}
