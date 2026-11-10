package org.deveco.code.acp

import com.intellij.openapi.diagnostic.Logger
import com.intellij.util.concurrency.AppExecutorUtil
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import org.deveco.code.MyMessageBundle
import java.io.IOException
import java.io.InputStream
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
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Structured form of the backend's `session.status` event payload.
 * `type` is "idle" | "retry" | "busy"; the remaining fields are present only on retry.
 */
internal data class SessionStatusInfo(
    val type: String,
    val attempt: Int? = null,
    val message: String? = null,
    val next: Long? = null,
)

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
        // Full SKILL.md body (frontmatter stripped) from /skill/status, which
        // spreads the skill Info schema. Empty for locally constructed entries
        // (disk scan, builtin placeholders). Used to reverse-match expanded
        // skill templates during replay (see session/model/SkillExpansion.kt).
        val content: String = "",
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
    ) {
        // Displayed verbatim by the provider combo's default renderer. The
        // "connected" suffix lives here so the combo needs no custom renderer,
        // which would bypass the platform's New UI popup styling (rounded
        // inset selection, popup spacing).
        override fun toString(): String =
            if (hasAuth) "$name (${MyMessageBundle.message("settings.models.dialog.connected")})" else name
    }
    data class ProviderModelInfo(val id: String, val name: String)
    data class CustomModel(val id: String, val name: String)
    data class CustomProvider(
        val id: String,
        val name: String,
        val baseUrl: String,
        val apiKey: String?,
        val headers: Map<String, String>,
        val models: List<CustomModel>,
        val apiNpm: String = DEFAULT_API_NPM,
    ) {
        companion object {
            // Written into the provider definition's `npm` field; the backend
            // resolves it through its bundled SDK registry (BUNDLED_PROVIDERS
            // in provider.ts), so any of the supported ids works unchanged.
            const val DEFAULT_API_NPM = "@ai-sdk/openai-compatible"
        }
    }
    data class FileEditDiff(
        val path: String,
        val additions: Int,
        val deletions: Int,
        val beforeText: String?,
        val afterText: String?,
    )

    data class SessionMessageTime(
        val id: String,
        val role: String,
        val createdAt: Long,
        val completedAt: Long?,
        val errorName: String? = null,
        val errorMessage: String? = null,
        val parentID: String? = null,
        val partIds: Set<String> = emptySet(),
        val hasSubtaskPart: Boolean = false,
        // The turn's user message carries only a compaction part: ACP replay emits
        // no chunk for it, so callers reconciling replayed USER rows must skip it.
        val hasCompactionPart: Boolean = false,
        // /debug status|clear persist a debug-state-part-only user message: replay
        // emits no user chunk for it (the marker travels as an agent chunk), so it
        // owns no local USER row and must be skipped like the compaction shape.
        // Sticky-enter turns carry a synthetic text part next to the marker and DO
        // replay into an internal-only USER row, hence the text-part companion flag.
        val hasDebugStatePart: Boolean = false,
        val hasTextPart: Boolean = false,
        val parts: List<SessionPart> = emptyList(),
    )

    data class SessionPart(val id: String, val messageID: String, val type: String, val data: JsonObject)

    data class PendingQuestionOption(val label: String, val description: String?)
    data class PendingQuestionField(
        val header: String,
        val question: String,
        val options: List<PendingQuestionOption>,
        val multiple: Boolean,
        val custom: Boolean,
    )
    data class PendingQuestion(val id: String, val sessionId: String, val fields: List<PendingQuestionField>)

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

    /**
     * Deletes one message; its parts (including admitted image blobs) go with it
     * via the storage-level cascade. Throws on a busy session — the backend
     * refuses deletes while a turn is in flight.
     */
    fun deleteMessage(sessionId: String, messageId: String, directory: String): Boolean {
        val response =
            delete("session/${encode(sessionId)}/message/${encode(messageId)}?directory=${encQuery(directory)}")
        requireSuccess(response, "message deletion")
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

    fun sessionMessages(sessionId: String, directory: String): List<SessionMessageTime> {
        val path = "session/${encode(sessionId)}/message?directory=${encQuery(directory)}&limit=0"
        val response = get(path)
        val parsed = Json.parseToJsonElement(response)
        if (parsed !is JsonArray) return emptyList()
        return parsed.mapNotNull { item ->
            val message = item as? JsonObject ?: return@mapNotNull null
            val info = message.obj("info") ?: return@mapNotNull null
            val id = info.str("id") ?: return@mapNotNull null
            val role = info.str("role") ?: return@mapNotNull null
            val time = info.obj("time") ?: return@mapNotNull null
            val created = time["created"]?.jsonPrimitive?.longOrNull ?: return@mapNotNull null
            val completed = time["completed"]?.jsonPrimitive?.longOrNull
            val error = info.obj("error")
            val errorName = error?.str("name")
            val errorMessage = error?.obj("data")?.str("message")
            val parentID = info.str("parentID")
            val parts = message["parts"]?.jsonArray.orEmpty()
            val partIds = parts.flatMap { part ->
                val value = part as? JsonObject ?: return@flatMap emptyList()
                listOfNotNull(value.str("id"), value.str("callID"))
            }.toSet()
            val hasSubtaskPart = parts.any { part -> (part as? JsonObject)?.str("type") == "subtask" }
            val hasCompactionPart = parts.any { part -> (part as? JsonObject)?.str("type") == "compaction" }
            val hasDebugStatePart = parts.any { part -> (part as? JsonObject)?.str("type") == "debug-state" }
            val hasTextPart = parts.any { part -> (part as? JsonObject)?.str("type") == "text" }
            SessionMessageTime(
                id = id,
                role = role,
                createdAt = created,
                completedAt = completed,
                errorName = errorName,
                errorMessage = errorMessage,
                parentID = parentID,
                partIds = partIds,
                hasSubtaskPart = hasSubtaskPart,
                hasCompactionPart = hasCompactionPart,
                hasDebugStatePart = hasDebugStatePart,
                hasTextPart = hasTextPart,
                parts = parts.mapNotNull { element ->
                    val part = element as? JsonObject ?: return@mapNotNull null
                    val type = part.str("type") ?: return@mapNotNull null
                    SessionPart(
                        id = part.str("id") ?: return@mapNotNull null,
                        messageID = part.str("messageID") ?: id,
                        type = type,
                        // Image file parts persist their payload as an inline data:
                        // URI. Rendering reads attachments from the local caches, so
                        // dropping the body here keeps snapshot parsing/retention from
                        // growing with every image the session ever carried.
                        data = if (type == "file") part.withoutInlineDataUri() else part,
                    )
                },
            )
        }
    }

    /** Busy session ids plus the roots that own them (a busy descendant each). */
    data class SubagentProbe(
        val roots: Set<String>,
        val busy: Set<String>,
        val parents: Map<String, String>,
        /** True when the session list hit the page cap, so [parents] is partial. */
        val truncated: Boolean,
    )

    /**
     * Roots that are idle themselves but still have a busy descendant — a
     * background subagent outliving the turn that spawned it. The backend drops
     * the parent/child ACP link as soon as the task tool part completes, so this
     * cross-reference is the only remaining signal.
     */
    fun sessionsWithBusySubagents(directory: String): SubagentProbe {
        val query = encQuery(directory)
        val status = Json.parseToJsonElement(get("session/status?directory=$query"))
        if (status !is JsonObject) return SubagentProbe(emptySet(), emptySet(), emptyMap(), false)
        val busy = status.entries.mapNotNull { (id, value) ->
            if ((value as? JsonObject)?.str("type") == "idle") null else id
        }.toSet()
        if (busy.isEmpty()) return SubagentProbe(emptySet(), emptySet(), emptyMap(), false)

        val parents = HashMap<String, String>()
        var rows = 0
        when (val sessions = Json.parseToJsonElement(get("session?directory=$query&limit=$SESSION_PAGE_LIMIT"))) {
            is JsonArray -> {
                rows = sessions.size
                for (item in sessions) {
                    val session = item as? JsonObject ?: continue
                    val id = session.str("id") ?: continue
                    session.str("parentID")?.let { parents[id] = it }
                }
            }

            else -> return SubagentProbe(emptySet(), emptySet(), emptyMap(), false)
        }

        val roots = LinkedHashSet<String>()
        for (id in busy) {
            var current = id
            var hop = 0
            while (parents.containsKey(current) && hop++ < 10) {
                current = parents[current]!!
            }
            if (current != id) roots.add(current)
        }
        return SubagentProbe(roots, busy, parents, rows >= SESSION_PAGE_LIMIT)
    }

    /** Terminal outcome of a finished subagent, read from its own session. */
    data class SubagentOutcome(val state: String, val body: String?)

    /**
     * Outcome of a session's newest assistant message, picked by created-time
     * because the paged message endpoint returns newest-first. The backend has no
     * failed session status, so the message's error is the only terminal kind.
     * Returns null when that message is not finalized yet (no time.completed):
     * the child's idle event can outrun the abort finalization that stamps the
     * error. Callers read once and settle a null (or a non-array response) as
     * completed — the merged card is corrected by the next replay — rather
     * than retry.
     */
    fun sessionFinalAssistant(sessionId: String, directory: String): SubagentOutcome? {
        val path = "session/${encode(sessionId)}/message?directory=${encQuery(directory)}&limit=50"
        val parsed = Json.parseToJsonElement(get(path)) as? JsonArray ?: return SubagentOutcome("completed", null)
        var bestCreated = -1L
        var best: JsonObject? = null
        for (item in parsed) {
            val message = item as? JsonObject ?: continue
            val info = message.obj("info") ?: continue
            if (info.str("role") != "assistant") continue
            val created = info.obj("time")?.get("created")?.jsonPrimitive?.longOrNull ?: continue
            if (created > bestCreated) {
                bestCreated = created
                best = message
            }
        }
        val message = best ?: return SubagentOutcome("completed", null)
        val info = message.obj("info") ?: return SubagentOutcome("completed", null)
        if (info.obj("time")?.get("completed")?.jsonPrimitive?.longOrNull == null) return null
        val text = message.array("parts")?.mapNotNull { part ->
            val obj = part as? JsonObject ?: return@mapNotNull null
            if (obj.str("type") != "text") null else obj.str("text")
        }?.joinToString("\n")?.takeIf { it.isNotBlank() }
        val error = info.obj("error") ?: return SubagentOutcome("completed", text)
        val reason = error.obj("data")?.str("message")
        val state = if (error.str("name") == "MessageAbortedError") "cancelled" else "error"
        return SubagentOutcome(state, text ?: reason)
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

    /** Pending question requests the backend is blocked on; used to re-render a card the ACP push missed. */
    fun pendingQuestions(directory: String): List<PendingQuestion> {
        val parsed = Json.parseToJsonElement(get("question?directory=${encQuery(directory)}"))
        if (parsed !is JsonArray) return emptyList()
        return parsed.mapNotNull { item ->
            val request = item as? JsonObject ?: return@mapNotNull null
            val id = request.str("id") ?: return@mapNotNull null
            val sessionId = request.str("sessionID") ?: return@mapNotNull null
            val questions = request.get("questions")?.jsonArray ?: return@mapNotNull null
            val fields = questions.mapNotNull { question ->
                val obj = question as? JsonObject ?: return@mapNotNull null
                PendingQuestionField(
                    header = obj.str("header").orEmpty(),
                    question = obj.str("question").orEmpty(),
                    options = obj.get("options")?.jsonArray?.mapNotNull { option ->
                        val optionObj = option as? JsonObject ?: return@mapNotNull null
                        PendingQuestionOption(
                            optionObj.str("label") ?: return@mapNotNull null,
                            optionObj.str("description"),
                        )
                    }.orEmpty(),
                    multiple = obj.get("multiple")?.jsonPrimitive?.booleanOrNull ?: false,
                    custom = obj.get("custom")?.jsonPrimitive?.booleanOrNull ?: true,
                )
            }
            PendingQuestion(id, sessionId, fields)
        }
    }

    fun replyQuestion(requestID: String, answers: List<List<String>>, directory: String) {
        val body = buildJsonObject {
            put("answers", JsonArray(answers.map { answer -> JsonArray(answer.map(::JsonPrimitive)) }))
        }
        sendJson("question/${encode(requestID)}/reply?directory=${encQuery(directory)}", "POST", body, "question reply")
    }

    fun rejectQuestion(requestID: String, directory: String) {
        postEmpty("question/${encode(requestID)}/reject?directory=${encQuery(directory)}", "question reject")
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

    data class CommandEntry(
        val name: String,
        val description: String?,
        val source: String?,
        // True when the command is explicitly configured as an isolated subtask
        // (/analyze, /review). The server replaces the typed text with a subtask
        // part, so echoing it as a user bubble would diverge from the transcript.
        // Replay emits no chunk for such a turn either, so callers keying
        // per-user-message decorations (original texts) need this flag.
        val subtask: Boolean = false,
        // The command template as the registry serves it (builtins arrive with
        // ${path} already resolved). Null when the value is not a plain string —
        // MCP prompt templates resolve lazily and never serialize to one. Lets
        // the send path echo the same expanded text the server persists.
        val template: String? = null,
    )

    // Full command registry (builtins + spec templates + skills + config commands),
    // the same source the ACP available_commands_update broadcast carries. Unlike that
    // one-shot notification this request/response path cannot be lost to a race.
    fun commands(directory: String): List<CommandEntry> {
        val path = "command?directory=${encQuery(directory)}"
        val parsed = Json.parseToJsonElement(get(path))
        if (parsed !is JsonArray) return emptyList()
        return parsed.mapNotNull { item ->
            val value = item as? JsonObject ?: return@mapNotNull null
            val name = value.str("name") ?: return@mapNotNull null
            CommandEntry(
                name = name,
                description = value.str("description"),
                source = value.str("source"),
                subtask = value["subtask"]?.jsonPrimitive?.booleanOrNull ?: false,
                template = value.str("template"),
            )
        }
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
            SkillEntry(name, value.str("description") ?: "", location, scope, enabled, value.str("content") ?: "")
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

    // Lightweight readiness probe: GET /global/health (a few dozen bytes,
    // global scope). The HTTP sidecar answers as soon as it starts listening,
    // BEFORE per-directory instance bootstrap finishes — so a true return only
    // proves the port is up, not that directory data is ready. The settings
    // page polls this until the port binds, then does one real catalog GET
    // (whose 10s timeout absorbs the instance bootstrap). get() throws on
    // non-2xx (requireSuccess) and on ConnectException (port not listening),
    // so a clean return is the right boolean signal.
    //
    // Uses a 2s timeout instead of get()'s 10s: this is a fast yes/no on
    // port binding, not a data fetch. The unbound-port case fails instantly
    // (ConnectException), but if the sidecar binds then hangs (rare, but
    // possible during startup races / AV interference), the longer timeout
    // would multiply across the 3-attempt reload poll and could block the
    // modal Settings dialog for ~30s before ERROR. 2s caps each probe at a
    // fraction of that and still tolerates a briefly slow bind.
    fun isHealthy(): Boolean = try {
        get("global/health", Duration.ofSeconds(2))
        true
    } catch (_: Exception) {
        false
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
            // A provider is authenticated when it has a top-level "key"
            // (sourced from auth.json/env) OR an options.apiKey (sourced
            // directly from a deveco.json config entry). Without the
            // options.apiKey check, models configured only in the config
            // file disappear from the dropdown after IDE restart.
            val optionsApiKey = provider.obj("options")?.str("apiKey")
            val hasKey = provider.str("key") != null || optionsApiKey != null
            if (!hasKey && !isBuiltin) return@mapNotNull null
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
            // hasAuth must reflect whether an API key is actually stored in
            // auth.json OR configured directly in the config file under
            // options.apiKey. Config-only providers never receive a
            // top-level "key" field (that is only assigned for env/auth.json
            // sourced keys), so without checking options.apiKey they would
            // be reported as disconnected and their models would be filtered
            // out of the dropdown after IDE restart.
            val optionsApiKey = provider.obj("options")?.str("apiKey")
            val hasAuth = id in connected && (provider.str("key") != null || optionsApiKey != null)
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
        val response =
            delete("provider/${encode(providerId)}/models/${encode(modelId)}?directory=${encQuery(directory)}")
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
            put("npm", provider.apiNpm)
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
    // writes the selected protocol's SDK id as npm, defaulting to
    // @ai-sdk/openai-compatible). Built-in providers connected via
    // connectProvider only write "models" to the config; their npm comes from
    // the models.dev catalog at runtime, so it is absent from the raw config.
    // This is the single-source-of-truth way to distinguish custom providers
    // from built-in ones without a client-side registry.
    fun customProviderIds(): Set<String> {
        val response = get("global/config")
        val parsed = Json.parseToJsonElement(response) as? JsonObject ?: return emptySet()
        val providers = parsed.obj("provider") ?: return emptySet()
        return providers.entries.mapNotNull { (id, def) ->
            val defObj = def as? JsonObject ?: return@mapNotNull null
            if (defObj.str("npm") != null) id else null
        }.toSet()
    }

    // Map of provider id → npm for providers whose raw global config
    // definition carries an explicit `npm` field. This is the authoritative
    // protocol of a custom provider: the plugin's own registry can lag behind
    // hand edits of the config, and npm values outside the dialog's known
    // protocols (e.g. a hand-edited @ai-sdk/groq) must be preserved through
    // edit/rebuild flows instead of being silently rewritten to the default.
    fun customProviderNpms(): Map<String, String> {
        val response = get("global/config")
        val parsed = Json.parseToJsonElement(response) as? JsonObject ?: return emptyMap()
        val providers = parsed.obj("provider") ?: return emptyMap()
        return providers.entries.mapNotNull { (id, def) ->
            val defObj = def as? JsonObject ?: return@mapNotNull null
            defObj.str("npm")?.let { npm -> id to npm }
        }.toMap()
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

    private fun get(path: String): String = get(path, Duration.ofSeconds(10))

    private fun get(path: String, timeout: Duration): String {
        val request = newRequest(path, timeout).GET()
        val response = client.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
        requireSuccess(response, "DevEco Code request")
        return response.body()
    }

    /**
     * Long-lived SSE request. The timeout bounds the header wait only — verified
     * against a live stream: a 5s timeout leaves a 30s+ heartbeat stream intact.
     * Without it, a server that accepts the connection but never answers would
     * park this thread forever while [GlobalEventStream] still had no stream to
     * close.
     */
    internal fun openEventStream(): InputStream {
        val request = newRequest("global/event", Duration.ofMillis(EVENT_HEADERS_TIMEOUT_MS)).GET()
        val response = client.send(request.build(), HttpResponse.BodyHandlers.ofInputStream())
        if (response.statusCode() !in 200..299) {
            runCatching { response.body()?.close() }
            throw IOException("DevEco Code global event stream returned HTTP ${response.statusCode()}")
        }
        return response.body()
    }

    /** See [GlobalEventStream]: one reader thread with reconnect and resync. */
    internal fun openGlobalEventStream(
        onStatus: (directory: String, sessionId: String, status: SessionStatusInfo) -> Unit,
        onResync: () -> Unit,
    ): GlobalEventStream {
        val stream = GlobalEventStream(onStatus, onResync)
        stream.start()
        return stream
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

    /** Blanks an inline `data:` URI (base64 media body) while keeping the part's other fields. */
    private fun JsonObject.withoutInlineDataUri(): JsonObject {
        val url = str("url") ?: return this
        if (!url.startsWith("data:")) return this
        return JsonObject(toMutableMap().apply { put("url", JsonPrimitive("")) })
    }

    /**
     * Reader for /global/event. One daemon thread owns the connection and its
     * reconnection; a watchdog closes a stream that stops heartbeating so a
     * half-dead socket cannot masquerade as live. Only session.status events are
     * forwarded — everything else is dropped without logging.
     */
    internal inner class GlobalEventStream(
        private val onStatus: (directory: String, sessionId: String, status: SessionStatusInfo) -> Unit,
        private val onResync: () -> Unit,
    ) {
        private val closed = AtomicBoolean(false)
        private val lastAliveAt = AtomicLong(System.currentTimeMillis())
        private val current = AtomicReference<InputStream>()
        private val watchdog = AppExecutorUtil.getAppScheduledExecutorService()
            .scheduleWithFixedDelay({ closeIfStale() }, HEARTBEAT_GRACE_MS, HEARTBEAT_GRACE_MS, TimeUnit.MILLISECONDS)
        private val reader = Thread(::readLoop, "deveco-global-event-stream").apply { isDaemon = true }

        fun start() {
            reader.start()
        }

        fun close() {
            if (!closed.compareAndSet(false, true)) return
            watchdog.cancel(false)
            runCatching { current.get()?.close() }
            reader.interrupt()
        }

        private fun closeIfStale() {
            if (closed.get()) return
            if (System.currentTimeMillis() - lastAliveAt.get() <= HEARTBEAT_GRACE_MS) return
            runCatching { current.get()?.close() }
        }

        private fun readLoop() {
            var backoff = RECONNECT_BASE_MS
            while (!closed.get()) {
                try {
                    openEventStream().use { input ->
                        current.set(input)
                        // close() may have run while the request was in flight;
                        // its current.get() was null then, so re-check here.
                        if (closed.get()) return@use
                        lastAliveAt.set(System.currentTimeMillis())
                        backoff = RECONNECT_BASE_MS
                        onResync()
                        input.bufferedReader().useLines { lines ->
                            for (line in lines) {
                                if (closed.get()) break
                                lastAliveAt.set(System.currentTimeMillis())
                                if (line.startsWith("data:")) handle(line.substring(5).trim())
                            }
                        }
                    }
                } catch (e: Exception) {
                    if (closed.get()) return
                    log.debug("Global event stream dropped, reconnecting in ${backoff}ms", e)
                } finally {
                    current.set(null)
                }
                if (closed.get()) return
                try {
                    Thread.sleep(backoff)
                } catch (e: InterruptedException) {
                    return
                }
                backoff = minOf(backoff * 2, RECONNECT_MAX_MS)
            }
        }

        private fun handle(payload: String) {
            val envelope = runCatching { Json.parseToJsonElement(payload) as? JsonObject }.getOrNull() ?: return
            val event = envelope.obj("payload") ?: return
            if (event.str("type") != "session.status") return
            val directory = envelope.str("directory") ?: return
            val properties = event.obj("properties") ?: return
            val sessionId = properties.str("sessionID") ?: return
            val statusObj = properties.obj("status") ?: return
            val type = statusObj.str("type") ?: return
            val info = SessionStatusInfo(
                type = type,
                attempt = (statusObj["attempt"] as? JsonPrimitive)?.intOrNull,
                message = statusObj.str("message"),
                next = (statusObj["next"] as? JsonPrimitive)?.longOrNull,
            )
            onStatus(directory, sessionId, info)
        }
    }

    companion object {
        private val log = Logger.getInstance(DevEcoHttpApi::class.java)

        // The server heartbeats every 10s; two missed beats mean the socket lies.
        private const val HEARTBEAT_GRACE_MS = 30_000L
        private const val RECONNECT_BASE_MS = 1_000L
        private const val RECONNECT_MAX_MS = 15_000L
        private const val EVENT_HEADERS_TIMEOUT_MS = 30_000L
        private const val SESSION_PAGE_LIMIT = 1000

        private val NO_PROXY_SELECTOR = object : ProxySelector() {
            override fun select(uri: URI): List<Proxy> = listOf(Proxy.NO_PROXY)
            override fun connectFailed(uri: URI, sa: SocketAddress, ioe: IOException) {}
        }
    }
}
