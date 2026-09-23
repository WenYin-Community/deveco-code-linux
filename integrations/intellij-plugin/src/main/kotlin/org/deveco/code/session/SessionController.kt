package org.deveco.code.session

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentclientprotocol.model.*
import com.intellij.openapi.application.ApplicationManager
import kotlinx.coroutines.CancellationException
import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.deveco.code.acp.AcpClientService
import org.deveco.code.action.DevEcoSessionActions
import org.deveco.code.MyMessageBundle
import org.deveco.code.util.errorMessage
import org.deveco.code.acp.AcpToolInputParser
import org.deveco.code.acp.AcpSessionUpdate
import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.session.SessionStorage
import org.deveco.code.skill.SkillStore
import org.deveco.code.session.SESSION_REFRESH_TOPIC
import org.deveco.code.session.SessionRefreshListener
import org.deveco.code.session.model.ChatItem
import org.deveco.code.session.model.ChatRole
import org.deveco.code.session.model.isTodoTool
import org.deveco.code.session.model.LabeledChoice
import org.deveco.code.session.model.AttachmentItem
import org.deveco.code.session.model.CommandChoice
import org.deveco.code.session.model.CommandKind
import org.deveco.code.session.model.CommandKindInference
import org.deveco.code.session.model.FileReference
import org.deveco.code.session.model.ModeChoice
import org.deveco.code.session.model.ModelChoice
import org.deveco.code.session.model.PermissionChoice
import org.deveco.code.session.model.PermissionMode
import org.deveco.code.session.model.SessionViewState
import org.deveco.code.session.ui.composer.isTextLikeMimeType
import java.io.File
import java.util.Base64
import java.util.concurrent.CompletableFuture

private data class ToolUpdate(
    val id: String,
    val title: String?,
    val kind: ToolKind?,
    val status: ToolCallStatus?,
    val content: List<ToolCallContent>?,
    val rawInput: Any?,
    val rawOutput: Any?,
    val locations: List<ToolCallLocation>?,
)

internal enum class TodoDockStatus {
    COMPLETED, IN_PROGRESS, PENDING, CANCELLED;

    companion object {
        fun fromString(s: String?): TodoDockStatus = when (s?.lowercase()?.replace("-", "_")) {
            "completed", "done" -> COMPLETED
            "in_progress", "inprogress", "running", "active" -> IN_PROGRESS
            "cancelled", "canceled" -> CANCELLED
            else -> PENDING
        }
    }
}

internal data class TodoDockItem(
    val content: String,
    val status: TodoDockStatus,
    val toolItemId: String,
)

internal fun parseTodoDockItems(rawInput: Any?, toolItemId: String): List<TodoDockItem> {
    val values: Map<*, *>? = when (rawInput) {
        is JsonObject -> rawInput
        is Map<*, *> -> rawInput
        is String -> try { Json.parseToJsonElement(rawInput) as? JsonObject } catch (e: Exception) { null }
        else -> null
    }
    val todosValue = values?.get("todos") ?: values?.get("tasks") ?: values?.get("items")
    val items: List<*>? = when (todosValue) {
        is JsonArray -> todosValue
        is List<*> -> todosValue
        else -> null
    }
    return items?.mapNotNull { item ->
        val itemMap = when (item) {
            is JsonObject -> item
            is Map<*, *> -> item
            else -> null
        } ?: return@mapNotNull null
        val content = when (val v = itemMap["content"] ?: itemMap["task"] ?: itemMap["description"]) {
            is String -> v
            is JsonPrimitive -> v.contentOrNull
            else -> null
        } ?: return@mapNotNull null
        val status = when (val v = itemMap["status"] ?: itemMap["state"]) {
            is String -> v
            is JsonPrimitive -> v.contentOrNull
            else -> null
        }
        TodoDockItem(content, TodoDockStatus.fromString(status), toolItemId)
    } ?: emptyList()
}

/**
 * Heuristic TODO completion inference.
 *
 * When the agent calls TODO tool infrequently (only at start and end), the dock
 * would jump from 0/N to N/N. This function infers incremental completions by
 * matching completed non-TODO tool calls against pending TODO items using
 * layered matching strategies:
 *
 * 1. File path exact match (most reliable)
 * 2. Keyword match (build/run/check → shell tool)
 * 3. Sequential fallback (next pending item, least reliable)
 */
private fun tryInferTodoCompletion(
    completedToolKind: ToolKind?,
    completedToolPath: String?,
    completedToolTitle: String,
    completedToolText: String,
    baseline: List<TodoDockItem>,
    inferredCompleted: MutableSet<Int>,
): Int? {
    if (baseline.isEmpty()) return null

    // Build set of candidate indices (pending items not yet inferred as completed)
    val candidates = baseline.indices.filter {
        it !in inferredCompleted && baseline[it].status == TodoDockStatus.PENDING
    }
    if (candidates.isEmpty()) return null

    // Layer 1: File path exact match
    if (!completedToolPath.isNullOrBlank()) {
        val normalizedPath = completedToolPath.replace("\\", "/")
        val matched = candidates.firstOrNull { idx ->
            val todoContent = baseline[idx].content
            // Check if TODO content contains the file path (case-insensitive)
            todoContent.contains(normalizedPath, ignoreCase = true) ||
                // Also check just the filename
                normalizedPath.substringAfterLast('/').let { fileName ->
                    todoContent.contains(fileName, ignoreCase = true)
                }
        }
        if (matched != null) return matched
    }

    // Layer 2: Keyword match for shell/execute tools
    val shellKeywords = listOf("build", "run", "check", "lint", "test", "compile")
    if (completedToolKind == ToolKind.EXECUTE) {
        val matched = candidates.firstOrNull { idx ->
            val todoContent = baseline[idx].content.lowercase()
            shellKeywords.any { kw -> todoContent.contains(kw) }
        }
        if (matched != null) return matched
    }

    // Layer 3: Title/text keyword match for edit/delete tools
    if (completedToolKind == ToolKind.EDIT || completedToolKind == ToolKind.DELETE) {
        val matched = candidates.firstOrNull { idx ->
            val todoContent = baseline[idx].content.lowercase()
            val titleLower = completedToolTitle.lowercase()
            val textLower = completedToolText.lowercase()
            // Check if TODO content keywords appear in tool title or text
            todoContent.split(" ").filter { it.length > 3 }.any { word ->
                titleLower.contains(word) || textLower.contains(word)
            }
        }
        if (matched != null) return matched
    }

    // Layer 4: Sequential fallback - match next pending item in order
    return candidates.minOrNull()
}

@Suppress("TooManyFunctions")
internal class SessionController(
    initialSessionId: String,
    private val service: AcpClientService,
    private val modelStore: SessionModelStore,
    private val tokenUsageStore: TokenUsageStore,
    private val messageStore: SessionMessageStore,
    restoredState: SessionViewState?,
    internal val project: com.intellij.openapi.project.Project,
    private val onLoaded: () -> Unit,
) {
    private val log = Logger.getInstance(SessionController::class.java)

    // Mutable session ID: replaced when editing a message creates a new backend session.
    // @Volatile: written on the EDT, read by ACP notification threads in onSessionUpdate.
    @Volatile
    internal var sessionId: String = initialSessionId

    // ------------------------------------------------------------------------------------
    // Shared constants / pure helpers. These have ZERO dependency on instance state so they
    // live in a companion. Putting them at file-level would pollute the package namespace.
    // ------------------------------------------------------------------------------------
    companion object {
        private const val MAX_COMPACTIONS = 3

        // 默认模型：新建/首次打开项目（本项目从未配置过模型）时自动选择 GLM-5.1，而非 Auto 或后端默认模型
        private const val DEFAULT_MODEL_NAME = "GLM-5.1"

        // 精确匹配 "DevEco Code/GLM-5.1" 或 "DevEco Code\GLM-5.1"（大小写不敏感），
        // 排除其他来源的同名模型（如 Alibaba(China)/GLM-5.1）
        private fun isDefaultModelChoice(choice: ModelChoice): Boolean {
            val normalized = choice.name.replace('\\', '/')
            val prefix = "deveco code/"
            return normalized.length > prefix.length &&
                normalized.substring(0, prefix.length).equals(prefix, ignoreCase = true) &&
                normalized.substring(prefix.length).equals(DEFAULT_MODEL_NAME, ignoreCase = true)
        }

        // 已知支持图片输入的模型名称模式（允许列表）。
        // 只有模型名命中以下任一模式时才显示"选择图片"选项。
        // 新增支持图片的模型时，在此列表添加对应模式即可。
        private val IMAGE_MODEL_PATTERNS = listOf(
            "vision",       // e.g. GPT-4 Vision, Qwen-Vision
            "-vl", "vl-",   // e.g. Qwen-VL, InternVL
            "4v",           // e.g. GLM-4V, GLM-4.5V
            "4o",           // e.g. GPT-4o
            "gemini",       // Gemini 系列
            "claude-3",     // Claude 3 系列
            "claude-4",     // Claude 4 系列
            "multimodal",   // 显式多模态模型
            "internvl",     // InternVL
            "minicpm-v",    // MiniCPM-V
        )

        private fun modelSupportsImages(model: ModelChoice?): Boolean {
            if (model == null) return false
            val name = model.name.lowercase()
            return IMAGE_MODEL_PATTERNS.any { name.contains(it) }
        }

        private const val DEFAULT_TOTAL_TOKENS = 170_000L
        private const val MAX_PROMPT_HISTORY = 50
        private const val MAX_TITLE_LEN = 50
        private const val COMPACTION_RATIO_THRESHOLD = 0.70

        // Max bytes of a text attachment to inline verbatim; anything beyond gets a "[truncated N chars]" trailer.
        private const val MAX_INLINED_TEXT_BYTES = 60_000

        // Max total number of attachments + file references per prompt.
        const val MAX_ATTACHMENTS = 20

        // Decode bytes as UTF-8. Invalid sequences become replacement chars; never throws.
        private fun decodeTextBytes(bytes: ByteArray): String = String(bytes, Charsets.UTF_8)


    }

    val messages = mutableStateListOf<ChatItem>()
    val expandedThoughts = mutableStateMapOf<String, Boolean>()
    val expandedTools = mutableStateMapOf<String, Boolean>()
    val permissionChoices = mutableStateMapOf<String, List<PermissionChoice>>()
    val permissionResults = mutableStateMapOf<String, String>()
    private val deniedPermissions = mutableStateMapOf<String, Boolean>()
    val permissionDeniedIds: Set<String> get() = deniedPermissions.keys
    val attachments = mutableStateListOf<AttachmentItem>()

    val fileReferences = mutableStateListOf<FileReference>()

    val isAttachmentLimitReached: Boolean
        get() = attachments.size + fileReferences.size >= Companion.MAX_ATTACHMENTS

    var permissionMode by mutableStateOf(PermissionMode.RECOMMENDED)
        private set

    var usedTokens by mutableStateOf(0L)
        private set
    var totalTokens by mutableStateOf(0L)
        private set
    var customTokenLimit by mutableStateOf(0L)
        private set

    init {
        // Synchronously restore persisted token usage so the first render sees the real value
        // instead of briefly flashing the 200K default placeholder.
        tokenUsageStore.getUsage(sessionId)?.let { (u, t, c) ->
            usedTokens = u
            totalTokens = t
            if (c > 0) customTokenLimit = c
        }
        restoredState?.let {
            expandedThoughts.putAll(it.expandedThoughts)
            expandedTools.putAll(it.expandedTools)
            fileReferences.addAll(it.fileReferences)
        }
    }

    val effectiveTotalTokens: Long
        get() = when {
            customTokenLimit > 0 -> customTokenLimit
            totalTokens > 0      -> totalTokens
            else                 -> DEFAULT_TOTAL_TOKENS
    }

    val tokenThreshold: Long
        get() = if (totalTokens > 0) totalTokens else DEFAULT_TOTAL_TOKENS

    var lastDuration by mutableStateOf(0L)
        private set

    fun getPromptDuration(): Long {
        return if (promptStartMs > 0) System.currentTimeMillis() - promptStartMs else lastDuration
    }

    var memoryLimitReached by mutableStateOf(false)
        private set

    @Volatile
    private var compactionCount = 0
    @Volatile
    private var compacting = false
    private var promptStartMs by mutableStateOf(0L)

    var status by mutableStateOf(MyMessageBundle.message("session.status.loading"))
        private set
    var ready by mutableStateOf(false)
        private set
    var sendTick by mutableStateOf(0)
        private set
    var responding by mutableStateOf(false)
        private set
    var todoDockItems by mutableStateOf<List<TodoDockItem>>(emptyList())
        private set
    // Heuristic TODO inference state
    @Volatile
    private var todoInferBaseline: List<TodoDockItem> = emptyList()
    @Volatile
    private var todoInferredCompleted: MutableSet<Int> = mutableSetOf()
    @Volatile
    private var nonTodoCompletedSinceTodo: Int = 0
    @Volatile
    private var lastTodoUpdateMs: Long = 0
    var models by mutableStateOf(emptyList<ModelChoice>())
        private set
    // Backend models filtered to connected providers and the blacklist;
    // blacklistListener re-filters on change without re-fetching.
    @Volatile
    private var rawModels: List<ModelChoice> = emptyList()
    // Backend-sourced models (from ACP session config). Kept separately so
    // that refreshModels can rebuild rawModels without losing the backend
    // portion.
    @Volatile
    private var backendModels: List<ModelChoice> = emptyList()
    var selectedModel by mutableStateOf<ModelChoice?>(null)
        private set
    var modes by mutableStateOf(emptyList<ModeChoice>())
        private set
    var selectedMode by mutableStateOf<ModeChoice?>(null)
        private set
    var commands by mutableStateOf(emptyList<CommandChoice>())
        private set
    // `commands` is the union of non-skill server commands (init/review/...)
    // and skill commands filtered by the user's per-scope selection. Skills are
    // sourced solely from /skill (which carries scope for priority de-dup);
    // available_commands only contributes non-skill commands, with any name
    // that is a known skill excluded so a skill can never appear in both lists.
    @Volatile
    private var nonSkillCommands: List<CommandChoice> = emptyList()
    @Volatile
    private var skillCommands: List<CommandChoice> = emptyList()
    @Volatile
    private var skillScopeByName: Map<String, DevEcoHttpApi.SkillScope> = emptyMap()
    @Volatile
    private var lastAvailableCommandsUpdate: SessionUpdate.AvailableCommandsUpdate? = null
    @Volatile
    private var lastAcuNames: Set<String> = emptySet()
    @Volatile
    private var lastSkillEntries: List<DevEcoHttpApi.SkillEntry> = emptyList()
    @Volatile
    private var lastDiskEntries: List<DevEcoHttpApi.SkillEntry> = emptyList()
    @Volatile
    private var skillDataLoaded = false
    var supportsImages by mutableStateOf(false)
        private set

    // Prompt history for Up/Down arrow navigation (newest first, capped at 50).
    // When the user presses Up we walk backwards through previously sent prompts; Down walks
    // forward toward the most recent or an empty draft.
    private val promptHistory = mutableStateListOf<String>()
    @Volatile
    private var historyIndex = -1

    /**
     * Navigate prompt history. `direction < 0` = older (Up arrow), `direction > 0` = newer
     * (Down arrow). Returns the prompt text at the target position, or `null` if we should
     * show an empty draft (i.e. we've exhausted the history in that direction).
     */
    fun navigateHistory(direction: Int): String? {
        if (promptHistory.isEmpty()) return null
        historyIndex = when {
            direction < 0 -> (historyIndex + 1) % promptHistory.size
            historyIndex <= 0 -> -1
            else -> historyIndex - 1
        }
        return if (historyIndex >= 0) promptHistory[historyIndex] else null
    }

    fun saveToHistory(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        // Avoid consecutive duplicates (common when the user resends the same prompt after an
        // error) while still allowing the same prompt at different positions later on.
        if (promptHistory.firstOrNull() != trimmed) {
            promptHistory.add(0, trimmed)
            if (promptHistory.size > MAX_PROMPT_HISTORY) promptHistory.removeAt(promptHistory.lastIndex)
        }
        historyIndex = -1
    }

    fun resetHistoryIndex() { historyIndex = -1 }

    // Rebuild promptHistory (newest-first, deduplicated, capped at 50) from the restored USER
    // messages. Called after SessionMessageStore restores messages in loadSession() so that
    // Up/Down arrow history navigation keeps working when a project is reopened.
    //
    // promptHistory itself is never persisted —only the rendered USER ChatItem is. So we
    // reconstruct the history from those items. We skip entries whose original text was blank
    // (attachment-only prompts render as "📎 name1, name2"), which saveToHistory() would also
    // have skipped because it returns early on blank trimmed text.
    private fun rebuildPromptHistoryFrom(restoredMessages: List<ChatItem>) {
        promptHistory.clear()
        historyIndex = -1
        // `messages` are chronological (oldest first); promptHistory is newest-first.
        val restored = restoredMessages
            .asReversed()
            .filter { it.role == ChatRole.USER }
            .map { it.text.trim() }
            .filter { it.isNotEmpty() && !it.startsWith("📎 ") }
        // Mirror saveToHistory's consecutive-duplicate suppression so a restored history
        // matches what the user would have seen if they'd kept the session open.
        for (text in restored) {
            if (promptHistory.firstOrNull() != text) {
                promptHistory.add(text)
                if (promptHistory.size >= MAX_PROMPT_HISTORY) break
            }
        }
    }

    // Image viewer state —shared between composer (pre-send) and message list (post-send).
    var viewerBytes by mutableStateOf<ByteArray?>(null)
        private set
    fun showImageViewer(bytes: ByteArray) { viewerBytes = bytes }
    fun dismissImageViewer() { viewerBytes = null }

    @Volatile
    private var modelConfigId: String? = null
    @Volatile
    private var activeThoughtId: String? = null
    @Volatile
    private var prompting = false
    @Volatile
    private var pendingModelRefresh = false
    @Volatile
    private var cancelled = false
    @Volatile
    private var stopped = false
    @Volatile
    private var disposed = false
    @Volatile
    private var sessionLoading = false
    @Volatile
    private var restoredFromLocalStore = false
    @Volatile
    private var started = false
    // Headless mode: the editor closed while a turn is in flight; the registry keeps
    // this controller alive so the response keeps streaming and persisting.
    @Volatile
    internal var detached = false
        private set
    // Fires when the in-flight turn finishes while headless; cleared on re-attach.
    @Volatile
    private var onTurnCompleted: (() -> Unit)? = null
    private val pendingPermissions = mutableListOf<CompletableFuture<RequestPermissionResponse>>()
    private val listener: (AcpSessionUpdate) -> Unit = ::onSessionUpdate
    private val editTracker = ToolEditTracker(sessionId, project.basePath ?: "")
    private val messageBusConnection = project.messageBus.connect()
    private val permissionHandler: (RequestPermissionRequest) -> RequestPermissionResponse? =
        ::onPermissionRequest
    private val globalModelListener: (String?) -> Unit = { newModelId ->
        if (newModelId != null && ready && models.isNotEmpty()) {
            val model = models.firstOrNull { it.modelId == newModelId }
            if (model != null && model.id != selectedModel?.id) {
                // Simple MutableState write —Compose snapshot system is multi-thread safe, no EDT
                // needed. Running this via updateUi{} would risk dropping it when disposed=true.
                selectedModel = model
                supportsImages = modelSupportsImages(model)
                modelStore.setModelId(sessionId, model.modelId)
                ApplicationManager.getApplication().executeOnPooledThread {
                    try {
                        service.setSessionConfigOption(sessionId, modelConfigId ?: return@executeOnPooledThread, model.id)
                    } catch (e: Exception) {
                        log.warn("Failed to set session config option", e)
                    }
                }
            }
        }
    }

    // Re-filters models when the blacklist changes; falls back to the
    // default model if the current selection was just blacklisted. Deferred
    // to the end of an in-flight prompt, same as refreshModels.
    private val blacklistListener: () -> Unit = {
        if (prompting) {
            pendingModelRefresh = true
        } else {
            rebuildRawModels()
            val current = selectedModel
            if (current != null && models.none { it.id == current.id }) {
                selectFallbackModel()
            }
        }
    }

    fun start() {
        // Idempotent: re-attached headless controllers are already started.
        if (started) return
        started = true
        service.addSessionListener(listener)
        service.addPermissionHandler(permissionHandler)
        modelStore.addGlobalModelListener(globalModelListener)
        modelStore.addBlacklistListener(blacklistListener)
        messageBusConnection.subscribe(SESSION_REFRESH_TOPIC, SessionRefreshListener {
            refreshCommands()
            refreshModels()
        })
        ApplicationManager.getApplication().executeOnPooledThread { loadSession() }
    }

    fun stopSession() {
        ApplicationManager.getApplication().executeOnPooledThread {
            service.cancelSession(sessionId)
        }
        // 清空当前会话待处理的授权请求
        permissionChoices.clear()
    }

    /** True while a prompt round-trip is in flight (sendPrompt / regenerateMessage). */
    internal val isTurnActive: Boolean
        get() = prompting

    /** True once [start] has run; a headless-reused controller is already started. */
    internal val isStarted: Boolean
        get() = started

    /** The session's editor was (re)opened: leave headless mode. */
    internal fun markAttached() {
        detached = false
        onTurnCompleted = null
    }

    /** The editor closed while a turn is in flight: stay headless until [onTurnFinished] fires. */
    internal fun markDetached(onTurnFinished: () -> Unit) {
        detached = true
        onTurnCompleted = onTurnFinished
    }

    private fun cancelPendingTodos() {
        todoDockItems = todoDockItems.map {
            if (it.status == TodoDockStatus.IN_PROGRESS) it.copy(status = TodoDockStatus.CANCELLED) else it
        }
    }

    fun refreshCommands() {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                // Read /skill WITHOUT disposing first. refreshInstance (dispose)
                // makes the backend re-scan, and for skills whose name collides
                // across scopes the rescan returns a non-deterministic
                // location/scope each time — which made the `/` popup flicker
                // between two different lists. The running instance already
                // carries a stable skill set; reads are idempotent.
                val skills = SkillStore.stableSkillEntries(service)
                // Retry skill preference PATCHes that failed earlier — the
                // backend has now re-discovered the skills (stableSkillEntries
                // waited for the re-scan to settle), so the PATCH can succeed.
                SkillStore.syncPendingSkillPrefs(project, skills.map { it.name }.toSet())
                val disk = SkillStore.diskUserSkillEntries(project, service, skills)
                lastSkillEntries = skills
                lastDiskEntries = disk
                skillScopeByName = skills.associate { it.name to it.scope }
                skillDataLoaded = true
                rebuildCommands()
            } catch (e: Exception) {
                log.warn("refreshCommands failed for $sessionId", e)
            }
        }
    }

    // Re-fetches the model list from the backend session config. Called on
    // SESSION_REFRESH_TOPIC so that model additions/deletions/API-key resets
    // in the settings page are reflected in the dropdown. The backend disposer
    // (in acp/service.ts) synchronously refreshes the directory cache and clears
    // sessionSnapshots during disposeInstance, so loadSession() returns fresh
    // data immediately — no sleep or retry needed.
    // Phased rebuild: if this session is mid-prompt, defer the refresh until
    // the prompt completes (checked in the prompt finally block) to avoid
    // racing with the in-flight ACP stream.
    private fun refreshModels() {
        if (prompting) {
            pendingModelRefresh = true
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                refreshCatalogAndModels()
            } catch (e: Exception) {
                log.warn("refreshModels failed for $sessionId", e)
            }
        }
    }

    private fun refreshCatalogAndModels() {
        val catalog = runCatching { service.modelCatalog() }.getOrElse { emptyList() }
        val providers = runCatching { service.availableProviders() }.getOrElse { emptyList() }
        val disconnectedIds = providers.filter { !it.hasAuth }.map { it.id }.toSet()
        val filteredCatalog = if (catalog.isNotEmpty() && disconnectedIds.isNotEmpty()) {
            catalog.filter { it.providerId !in disconnectedIds }
        } else {
            catalog
        }
        if (filteredCatalog.isNotEmpty()) modelStore.cacheCatalog(filteredCatalog)
        val configOptions = runCatching { service.loadSession(sessionId) }.getOrNull()
        if (configOptions != null) {
            ApplicationManager.getApplication().invokeLater {
                updateConfigOptions(configOptions)
            }
            log.info("refreshCatalogAndModels: sessionId=$sessionId catalogSize=${catalog.size} filteredSize=${filteredCatalog.size} configOptions=${configOptions.size}")
        } else {
            log.warn("refreshCatalogAndModels: sessionId=$sessionId loadSession returned null")
        }
    }

    // backendModels (from loadSession) is the single source of truth —
    // the backend's model Select choices only includes models the backend
    // can actually serve. The backend disposer (registered in acp/service.ts)
    // refreshes the directory cache + sessionSnapshots on disposeInstance,
    // so loadSession() returns fresh data after any config change.
    // Filter by connection state: show models from providers with a
    // stored API key (in cachedCatalog), plus manual-type providers whose
    // API key is optional. Then drop blacklisted models. Called from
    // updateModels, refreshModels (SESSION_REFRESH_TOPIC) and blacklistListener.
    private fun rebuildRawModels() {
        val cachedCatalog = modelStore.getCachedCatalog()
        val connectedProviderIds = cachedCatalog.map { it.providerId.lowercase() }.toSet()
        val manualProviderIds = modelStore.getProviderTypes()
            .filter { it.type == "manual" }
            .map { it.providerId.lowercase() }
            .toSet()
        val blacklistedIds = modelStore.getBlacklist()
            .map { "${it.providerId}/${it.modelId}" }
            .toSet()
        rawModels = if (connectedProviderIds.isNotEmpty() || manualProviderIds.isNotEmpty()) {
            backendModels.filter {
                (it.providerId.lowercase() in connectedProviderIds ||
                    it.providerId.lowercase() in manualProviderIds) &&
                    it.id !in blacklistedIds
            }
        } else {
            backendModels.filter { it.id !in blacklistedIds }
        }
        models = rawModels
        log.info("rebuildRawModels: backendModels=${backendModels.size} cachedCatalogProviders=${connectedProviderIds} manualProviders=${manualProviderIds} blacklisted=${blacklistedIds.size} models=${models.size} modelIds=${models.map { it.id }}")
    }

    // Called when the currently selected model is no longer in the filtered
    // list (blacklisted or provider disconnected). Falls back to the built-in
    // default model (deveco code/GLM-5.1), or the first available model if
    // the built-in isn't present. Updates selectedModel, globalModelId, and
    // pushes the new selection to the backend.
    private fun selectFallbackModel() {
        // Identify the built-in (deveco) model by providerId from the cached
        // catalog — NOT by model name, because provider models (e.g.
        // alibaba-cn) can have the same model name (e.g. GLM-5.1).
        val builtinModelIds = modelStore.getCachedCatalog()
            .filter { it.providerId.equals("deveco", ignoreCase = true) }
            .map { "${it.providerId}/${it.modelId}" }
            .toSet()
        val fallback = models.firstOrNull { it.id in builtinModelIds }
            ?: models.firstOrNull()
        if (fallback == null) {
            selectedModel = null
            return
        }
        selectedModel = fallback
        supportsImages = modelSupportsImages(fallback)
        modelStore.setGlobalModelId(fallback.modelId)
        modelStore.setModelId(sessionId, fallback.modelId)
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val configId = modelConfigId ?: return@executeOnPooledThread
                service.setSessionConfigOption(sessionId, configId, fallback.id)
            } catch (e: Exception) {
                log.warn("selectFallbackModel: setSessionConfigOption failed, clearing globalModelId", e)
                modelStore.setGlobalModelId(null)
            }
        }
    }

    /**
     * `available_commands` only contributes non-skill server commands (init,
     * review, ...). Any name that is a known skill (present in the /skill scope
     * cache, or flagged by _meta) is dropped here so it can never also appear in
     * the skill list built by [rebuildCommands] — that overlap produced
     * duplicate `/skill` entries in the popup.
     */
    private fun applyAvailableCommands(update: SessionUpdate.AvailableCommandsUpdate) {
        val names = update.availableCommands.map { it.name }.toSet()
        val changed = names != lastAcuNames
        lastAcuNames = names
        lastAvailableCommandsUpdate = update
        // Always rebuild sync — non-skill commands use the just-arrived fresh
        // data; skill commands use cached data (brief flicker only if skill
        // data is stale, fixed by the async refresh below).
        rebuildCommands()
        if (changed) refreshCommands()
    }

    private fun rebuildCommands() {
        val available = lastAvailableCommandsUpdate?.availableCommands ?: emptyList()
        val availableNames = available.map { it.name }.toSet()
        // A command is a skill if it lives in the /skill or on-disk caches, OR
        // if the backend tagged it via _meta.source == "skill". The old code
        // folded ALL available_names in, which made /init, /review, ... satisfy
        // the "is a skill" filter and wiped nonSkillCommands — so every plain
        // slash command vanished from the popup.
        val allSkillNames = (
            lastSkillEntries.map { it.name } +
            lastDiskEntries.map { it.name } +
            available.filter { sourceOf(it._meta).equals("skill", true) }.map { it.name }
        ).toSet()
        if (skillDataLoaded) {
            skillCommands = SkillStore.filterSlashSkills(lastSkillEntries, lastDiskEntries, project, availableNames)
                .map { CommandChoice(it.name, it.description, CommandKind.SKILL) }
        }
        // Non-skill: available_commands minus any name that is a known skill.
        // Also exclude internal prompt-template commands (contain ':') that
        // are not meant to be user-facing slash commands.
        nonSkillCommands = available
            .filter { it.name !in allSkillNames && !it.name.contains(':') }
            .map { CommandChoice(it.name, it.description ?: "", CommandKindInference.infer(it.name, sourceOf(it._meta))) }
        commands = nonSkillCommands + skillCommands
    }

    fun sendPrompt(text: String): Boolean {
        val value = text.trim()
        val hasAttachments = attachments.isNotEmpty()
        val fileRefs = fileReferences.toList()
        if (value.isEmpty() && !hasAttachments && fileRefs.isEmpty()) return false
        if (!ready || memoryLimitReached) return false
        val attachmentList = if (hasAttachments) attachments.toList() else emptyList()
        if (hasAttachments) attachments.clear()
        // Read file reference contents and inject into prompt for AI
        val fileRefContents = fileRefs.map { readFileReferenceContent(it) }.filterNotNull()
        fileReferences.clear()
        // promptText includes file content for AI; value is user's original text for display
        val promptText = if (fileRefContents.isNotEmpty()) {
            fileRefContents.joinToString("\n\n") + "\n\n" + value
        } else {
            value
        }
        if (handleUnsupportedAttachments(promptText, attachmentList)) {
            sendTick++
            return true
        }
        val isFirstUserMessage = messages.none { it.role == ChatRole.USER }
        val userMsgCountBefore = messages.size
        todoDockItems = emptyList()
        todoInferBaseline = emptyList()
        todoInferredCompleted = mutableSetOf()
        nonTodoCompletedSinceTodo = 0
        lastTodoUpdateMs = 0
        // Pass original value (not promptText) for display, plus fileRefs for chip rendering
        appendUserAndTitle(value, attachmentList, isFirstUserMessage, fileRefs)
        activeThoughtId = null
        prompting = true
        ready = false
        responding = true
        promptStartMs = System.currentTimeMillis()
        status = MyMessageBundle.message("session.status.responding")
        stopped = false
        // onPromptDone fires on the coroutine's dispatcher thread and drives
        // the state machine the old blocking call's finally block did.
        val onPromptDone: (Throwable?) -> Unit = { err ->
            var promptError = false
            when (err) {
                null -> {}
                is CancellationException -> {
                    cancelled = true
                    stopped = true
                }
                else -> {
                    promptError = true
                    log.error("Failed to send prompt with attachments", err)
                    (err as? Exception)?.let { appendErrorMessageNow(error("session.error.send", it)) }
                }
            }
            val duration = if (promptStartMs > 0) System.currentTimeMillis() - promptStartMs else 0
            if (duration > 0) {
                lastDuration = duration
                SessionStorage.saveLastDuration(project, sessionId, duration)
            }
            promptStartMs = 0
            val anyAgentOrTool = messages.size > userMsgCountBefore + 1 ||
                messages.any { m -> m.role == ChatRole.AGENT || m.role == ChatRole.TOOL }
            prompting = false
            if (pendingModelRefresh) {
                pendingModelRefresh = false
                ApplicationManager.getApplication().executeOnPooledThread {
                    try {
                        refreshCatalogAndModels()
                    } catch (e: Exception) {
                        log.warn("Deferred model refresh failed for $sessionId", e)
                    }
                }
            }
            responding = false
            ready = true
            status = MyMessageBundle.message("session.status.connected")
            updateUi {
                // Update the last AGENT message with the duration
                if (duration > 0) {
                    val lastAgentIdx = messages.indexOfLast { it.role == ChatRole.AGENT }
                    if (lastAgentIdx >= 0) {
                        val updated = messages[lastAgentIdx].copy(duration = duration)
                        messages[lastAgentIdx] = updated
                        messageStore.updateMessage(sessionId, updated.id) { updated }
                    }
                }
                if (cancelled) {
                    cancelled = false
                    markLastAgentInterrupted()
                    cancelPendingTodos()
                    sendTick++
                } else {
                    completeLastAgentMessageNow()
                    if (!anyAgentOrTool && !promptError) {
                        val modelInfo = selectedModel?.let { " (model: ${it.id})" } ?: " (no model selected)"
                        log.warn("Prompt produced no agent/tool output, sessionId=$sessionId, hasAttachments=$hasAttachments, MIMEs=${attachmentList.joinToString(",") { it.mimeType }}, model=$selectedModel")
                        val msg = if (hasAttachments) {
                            MyMessageBundle.message(
                                "session.error.noResponseWithAttachments",
                                attachmentList.joinToString(", ") { it.mimeType.ifBlank { "-" } }
                            ) + modelInfo
                        } else {
                            MyMessageBundle.message("session.error.noResponsePlain") + modelInfo
                        }
                        appendErrorMessageNow(msg)
                    }
                }
            }
            // Headless: notify the registry the turn finished. Must be scheduled AFTER
            // the updateUi call above — both use unconditional invokeLater (FIFO), so
            // the completion persistence flushes before the registry disposes us.
            onTurnCompleted?.invoke()
        }
        if (hasAttachments) {
            // buildAttachmentBlocks reads files — keep that off the EDT.
            ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    val blocks = buildAttachmentBlocks(promptText, attachmentList)
                    service.prompt(sessionId, blocks, onPromptDone)
                } catch (e: Exception) {
                    onPromptDone(e)
                }
            }
        } else {
            service.prompt(sessionId, promptText, onPromptDone)
        }
        sendTick++
        return true
    }

    // Pre-flight: reject attachments we KNOW ACP will silently ignore (non-image, non-text
    // binaries like docx, xlsx, pdf, zip...). We produce a synchronous SYSTEM card here so the
    // user sees immediate feedback instead of waiting for a doomed round-trip.
    private fun handleUnsupportedAttachments(value: String, attachmentList: List<AttachmentItem>): Boolean {
        val unsupported = collectUnsupportedAttachmentNames(attachmentList)
        if (unsupported.isEmpty()) return false
        log.warn("Rejecting prompt pre-flight due to ${unsupported.size} unsupported attachments: ${unsupported.joinToString(";")}")
        val listed = unsupported.joinToString(", ")
        val textAndImageNames = attachmentList
            .filter { a -> a.isImage || isTextLikeMimeType(a.mimeType) }
            .joinToString(", ") { it.name }
        val advice = if (textAndImageNames.isNotEmpty())
            MyMessageBundle.message("session.error.attachmentUnsupportedPartial", listed, textAndImageNames)
        else
            MyMessageBundle.message("session.error.attachmentUnsupported", listed)
        // Render USER bubble synchronously so it can never be dropped. If the user typed
        // nothing (only attached a file) we show attachment names instead of a blank string;
        // the blank string used to render a 0px card which the user interpreted as "no
        // bubble appeared".
        val isFirst = messages.none { it.role == ChatRole.USER }
        appendUserAndTitle(value, attachmentList, isFirst)
        appendErrorMessageNow(advice)
        // Do NOT touch ready/responding/prompting here: they were unchanged, so the user can
        // immediately try again with a different attachment.
        sendTick++
        return true
    }

    // Synchronous USER bubble: never rely on invokeLater for the user's own text. Also ensures
    // blank-text-when-attachments renders (appendUserMessageNow substitutes attachment names).
    private fun appendUserAndTitle(value: String, attachmentList: List<AttachmentItem>, isFirstUserMessage: Boolean, fileRefs: List<FileReference> = emptyList()) {
        appendUserMessageNow(value, attachmentList, fileRefs)
        saveToHistory(value)
        if (isFirstUserMessage) {
            val titleText = value.ifBlank { attachmentList.joinToString(", ") { it.name } }
            val title = if (titleText.length > MAX_TITLE_LEN) titleText.take(MAX_TITLE_LEN) + "..." else titleText
            DevEcoSessionActions.forProject(project).promptSent(sessionId, title)
        } else {
            DevEcoSessionActions.forProject(project).promptSent(sessionId, null)
        }
    }

    private fun buildAttachmentBlocks(text: String, attachmentList: List<AttachmentItem>): List<ContentBlock> {
        val blocks = mutableListOf<ContentBlock>()
        if (text.isNotEmpty()) blocks.add(ContentBlock.Text(text))
        attachmentList.forEach { att ->
            val bytes = File(att.path).readBytes()
            log.info("Sending attachment: ${att.name}, size=${bytes.size} bytes, mimeType=${att.mimeType}, isImage=${att.isImage}")
            when {
                att.isImage -> {
                    val base64 = Base64.getEncoder().encodeToString(bytes)
                    blocks.add(ContentBlock.Image(data = base64, mimeType = att.mimeType, uri = ""))
                }
                isTextLikeMimeType(att.mimeType) -> {
                    // Bypass ACP's Resource path (which historically produced 0 tokens
                    // for non-image Resources) by inlining decoded file contents as a
                    // Text block wrapped with a fenced header so the LLM understands
                    // which file it is.
                    val decoded = decodeTextBytes(bytes)
                    val header = "--- ${att.name} (${att.mimeType}, ${bytes.size} bytes) ---\n"
                    val safeText = decoded.take(MAX_INLINED_TEXT_BYTES)
                    val trailer = if (decoded.length > MAX_INLINED_TEXT_BYTES)
                        "\n--- [truncated ${decoded.length - MAX_INLINED_TEXT_BYTES} chars] ---" else ""
                    blocks.add(ContentBlock.Text(header + "```\n" + safeText + "\n```" + trailer))
                }
                // NOTE: This else branch SHOULD be unreachable because
                // collectUnsupportedAttachmentNames pre-flight-rejects any attachment
                // that isn't image or text-like. If we ever land here, it means the
                // pre-flight check (at the top of sendPrompt) and this when-tree
                // have diverged —we log at WARN so the divergence is obvious, fall
                // back to a Resource block defensively, and move on.
                else -> {
                    log.warn(
                        "Attachment reached defensive Resource fallback despite pre-flight: " +
                            "name=${att.name}, mimeType=${att.mimeType}. " +
                            "Pre-flight ${collectUnsupportedAttachmentNames(attachmentList)}"
                    )
                    val base64 = Base64.getEncoder().encodeToString(bytes)
                    blocks.add(ContentBlock.Resource(
                        EmbeddedResourceResource.BlobResourceContents(
                            blob = base64, uri = "", mimeType = att.mimeType,
                        )
                    ))
                }
            }
        }
        return blocks
    }

    fun clearConversation() {
        // Compose SnapshotState collections are safe to mutate from any thread (they use
        // copy-on-write snapshot isolation), so we can clear these synchronously instead of
        // deferring to updateUi{} —which might no-op if disposed gets set during a teardown
        // race, leaving stale UI state in place for the remainder of the render frame.
        messages.clear()
        expandedThoughts.clear()
        expandedTools.clear()
        permissionChoices.clear()
        attachments.clear()
        activeThoughtId = null
        usedTokens = 0L
        totalTokens = 0L
        customTokenLimit = 0L
        memoryLimitReached = false
        tokenUsageStore.clearUsage(sessionId)
        messageStore.clearMessages(sessionId)
        compactionCount = 0
        compacting = false
    }

    // addAttachment / removeAttachment are called directly from Compose onClick callbacks (EDT) so
    // there's no value in routing through updateUi -> invokeLater. SnapshotStateList mutations are
    // legal from any thread but these are effectively "always EDT" entry points, so they stay as
    // direct mutations —not wrapped in anything.
    fun clearFileReferences() {
        fileReferences.clear()
    }

    /**
     * Adds a file reference to a running session (e.g., when reusing an existing
     * session tab via "Jump to DevEco Code"). Multiple references accumulate
     * instead of overwriting each other.
     */
    fun addFileReference(ref: FileReference) {
        fileReferences.add(ref)
    }

    fun openFileAtLine(path: String, line: Int) {
        val virtualFile = com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(path) ?: return
        com.intellij.openapi.fileEditor.OpenFileDescriptor(project, virtualFile, line, 0).navigate(true)
    }

    /**
     * Reads the content of a file reference (specific line range) and formats it
     * as a structured block for the LLM prompt.
     */
    private fun readFileReferenceContent(fileRef: FileReference): String? {
        // Whole-file reference (from @ mention) — send path token to AI
        if (!fileRef.hasLineRange) return "@${fileRef.path}"
        return try {
            val file = java.io.File(fileRef.path)
            if (!file.exists() || !file.isFile) return null
            val lines = file.readLines()
            val startIdx = (fileRef.startLine - 1).coerceIn(0, lines.size - 1)
            val endIdx = (fileRef.endLine - 1).coerceIn(startIdx, lines.size - 1)
            val selectedLines = lines.subList(startIdx, endIdx + 1)
            val lineNumbers = (fileRef.startLine..fileRef.endLine).toList()
            val formatted = selectedLines.zip(lineNumbers).joinToString("\n") { (line, num) ->
                "%4d | %s".format(num, line)
            }
            "```file:${fileRef.path} lines:${fileRef.startLine}-${fileRef.endLine}\n$formatted\n```"
        } catch (e: Exception) {
            log.warn("Failed to read file reference: ${fileRef.path}", e)
            null
        }
    }

    fun addAttachment(item: AttachmentItem) { attachments.add(item) }

    fun removeAttachment(index: Int) {
        if (index in attachments.indices) attachments.removeAt(index)
    }

    fun selectPermissionMode(mode: PermissionMode) {
        permissionMode = mode
    }

    fun selectPermissionModeById(id: String) {
        val mode = PermissionMode.entries.firstOrNull { it.id == id }
        if (mode != null) {
            permissionMode = mode
            when (mode) {
                PermissionMode.AUTO -> log.warn("Permission mode set to AUTO: all tool calls will be auto-approved (risk: untrusted commands may execute without user consent)")
                else -> log.info("Permission mode changed to: ${mode.label}")
            }
        }
    }

    fun setTokenLimit(limit: Long) {
        customTokenLimit = limit
        tokenUsageStore.saveCustomLimit(sessionId, limit)
        log.info("Token limit set to: $limit, effectiveTotal=$effectiveTotalTokens, used=$usedTokens")
        // Recalculate memoryLimitReached based on new limit
        val effectiveTotal = effectiveTotalTokens
        if (effectiveTotal > 0 && usedTokens > 0) {
            val ratio = usedTokens.toDouble() / effectiveTotal.toDouble()
            memoryLimitReached = ratio >= 1.0
            log.info("Memory limit rechecked: ratio=$ratio, memoryLimitReached=$memoryLimitReached")
        }
    }

    fun selectModel(id: String) {
        if (!ready) return
        val model = models.firstOrNull { it.id == id } ?: return
        if (model.id == selectedModel?.id) return
        val previousModel = selectedModel
        selectedModel = model
        supportsImages = modelSupportsImages(model)
        modelStore.setModelId(sessionId, model.modelId)
        modelStore.setGlobalModelId(model.modelId)
        modelStore.markManuallySelected(sessionId)
        status = MyMessageBundle.message("session.model.switching", model.name)
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                modelConfigId?.let { service.setSessionConfigOption(sessionId, it, model.id) }
            } catch (e: Exception) {
                // Revert to the previous model so the dropdown doesn't show
                // a selection the backend rejected (e.g. "model not found").
                selectedModel = previousModel
                supportsImages = modelSupportsImages(previousModel)
                addMessage(ChatRole.SYSTEM, MyMessageBundle.message("session.message.system"), error("session.model.error", e))
            } finally {
                status = MyMessageBundle.message("session.status.connected")
            }
        }
    }

    fun addCustomModel(id: String, name: String) {
        // No-op for the dropdown — the backend config (updated via HTTP API
        // in Settings) is the single source of truth. SESSION_REFRESH_TOPIC
        // → refreshModels() → loadSession() picks up the new model.
        log.info("Custom model update: $id ($name)")
    }

    fun selectMode(id: String) = selectOption(
        id, modes, selectedMode, "session.mode.switching", "session.mode.error",
        setSelected = { selectedMode = it },
    ) { mode -> service.setSessionMode(sessionId, mode.id) }

    private fun <T : LabeledChoice> selectOption(
        id: String,
        options: List<T>,
        selected: T?,
        switchingKey: String,
        errorKey: String,
        setSelected: (T) -> Unit,
        apply: (T) -> Unit,
    ) {
        if (!ready) return
        val item = options.firstOrNull { it.id == id } ?: return
        if (item.id == selected?.id) return
        setSelected(item)
        status = MyMessageBundle.message(switchingKey, item.name)
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                apply(item)
            } catch (e: Exception) {
                addMessage(ChatRole.SYSTEM, MyMessageBundle.message("session.message.system"), error(errorKey, e))
            } finally {
                // Simple MutableState<String> —any-thread write propagates via snapshot MVCC.
                status = MyMessageBundle.message("session.status.connected")
            }
        }
    }

    fun dispose() {
        disposed = true
        messageBusConnection.disconnect()
        service.removeSessionListener(listener)
        service.removePermissionHandler(permissionHandler)
        modelStore.removeGlobalModelListener(globalModelListener)
        modelStore.removeBlacklistListener(blacklistListener)
        // Intentionally NOT calling service.unloadSession(sessionId) here.
        // Closing the ACP session holder while the backend still has pending
        // session/update notifications causes "Session not found" errors in the
        // ACP Client.getOrCreateSessionHolder. The session holder is lightweight
        // and is cleaned up when the ACP client disconnects or the session is
        // explicitly deleted.
        synchronized(pendingPermissions) {
            pendingPermissions.forEach { it.complete(cancelledPermission()) }
            pendingPermissions.clear()
        }
    }

    private fun loadSession() {
        val persistedUsage = restoreFromLocalStore()
        loadFromBackend(persistedUsage)
        // onLoaded is the SessionViewStateStore side-effect of publishing this controller to
        // the global registry; it's independent of EDT but historically we want it to happen
        // after all UI state is committed. Since we just wrote all state synchronously, we can
        // call it directly (no EDT requirement).
        onLoaded()
        // Populate the `/` skill list now that the backend instance is loaded,
        // so the first `/` invoke already shows skills (no empty→populated flip).
        refreshCommands()
    }

    // 1. Restore messages + token usage from local store first (never fails, no backend IO).
    private fun restoreFromLocalStore(): Triple<Long, Long, Long>? {
        val savedMessages = messageStore.getMessages(sessionId)
        val persistedUsage = tokenUsageStore.getUsage(sessionId)
        if (savedMessages.isNotEmpty()) {
            restoredFromLocalStore = true
            // messages.addAll and the following log both look fine from any thread, but the
            // persistent store access inside updateUi{} historically expected EDT. We keep the
            // addAll on EDT out of caution (PersistentStateComponent mutation).
            updateUi {
                messages.addAll(savedMessages)
                // promptHistory is in-memory only and was lost when the project closed.
                // Rebuild it from the just-restored USER messages so Up/Down arrow
                // navigation works again on a reopened session.
                rebuildPromptHistoryFrom(savedMessages)
                log.info("Restored ${savedMessages.size} messages for session $sessionId")
            }
        }
        if (persistedUsage != null) {
            // Simple value writes (snapshot MVCC-safe on any thread), NOT gated on disposed
            // because these are the canonical restored numbers and must take effect even if a
            // dispose races in shortly after controller creation.
            usedTokens = persistedUsage.first
            totalTokens = persistedUsage.second
            if (persistedUsage.third > 0) customTokenLimit = persistedUsage.third
            val effectiveTotal = effectiveTotalTokens
            if (effectiveTotal > 0 && persistedUsage.first > 0) {
                memoryLimitReached = persistedUsage.first.toDouble() / effectiveTotal.toDouble() >= 1.0
            }
        }
        return persistedUsage
    }

    // 2. Contact backend to fetch config options. This may fail; the messages restored above
    // remain visible to the user regardless.
    private fun loadFromBackend(persistedUsage: Triple<Long, Long, Long>?) {
        sessionLoading = true
        val start = System.currentTimeMillis()
        val maxAttempts = 5
        var lastError: Exception? = null
        for (attempt in 1..maxAttempts) {
            try {
                val isNew = service.isNewSession(sessionId)
                // Refresh the catalog cache before updateConfigOptions so
                // rebuildRawModels filters by the latest connection state
                // (only providers with a stored API key).
                val catalog = runCatching { service.modelCatalog() }.getOrElse { emptyList() }
                if (catalog.isNotEmpty()) {
                    val loadProviders = runCatching { service.availableProviders() }.getOrElse { emptyList() }
                    val loadDisconnected = loadProviders.filter { !it.hasAuth }.map { it.id }.toSet()
                    val safeCatalog = if (loadDisconnected.isNotEmpty()) {
                        catalog.filter { it.providerId !in loadDisconnected }
                    } else {
                        catalog
                    }
                    modelStore.cacheCatalog(safeCatalog)
                }
                updateConfigOptions(service.loadSession(sessionId), isNew)
                supportsImages = modelSupportsImages(selectedModel)
                val cachedCommands = service.getAvailableCommands(sessionId)
                val cachedUsage = service.getCachedUsage(sessionId)
                val usageToRestore = cachedUsage?.let { Triple(it.first, it.second, 0L) } ?: persistedUsage
                // The backend replays historical events asynchronously after loadSession() returns.
                // Wait briefly to let the replay finish before disabling the deduplication guard.
                Thread.sleep(500)
                sessionLoading = false
                if (cachedCommands.isNotEmpty()) commands = cachedCommands
                if (usageToRestore != null && cachedUsage != null) {
                    usedTokens = usageToRestore.first
                    totalTokens = usageToRestore.second
                    val effectiveTotal = effectiveTotalTokens
                    if (effectiveTotal > 0 && usageToRestore.first > 0) {
                        memoryLimitReached = usageToRestore.first.toDouble() / effectiveTotal.toDouble() >= 1.0
                    }
                }
                ready = true
                status = MyMessageBundle.message("session.status.connected")
                log.info("loadSession: $sessionId ready in ${System.currentTimeMillis() - start}ms (attempt $attempt)")
                restoreEditedFilesFromDiff()
                return
            } catch (e: Exception) {
                lastError = e
                log.warn("Backend load attempt $attempt/$maxAttempts failed for session $sessionId", e)
                if (attempt < maxAttempts) {
                    sessionLoading = true
                    status = MyMessageBundle.message("session.status.loading")
                    Thread.sleep(2000L)
                }
            }
        }
        sessionLoading = false
        ready = false
        status = MyMessageBundle.message("session.status.load.failed")
        log.warn("Backend load failed after $maxAttempts attempts for session $sessionId", lastError)
    }

    // Reopen path: the local message store restores TOOL items without their
    // +A/-D edits (toolFileEdits is not persisted), and the backend's historical
    // tool_call_update replay is skipped when restoredFromLocalStore is true.
    // Fetch the authoritative per-file diff from DevEco Code and reattach counts
    // to the matching TOOL items by path so the Edited-files badges reappear.
    private fun restoreEditedFilesFromDiff() {
        val diffs = runCatching { service.sessionDiff(sessionId) }.getOrElse { e ->
            log.warn("Failed to restore session diff for $sessionId", e); return
        }
        if (diffs.isEmpty()) return
        val byPath = diffs.associateBy { it.path }
        updateUi {
            for (i in messages.indices) {
                val m = messages[i]
                if (m.role != ChatRole.TOOL || m.toolFileEdits.isNotEmpty()) continue
                val path = m.toolPath ?: continue
                val d = byPath[path] ?: continue
                messages[i] = m.copy(toolFileEdits = listOf(ToolEditTracker.FileEdit(d.path, d.additions, d.deletions)))
            }
        }
    }

    private fun onSessionUpdate(notification: AcpSessionUpdate) {
        // Filter on the calling thread so other sessions' notifications never reach
        // the EDT; everything else runs on the EDT (single writer).
        if (notification.sessionId.value != sessionId) return
        updateUi { handleSessionUpdate(notification.update) }
    }

    // Runs on the EDT via onSessionUpdate; nested updateUi{} dispatch stays FIFO-ordered.
    private fun handleSessionUpdate(update: SessionUpdate) {
        // During backend load, the server replays historical events. If we already restored
        // messages from the local store, skip message-producing events to avoid duplication.
        // If the local store was empty, we MUST process these events — they are the only
        // source of the conversation history (e.g., after restart when persistence failed
        // or on a new machine). Config/mode/commands/usage events are always processed
        // during loading and then we return (they don't need the message-processing path).
        if (sessionLoading) {
            when (update) {
                is SessionUpdate.CurrentModeUpdate -> {
                    selectedMode = modes.firstOrNull { it.id == update.currentModeId.value }
                    return
                }
                is SessionUpdate.ConfigOptionUpdate -> {
                    updateConfigOptions(update.configOptions)
                    return
                }
                is SessionUpdate.AvailableCommandsUpdate -> {
                    applyAvailableCommands(update)
                    return
                }
                is SessionUpdate.UsageUpdate -> {
                    handleUsageUpdate(update.used, update.size)
                    return
                }
                // Message-producing events: skip if local store had messages (already restored,
                // avoids duplication). Fall through to normal processing if local store was empty
                // so the backend's historical replay populates the UI.
                is SessionUpdate.AgentMessageChunk,
                is SessionUpdate.UserMessageChunk,
                is SessionUpdate.AgentThoughtChunk,
                is SessionUpdate.ToolCall,
                is SessionUpdate.ToolCallUpdate -> {
                    if (restoredFromLocalStore) return
                    // Fall through to normal processing below
                }
                else -> return
            }
        }
        // After Stop (CancellationException fired), drop any queued-up message-producing
        // SessionUpdate events still pending on EDT — otherwise they would append
        // Thinking/Tool/new AGENT chunks AFTER the interrupted AGENT + action bar,
        // breaking the "action bar at very bottom of the turn" layout.
        // UsageUpdate(used=0) on the cancel path is already filtered at the publish()
        // origin (AcpClientConnection.publish), so it never reaches here; non-zero
        // UsageUpdate that legitimately reports partial billing is still applied below.
        if (stopped) {
            when (update) {
                is SessionUpdate.AgentMessageChunk,
                is SessionUpdate.AgentThoughtChunk,
                is SessionUpdate.UserMessageChunk,
                is SessionUpdate.ToolCall,
                is SessionUpdate.ToolCallUpdate -> {
                    log.info("onSessionUpdate STOPPED: dropping ${update::class.java.simpleName} for sessionId=$sessionId")
                    return
                }
                else -> Unit
            }
        }
        if (update is SessionUpdate.AgentMessageChunk ||
            update is SessionUpdate.UserMessageChunk ||
            update is SessionUpdate.ToolCall) finishThought()
        when (update) {
            is SessionUpdate.AgentMessageChunk -> (update.content as? ContentBlock.Text)?.let {
                appendAgent(update.messageId?.value ?: "streaming-agent", it.text)
            }
            is SessionUpdate.UserMessageChunk -> if (!prompting) {
                SessionStorage.markInteracted(project, sessionId)
                (update.content as? ContentBlock.Text)?.let {
                    addMessage(ChatRole.USER, MyMessageBundle.message("session.message.you"), it.text)
                }
            }
            is SessionUpdate.AgentThoughtChunk -> (update.content as? ContentBlock.Text)?.let {
                appendThought(update.messageId?.value, it.text)
            }
            is SessionUpdate.ToolCall -> updateTool(ToolUpdate(
                update.toolCallId.value, update.title, update.kind, update.status, update.content,
                update.rawInput, update.rawOutput, update.locations,
            ))
            is SessionUpdate.ToolCallUpdate -> updateTool(ToolUpdate(
                update.toolCallId.value, update.title, update.kind, update.status, update.content,
                update.rawInput, update.rawOutput, update.locations,
            ))
            is SessionUpdate.CurrentModeUpdate ->
                selectedMode = modes.firstOrNull { it.id == update.currentModeId.value }
            is SessionUpdate.AvailableCommandsUpdate -> applyAvailableCommands(update)
            is SessionUpdate.UsageUpdate -> handleUsageUpdate(update.used, update.size)
            else -> Unit
        }
    }

    private fun handleUsageUpdate(used: Long, size: Long) {
        if (used == 0L && usedTokens > 0L) {
            log.warn("handleUsageUpdate: rejecting used=0 overwrite, prior usedTokens=$usedTokens preserved, size=$size, sessionId=$sessionId")
            if (size > 0L) totalTokens = size
            return
        }
        log.info("UsageUpdate received: used=$used, size=$size, customLimit=$customTokenLimit, effectiveTotal=$effectiveTotalTokens")
        usedTokens = used
        totalTokens = size
        tokenUsageStore.saveUsage(sessionId, used, size)
        val effectiveTotal = effectiveTotalTokens
        if (effectiveTotal <= 0 || used <= 0) return
        val ratio = used.toDouble() / effectiveTotal.toDouble()

        if (ratio >= COMPACTION_RATIO_THRESHOLD && !compacting && !memoryLimitReached && compactionCount < MAX_COMPACTIONS) {
            compacting = true
            compactionCount++
            log.info("Token usage at ${(ratio * 100).toInt()}%, auto-compacting (attempt $compactionCount/$MAX_COMPACTIONS)")
            service.prompt(sessionId, "/compact") { err ->
                if (err != null && err !is CancellationException) {
                    log.warn("Auto-compaction failed", err)
                }
                compacting = false
            }
        }

        if (ratio >= 1.0) {
            if (!memoryLimitReached) {
                memoryLimitReached = true
                log.info("Memory limit reached: used=$used, effectiveTotal=$effectiveTotal, ratio=$ratio, compactions=$compactionCount")
            }
        } else if (memoryLimitReached) {
            memoryLimitReached = false
            log.info("Memory limit cleared: used=$used, effectiveTotal=$effectiveTotal, ratio=$ratio")
        }
    }

    private fun appendAgent(id: String, chunk: String) = updateUi {
        val index = messages.indexOfFirst { it.id == id }
        if (index < 0) {
            val message = ChatItem(id, ChatRole.AGENT, MyMessageBundle.message("session.message.agent"), chunk, isComplete = false)
            messages += message
            messageStore.appendMessage(sessionId, message)
        } else {
            val updated = messages[index].copy(text = messages[index].text + chunk)
            messages[index] = updated
            messageStore.updateMessage(sessionId, id) { updated }
        }
    }

    private fun appendThought(messageId: String?, chunk: String) = updateUi {
        // Merge by backend message id (namespaced: the AGENT item reuses the raw id), so
        // EDT queueing delays and controller rebuilds cannot split one reasoning stream.
        val id = messageId?.let { "thought-$it" } ?: activeThoughtId ?: "thought-${System.nanoTime()}"
        val index = messages.indexOfFirst { it.id == id }
        if (index >= 0) {
            val updated = messages[index].copy(text = messages[index].text + chunk)
            messages[index] = updated
            messageStore.updateMessage(sessionId, id) { updated }
        } else {
            // A store hit is only possible for a messageId-derived id: a previous
            // controller persisted it while this one was rebuilt mid-stream. Adopt the
            // persisted item instead of appending a duplicate entry.
            val existing = if (messageId != null) {
                messageStore.getMessages(sessionId).firstOrNull { it.id == id }
            } else {
                null
            }
            if (existing != null) {
                val updated = existing.copy(text = existing.text + chunk)
                messages += updated
                messageStore.updateMessage(sessionId, id) { updated }
            } else {
                val message = ChatItem(id, ChatRole.THOUGHT, "Thought", chunk)
                messages += message
                messageStore.appendMessage(sessionId, message)
            }
            expandedThoughts[id] = true
        }
        activeThoughtId = id
    }

    // Runs on the EDT (updateUi) so the reset cannot interleave with queued appendThought.
    private fun finishThought() = updateUi {
        activeThoughtId?.let { expandedThoughts[it] = false }
        activeThoughtId = null
    }

    private fun updateTool(update: ToolUpdate) = updateUi {
        val (id, title, kind, status, content, rawInput, rawOutput, locations) = update
        val itemId = "tool-$id"
        val previous = messages.firstOrNull { it.id == itemId }
        val readRange = AcpToolInputParser.readRange(rawInput)
        val path = AcpToolInputParser.readOutputPath(rawOutput)
            ?: locations?.firstOrNull()?.path
            ?: AcpToolInputParser.readPath(rawInput)
            ?: previous?.toolPath
        val running = status == null ||
            status == ToolCallStatus.PENDING ||
            status == ToolCallStatus.IN_PROGRESS

        // Compute per-file +A/-D edits. Snapshots are captured while the tool is
        // still running so the "always allow" path (no permission request) is
        // covered; on completion the snapshot is diffed against disk for a real
        // count. Protocol-provided counts take precedence when present.
        var parsedEdits = editTracker.parseEdits(kind, content, rawInput, rawOutput, locations)
        when {
            status == ToolCallStatus.FAILED -> editTracker.discard(id)
            status == ToolCallStatus.COMPLETED && parsedEdits.isNotEmpty() -> {
                val precise = editTracker.protocolCountsPrecise(rawOutput, content, rawInput)
                parsedEdits = editTracker.resolve(id, parsedEdits, precise)
            }
            running && kind == ToolKind.EDIT && parsedEdits.isNotEmpty() ->
                editTracker.capture(id, parsedEdits)
        }
        if (parsedEdits.isEmpty()) parsedEdits = previous?.toolFileEdits ?: emptyList()

        val item = ChatItem(
            itemId,
            ChatRole.TOOL,
            title?.takeIf { it.isNotBlank() }
                ?: kind?.name?.lowercase()?.replace('_', ' ')
                ?: previous?.title
                ?: MyMessageBundle.message("session.tool.call"),
            toolOutput(content, rawOutput) ?: previous?.text.orEmpty(),
            kind ?: previous?.toolKind,
            path,
            locations?.firstOrNull()?.line?.toInt() ?: previous?.toolLine,
            readRange?.offset ?: previous?.toolOffset,
            readRange?.limit ?: previous?.toolLimit,
            status,
            rawInput,
            rawOutput,
            locations,
            parsedEdits,
        )
        val index = messages.indexOfFirst { it.id == item.id }
        if (index < 0) {
            messages += item
            expandedTools[item.id] = running
            messageStore.appendMessage(sessionId, item)
        } else {
            messages[index] = item
            expandedTools[item.id] = running
            messageStore.updateMessage(sessionId, item.id) { item }
        }
        if (isTodoTool(item)) {
            val parsed = parseTodoDockItems(item.toolRawInput, item.id)
            // If agent provided explicit status updates, use them directly
            val hasExplicitUpdates = parsed.any { it.status != TodoDockStatus.PENDING }
            if (hasExplicitUpdates) {
                todoDockItems = parsed
                todoInferBaseline = parsed
                todoInferredCompleted = mutableSetOf()
                nonTodoCompletedSinceTodo = 0
                lastTodoUpdateMs = System.currentTimeMillis()
            } else if (parsed.isNotEmpty() && todoInferBaseline.isEmpty()) {
                // First TODO call with all pending - save as baseline for inference
                todoDockItems = parsed
                todoInferBaseline = parsed
                todoInferredCompleted = mutableSetOf()
                nonTodoCompletedSinceTodo = 0
                lastTodoUpdateMs = System.currentTimeMillis()
            } else if (parsed.isNotEmpty()) {
                // Subsequent TODO call, still all pending - update baseline
                todoDockItems = parsed
                todoInferBaseline = parsed
                todoInferredCompleted = mutableSetOf()
                nonTodoCompletedSinceTodo = 0
                lastTodoUpdateMs = System.currentTimeMillis()
            }
        } else if (!running && status == ToolCallStatus.COMPLETED && todoInferBaseline.isNotEmpty()) {
            // Non-TODO tool completed - try to infer TODO completion
            nonTodoCompletedSinceTodo++
            val matchedIdx = tryInferTodoCompletion(
                kind, path, item.title, item.text,
                todoInferBaseline, todoInferredCompleted
            )
            if (matchedIdx != null) {
                todoInferredCompleted.add(matchedIdx)
                // Rebuild dock items with inferred completions
                todoDockItems = todoInferBaseline.mapIndexed { idx, base ->
                    if (idx in todoInferredCompleted) {
                        base.copy(status = TodoDockStatus.COMPLETED)
                    } else {
                        base
                    }
                }
            }
        }
    }

    private fun toolOutput(content: List<ToolCallContent>?, rawOutput: Any?): String? {
        val rendered = content.orEmpty().mapNotNull { block ->
            when (block) {
                is ToolCallContent.Content -> when (val value = block.content) {
                    is ContentBlock.Text -> value.text
                    else -> value?.toString()
                }
                is ToolCallContent.Diff -> buildString {
                    append(block.path)
                    block.newText.takeIf { it.isNotBlank() }?.let { append("\n").append(it) }
                }
                is ToolCallContent.Terminal -> block.terminalId
            }
        }.filter { it.isNotBlank() }.joinToString("\n\n").takeIf { it.isNotBlank() }
        // Handle JSON text in content (e.g. list_directory_tree returns JSON array as text)
        if (rendered != null) {
            val trimmed = rendered.trim()
            if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
                val jsonRendered = renderJsonOutput(trimmed)
                if (jsonRendered != null) return jsonRendered
            }
            return rendered
        }
        // Handle structured JSON output in rawOutput
        val jsonRendered = renderJsonOutput(rawOutput)
        if (jsonRendered != null) return jsonRendered
        return rawOutput?.toString()?.takeUnless { it == "{}" }
    }

    /**
     * Renders structured JSON tool output into plain text.
     *
     * Handles JsonArray of file-entry objects (e.g. from list_directory_tree) by
     * extracting path-like fields from each element — including nested `children` —
     * and joining them with newlines so that FileTreeParser.parseFilePaths() can
     * consume the result.
     */
    private fun renderJsonOutput(rawOutput: Any?): String? {
        val array: JsonArray = when (rawOutput) {
            is JsonArray -> rawOutput
            is List<*> -> {
                val objects = rawOutput.filterIsInstance<JsonObject>()
                if (objects.isEmpty()) return null
                JsonArray(objects)
            }
            is String -> {
                // Try to parse JSON string
                val trimmed = rawOutput.trim()
                if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
                    try {
                        Json.parseToJsonElement(trimmed) as? JsonArray ?: return null
                    } catch (e: Exception) {
                        return null
                    }
                } else {
                    return null
                }
            }
            else -> return null
        }
        if (array.isEmpty()) return null
        // Keys that typically hold a file path in directory-listing tool responses.
        val pathKeys = listOf("path", "name", "file", "file_path", "filePath")
        val lines = array.flatMap { extractPathsFromElement(it, pathKeys) }
        return lines.takeIf { it.isNotEmpty() }?.joinToString("\n")
    }

    /**
     * Recursively extracts path-like fields from a JSON element and its nested
     * `children` array. This handles tree-structured directory listings where
     * folders contain child entries.
     */
    private fun extractPathsFromElement(element: JsonElement, pathKeys: List<String>): List<String> {
        if (element !is JsonObject) return listOf(element.toString())
        val result = mutableListOf<String>()
        // Extract current node's path
        for (key in pathKeys) {
            val value = element[key]
            if (value is JsonPrimitive) {
                val text = value.contentOrNull
                if (!text.isNullOrBlank()) {
                    result.add(text)
                    break
                }
            }
        }
        // Fallback: use the first string-typed value in the object.
        if (result.isEmpty()) {
            element.entries.firstOrNull { it.value is JsonPrimitive && (it.value as JsonPrimitive).contentOrNull?.isNotBlank() == true }
                ?.let { (it.value as JsonPrimitive).contentOrNull }
                ?.let { result.add(it) }
        }
        // Recursively extract children paths
        val children = element["children"]
        if (children is JsonArray) {
            for (child in children) {
                result.addAll(extractPathsFromElement(child, pathKeys))
            }
        }
        return result
    }

    private fun updateConfigOptions(options: List<SessionConfigOption>?, isNewSession: Boolean = false) {
        val selects = options.orEmpty().filterIsInstance<SessionConfigOption.Select>()
        updateModels(selects, isNewSession)
        updateModes(selects)
    }

    private fun updateModels(selects: List<SessionConfigOption.Select>, isNewSession: Boolean = false) {
        val (option, choices) = findSelectOption(selects, "model") {
            val value = it.value.value
            val slashIdx = value.indexOf('/')
            val providerId = if (slashIdx >= 0) value.substring(0, slashIdx) else ""
            val modelId = if (slashIdx >= 0) value.substring(slashIdx + 1) else value
            ModelChoice(value, it.name, providerId, modelId)
        } ?: run {
            log.warn("updateModels: model Select not found in configOptions, selects=${selects.map { it.id.value }}")
            return
        }
        modelConfigId = option.id.value
        backendModels = choices
        log.info("updateModels: sessionId=$sessionId backendModels=${choices.size} ids=${choices.map { it.id }}")
        rebuildRawModels()
        // A session whose model the user explicitly switched keeps that choice on
        // reload instead of being reset to the global preferred default.
        if (modelStore.wasManuallySelected(sessionId)) {
            val found = models.firstOrNull { it.id == option.currentValue.value }
            if (found != null && (selectedModel == null || found.id == selectedModel?.id)) {
                selectedModel = found
                supportsImages = modelSupportsImages(found)
                return
            }
            // found == null: the manually selected model is no longer in the
            // backend's choices (edited/deleted/disconnected). Fall through to
            // selectFallbackModel instead of keeping a stale selection.
        }
        var globalModelId = modelStore.getGlobalModelId()
        // 首次使用（本项目从未配置过模型）时默认选择 GLM-5.1，而非 Auto/后端默认模型。
        // globalModelConfigured 用于区分"从未配置"与"用户主动选择 Auto"，后者不做默认回填。
        if (globalModelId == null && !modelStore.isGlobalModelConfigured()) {
            globalModelId = models.firstOrNull { isDefaultModelChoice(it) }?.also { default ->
                modelStore.setGlobalModelId(default.modelId)
            }?.modelId
        }
        selectedModel = when {
            globalModelId != null -> models.firstOrNull { it.modelId == globalModelId }
            else -> models.firstOrNull { it.id == option.currentValue.value }
        }
        // globalModelId expired: the preferred model is no longer in the
        // backend's choices (edited/deleted/disconnected). Auto-clear and
        // fall back to the default model so new sessions don't try to use a
        // stale preference.
        if (globalModelId != null && selectedModel == null) {
            modelStore.setGlobalModelId(null)
            selectedModel = models.firstOrNull { isDefaultModelChoice(it) } ?: models.firstOrNull()
        }
        val effectiveModelId = selectedModel?.modelId ?: return
        modelStore.setModelId(sessionId, effectiveModelId)
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                if (modelStore.wasManuallySelected(sessionId)) return@executeOnPooledThread
                val configId = modelConfigId ?: return@executeOnPooledThread
                val backendValue = selectedModel?.id ?: effectiveModelId
                service.setSessionConfigOption(sessionId, configId, backendValue)
            } catch (e: Exception) {
                log.warn("updateModels: setSessionConfigOption failed, clearing globalModelId", e)
                modelStore.setGlobalModelId(null)
            }
        }
    }

    private fun updateModes(selects: List<SessionConfigOption.Select>) {
        val (option, choices) = findSelectOption(selects, "mode") { ModeChoice(it.value.value, it.name) } ?: return
        modes = choices
        selectedMode = choices.firstOrNull { it.id == option.currentValue.value }
    }

    private fun <T> findSelectOption(
        selects: List<SessionConfigOption.Select>,
        key: String,
        map: (SessionConfigSelectOption) -> T,
    ): Pair<SessionConfigOption.Select, List<T>>? {
        val option = selects.firstOrNull {
            it.category?.value.equals(key, true) || it.id.value.equals(key, true)
        } ?: return null
        return option to option.selectChoices().map(map)
    }

    private fun sourceOf(meta: kotlinx.serialization.json.JsonElement?): String? =
        (meta as? kotlinx.serialization.json.JsonObject)
            ?.get("source")?.let { it as? kotlinx.serialization.json.JsonPrimitive }?.contentOrNull

    private fun SessionConfigOption.Select.selectChoices(): List<SessionConfigSelectOption> =
        when (val values = options) {
            is SessionConfigSelectOptions.Flat -> values.options
            is SessionConfigSelectOptions.Grouped -> values.groups.flatMap { it.options }
        }

    private fun onPermissionRequest(request: RequestPermissionRequest): RequestPermissionResponse? {
        if (request.sessionId.value != sessionId || disposed) return null
        // Headless (editor closed mid-turn): the permission card has no UI to render on
        // and result.get() below would block the turn forever — cancel, like the
        // disposed path used to.
        if (detached) {
            log.info("Permission request while headless, cancelling: ${request.toolCall.title}")
            return cancelledPermission()
        }
        val toolTitle = request.toolCall.title ?: "unknown"
        log.info("Permission request: tool=$toolTitle, mode=${permissionMode.label}, options=${request.options.size}")
        // Snapshot files at permission time as a backup for the always-allow path.
        editTracker.captureFromPermission(
            request.toolCall.toolCallId.value,
            request.toolCall.kind,
            request.toolCall.content,
            request.toolCall.rawInput,
            request.toolCall.rawOutput,
            request.toolCall.locations,
        )

        // AUTO mode: auto-approve all tool calls
        if (permissionMode == PermissionMode.AUTO && request.options.isNotEmpty()) {
            return handleAutoPermission(request, toolTitle)
        }

        // RECOMMENDED and SANDBOX: show permission prompt (user configured settings)
        if (request.options.isEmpty()) {
            log.warn("No permission options available for $toolTitle, cancelling")
            return cancelledPermission()
        }

        log.info("Showing permission prompt (${permissionMode.label}): $toolTitle")
        val result = CompletableFuture<RequestPermissionResponse>()
        synchronized(pendingPermissions) { pendingPermissions += result }

        val messageId = "permission-${System.nanoTime()}"
        // Check if this is a sensitive permission request (contains upload/network keywords)
        val isSensitive = request.toolCall.title?.contains("RAG", ignoreCase = true) == true ||
            request.toolCall.title?.contains("云端", ignoreCase = true) == true ||
            request.toolCall.title?.contains("上传", ignoreCase = true) == true

        val requestTitle = if (isSensitive) {
            MyMessageBundle.message("session.permission.request.warning.title", toolTitle)
        } else {
            MyMessageBundle.message("session.permission.request.title", toolTitle)
        }

        updateUi {
            val message = ChatItem(
                messageId,
                ChatRole.SYSTEM,
                requestTitle,
                request.toolCall.title ?: "Permission requested",
            )
            messages += message
            messageStore.appendMessage(sessionId, message)
            permissionChoices[messageId] = buildPermissionChoices(request, toolTitle, result, messageId)
        }
        return try {
            result.get()
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            log.info("Permission cancelled: $toolTitle (${permissionMode.label})")
            cancelledPermission()
        } finally {
            permissionChoices.remove(messageId)
            synchronized(pendingPermissions) { pendingPermissions.remove(result) }
        }
    }

    private fun handleAutoPermission(request: RequestPermissionRequest, toolTitle: String): RequestPermissionResponse {
        val firstOption = request.options.first()
        log.info("Auto-approved (${permissionMode.label}): $toolTitle -> ${firstOption.name}")
        return RequestPermissionResponse(
            RequestPermissionOutcome.Selected(firstOption.optionId),
        )
    }

    private fun buildPermissionChoices(
        request: RequestPermissionRequest,
        toolTitle: String,
        result: CompletableFuture<RequestPermissionResponse>,
        messageId: String,
    ): List<PermissionChoice> {
        return request.options.map { option ->
            val displayName = translatePermissionOption(option.name)
            val isReject = option.name.equals("Reject", ignoreCase = true)
            PermissionChoice(displayName) {
                permissionChoices.remove(messageId)
                if (isReject) {
                    // Mark as denied for UI display
                    deniedPermissions[messageId] = true
                    // Update the message title to show denied
                    val deniedTitle = MyMessageBundle.message("session.permission.denied.title", toolTitle)
                    updateUi {
                        val index = messages.indexOfFirst { it.id == messageId }
                        if (index >= 0) {
                            val updatedMessage = messages[index].copy(title = deniedTitle)
                            messages[index] = updatedMessage
                            messageStore.updateMessage(sessionId, messageId) { updatedMessage }
                        }
                    }
                    log.info("User rejected: $toolTitle (${permissionMode.label})")
                    result.complete(RequestPermissionResponse(RequestPermissionOutcome.Cancelled))
                } else {
                    // Store the permission result for success card display
                    permissionResults[messageId] = displayName
                    // Update the message title to show success
                    val successTitle = MyMessageBundle.message("session.permission.success.title", toolTitle, displayName)
                    updateUi {
                        val index = messages.indexOfFirst { it.id == messageId }
                        if (index >= 0) {
                            val updatedMessage = messages[index].copy(title = successTitle)
                            messages[index] = updatedMessage
                            messageStore.updateMessage(sessionId, messageId) { updatedMessage }
                        }
                    }
                    log.info("User approved: $toolTitle -> ${option.name} (${permissionMode.label})")
                    result.complete(
                        RequestPermissionResponse(
                            RequestPermissionOutcome.Selected(option.optionId),
                        ),
                    )
                }
            }
        }
    }

    /**
     * Translates permission option names using the i18n bundle.
     */
    private fun translatePermissionOption(name: String): String {
        val key = when (name) {
            "Allow once" -> "permission.option.allow_once"
            "Always allow" -> "permission.option.always_allow"
            "Reject" -> "permission.option.reject"
            else -> return name
        }
        return MyMessageBundle.message(key)
    }

    private fun addMessage(role: ChatRole, title: String, text: String) = updateUi {
        val message = ChatItem("${role.name}-${System.nanoTime()}", role, title, text)
        messages += message
        messageStore.appendMessage(sessionId, message)
    }

    private fun completeLastAgentMessage() {
        completeLastAgentMessageNow()
    }

    private fun completeLastAgentMessageNow() {
        val lastAgentIndex = messages.indexOfLast { it.role == ChatRole.AGENT && !it.isComplete }
        if (lastAgentIndex >= 0) {
            val updated = messages[lastAgentIndex].copy(isComplete = true)
            messages.removeAt(lastAgentIndex)
            messages.add(updated)
            messageStore.saveMessages(sessionId, messages.toList())
        }
    }

    private fun markLastAgentInterrupted() {
        val idx = messages.indexOfLast { it.role == ChatRole.AGENT && !it.isComplete }
        if (idx >= 0) {
            val updated = messages[idx].copy(interrupted = true, isComplete = true)
            messages.removeAt(idx)
            messages.add(updated)
            messageStore.saveMessages(sessionId, messages.toList())
        } else {
            val placeholder = ChatItem(
                "AGENT-${System.nanoTime()}",
                ChatRole.AGENT,
                MyMessageBundle.message("session.message.agent"),
                "",
                isComplete = true,
                interrupted = true,
            )
            messages += placeholder
            messageStore.appendMessage(sessionId, placeholder)
        }
    }

    private fun updateUi(action: () -> Unit) = ApplicationManager.getApplication().invokeLater {
        if (disposed) {
            log.warn("updateUi skipped: SessionController disposed, sessionId=$sessionId")
        } else {
            action()
        }
    }

    private fun error(key: String, e: Exception) =
        MyMessageBundle.message(key, errorMessage(e))

    private fun cancelledPermission() =
        RequestPermissionResponse(RequestPermissionOutcome.Cancelled)

    // Append a SYSTEM/error message DIRECTLY to the in-memory message list (synchronous, any
    // thread safe because `messages` is a SnapshotStateList). We deliberately avoid addMessage()
    // here because that function dispatches via updateUi -> invokeLater, which may be dropped when
    // invokeLater coalescing kicks in during heavy EDT activity —leaving the user with exactly
    // zero visible UI feedback for their failed request, which is the bug reported in this session.
    // Persistent storage is best-effort via updateUi; the user seeing the error is more important.
    private fun appendErrorMessageNow(text: String): ChatItem {
        // SYSTEM cards always represent a user-visible failure (unsupported attachment, 0-token
        // agent reply, send exception, —. Log at WARN so the severity is obvious in traces.
        log.warn("Showing SYSTEM error card: ${text.take(200)}")
        return appendMessageNow(ChatRole.SYSTEM, MyMessageBundle.message("session.message.system"), text)
    }

    // Same thread-safety reasoning as appendErrorMessageNow: for USER (and any other role) that
    // must render reliably (e.g. because the user typed nothing and we need to show what
    // attachments they sent), write straight to the snapshot list + best-effort persist.
    // If `text` is blank we fall back to rendering the attachment names so the card is never 0px.
    private fun appendUserMessageNow(
        text: String,
        attachmentsForDisplay: List<AttachmentItem>,
        fileRefs: List<FileReference> = emptyList(),
    ): ChatItem {
        val displayText = text.ifBlank {
            if (attachmentsForDisplay.isEmpty()) MyMessageBundle.message("session.noContent")
            else attachmentsForDisplay.joinToString(prefix = "📎 ", separator = ", ") { it.name }
        }
        return appendMessageNow(ChatRole.USER, MyMessageBundle.message("session.message.you"), displayText, attachmentsForDisplay, fileRefs)
    }

    private fun appendMessageNow(role: ChatRole, title: String, text: String, attachments: List<AttachmentItem> = emptyList(), fileRefs: List<FileReference> = emptyList()): ChatItem {
        val id = "${role.name}-${System.nanoTime()}"
        val item = ChatItem(id, role, title, text, attachments = attachments, fileReferences = fileRefs)
        messages.add(item)
        log.info("appendMessageNow id=$id role=$role textLen=${text.length} attachments=${attachments.size} fileRefs=${fileRefs.size}")
        updateUi { runCatching { messageStore.appendMessage(sessionId, item) } }
        return item
    }

    // Returns a list of attachment names + MIME types that the plugin KNOWS will produce a
    // zero-token response from ACP. For these we short-circuit the request entirely and show a
    // user-visible error instead of spending time on a round-trip we know will fail. See
    // debug-attachment-no-response.md for the underlying evidence (ACP stopReason=END_TURN,
    // inputTokens=0, outputTokens=0).
    private fun collectUnsupportedAttachmentNames(attachments: List<AttachmentItem>): List<String> {
        return attachments.mapNotNull { att ->
            if (att.isImage) return@mapNotNull null
            if (isTextLikeMimeType(att.mimeType)) return@mapNotNull null
            val mime = att.mimeType.ifBlank { "application/octet-stream" }
            // Images and text/plain/code are the only two categories ACP actually processes
            // without returning 0 tokens. Everything else (docx, xlsx, pptx, pdf, zip, arbitrary
            // binary, mime types we don't recognise) is unsupported for now.
            "${att.name} ($mime)"
        }
    }


    fun regenerateMessage(item: ChatItem) {
        val index = messages.indexOf(item)
        if (index < 0) return
        val userMessage = messages.subList(0, index).lastOrNull { it.role == ChatRole.USER }
        if (userMessage == null) return
        addMessage(ChatRole.USER, MyMessageBundle.message("session.message.you"), userMessage.text)
        activeThoughtId = null
        prompting = true
        ready = false
        responding = true
        promptStartMs = System.currentTimeMillis()
        status = MyMessageBundle.message("session.status.responding")
        sendTick++
        stopped = false
        // The callback fires on the coroutine's dispatcher thread and replaces
        // the old blocking call's try/finally state machine.
        service.prompt(sessionId, userMessage.text) { err ->
            when (err) {
                null -> {}
                is CancellationException -> {
                    cancelled = true
                    stopped = true
                }
                else -> {
                    log.error("Failed to regenerate message", err)
                    (err as? Exception)?.let {
                        addMessage(ChatRole.SYSTEM, MyMessageBundle.message("session.message.system"), error("session.error.send", it))
                    }
                }
            }
            val duration = if (promptStartMs > 0) System.currentTimeMillis() - promptStartMs else 0
            if (duration > 0) {
                lastDuration = duration
                SessionStorage.saveLastDuration(project, sessionId, duration)
            }
            promptStartMs = 0
            prompting = false
            if (pendingModelRefresh) {
                pendingModelRefresh = false
                ApplicationManager.getApplication().executeOnPooledThread {
                    try {
                        refreshCatalogAndModels()
                    } catch (e: Exception) {
                        log.warn("Deferred model refresh failed for $sessionId", e)
                    }
                }
            }
            responding = false
            ready = true
            status = MyMessageBundle.message("session.status.connected")
            updateUi {
                // Update the last AGENT message with the duration
                if (duration > 0) {
                    val lastAgentIdx = messages.indexOfLast { it.role == ChatRole.AGENT }
                    if (lastAgentIdx >= 0) {
                        val updated = messages[lastAgentIdx].copy(duration = duration)
                        messages[lastAgentIdx] = updated
                        messageStore.updateMessage(sessionId, updated.id) { updated }
                    }
                }
                if (cancelled) {
                    cancelled = false
                    markLastAgentInterrupted()
                    cancelPendingTodos()
                    sendTick++
                } else {
                    completeLastAgentMessageNow()
                }
            }
            // Headless: see sendPrompt for the ordering rationale.
            onTurnCompleted?.invoke()
        }
    }

    fun submitFeedback(messageId: String, type: String?) {
        val event = when (type) {
            "like" -> "feedback_like"
            "dislike" -> "feedback_dislike"
            else -> return
        }
        log.info("Feedback submitted: $event for message $messageId")
    }

    fun reportMessage(messageId: String, reason: String) {
        log.info("Message reported: $messageId, reason: $reason")
    }
}
