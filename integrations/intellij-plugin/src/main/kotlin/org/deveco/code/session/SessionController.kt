package org.deveco.code.session

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentclientprotocol.model.*
import com.intellij.ide.SaveAndSyncHandler
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.deveco.code.acp.AcpClientService
import org.deveco.code.acp.ElicitationRequest
import org.deveco.code.acp.ElicitationResponse
import org.deveco.code.acp.SessionStatusInfo
import org.deveco.code.action.DevEcoSessionActions
import org.deveco.code.MyMessageBundle
import org.deveco.code.util.errorMessage
import org.deveco.code.util.resolveVirtualFileWithRefresh
import org.deveco.code.util.runInEdt
import org.deveco.code.acp.AcpToolInputParser
import org.deveco.code.acp.AcpSessionUpdate
import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.session.SessionStorage
import org.deveco.code.skill.SkillStore
import org.deveco.code.session.SESSION_REFRESH_TOPIC
import org.deveco.code.session.SessionRefreshListener
import org.deveco.code.session.model.ChatItem
import org.deveco.code.session.model.ChatRole
import org.deveco.code.session.model.collectTurnAgentText
import org.deveco.code.session.model.insertSubtaskTurnBoundaries
import org.deveco.code.session.model.isTodoTool
import org.deveco.code.session.model.isSubtaskCommand
import org.deveco.code.session.model.expandCommandTemplate
import org.deveco.code.session.model.hasShellSubstitution
import org.deveco.code.session.model.SkillBody
import org.deveco.code.session.model.SkillExpansionIndex
import org.deveco.code.session.model.slashCommandArgs
import org.deveco.code.session.model.slashCommandName
import org.deveco.code.session.model.LabeledChoice
import org.deveco.code.session.model.AttachmentItem
import org.deveco.code.session.model.CommandChoice
import org.deveco.code.session.model.CommandKind
import org.deveco.code.session.model.CommandKindInference
import org.deveco.code.session.model.ElicitationFieldItem
import org.deveco.code.session.model.ElicitationItem
import org.deveco.code.session.model.ElicitationOptionItem
import org.deveco.code.session.model.FileReference
import org.deveco.code.session.model.ModeChoice
import org.deveco.code.session.model.ModelChoice
import org.deveco.code.session.model.newTurnBoundary
import org.deveco.code.session.model.PermissionChoice
import org.deveco.code.session.model.PermissionMode
import org.deveco.code.session.model.ModelPreferenceResolver
import org.deveco.code.session.model.PROVISIONAL_ERROR_ID_PREFIX
import org.deveco.code.session.model.SessionViewState
import org.deveco.code.session.model.snapshotLocalSystemRows
import org.deveco.code.session.model.defaultEffortToApply
import org.deveco.code.session.model.forwardedDefaultEffort
import org.deveco.code.session.model.hasVisibleUserParts
import org.deveco.code.session.model.mergeSnapshotItems
import org.deveco.code.session.model.renderSessionSnapshot
import org.deveco.code.session.ui.composer.isTextLikeMimeType
import java.io.File
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

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

// The only tool titles whose output the plugin is allowed to parse as a JSON
// path listing. ACP tool calls carry no tool name; MCP tools — the only
// producers of such listings — keep their tool name as the call title in the
// form `<client>_<tool>` (`ide_list_directory_tree`), so the suffix is matched.
// Everything else is rendered verbatim: an unrecognized title never gets parsed.
private val PATH_LISTING_TOOL_TITLES = listOf("list_directory_tree")

private fun isPathListingTool(title: String?): Boolean =
    PATH_LISTING_TOOL_TITLES.any { title?.endsWith(it) == true }

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
 * Heuristic TODO completion inference (section 5 tightened).
 *
 * Layer 1: file path exact match. Layer 2: shell keywords must appear in BOTH
 * the todo content and the command text. Layer 3: edit/delete match against
 * the tool title only — the full diff text shares a word with almost any item.
 * The old sequential fallback (tick the next pending item on ANY tool
 * completion) is gone: it pre-checked items the agent had not reached.
 * IN_PROGRESS items may be completed by exact matches so a turn that dies
 * after a single todowrite can still progress.
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

    val candidates = baseline.indices.filter {
        it !in inferredCompleted &&
            (baseline[it].status == TodoDockStatus.PENDING || baseline[it].status == TodoDockStatus.IN_PROGRESS)
    }
    if (candidates.isEmpty()) return null

    // Layer 1: File path exact match
    if (!completedToolPath.isNullOrBlank()) {
        val normalizedPath = completedToolPath.replace("\\", "/")
        val matched = candidates.firstOrNull { idx ->
            val todoContent = baseline[idx].content
            todoContent.contains(normalizedPath, ignoreCase = true) ||
                normalizedPath.substringAfterLast('/').let { fileName ->
                    fileName.length > 2 && todoContent.contains(fileName, ignoreCase = true)
                }
        }
        if (matched != null) return matched
    }

    // Layer 2: keyword must appear in both the todo content and the command
    val shellKeywords = listOf("build", "run", "check", "lint", "test", "compile")
    if (completedToolKind == ToolKind.EXECUTE) {
        val commandText = completedToolTitle.lowercase()
        val matched = candidates.firstOrNull { idx ->
            val todoContent = baseline[idx].content.lowercase()
            shellKeywords.any { kw -> todoContent.contains(kw) && commandText.contains(kw) }
        }
        if (matched != null) return matched
    }

    // Layer 3: title-only match for edit/delete tools
    if (completedToolKind == ToolKind.EDIT || completedToolKind == ToolKind.DELETE) {
        val titleLower = completedToolTitle.lowercase()
        val matched = candidates.firstOrNull { idx ->
            val todoContent = baseline[idx].content.lowercase()
            todoContent.split(" ").filter { it.length > 3 }.any { word ->
                titleLower.contains(word)
            }
        }
        if (matched != null) return matched
    }

    return null
}

/**
 * Section 11: the model forgets to close the previous in_progress item when
 * switching tasks. Keep only the LAST in_progress; earlier ones become
 * completed (advancing to phase N implies phase N-1 ended).
 */
private fun normalizeTodoStatuses(items: List<TodoDockItem>): List<TodoDockItem> {
    val lastInProgress = items.indexOfLast { it.status == TodoDockStatus.IN_PROGRESS }
    if (lastInProgress < 0) return items
    return items.mapIndexed { idx, item ->
        if (idx < lastInProgress && item.status == TodoDockStatus.IN_PROGRESS) {
            item.copy(status = TodoDockStatus.COMPLETED)
        } else {
            item
        }
    }
}

/**
 * Sections 10/12/13: activity inference. Non-todo tool paths light up the
 * matching item as IN_PROGRESS (spin), scanning only from the sequential
 * cursor forward. A path segment that also appears in any other item's
 * content is ambiguous and never matches (wrong state is worse than missing
 * state). When the hit lies beyond the cursor, every open item between the
 * cursor and the hit is marked completed.
 *
 * Returns the rebuilt list, or null when nothing matches.
 */
private fun inferTodoActivity(
    toolPath: String?,
    baseline: List<TodoDockItem>,
): List<TodoDockItem>? {
    if (toolPath.isNullOrBlank() || baseline.isEmpty()) return null
    val segments = toolPath.replace("\\", "/").split('/').filter { it.length > 2 }
    if (segments.isEmpty()) return null

    // Sequential cursor: the explicit in_progress item (at most one after
    // normalization), else the earliest open item.
    val cursor = baseline.indexOfFirst { it.status == TodoDockStatus.IN_PROGRESS }
        .takeIf { it >= 0 }
        ?: baseline.indexOfFirst { it.status == TodoDockStatus.PENDING }
    if (cursor < 0) return null

    for (idx in cursor until baseline.size) {
        if (baseline[idx].status != TodoDockStatus.PENDING) continue
        val content = baseline[idx].content
        val unambiguous = segments.filter { seg ->
            content.contains(seg, ignoreCase = true) &&
                baseline.indices.none { other ->
                    other != idx && baseline[other].content.contains(seg, ignoreCase = true)
                }
        }
        if (unambiguous.isEmpty()) continue
        return baseline.mapIndexed { i, item ->
            when {
                i == idx -> item.copy(status = TodoDockStatus.IN_PROGRESS)
                i in cursor until idx && item.status == TodoDockStatus.PENDING ->
                    item.copy(status = TodoDockStatus.COMPLETED)
                else -> item
            }
        }
    }
    return null
}

internal data class PromptHistoryEntry(
    val text: String,
    val attachments: List<AttachmentItem>,
    val fileReferences: List<FileReference>,
)

@Suppress("TooManyFunctions")
internal class SessionController(
    initialSessionId: String,
    private val service: AcpClientService,
    private val modelStore: SessionModelStore,
    private val tokenUsageStore: TokenUsageStore,
    restoredState: SessionViewState?,
    internal val project: com.intellij.openapi.project.Project,
    private var onLoaded: (() -> Unit)?,
) {
    private val log = Logger.getInstance(SessionController::class.java)
    private val viewStateStore = project.getService(SessionViewStateStore::class.java)

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

        // Matches queue position in backend messages: "position N of the queue"
        private val QUEUE_POSITION_REGEX = Regex("position\\s+(\\d+)\\s+of\\s+the\\s+queue", RegexOption.IGNORE_CASE)

        // 默认模型：新建/首次打开项目（本项目从未配置过模型）时自动选择 GLM-5.3，而非 Auto 或后端默认模型
        private const val DEFAULT_MODEL_NAME = "GLM-5.3"

        // 精确匹配 "DevEco Code/GLM-5.3" 或 "DevEco Code\GLM-5.3"（大小写不敏感），
        // 排除其他来源的同名模型（如 Alibaba(China)/GLM-5.3）
        private fun isDefaultModelChoice(choice: ModelChoice): Boolean {
            val normalized = choice.name.replace('\\', '/')
            val prefix = "deveco code/"
            return normalized.length > prefix.length &&
                normalized.substring(0, prefix.length).equals(prefix, ignoreCase = true) &&
                normalized.substring(prefix.length).equals(DEFAULT_MODEL_NAME, ignoreCase = true)
        }

        private const val MAX_PROMPT_HISTORY = 50
        private const val MAX_SESSION_UPDATES_PER_EDT_TURN = 64
        private const val MAX_TITLE_LEN = 50
        private const val COMPACTION_RATIO_THRESHOLD = 0.70

        // Builtin commands whose turn persists a user message replay emits no chunk
        // for (subtask part only); fallback for the subtask flag until the HTTP
        // command registry lands (the ACP update carries no subtask flag).
        private val BUILTIN_SUBTASK_COMMANDS = setOf("review", "analyze")

        // /debug arguments that only echo a state marker (the server persists a
        // debug-state part with no text, so replay emits no chunk for the turn).
        private val DEBUG_ECHO_ARGS = setOf("status", "clear")

        // Max bytes of a text attachment to inline verbatim; anything beyond gets a "[truncated N chars]" trailer.
        private const val MAX_INLINED_TEXT_BYTES = 60_000

        // Code snippet hybrid strategy: snippets <= this many lines are sent in full;
        // larger snippets emit a path + line-range reference so the model can read on demand.
        private const val CODE_PREVIEW_THRESHOLD_LINES = 500

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
    val pendingElicitation = mutableStateOf<ElicitationItem?>(null)
    val attachments = mutableStateListOf<AttachmentItem>()

    val fileReferences = mutableStateListOf<FileReference>()

    var pendingPrompt by mutableStateOf<String?>(null)

    // Text handed back to the composer when a prompt was dropped during
    // attachment prep (stop before dispatch). One-shot: the composer consumes
    // and clears it. Mirrors the TUI's interrupt-before-output recall.
    var restoreDraft by mutableStateOf<String?>(null)

    @Volatile
    var autoSendOnReady: String? = null

    /**
     * One-shot callback invoked on the EDT once the backend load completes, just before
     * [autoSendOnReady] so a caller can settle state ahead of the send. This is the only moment the
     * session's config options are known: a caller that wrote options before the tab opened — the
     * DevEco Studio bridge writes the mode before `session/load` can recompute it — needs it to sync
     * what the composer shows. Consumed once.
     */
    @Volatile
    var onReady: (() -> Unit)? = null

    var permissionMode by mutableStateOf(PermissionMode.RECOMMENDED)
        private set

    // Server-reported session context usage: the last UsageUpdate, or the value
    // restored from disk. Model changes deliberately keep these — they remain the
    // session's best known numbers (exact while an in-flight turn still runs the
    // old model) and the next UsageUpdate overwrites them, so the context ring
    // never blanks out across a model switch.
    var usedTokens by mutableStateOf(0L)
        private set
    var totalTokens by mutableStateOf(0L)
        private set
    var customTokenLimit by mutableStateOf(0L)
        private set

    // Prompt history for Up/Down arrow navigation (newest first, capped at 50).
    // When the user presses Up we walk backwards through previously sent prompts; Down walks
    // forward toward the most recent or an empty draft. Each entry stores both the text and
    // the lightweight attachment metadata (without thumbnails/originalBytes) so that Up/Down
    // can restore attachments alongside the text.
    private val promptHistory = mutableStateListOf<PromptHistoryEntry>()

    init {
        // Restore persisted usage so the ring shows real numbers on session re-open.
        tokenUsageStore.getUsage(sessionId)?.let { (u, t, c) ->
            usedTokens = u
            totalTokens = t
            if (c > 0) customTokenLimit = c
        }
        restoredState?.let {
            expandedThoughts.putAll(it.expandedThoughts)
            expandedTools.putAll(it.expandedTools)
            fileReferences.addAll(it.fileReferences)
            attachments.addAll(it.attachments.map { it.copy(thumbnail = null, originalBytes = null, optimizedBytes = null, optimizedMime = null) })
        }
        // Restore prompt history so Up/Down navigation survives a tab switch that
        // disposed the previous controller. Stored lightweight (no thumb/bytes).
        // Falls back to disk persistence so history survives IDE restart.
        val history = project.getService(SessionViewStateStore::class.java)
            .getPromptHistory(sessionId)
            ?: SessionStorage.loadPromptHistory(project, sessionId)
        if (history.isNotEmpty()) promptHistory.addAll(history)
    }

    // 0 until the backend reports a real limit via UsageUpdate; UI hides the ring on 0.
    val effectiveTotalTokens: Long
        get() = when {
            customTokenLimit > 0 -> customTokenLimit
            else                 -> totalTokens
    }

    val tokenThreshold: Long
        get() = effectiveTotalTokens

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
    // Set when the compaction threshold trips while a turn is still running
    // (per-step usage updates now arrive mid-turn); consumed at turn end.
    @Volatile
    private var pendingAutoCompact = false
    private var promptStartMs by mutableStateOf(0L)

    var status by mutableStateOf(MyMessageBundle.message("session.status.loading"))
        private set
    var ready by mutableStateOf(false)
        private set
    var sendTick by mutableStateOf(0)
        private set
    var responding by mutableStateOf(false)
        private set

    /**
     * A server-side turn is running that no client RPC started (a background
     * notice re-prompted this session). The composer offers stop for it; message
     * actions keep reading [responding], so they are unaffected.
     */
    var serverTurn by mutableStateOf(false)
        private set

    /**
     * True from the first stop click until the turn settles in the UI. A large
     * attachment payload delays session/cancel by seconds (it queues behind the
     * prompt on the same stdio pipe), so the composer immediately dims and
     * disables the stop button, and repeat clicks do not re-send the cancel.
     */
    var stopping by mutableStateOf(false)
        private set
    var todoDockItems by mutableStateOf<List<TodoDockItem>>(emptyList())
        private set
    // Heuristic TODO inference state
    @Volatile
    private var todoInferBaseline: List<TodoDockItem> = emptyList()
    @Volatile
    private var todoInferredCompleted: MutableSet<Int> = mutableSetOf()
    // Section 10: single index lit by activity inference / frontier fallback;
    // cleared whenever an explicit todowrite arrives.
    @Volatile
    private var todoInferredActive: Int = -1
    var models by mutableStateOf(emptyList<ModelChoice>())
        private set
    // Backend models from the backend's configOptions, filtered to connected
    // providers and the blacklist; blacklistListener re-filters on change
    // without re-fetching.
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
    private var lastHttpCommands: List<DevEcoHttpApi.CommandEntry> = emptyList()
    // Precomputed reverse-match index over skill bodies (/skill/status content).
    // Rebuilt on the pooled thread by refreshCommands; read on the EDT during
    // replay to restore the typed "/name args" for skill turns whose original
    // text was never saved locally — sent from another client (TUI/CLI),
    // persisted before the origText decoration, or sent via the pendingPrompt
    // path (#1388). Mirrors the TUI's render-time matchSkillExpansion.
    @Volatile
    private var skillExpansionIndex: SkillExpansionIndex = SkillExpansionIndex.EMPTY
    // Sticky-debug activity as observed from the server's debug-state markers
    // (live chunks and replay both carry them). The server resolves a bare
    // "/debug" by state — enter when idle, marker-only status echo when active
    // (packages/opencode/src/session/agent-mode/debug.ts) — and only the enter
    // turn consumes a replay index, so the send path needs this to classify it.
    // Reset on session load; replay rebuilds it from the markers in order.
    @Volatile
    private var debugModeActive = false
    // Index of this turn's user message in the replay order, or -1 when the turn
    // has none (subtask commands persist no user text, so the transcript and the
    // replay both skip it). Interrupted markers must use this instead of
    // `getBackendUserMsgCount() - 1`, which would point at an older message.
    @Volatile
    private var activeUserMsgIndex: Int = -1
    @Volatile
    private var skillDataLoaded = false

    @Volatile
    private var historyIndex = -1

    /**
     * Navigate prompt history. `direction < 0` = older (Up arrow), `direction > 0` = newer
     * (Down arrow). Returns the entry at the target position, or `null` if we should
     * show an empty draft (i.e. we've exhausted the history in that direction).
     */
    fun navigateHistory(direction: Int): PromptHistoryEntry? {
        if (promptHistory.isEmpty()) return null
        historyIndex = when {
            direction < 0 -> (historyIndex + 1) % promptHistory.size
            historyIndex <= 0 -> -1
            else -> historyIndex - 1
        }
        return if (historyIndex >= 0) promptHistory[historyIndex] else null
    }

    fun saveToHistory(text: String, attachments: List<AttachmentItem> = emptyList(), fileRefs: List<FileReference> = emptyList()) {
        // Strip @path text for file refs that are stored as chips, so Up/Down restores
        // chips instead of duplicating the path as both chip and @path text.
        val cleanedText = stripAtPathRefs(text.trim(), fileRefs)
        // Skip entries with no text AND no attachments AND no file refs — nothing to restore.
        if (cleanedText.isEmpty() && attachments.isEmpty() && fileRefs.isEmpty()) return
        // Avoid consecutive duplicates (common when the user resends the same prompt after an
        // error) while still allowing the same prompt at different positions later on.
        val entry = PromptHistoryEntry(cleanedText, attachments.map { it.copy(thumbnail = null, originalBytes = null, optimizedBytes = null, optimizedMime = null) }, fileRefs.toList())
        if (promptHistory.firstOrNull() != entry) {
            promptHistory.add(0, entry)
            if (promptHistory.size > MAX_PROMPT_HISTORY) promptHistory.removeAt(promptHistory.lastIndex)
            persistPromptHistory()
        }
        historyIndex = -1
    }

    private fun stripAtPathRefs(text: String, fileRefs: List<FileReference>): String {
        if (fileRefs.isEmpty() || !text.contains('@')) return text
        var result = text
        for (ref in fileRefs) {
            val atPath = "@${ref.path}"
            if (result.contains(atPath)) {
                result = result.replace(atPath, "").trim()
            }
        }
        return result
    }

    private fun persistPromptHistory() {
        val history = promptHistory.toList()
        // The constructor-stored store, not a fresh getService(): this runs inside
        // dispose(), where a plugin unload/disable may already have unregistered the
        // service — the lookup would return null and abort the whole disposal chain.
        viewStateStore.savePromptHistory(sessionId, history)
        // Disk write is best-effort here: failing it must not abort the controller's
        // teardown (which would leave listeners registered and pin the classloader).
        runCatching { SessionStorage.savePromptHistory(project, sessionId, history) }
            .onFailure { log.warn("Failed to persist prompt history for session $sessionId", it) }
    }

    fun resetHistoryIndex() { historyIndex = -1 }

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
    private var activeAssistantMessageId: String? = null
    @Volatile
    private var prompting = false

    // True once a terminal session.error has been routed to markLastAgentWithError
    // this turn. Suppresses the subsequent markLastAgentInterrupted call (e.g. from
    // a CancellationException or turnInterrupted) so "Generation cancelled" cannot
    // overwrite the real error card. Reset at each prompt start.
    @Volatile
    private var terminalErrorHandled = false

    /**
     * Non-null while the backend is retrying (queue waiting, 429 concurrent-
     * connection, etc.); carries the human-readable message from the
     * structured `session.status` retry event. The composer shows a non-
     * blocking notice bar above the input while this is non-null.
     * Cleared on idle transitions, prompt start/end, and session/update.
     */
    var retryNotice by mutableStateOf<String?>(null)
        private set
    private val sessionStatusListener: (String, SessionStatusInfo) -> Unit = { sid, status ->
        if (sid == sessionId) {
            if (status.type == "idle" && !sessionLoading && !prompting) {
                refreshSessionTimeline("idle")
            }
            if (prompting) {
                project.runInEdt {
                    if (!prompting) return@runInEdt
                    // The backend re-asserts "busy" at the start of every retry attempt, so
                    // clearing on it blinks the bar off between queue position updates.
                    when (status.type) {
                        "retry" -> retryNotice = localizeRetryMessage(status.message)
                        "busy" -> Unit
                        else -> retryNotice = null
                    }
                }
            }
        }
    }

    /**
     * Maps backend retry messages to localized UI text.
     * Backend always emits English messages; this function detects known patterns
     * and returns the corresponding localized bundle string.
     */
    private fun localizeRetryMessage(message: String?): String? {
        if (message == null) return null
        // Queue position: "You are now in position N of the queue"
        val queueMatch = QUEUE_POSITION_REGEX.find(message)
        if (queueMatch != null) {
            val position = queueMatch.groupValues[1]
            return MyMessageBundle.message("session.retry.queue.notice", position)
        }
        // Concurrent connection limit
        if (message.contains("concurrent connections", ignoreCase = true) ||
            message.contains("has reached its limit", ignoreCase = true)) {
            return MyMessageBundle.message("session.retry.concurrent.limit")
        }
        // Unknown retry message — pass through as-is
        return message
    }

    // Pre-loaded original texts for replay to avoid flashing promptText
    @Volatile
    private var replayOrigTexts: Map<Int, String> = emptyMap()
    // Pre-loaded file refs and attachments for replay to avoid flashing text-only state
    @Volatile
    private var replayFileRefs: Map<Int, List<FileReference>> = emptyMap()
    @Volatile
    private var replayAttachments: Map<Int, List<AttachmentItem>> = emptyMap()
    // Pre-loaded interrupted USER message indices for replay to restore
    // "Generation cancelled" markers on the correct AGENT messages.
    @Volatile
    private var replayInterruptedIndices: Set<Int> = emptySet()
    // Synchronous counter for replay user message index. Incremented in
    // handleSessionUpdate (on EDT) so it's correct even though addMessage
    // is async (invokeLater) — the actual messages list update is deferred
    // but the index advances immediately, matching the persistent save key.
    // @Volatile: reset on pooled thread (loadFromBackend), read/incremented on EDT.
    // Visibility relies on @Volatile + the load-response ordering + invokeLater FIFO ordering.
    @Volatile
    private var replayUserMsgCount = 0
    // Tracks which messageId has been assigned which replay index, so that
    // multiple UserMessageChunk events for the same message (e.g. text + file parts)
    // are merged into a single ChatItem instead of creating duplicates.
    private val replayMessageIdToIndex = mutableMapOf<String, Int>()
    // Tracks the last messageId that triggered a message creation from a non-text
    // content chunk (image/resource). Prevents duplicate messages when multiple
    // non-text chunks arrive for the same message.
    // @Volatile: same cross-thread pattern as replayUserMsgCount.
    @Volatile
    private var replayLastNonTextMsgId: String? = null
    @Volatile
    private var pendingModelRefresh = false
    @Volatile
    private var cancelled = false
    @Volatile
    private var stopped = false
    // Set by stopSession() while the client-side attachment prep (decode/optimize/
    // base64 of large images) is still running and no ACP prompt has been sent yet.
    // In that window session/cancel is a server-side no-op and the connection-layer
    // cancel marker is discarded as stale when the turn starts, so the prep thread
    // must check this flag itself and drop the prompt. Reset at every sendPrompt.
    @Volatile
    private var stopRequested = false
    @Volatile
    private var disposed = false
    // Compose state: the position-restore effect watches it so a load attempt that
    // ends without ready can release the restoringPosition mute (which would
    // otherwise block follow-tail forever). Also read on the EDT in
    // handleSessionUpdate.
    var sessionLoading by mutableStateOf(false)
        private set
    @Volatile
    private var started = false
    // Monotonic: set once the backend load completes successfully, never reset (a turn in
    // flight or clearConversation() leaves it true). The registry only caches controllers
    // that reached this, so a load that failed after retries is disposed on release instead
    // of being served stale — reopening the tab then rebuilds and retries the load.
    @Volatile
    private var loadSucceeded = false
    // Flipped once the load response is processed (queued behind the replay
    // notifications in the same FIFO). The SDK can dispatch queued replay chunks
    // before the response completes, so this flag may still be false while replay
    // chunks are handled — appendAgent exempts that window via sessionLoading;
    // this flag covers chunks arriving after the load, marking them complete.
    @Volatile
    private var replayComplete = false
    // Server messages fetched via HTTP during restoreReplayedMessageTimes; used by
    // the replay safety net to restore error info (errorText / interrupted) that ACP
    // replay doesn't carry. Cleared after the safety net consumes it.
    @Volatile
    private var serverMessageCache: List<DevEcoHttpApi.SessionMessageTime> = emptyList()
    // The same replay-time fetch paired with the timeline epoch it observed, so the
    // post-replay "load" reconciliation can reuse it instead of issuing a second
    // full request; stale once a prompt bumps the epoch.
    @Volatile
    private var replaySnapshotFetch: Pair<Long, List<DevEcoHttpApi.SessionMessageTime>>? = null
    // Read on the pooled refresh thread (unchanged-snapshot skip) and written on
    // the EDT commit; the signature hashes every part, so computing it off the EDT
    // keeps long sessions from stalling the UI thread.
    @Volatile
    private var lastAppliedSnapshotSignature: Triple<String, Int, Int>? = null
    // One snapshot pipeline (fetch → project → commit) at a time: turn-complete and
    // the server's idle status fire at the same turn end, and running both would
    // re-transfer and re-render identical state.
    private val snapshotRefreshInFlight = AtomicBoolean(false)
    // Invalidates snapshot requests that outlive the turn/load which started them.
    private val timelineEpoch = AtomicLong()
    private val snapshotRequestSequence = AtomicLong()
    private val latestSnapshotRequest = AtomicLong()
    // Headless mode: the editor closed while a turn is in flight; the registry keeps
    // this controller alive so the response keeps streaming and persisting.
    @Volatile
    internal var detached = false
        private set
    // Fires when the in-flight turn finishes while headless; cleared on re-attach.
    @Volatile
    private var onTurnCompleted: (() -> Unit)? = null
    private val pendingPermissions = mutableListOf<CompletableFuture<RequestPermissionResponse>>()
    @Volatile
    private var pendingElicitationResult: CompletableFuture<ElicitationResponse>? = null
    private val listener: (AcpSessionUpdate) -> Unit = ::onSessionUpdate
    private val editTracker = ToolEditTracker(sessionId, project.basePath ?: "")
    private val messageBusConnection = project.messageBus.connect()
    private val permissionHandler: suspend (RequestPermissionRequest) -> RequestPermissionResponse? =
        ::onPermissionRequest
    private val elicitationHandler: suspend (ElicitationRequest) -> ElicitationResponse? =
        ::onElicitationRequest
    private val globalModelListener: (String?) -> Unit = { _ ->
        applyGlobalModelPreference()
    }

    // Applies the current global model preference to this session. Sessions
    // where the user explicitly picked a model keep their own choice (the
    // same semantics as updateModels' restore branch); only sessions without
    // a per-session selection follow the global preference. No-ops while
    // the session is busy (prompting), its model list is empty, or the
    // stored model is not in the list — turn completion re-runs this for
    // sessions that were busy when the preference changed.
    private fun applyGlobalModelPreference() {
        // Headless cached controller: nobody is viewing it, so defer the backend write until
        // it is shown again (markAttached re-runs this). Avoids turning one global-model change
        // into a config write for every cached session.
        if (detached) return
        if (!ready || models.isEmpty()) return
        if (modelStore.wasManuallySelected(sessionId)) return
        val stored = modelStore.getGlobalModelId() ?: return
        val model = resolveStoredModel(stored) ?: return
        if (model.id == selectedModel?.id) return
        // Simple MutableState write —Compose snapshot system is multi-thread safe, no EDT
        // needed. Running this via updateUi{} would risk dropping it when disposed=true.
        selectedModel = model
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val configId = modelConfigId ?: return@executeOnPooledThread
                writeModelAndApplyDefault(configId, model.id)
            } catch (e: Exception) {
                log.warn("Failed to set session config option", e)
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

    private val runningListener: () -> Unit = {
        project.runInEdt {
            serverTurn = service.hasServerTurn(sessionId)
            // A stopped server-driven turn never passes through the local
            // onDone; release the stopping state once it disappears. Local
            // turns settle through onDone instead (responding still true here).
            if (!serverTurn && !responding) stopping = false
        }
    }

    fun start() {
        // Idempotent: re-attached headless controllers are already started.
        if (started) return
        started = true
        service.addSessionListener(listener)
        service.addPermissionHandler(permissionHandler)
        service.addElicitationHandler(elicitationHandler)
        service.addBackgroundSettledHandler(backgroundSettledHandler)
        service.addOnRunningChanged(runningListener)
        service.addQueuePositionListener(sessionStatusListener)
        serverTurn = service.hasServerTurn(sessionId)
        modelStore.addGlobalModelListener(globalModelListener)
        modelStore.addBlacklistListener(blacklistListener)
        messageBusConnection.subscribe(SESSION_REFRESH_TOPIC, SessionRefreshListener {
            // A headless cached controller has no UI to update; skip the backend-hitting
            // skill/catalog refresh and catch up in markAttached when it is shown again.
            if (detached) return@SessionRefreshListener
            refreshCommands()
            refreshModels()
        })
        ApplicationManager.getApplication().executeOnPooledThread { loadSession() }
    }

    fun stopSession() {
        // Reach the client-side attachment-prep phase too: until the ACP prompt
        // is on the wire, session/cancel has nothing to abort server-side.
        stopRequested = true
        // One cancel per turn: with a large attachment payload the cancel lands
        // seconds late (queued behind the prompt on the same stdio pipe), so
        // repeat clicks would only stack redundant RPCs without stopping any
        // sooner. stopping drives the immediate composer feedback and is
        // cleared when the turn settles (onDone / runningListener).
        if (!stopping) {
            stopping = true
            status = MyMessageBundle.message("session.status.stopping")
            ApplicationManager.getApplication().executeOnPooledThread {
                // Same guard as the raced-stop re-send: an unwrapped throw here
                // (cancelPrompt wraps a runBlocking cancel) would leave stopping
                // true with no cancel on the wire — release the button so the
                // click stays retryable until the turn settles anyway.
                runCatching { service.cancelSession(sessionId) }
                    .onFailure { e ->
                        log.warn("session/cancel dispatch failed, sessionId=$sessionId", e)
                        project.runInEdt { stopping = false }
                    }
            }
        }
        // 清空当前会话待处理的授权请求
        permissionChoices.clear()
        synchronized(pendingPermissions) {
            pendingPermissions.forEach { it.complete(cancelledPermission()) }
            pendingPermissions.clear()
        }
        cancelPendingElicitation()
    }

    /** True while a prompt round-trip is in flight (sendPrompt). */
    internal val isTurnActive: Boolean
        get() = prompting

    /** True once [start] has run; a headless-reused controller is already started. */
    internal val isStarted: Boolean
        get() = started

    /** True once a backend load completed successfully; the registry caches only these. */
    internal val isLoaded: Boolean
        get() = loadSucceeded

    /** The session's editor was (re)opened: leave headless mode. */
    internal fun markAttached() {
        val reattached = detached
        detached = false
        onTurnCompleted = null
        // While headless we skipped SESSION_REFRESH_TOPIC refreshes and the global-model
        // preference write (no UI to show them, and they hit the backend for a session nobody
        // is viewing). Catch up now so the `/` list, model dropdown and model choice are current.
        if (reattached) {
            refreshCommands()
            refreshModels()
            applyGlobalModelPreference()
        }
        // claimRoute takes the backend monitor; never on the EDT (editor open path).
        ApplicationManager.getApplication().executeOnPooledThread { service.claimSession(sessionId) }
        recoverPendingElicitation()
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
                // The HTTP registry is the race-free command source; the ACP
                // available_commands_update broadcast only fires on session
                // create/load/fork and can be dropped by the client-side
                // notification race, leaving the popup without builtins.
                lastHttpCommands = runCatching { service.commandEntries() }.getOrElse { emptyList() }
                lastSkillEntries = skills
                lastDiskEntries = disk
                skillScopeByName = skills.associate { it.name to it.scope }
                // Reverse-match index over the freshly fetched skill bodies, used
                // to restore typed "/name args" for replayed skill turns that have
                // no locally saved original text (see skillExpansionIndex). Built
                // here on the pooled thread so the per-message match on the EDT is
                // cheap. Empty content (builtins whose /skill/status body is blank)
                // is skipped by the index builder.
                skillExpansionIndex = SkillExpansionIndex.build(skills.map { SkillBody(it.name, it.content) })
                skillDataLoaded = true
                rebuildCommands()
                // Replay chunks that arrived BEFORE this index landed still show the
                // expanded template; rewrite those bubbles now that the bodies are
                // available. Idempotent, runs on the EDT behind the FIFO queue.
                enqueueSessionUiUpdate { restoreSkillExpansionsInMessages() }
            } catch (e: Exception) {
                log.warn("refreshCommands failed for $sessionId", e)
            }
        }
    }

    // Derived per send from the project-level command cache (populated by any
    // session's refresh). The registry can still be empty before the first fetch
    // ever completes; the send path then falls back to the builtin subtask names,
    // exactly like rebuildCommands() does for the popup list — a /review sent in
    // that window persists a subtask-part-only message replay emits no chunk for,
    // so keying it replayable would echo a bubble AND shift every later save key.
    private fun subtaskCommandNames(): Set<String> {
        val registry = service.cachedCommandEntries()
        if (registry.isEmpty()) return BUILTIN_SUBTASK_COMMANDS
        return registry.asSequence().filter { it.subtask }.map { it.name }.toSet()
    }

    // Re-fetches the model list on SESSION_REFRESH_TOPIC so model/API-key
    // changes in the settings page are reflected in the dropdown. Uses
    // set_config_option, not session/load — load replays the conversation
    // into the chat panel, duplicating already-rendered messages.
    // If mid-prompt, defer the refresh until the prompt completes to avoid
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
        val configOptions = refreshConfigOptions()
        if (configOptions != null) {
            ApplicationManager.getApplication().invokeLater {
                updateConfigOptions(configOptions)
            }
            log.info("refreshCatalogAndModels: sessionId=$sessionId catalogSize=${catalog.size} filteredSize=${filteredCatalog.size} configOptions=${configOptions.size}")
        } else {
            log.warn("refreshCatalogAndModels: sessionId=$sessionId set_config_option refresh returned null")
        }
    }

    // set_config_option returns the full configOptions with no history replay,
    // so re-asserting the current model doubles as a refresh (the backend
    // disposer invalidates its snapshot caches on disposeInstance, so the
    // first call after a config change serves fresh data). If the model no
    // longer exists after the change, retry once with the default choice.
    private fun refreshConfigOptions(): List<SessionConfigOption>? {
        val configId = modelConfigId ?: return null
        val current = selectedModel?.id
            ?: models.firstOrNull { isDefaultModelChoice(it) }?.id
            ?: return null
        runCatching { writeModelAndApplyDefault(configId, current) }
            .onSuccess { return it }
        val fallback = models.firstOrNull { isDefaultModelChoice(it) }?.id ?: return null
        if (fallback == current) return null
        return runCatching { writeModelAndApplyDefault(configId, fallback) }.getOrNull()
    }

    // backendModels (from the backend's configOptions) is the single source of
    // truth — the model Select choices only include models the backend can
    // actually serve, and they come back fresh after any config change (the
    // backend disposer invalidates its snapshot caches on disposeInstance).
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
        log.debug("rebuildRawModels: backendModels=${backendModels.size} cachedCatalogProviders=${connectedProviderIds} manualProviders=${manualProviderIds} blacklisted=${blacklistedIds.size} models=${models.size} modelIds=${models.map { it.id }}")
    }

    // Called when the currently selected model is no longer in the filtered
    // list (blacklisted or provider disconnected). Falls back to the built-in
    // default model (deveco code/GLM-5.3), or the first available model if
    // the built-in isn't present. Updates selectedModel, globalModelId, and
    // pushes the new selection to the backend.
    private fun selectFallbackModel() {
        // Identify the built-in (deveco) model by providerId from the cached
        // catalog — NOT by model name, because provider models (e.g.
        // alibaba-cn) can have the same model name (e.g. GLM-5.3).
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
        // Gate persistence on catalogEverFed: before the first successful
        // catalog fetch, builtinModelIds is unreliable (empty), so identifying
        // the built-in default and writing it to models.json / pushing it to
        // the backend would persist a wrong fallback. The local selection
        // above still keeps the session usable (dropdown shows fallback),
        // we just don't promote it to the global preference until we know
        // what the catalog actually says.
        if (modelStore.catalogEverFed()) {
            modelStore.setGlobalModelId(fallback.id)
            ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    val configId = modelConfigId ?: return@executeOnPooledThread
                    writeModelAndApplyDefault(configId, fallback.id)
                } catch (e: Exception) {
                    log.warn("selectFallbackModel: setSessionConfigOption failed, clearing globalModelId", e)
                    modelStore.setGlobalModelId(null)
                }
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
        // Prefer the HTTP /command registry (race-free); fall back to the last
        // available_commands_update while the HTTP fetch has not landed yet.
        val available: List<Triple<String, String?, String?>> = lastHttpCommands
            .takeIf { it.isNotEmpty() }
            ?.map { Triple(it.name, it.description, it.source) }
            ?: lastAvailableCommandsUpdate?.availableCommands
                ?.map { Triple(it.name, it.description, sourceOf(it._meta)) }
            ?: emptyList()
        val availableNames = available.map { it.first }.toSet()
        // A command is a skill if it lives in the /skill or on-disk caches, OR
        // if the backend tagged it source == "skill". The old code folded ALL
        // available_names in, which made /init, /review, ... satisfy the "is a
        // skill" filter and wiped nonSkillCommands — so every plain slash
        // command vanished from the popup.
        val allSkillNames = (
            lastSkillEntries.map { it.name } +
            lastDiskEntries.map { it.name } +
            available.filter { it.third.equals("skill", true) }.map { it.first }
        ).toSet()
        if (skillDataLoaded) {
            skillCommands = SkillStore.filterSlashSkills(lastSkillEntries, lastDiskEntries, project, availableNames)
                .map { CommandChoice(it.name, it.description, CommandKind.SKILL) }
        }
        // Non-skill: registry minus any name that is a known skill.
        // Also exclude internal prompt-template commands (contain ':') that
        // are not meant to be user-facing slash commands.
        val subtaskNames = lastHttpCommands.takeIf { it.isNotEmpty() }
            ?.filter { it.subtask }?.map { it.name }?.toSet()
            // Before the HTTP registry lands only the ACP update is available and
            // it carries no subtask flag; fall back to the builtin subtask names so
            // a /review sent in that window is not keyed as replayable.
            ?: BUILTIN_SUBTASK_COMMANDS
        nonSkillCommands = available
            .filter { it.first !in allSkillNames && !it.first.contains(':') }
            .map {
                CommandChoice(
                    it.first,
                    it.second ?: "",
                    CommandKindInference.infer(it.first, it.third),
                    it.first in subtaskNames,
                )
            }
        commands = nonSkillCommands + skillCommands
    }

    // The backend persists a slash command's EXPANDED template as the turn's user
    // message (ACP delegates "/name args" to session/command) and the TUI renders
    // exactly that persisted text. ACP never streams the user message live, so the
    // send path mirrors the expansion locally (expandedSlashEcho) and needs no
    // typed-text decoration. Only when the expansion cannot be reproduced — skills,
    // missing or lazy templates, inline shell — is the typed text echoed and saved
    // here like the other per-message decorations, keeping live and replay
    // consistent. Commands whose turn leaves no replayable user message must NOT
    // save: replay emits no chunk for them, the replay index skips the turn, and
    // this entry would then be applied to the NEXT message's bubble.
    private fun savesReplayableSlashText(text: String): Boolean {
        val name = slashCommandName(text) ?: return false
        if (name == "compact" || name == "debug") return false
        return commands.firstOrNull { it.name == name }?.subtask != true
    }

    // The expanded template text to echo for a replayable slash command, matching
    // what the server persists and the TUI shows. Null keeps the typed echo plus
    // its saved decoration: skills stay typed because the TUI collapses their
    // expansion into a compact badge; MCP prompt templates resolve lazily and
    // never reach the registry as strings; and "!`cmd`" inline shell is executed
    // server-side, so expanding here would diverge from the persisted text.
    private fun expandedSlashEcho(text: String): String? {
        if (!savesReplayableSlashText(text)) return null
        val name = slashCommandName(text) ?: return null
        if (commands.firstOrNull { it.name == name }?.kind != CommandKind.COMMAND) return null
        val template = service.cachedCommandEntries().firstOrNull { it.name == name }?.template
        if (template.isNullOrEmpty() || hasShellSubstitution(template)) return null
        return expandCommandTemplate(template, slashCommandArgs(text)).trim()
    }

    // Reverse-matches a replayed user text against the loaded skill bodies —
    // the plugin-side twin of the TUI's matchSkillExpansion. The backend
    // persists the EXPANDED skill template as the user message, so a skill turn
    // no local origText decoration covers (sent from another client, persisted
    // before the decoration existed, or sent via the pendingPrompt path #1388)
    // would replay as the raw template. Restores the typed "/name args" shape
    // instead. The "/" prefix guard keeps the sweep idempotent: restored or
    // user-typed slash text can never re-match. Prompt history seeded during the
    // cold-cache window keeps the template text (pre-existing behaviour).
    private fun restoreSkillExpansion(text: String): String? {
        if (text.isEmpty() || text.startsWith("/")) return null
        return skillExpansionIndex.match(text)?.toTypedText()
    }

    // Cold-cache compensation: replay chunks that arrived before refreshCommands
    // populated skillExpansionIndex still show the expanded template; rewrite
    // those bubbles in place once the bodies land. Runs on the EDT.
    private fun restoreSkillExpansionsInMessages() {
        if (skillExpansionIndex === SkillExpansionIndex.EMPTY) return
        for (i in messages.indices) {
            val item = messages[i]
            if (item.role != ChatRole.USER || item.internalOnly) continue
            val restored = restoreSkillExpansion(item.text) ?: continue
            messages[i] = item.copy(text = restored)
        }
    }

    // /compact owns no USER bubble: ACP turns it into session.summarize, whose
    // compaction-part-only user message replay emits no chunk for, so the turn is
    // represented by a visible divider (TUI parity) instead of an echo the reopen
    // could never restore.
    private fun isCompactCommand(text: String): Boolean = slashCommandName(text) == "compact"

    fun sendPrompt(text: String): Boolean {
        val pending = pendingPrompt
        if (pending != null) {
            pendingPrompt = null
            if (!ready || memoryLimitReached) return false
            val hasAttachments = attachments.isNotEmpty()
            val attachmentList = if (hasAttachments) attachments.toList() else emptyList()
            if (hasAttachments) attachments.clear()
            val fileRefs = fileReferences.toList()
            val fileRefContents = fileRefs.map { readFileReferenceContent(it) }.filterNotNull()
            fileReferences.clear()
            val parts = mutableListOf<String>()
            if (fileRefContents.isNotEmpty()) parts.addAll(fileRefContents)
            parts.add(pending)
            if (text.isNotBlank()) parts.add(text)
            val promptText = parts.joinToString("\n\n")
            val displayText = if (text.isNotBlank()) "$pending\n\n$text" else pending
            val isFirstUserMessage = messages.none { it.role == ChatRole.USER && !it.internalOnly } &&
                SessionStorage.customTitle(project, sessionId).isNullOrBlank()
            val userMsgCountBefore = messages.size
            // This path never advances the backend user-message counter, so it
            // cannot claim a replay index for an interrupted marker. That also
            // means a pending prompt is replayed without its saved original
            // text/attachments; tracked as a follow-up (#1388) rather than
            // fixed here.
            activeUserMsgIndex = -1
            // Section 18: keep todoDockItems/todoInferBaseline across turns —
            // resumed sessions often never re-send todowrite, and clearing
            // made the dock vanish for the whole turn. Reset only the
            // inference overlays; the next explicit todowrite still wins.
            todoInferredCompleted = mutableSetOf()
            todoInferredActive = -1
            // The server only treats the first text part as a slash command.
            // `promptText` is that part: file-reference content is prepended to
            // it, so a chip in front of the command makes the server run a plain
            // prompt and persist the text. Probe the same string the server sees.
            val pendingSlashName = slashCommandName(promptText)
            val pendingDebugArgs = slashCommandArgs(promptText).lowercase()
            val pendingCompact = isCompactCommand(promptText)
            val userItem = appendUserAndTitle(
                displayText,
                attachmentList,
                isFirstUserMessage,
                fileRefs,
                // Same turn-shape rules as the direct send path: /debug owns no
                // bubble (the marker card is the turn) and /compact owns the
                // divider, or the live transcript and the reopen diverge.
                echo = !isSubtaskCommand(promptText, subtaskCommandNames()) &&
                    pendingSlashName != "debug" &&
                    !pendingCompact,
                compactionDivider = pendingCompact,
                bubbleText = expandedSlashEcho(promptText) ?: displayText,
            )
            // Same optimistic sticky-debug bookkeeping as the direct path, so a
            // bare /debug injected right after an enter classifies alike.
            if (pendingSlashName == "debug") {
                when {
                    pendingDebugArgs == "clear" -> debugModeActive = false

                    pendingDebugArgs.isNotEmpty() -> debugModeActive = true

                    else -> {}
                }
            }
            activeThoughtId = null
            activeAssistantMessageId = null
            timelineEpoch.incrementAndGet()
            prompting = true
            retryNotice = null
            terminalErrorHandled = false
            ready = false
            responding = true
            promptStartMs = System.currentTimeMillis()
            status = MyMessageBundle.message("session.status.responding")
            stopped = false
            stopRequested = false
            stopping = false
            // True once the prompt was handed to the ACP layer. A stop during
            // attachment prep drops it BEFORE dispatch: the backend never persists
            // a USER message for it, so no backend-indexed record (user message
            // count, interrupted index) may be advanced for the dropped turn.
            val promptDispatched = AtomicBoolean(false)
            val onDone: (Throwable?) -> Unit = { err ->
                var promptError = false
                when (err) {
                    null -> {}
                    is CancellationException -> {
                        cancelled = true
                        stopped = true
                    }
                    else -> {
                        if (service.isSessionClosed(sessionId)) {
                            // Same teardown attribution as the direct-prompt path.
                            log.warn("Pending prompt failed after session was closed by the user, sessionId=$sessionId", err)
                        } else {
                            promptError = true
                            log.error("Failed to send pending prompt", err)
                        }
                    }
                }
                val duration = if (promptStartMs > 0) System.currentTimeMillis() - promptStartMs else 0
                // A dropped prompt ran no turn: recording its prep-window seconds
                // as the last turn duration would skew the next turn's estimate.
                if (promptDispatched.get() && duration > 0) {
                    lastDuration = duration
                    SessionStorage.saveLastDuration(project, sessionId, duration)
                }
                promptStartMs = 0
                // Section 1/7: a "successful" turn may still have died
                // mid-way — the CLI maps stream failures to a normal
                // end_turn. Extract the reason from the CLI log HERE (file
                // IO must not run on the EDT); IN_PROGRESS todos are only a
                // secondary signal because the model may legitimately finish
                // to ask a question or summarize.
                val turnStartMs = if (duration > 0) System.currentTimeMillis() - duration else 0
                val streamFailure = if (err == null) TurnDiagnostics.diagnose(sessionId, turnStartMs) else null
                refreshSessionTimeline("turn-complete")
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
                // Turn completion must land after every notification of this turn: they are
                // drained in bounded batches from one FIFO, and a plain updateUi here could
                // overtake the not-yet-drained remainder of a fast token stream, completing
                // the message before its final chunks arrive.
                enqueueSessionUiUpdate {
                    prompting = false
                    retryNotice = null
                    responding = false
                    stopping = false
                    // This turn's own visible output (blank aborted shells and other
                    // turns' items don't count). Timestamp/content-based so list
                    // mutations from an earlier retract cannot skew it.
                    val turnHadOutput = turnStartMs > 0 && messages.any {
                        it.createdAt >= turnStartMs && it.role != ChatRole.USER &&
                            (it.role != ChatRole.AGENT || it.text.isNotBlank())
                    }
                    val retracting = cancelled && promptDispatched.get() && !turnHadOutput
                    // Hold `ready` until the retract settles so no new prompt can
                    // race the backend deletion.
                    ready = !retracting
                    status = MyMessageBundle.message("session.status.connected")
                    // A global model switch that arrived mid-turn was skipped
                    // (ready=false at the time); re-apply it now that the
                    // session is idle again.
                    applyGlobalModelPreference()
                    // A compaction threshold that tripped on a mid-turn usage
                    // update waits for the turn to end; run it now. An
                    // interrupted turn is skipped: before per-step pushes it
                    // never delivered an end-of-turn usage update either, so
                    // Stop must not kick off a fresh /compact turn.
                    if (pendingAutoCompact) {
                        pendingAutoCompact = false
                        if (err == null && !cancelled) startAutoCompact()
                    }
                    val turnInterrupted = err == null && (
                        streamFailure != null ||
                            (todoDockItems.any { it.status == TodoDockStatus.IN_PROGRESS } && !lastAgentHasVisibleText())
                        )
                    val anyAgentOrTool = messages.size > userMsgCountBefore + 1 ||
                        messages.any { m -> m.role == ChatRole.AGENT || m.role == ChatRole.TOOL }
                    if (promptDispatched.get() && duration > 0) {
                        val lastAgentIdx = messages.indexOfLast { it.role == ChatRole.AGENT }
                        if (lastAgentIdx >= 0) {
                            val updated = messages[lastAgentIdx].copy(duration = duration)
                            messages[lastAgentIdx] = updated
                        }
                    }
                    if (cancelled) {
                        cancelled = false
                        when {
                            // A prompt dropped before dispatch never existed for the
                            // backend — recall it into the composer (TUI-style
                            // interrupt-before-output), leaving no ghost user message
                            // that would vanish on reload.
                            !promptDispatched.get() ->
                                recallDroppedPrompt(userItem.id, text.takeIf { it.isNotBlank() }, pending, attachmentList, fileRefs, turnStartMs)
                            // Dispatched with zero visible output: retract the whole
                            // turn, backend rows included, and recall the prompt into
                            // the composer (TUI interrupt-before-output parity).
                            retracting ->
                                retractCancelledTurn(userItem.id, text.takeIf { it.isNotBlank() }, pending, attachmentList, fileRefs, null, turnStartMs)
                            // A dispatched turn with visible output keeps its bubble
                            // and gets exactly one terminal marker; only such a turn
                            // owned dock todos, so only such a stop cancels them.
                            else -> {
                                markLastAgentInterrupted(turnStartMs)
                                cancelPendingTodos()
                            }
                        }
                        sendTick++
                    } else {
                        if (turnInterrupted) {
                            markLastAgentInterrupted(turnStartMs)
                            cancelPendingTodos()
                        } else {
                            val completed = completeLastAgentMessageNow()
                            if (!completed && promptError) {
                                // Use the real error message (e.g. "Too many requests...")
                                // from the IOException; fall back to generic text.
                                markLastAgentWithError(err?.message?.takeIf { it.isNotBlank() } ?: MyMessageBundle.message("session.error.failed"))
                            } else if (!completed && messages.any { it.role == ChatRole.THOUGHT }) {
                                ensureCompletedAgentPlaceholder(duration)
                            }
                            if (!anyAgentOrTool && !promptError) {
                                appendErrorMessageNow(
                                    MyMessageBundle.message("session.error.noResponsePlain"),
                                    PROVISIONAL_ERROR_ID_PREFIX,
                                )
                            }
                        }
                    }
                }
                onTurnCompleted?.invoke()
            }
            if (hasAttachments) {
                ApplicationManager.getApplication().executeOnPooledThread {
                    try {
                        if (stopRequested) {
                            onDone(CancellationException("Stopped during attachment preparation"))
                            return@executeOnPooledThread
                        }
                        val blocks = buildAttachmentBlocks(promptText, attachmentList)
                        // A stop clicked while the (potentially seconds-long) image
                        // decode/optimize/base64 ran must not be swallowed: the ACP
                        // cancel marker for it is discarded as stale once the turn
                        // starts, so drop the prompt here instead.
                        if (stopRequested) {
                            onDone(CancellationException("Stopped during attachment preparation"))
                            return@executeOnPooledThread
                        }
                        promptDispatched.set(true)
                        service.prompt(sessionId, blocks, onDone)
                    } catch (e: Exception) {
                        onDone(e)
                    }
                }
            } else {
                promptDispatched.set(true)
                service.prompt(sessionId, promptText, onDone)
            }
            sendTick++
            return true
        }
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
        val isFirstUserMessage = messages.none { it.role == ChatRole.USER && !it.internalOnly } &&
            SessionStorage.customTitle(project, sessionId).isNullOrBlank()
        // Use a persistent backend-only counter as the save key so it matches
        // the replay index (which only counts backend-replayed messages, not
        // local-only messages like failed prompts or rejected attachments).
        val userMsgIndex = SessionStorage.getBackendUserMsgCount(project, sessionId)
        val userMsgCountBefore = messages.size
        // Subtask commands (/analyze, /review) are persisted by the server as a
        // subtask part with no user text, so the transcript only shows the
        // delegation card — echoing the typed command here would leave a bubble
        // ACP replay can never restore. The server reads the slash command from
        // the first text part only, which is `promptText` (file-reference
        // content is prepended); probing anything else would suppress the echo
        // for a plain prompt the server does persist.
        val subtaskCommand = isSubtaskCommand(promptText, subtaskCommandNames())
        val compactCommand = isCompactCommand(promptText)
        // /debug leaves no replayable user bubble in any argument shape: status and
        // clear echo a debug-state marker with no text part (replay emits no chunk
        // for the turn), while any other argument enters sticky debug mode whose
        // synthetic text replays internal-only. The TUI renders no user bubble for
        // /debug at all — the debug-state marker card is the turn's marker live and
        // on reopen — so the local echo is suppressed too and the typed text stays
        // only in prompt history.
        val debugCommand = slashCommandName(promptText) == "debug"
        // The marker-only turns also consume no replay index, exactly like the
        // subtask and compact turns: claiming one would apply their decorations to
        // the NEXT message's bubble and shift every later save key by one.
        // status/clear always echo; a bare /debug echoes too, but only while debug
        // is already active — idle it enters sticky mode with a replayable
        // synthetic text part (debug.ts handleDebugCommand).
        val debugArgs = slashCommandArgs(promptText).lowercase()
        val debugEcho = debugCommand &&
            (debugArgs in DEBUG_ECHO_ARGS || (debugArgs.isEmpty() && debugModeActive))
        // Keep the local view of the sticky-debug state in step with what was
        // sent, so a bare /debug right after an enter (before its marker lands)
        // classifies like the server's: the enter made debug active.
        if (debugCommand) {
            when {
                debugArgs == "clear" -> debugModeActive = false

                debugArgs.isNotEmpty() -> debugModeActive = true

                else -> {}
            }
        }
        val skipsReplayIndex = subtaskCommand || compactCommand || debugEcho
        // Recorded for interrupted-marker persistence: a turn that consumes no
        // replay index owns none, so `-1` keeps it from touching an older message.
        activeUserMsgIndex = if (skipsReplayIndex) -1 else userMsgIndex
        // Section 18: same as the pendingPrompt path — keep the dock across
        // turns, reset only inference overlays.
        todoInferredCompleted = mutableSetOf()
        todoInferredActive = -1
        // Pass original value (not promptText) for display, plus fileRefs for chip
        // rendering. Subtask commands pass echo=false: the server keeps no user
        // text for them, so only the delegation card represents the turn.
        // /compact likewise echoes nothing — the divider row is its turn marker.
        // Replayable slash commands echo the expanded template the server persists
        // (matching the TUI) whenever it can be reproduced locally.
        val slashEcho = expandedSlashEcho(promptText)
        val userItem = appendUserAndTitle(
            value,
            attachmentList,
            isFirstUserMessage,
            fileRefs,
            echo = !subtaskCommand && !compactCommand && !debugCommand,
            compactionDivider = compactCommand,
            bubbleText = slashEcho ?: value,
        )
        if (!skipsReplayIndex) {
            // Persist attachments, file refs, and original text by user message index.
            // During replay, the backend returns promptText (which includes file content);
            // we use the index to restore attachments/fileRefs and replace text with original value.
            // Save original text when file refs OR attachments are present, since
            // the backend may inject attachment content into the replayed text.
            // Slash commands only when the expanded echo was not reproducible
            // (slashEcho == null): the backend persists the expanded template, so
            // without the saved input replay would show the template while the live
            // bubble showed the typed "/name args" (see savesReplayableSlashText).
            // An expanded echo needs no decoration — replay renders the same
            // server template text the bubble already showed.
            val needOrigText = slashEcho == null && (
                fileRefs.isNotEmpty() || attachmentList.isNotEmpty() ||
                    (fileRefContents.isNotEmpty() && value != promptText) ||
                    savesReplayableSlashText(promptText)
                )
            if (attachmentList.isNotEmpty() || needOrigText) {
                val existingAtt = SessionStorage.loadAttachmentsByIndex(project, sessionId)
                val mergedAtt = existingAtt.toMutableMap()
                if (attachmentList.isNotEmpty()) mergedAtt[userMsgIndex] = attachmentList
                SessionStorage.saveAttachments(project, sessionId, mergedAtt)
            }
            if (fileRefs.isNotEmpty() || needOrigText) {
                val existingRefs = SessionStorage.loadFileRefsByIndex(project, sessionId)
                val mergedRefs = existingRefs.toMutableMap()
                if (fileRefs.isNotEmpty()) mergedRefs[userMsgIndex] = fileRefs
                SessionStorage.saveFileRefs(project, sessionId, mergedRefs)
            }
            if (needOrigText) {
                val existingTexts = SessionStorage.loadOriginalTexts(project, sessionId)
                val mergedTexts = existingTexts.toMutableMap()
                mergedTexts[userMsgIndex] = value
                SessionStorage.saveOriginalTexts(project, sessionId, mergedTexts)
            }
        }
        activeThoughtId = null
        activeAssistantMessageId = null
        timelineEpoch.incrementAndGet()
        prompting = true
        retryNotice = null
        terminalErrorHandled = false
        ready = false
        responding = true
        promptStartMs = System.currentTimeMillis()
        status = MyMessageBundle.message("session.status.responding")
        stopped = false
        stopRequested = false
        stopping = false
        // True once the prompt was handed to the ACP layer. A stop during
        // attachment prep drops it BEFORE dispatch: the backend never persists
        // a USER message for it, so no backend-indexed record (user message
        // count, interrupted index) may be advanced for the dropped turn.
        val promptDispatched = AtomicBoolean(false)
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
                        if (service.isSessionClosed(sessionId)) {
                            // The user deleted (or archived/detached) this session
                            // mid-turn; the backend legitimately fails the in-flight
                            // prompt once the deleted session's rows are gone.
                            // Teardown fallout, not an IDE error: log.error triggers
                            // the fatal-error balloon and appendErrorMessageNow would
                            // flash an in-session error card in an editor being closed
                            // — both skipped here.
                            log.warn("Prompt failed after session was closed by the user, sessionId=$sessionId", err)
                    } else {
                        promptError = true
                        log.error("Failed to send prompt with attachments", err)
                    }
                }
            }
            // Advance the counter only for a dispatched prompt the backend replays
            // as a user message: a prompt dropped during attachment prep never
            // reached the backend, and a subtask command persists no user text
            // part — advancing for either would shift every later replay index.
            // /compact persists a compaction-part-only message replay skips too, and
            // /debug status|clear persist a marker-only message replay skips as well.
            if (promptDispatched.get() && !skipsReplayIndex) {
                SessionStorage.setBackendUserMsgCount(project, sessionId, userMsgIndex + 1)
            }
            val duration = if (promptStartMs > 0) System.currentTimeMillis() - promptStartMs else 0
            // Dropped prompts leave no duration trace (same as the pending path).
            if (promptDispatched.get() && duration > 0) {
                lastDuration = duration
                SessionStorage.saveLastDuration(project, sessionId, duration)
            }
            promptStartMs = 0
            // Section 1/7: same mid-turn-death diagnosis as the pending path.
            val turnStartMs = if (duration > 0) System.currentTimeMillis() - duration else 0
            val streamFailure = if (err == null) TurnDiagnostics.diagnose(sessionId, turnStartMs) else null
            refreshSessionTimeline("prompt-complete")
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
            // Same FIFO-ordering rationale as the pending-prompt onDone above.
            enqueueSessionUiUpdate {
                prompting = false
                retryNotice = null
                responding = false
                stopping = false
                // Same visible-output check and retract gate as the pending path.
                val turnHadOutput = turnStartMs > 0 && messages.any {
                    it.createdAt >= turnStartMs && it.role != ChatRole.USER &&
                        (it.role != ChatRole.AGENT || it.text.isNotBlank())
                }
                val retracting = cancelled && promptDispatched.get() && !turnHadOutput
                ready = !retracting
                status = MyMessageBundle.message("session.status.connected")
                // A global model switch that arrived mid-turn was skipped
                // (ready=false at the time); re-apply it now that the
                // session is idle again.
                applyGlobalModelPreference()
                // A compaction threshold that tripped on a mid-turn usage
                // update waits for the turn to end; run it now. An interrupted
                // turn is skipped: before per-step pushes it never delivered
                // an end-of-turn usage update either, so Stop must not kick
                // off a fresh /compact turn.
                if (pendingAutoCompact) {
                    pendingAutoCompact = false
                    if (err == null && !cancelled) startAutoCompact()
                }
                val turnInterrupted = err == null && (
                    streamFailure != null ||
                        (todoDockItems.any { it.status == TodoDockStatus.IN_PROGRESS } && !lastAgentHasVisibleText())
                    )
                val anyAgentOrTool = messages.size > userMsgCountBefore + 1 ||
                    messages.any { m -> m.role == ChatRole.AGENT || m.role == ChatRole.TOOL }
                // Update the last AGENT message with the duration
                if (promptDispatched.get() && duration > 0) {
                    val lastAgentIdx = messages.indexOfLast { it.role == ChatRole.AGENT }
                    if (lastAgentIdx >= 0) {
                        val updated = messages[lastAgentIdx].copy(duration = duration)
                        messages[lastAgentIdx] = updated
                    }
                }
                if (cancelled) {
                    cancelled = false
                    // Same split as the pending path, plus one difference: this path
                    // persisted decorations and advanced the replay counter, so the
                    // zero-output retract rolls both back (userMsgIndex handed over).
                    when {
                        !promptDispatched.get() -> recallDroppedPrompt(userItem.id, value, null, attachmentList, fileRefs, turnStartMs)
                        retracting -> retractCancelledTurn(userItem.id, value, null, attachmentList, fileRefs, userMsgIndex, turnStartMs)
                        else -> {
                            markLastAgentInterrupted(turnStartMs)
                            cancelPendingTodos()
                        }
                    }
                    sendTick++
                } else {
                    // 正常完成时清除本轮的中断标志（subtask 回合没有回放索引，跳过）
                    val currentIdx = activeUserMsgIndex
                    if (currentIdx >= 0) {
                        val existing = SessionStorage.loadInterruptedIndices(project, sessionId)
                        if (currentIdx in existing) {
                            SessionStorage.saveInterruptedIndices(project, sessionId, existing - currentIdx)
                        }
                    }
                    if (turnInterrupted) {
                        markLastAgentInterrupted(turnStartMs)
                        cancelPendingTodos()
                    } else {
                        val completed = completeLastAgentMessageNow()
                        if (!completed && promptError) {
                            markLastAgentWithError(err?.message?.takeIf { it.isNotBlank() } ?: MyMessageBundle.message("session.error.failed"))
                        } else if (!completed && messages.any { it.role == ChatRole.THOUGHT }) {
                            ensureCompletedAgentPlaceholder(duration)
                        }
                        if (!anyAgentOrTool && !promptError) {
                            val modelInfo = selectedModel?.let { " (model: ${it.id})" } ?: " (no model selected)"
                            log.debug("Prompt produced no agent/tool output, sessionId=$sessionId, hasAttachments=$hasAttachments, MIMEs=${attachmentList.joinToString(",") { it.mimeType }}, model=$selectedModel")
                            val msg = if (hasAttachments) {
                                MyMessageBundle.message(
                                    "session.error.noResponseWithAttachments",
                                    attachmentList.joinToString(", ") { it.mimeType.ifBlank { "-" } }
                                ) + modelInfo
                            } else {
                                MyMessageBundle.message("session.error.noResponsePlain") + modelInfo
                            }
                            appendErrorMessageNow(msg, PROVISIONAL_ERROR_ID_PREFIX)
                        }
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
                    if (stopRequested) {
                        discardPromptArtifacts(userMsgIndex)
                        onPromptDone(CancellationException("Stopped during attachment preparation"))
                        return@executeOnPooledThread
                    }
                    val blocks = buildAttachmentBlocks(promptText, attachmentList)
                    // A stop clicked while the (potentially seconds-long) image
                    // decode/optimize/base64 ran must not be swallowed: the ACP
                    // cancel marker for it is discarded as stale once the turn
                    // starts, so drop the prompt here instead.
                    if (stopRequested) {
                        discardPromptArtifacts(userMsgIndex)
                        onPromptDone(CancellationException("Stopped during attachment preparation"))
                        return@executeOnPooledThread
                    }
                    promptDispatched.set(true)
                    service.prompt(sessionId, blocks, onPromptDone)
                } catch (e: Exception) {
                    // Prep threw (e.g. the file was moved/deleted between add and
                    // send) before dispatch: the counter gate skips the increment,
                    // so the decorations saved under userMsgIndex would outlive it
                    // and misbind onto the next prompt's replay index — clean them
                    // exactly like the stop-dropped path does.
                    if (!promptDispatched.get()) discardPromptArtifacts(userMsgIndex)
                    onPromptDone(e)
                }
            }
        } else {
            promptDispatched.set(true)
            service.prompt(sessionId, promptText, onPromptDone)
        }
        sendTick++
        return true
    }

    // A prompt dropped during attachment prep never reached the backend, but its
    // attachments/fileRefs/originalText were already persisted under userMsgIndex
    // when sendPrompt ran. The dropped turn does not advance backendUserMsgCount,
    // so the NEXT prompt reuses the same index — leftover entries would replay
    // onto that unrelated message (wrong text, ghost attachment chips).
    private fun discardPromptArtifacts(userMsgIndex: Int) {
        val attachmentsByIndex = SessionStorage.loadAttachmentsByIndex(project, sessionId).toMutableMap()
        if (attachmentsByIndex.remove(userMsgIndex) != null) {
            SessionStorage.saveAttachments(project, sessionId, attachmentsByIndex)
        }
        val fileRefsByIndex = SessionStorage.loadFileRefsByIndex(project, sessionId).toMutableMap()
        if (fileRefsByIndex.remove(userMsgIndex) != null) {
            SessionStorage.saveFileRefs(project, sessionId, fileRefsByIndex)
        }
        val originalTexts = SessionStorage.loadOriginalTexts(project, sessionId).toMutableMap()
        if (originalTexts.remove(userMsgIndex) != null) {
            SessionStorage.saveOriginalTexts(project, sessionId, originalTexts)
        }
    }

    // A prompt dropped during attachment prep never reached the backend: remove
    // the locally appended USER message (keeping it would show a bubble that
    // vanishes on reload, since replay has nothing for it) and hand the user's
    // content back to the composer — text via [restoreDraft], a flushed pending
    // The turn-end snapshot projects an aborted turn's assistant shell with
    // interrupted = aborted (SessionSnapshot), and it can land in [messages]
    // before the retract's backend delete runs. Such a blank shell is not
    // visible output: the zero-output retract gate discounts it (otherwise the
    // injection flips the gate and the turn silently keeps its bubble, blank
    // band and "Stopped" footer), and the recall sweep removes it so it cannot
    // survive as an orphan footer.
    private fun isAbortedAgentShell(item: ChatItem, turnStartMs: Long): Boolean =
        turnStartMs > 0 && item.role == ChatRole.AGENT && item.interrupted &&
            item.text.isBlank() && item.createdAt >= turnStartMs

    // prompt as its chip, attachment/file-ref chips as before the send. Mirrors
    // the TUI's interrupt-before-output recall. Runs on the EDT (FIFO UI drain);
    // items the user re-added while prep ran are skipped to avoid double chips.
    // [turnStartMs] bounds the [isAbortedAgentShell] sweep of the dropped turn's
    // own blank remnant; see the helper for why the snapshot can leave one here.
    private fun recallDroppedPrompt(
        userItemId: String,
        draft: String?,
        pendingRestore: String?,
        attachmentList: List<AttachmentItem>,
        fileRefs: List<FileReference>,
        turnStartMs: Long,
    ) {
        messages.removeAll { it.id == userItemId || isAbortedAgentShell(it, turnStartMs) }
        if (pendingRestore != null && pendingPrompt == null) pendingPrompt = pendingRestore
        if (!draft.isNullOrBlank() && restoreDraft == null) restoreDraft = draft
        attachmentList.forEach { att ->
            if (attachments.none { it.path == att.path }) attachments.add(att)
        }
        fileRefs.forEach { ref ->
            if (fileReferences.none { it.path == ref.path }) fileReferences.add(ref)
        }
    }

    // A turn cancelled with zero visible output retracts whole, mirroring the TUI's
    // interrupt-before-output recall: the backend USER message (plus any assistant
    // shell after it) is deleted over HTTP — the storage cascade takes the admitted
    // image parts with it — the replay counter and saved decorations roll back, and
    // the content returns to the composer. `ready` stays false meanwhile (settle
    // blocks) so no new prompt can race the deletion. Any failure falls back to the
    // interrupted marker, so the turn still settles visibly with exactly one marker.
    private fun retractCancelledTurn(
        userItemId: String,
        draft: String?,
        pendingRestore: String?,
        attachmentList: List<AttachmentItem>,
        fileRefs: List<FileReference>,
        userMsgIndex: Int?,
        notBeforeMs: Long,
    ) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val deleted = runCatching { deleteTurnMessagesFromLastUser(notBeforeMs) }
                .getOrElse {
                    log.warn("Retract: backend delete failed, sessionId=$sessionId", it)
                    false
                }
            if (deleted && userMsgIndex != null) {
                // The backend no longer has this turn's USER message: put the replay
                // index back and drop the decorations saved under it. The storage
                // helpers swallow I/O errors themselves; this guard is so an
                // unexpected throw cannot skip the ready=true enqueue below and
                // wedge the composer.
                runCatching {
                    SessionStorage.setBackendUserMsgCount(project, sessionId, userMsgIndex)
                    discardPromptArtifacts(userMsgIndex)
                }.onFailure { log.warn("Retract: bookkeeping rollback failed, sessionId=$sessionId", it) }
            }
            enqueueSessionUiUpdate {
                ready = true
                if (deleted) {
                    // Recall unconditionally, also while a newer prompt runs: the
                    // backend rows are gone, and keeping bubble+shell locally would
                    // show a ghost turn until the next snapshot refresh. The zero-output
                    // gate is timestamp/content-based, so removing this turn's rows
                    // cannot skew a running turn's decisions; draft/pending restore
                    // stays guarded inside recallDroppedPrompt.
                    recallDroppedPrompt(userItemId, draft, pendingRestore, attachmentList, fileRefs, notBeforeMs)
                } else {
                    markLastAgentInterrupted(notBeforeMs)
                }
                sendTick++
            }
        }
    }

    // Deletes this turn's user message and everything created from it up to (excluding)
    // the next user message (the aborted turn's assistant shell). The anchor is the
    // FIRST user message created at/after turn start — same-machine clocks make the
    // bound reliable, and it excludes earlier turns AND queued later prompts, whose
    // tails must survive this retract (anchoring on the newest user instead deleted a
    // not-yet-run queued turn while the cancelled turn's backend rows survived to be
    // re-projected by the next snapshot refresh). An empty window (message never
    // persisted, a backwards clock step, or a turn the backend persisted no user
    // message for — subtask commands persist no user text part) touches nothing and
    // reports failure, so the caller falls back to the interrupted marker rather than
    // risk another turn. The safety assertion rejects same-millisecond user ties
    // instead of guessing ownership. One retry: right after an abort the session can
    // still report busy.
    private fun deleteTurnMessagesFromLastUser(notBeforeMs: Long): Boolean {
        repeat(2) { attempt ->
            if (attempt > 0) Thread.sleep(300)
            val msgs = runCatching { service.sessionMessages(sessionId) }
                .onFailure { log.warn("Retract: listing messages failed, sessionId=$sessionId", it) }
                .getOrNull() ?: return@repeat
            val users = msgs.filter { it.hasVisibleUserParts() }.sortedBy { it.createdAt }
            val anchor = if (notBeforeMs > 0) users.firstOrNull { it.createdAt >= notBeforeMs } else users.lastOrNull()
            if (anchor == null) return false
            // A same-millisecond tie between two user messages cannot identify the turn.
            if (users.count { it.createdAt == anchor.createdAt } != 1) return false
            val nextUserCreatedAt = users.firstOrNull { it.createdAt > anchor.createdAt }?.createdAt
            val scope = msgs.filter {
                it.createdAt >= anchor.createdAt && (nextUserCreatedAt == null || it.createdAt < nextUserCreatedAt)
            }
            // The deleted window is exactly this turn: its user message plus any
            // assistant shells the aborted turn left behind — never a neighbour turn.
            if (scope.count { it.hasVisibleUserParts() } != 1) return false
            val ok = scope
                .sortedByDescending { it.createdAt }
                .all { m ->
                    runCatching { service.deleteMessage(sessionId, m.id) }.getOrElse {
                        log.warn("Retract: deleting message ${m.id} failed, sessionId=$sessionId", it)
                        false
                    }
                }
            if (ok) return true
        }
        return false
    }

    // Pre-flight: reject attachments we KNOW ACP will silently ignore (non-image, non-text
    // binaries like docx, xlsx, pdf, zip...). We produce a synchronous SYSTEM card here so the
    // user sees immediate feedback instead of waiting for a doomed round-trip.
    private fun handleUnsupportedAttachments(value: String, attachmentList: List<AttachmentItem>): Boolean {
        val unsupported = collectUnsupportedAttachmentNames(attachmentList)
        if (unsupported.isEmpty()) return false
        log.debug("Rejecting prompt pre-flight due to ${unsupported.size} unsupported attachments: ${unsupported.joinToString(";")}")
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
        val isFirst = messages.none { it.role == ChatRole.USER && !it.internalOnly } &&
            SessionStorage.customTitle(project, sessionId).isNullOrBlank()
        appendUserAndTitle(value, attachmentList, isFirst)
        appendErrorMessageNow(advice)
        // Do NOT touch ready/responding/prompting here: they were unchanged, so the user can
        // immediately try again with a different attachment.
        sendTick++
        return true
    }

    // Synchronous USER bubble: never rely on invokeLater for the user's own text. Also ensures
    // blank-text-when-attachments renders (attachment chips are rendered by UserMessageItem).
    // `echo=false` keeps the history/title/interaction side effects while leaving the
    // transcript without a bubble (subtask commands: the delegation card is the turn).
    // `bubbleText` overrides the bubble only ([value] still seeds history and title):
    // slash commands echo the expanded template the server persists — matching the
    // TUI — while history keeps the typed "/name args" for up-arrow recall.
    private fun appendUserAndTitle(
        value: String,
        attachmentList: List<AttachmentItem>,
        isFirstUserMessage: Boolean,
        fileRefs: List<FileReference> = emptyList(),
        echo: Boolean = true,
        compactionDivider: Boolean = false,
        bubbleText: String = value,
    ): ChatItem {
        // Messages keep render-only copies: optimizedBytes/optimizedMime are the
        // send-time cache, and pinning them to ChatItems would keep whole-image
        // bytes alive for the controller's entire life (the headless cache holds
        // several sessions; optimize returns the ORIGINAL bytes unchanged for
        // ≤1MB / undecodable / non-shrinking images, i.e. a full second copy).
        // Rendering and the preview dialogs read only thumbnail/name/path —
        // previews re-read from disk.
        val displayAttachments = attachmentList.map { it.copy(optimizedBytes = null, optimizedMime = null) }
        val item = when {
            echo -> appendUserMessageNow(bubbleText, displayAttachments, fileRefs)

            compactionDivider -> appendCompactionDividerNow()

            else -> appendTurnBoundaryNow()
        }
        saveToHistory(value, attachmentList, fileRefs)
        if (isFirstUserMessage) {
            val titleText = value.ifBlank { attachmentList.joinToString(", ") { it.name } }
            val title = if (titleText.length > MAX_TITLE_LEN) titleText.take(MAX_TITLE_LEN) + "..." else titleText
            DevEcoSessionActions.forProject(project).promptSent(sessionId, title)
        } else {
            DevEcoSessionActions.forProject(project).promptSent(sessionId, null)
        }
        return item
    }

    // A subtask has no visible USER bubble, but downstream UI aggregation still
    // needs an explicit logical boundary for copy and footer/status rendering.
    private fun appendTurnBoundaryNow(): ChatItem {
        val boundary = newTurnBoundary("TURN-${System.nanoTime()}")
        messages += boundary
        return boundary
    }

    // Visible turn marker for /compact turns (manual and auto): the backend's
    // compaction-part-only user message replays as no chunk at all, so both live
    // and reopen draw this divider instead of a USER bubble — the same rule the
    // TUI applies. The id prefix matches subtask boundaries so the safety net's
    // parentID fallback resolves the turn's summary assistant message.
    private fun appendCompactionDividerNow(id: String = "TURN-COMPACT-${System.nanoTime()}"): ChatItem {
        val divider = ChatItem(
            id = id,
            role = ChatRole.SYSTEM,
            title = "",
            text = "",
            turnBoundary = true,
            compactionDivider = true,
        )
        messages += divider
        return divider
    }

    private fun buildAttachmentBlocks(text: String, attachmentList: List<AttachmentItem>): List<ContentBlock> {
        val blocks = mutableListOf<ContentBlock>()
        if (text.isNotEmpty()) blocks.add(ContentBlock.Text(text))
        attachmentList.forEach { att ->
            when {
                att.isImage -> {
                    val cached = att.optimizedBytes
                    val cachedMime = att.optimizedMime
                    if (cached != null && cachedMime != null) {
                        // 方案一 cache hit: send the add-time payload and its add-time
                        // mime straight from memory — no disk read, no decode/scale/
                        // encode (the seconds-long window during which an immediate
                        // stop was swallowed). The mime was decided against the
                        // add-time original, so a file rewritten after add cannot
                        // mislabel the cached payload.
                        log.debug("Sending attachment: ${att.name}, size=${cached.size} bytes (cached at add), mimeType=$cachedMime, isImage=true")
                        blocks.add(ContentBlock.Image(data = Base64.getEncoder().encodeToString(cached), mimeType = cachedMime, uri = ""))
                    } else {
                        // History/replay-restored attachments and add-time optimize
                        // failures carry no cache: fall back to send-time read +
                        // compression (the pre-方案一 behavior).
                        val bytes = File(att.path).readBytes()
                        log.debug("Sending attachment: ${att.name}, size=${bytes.size} bytes, mimeType=${att.mimeType}, isImage=${att.isImage}")
                        val optimized = SendImageOptimizer.optimize(bytes, att.mimeType)
                        if (optimized.size < bytes.size) {
                            log.debug("Image optimized: ${att.name} ${bytes.size}B -> ${optimized.size}B")
                        }
                        val base64 = Base64.getEncoder().encodeToString(optimized)
                        val finalMime = if (optimized.size < bytes.size) "image/jpeg" else att.mimeType
                        blocks.add(ContentBlock.Image(data = base64, mimeType = finalMime, uri = ""))
                    }
                }
                isTextLikeMimeType(att.mimeType) -> {
                    val bytes = File(att.path).readBytes()
                    log.debug("Sending attachment: ${att.name}, size=${bytes.size} bytes, mimeType=${att.mimeType}, isImage=${att.isImage}")
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
                // that isn't image or text-like. If we ever land here, it means
                // the pre-flight check (at the top of sendPrompt) and this when-tree
                // have diverged —we log at WARN so the divergence is obvious, fall
                // back to a Resource block defensively, and move on.
                else -> {
                    val bytes = File(att.path).readBytes()
                    log.debug(
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
        cancelPendingElicitation()
        attachments.clear()
        activeThoughtId = null
        activeAssistantMessageId = null
        lastAppliedSnapshotSignature = null
        replaySnapshotFetch = null
        usedTokens = 0L
        totalTokens = 0L
        customTokenLimit = 0L
        memoryLimitReached = false
        tokenUsageStore.clearUsage(sessionId)
        compactionCount = 0
        compacting = false
        pendingAutoCompact = false
        replayComplete = false
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
        // The file may have been written by the external agent process and not yet
        // exist in the IDE's VFS — a plain findFileByPath would silently return null
        // (nothing opens). Resolve with a synchronous refresh off the EDT first.
        ApplicationManager.getApplication().executeOnPooledThread {
            val virtualFile = project.resolveVirtualFileWithRefresh(path) ?: return@executeOnPooledThread
            project.runInEdt {
                com.intellij.openapi.fileEditor.OpenFileDescriptor(project, virtualFile, line, 0).navigate(true)
            }
        }
    }

    /**
     * Files are written directly to disk by the external agent process, so the IDE's
     * VFS only learns about them through the file watcher — which batches and lags
     * (noticeably so when two sessions write concurrently). Trigger an async refresh
     * of the containing directories so generated files show up without a manual sync.
     */
    private fun refreshEditedFilesInVfs(paths: List<String>) {
        val base = project.basePath
        val dirs = paths.asSequence()
            .filter { it.isNotBlank() }
            // Protocol-reported paths can carry characters Path.of rejects (e.g. '*' on
            // Windows); skip those instead of letting one bad path abort the tool update.
            .mapNotNull { raw ->
                runCatching {
                    val p = java.nio.file.Path.of(raw.trim())
                    val resolved = if (p.isAbsolute || base == null) p else java.nio.file.Path.of(base).resolve(p)
                    resolved.normalize().parent?.toFile()
                }.getOrNull()
            }
            .distinctBy { it.absolutePath }
            // findFileByIoFile is a pure VFS lookup (no refresh, no events, no write
            // action needed); walk up because the agent may have created parent dirs too.
            .mapNotNull { dir ->
                generateSequence(dir) { it.parentFile }
                    .firstNotNullOfOrNull { com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByIoFile(it) }
            }
            .distinctBy { it.path }
            .toList()
        if (dirs.isEmpty()) return
        // Deliberately not refreshIoFiles: regardless of its async flag it maps every file
        // through refreshAndFindFileByIoFile first — a synchronous refresh that requires a
        // write action and trips TransactionGuard's "Write-unsafe context!" on this EDT
        // drain (verified in 243 and 261 platform bytecode). An async refresh of the
        // existing ancestor directories picks up new, changed and deleted children; newly
        // discovered directories are scanned recursively by the refresh itself.
        com.intellij.openapi.vfs.newvfs.RefreshQueue.getInstance().refresh(true, false, null, dirs)
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
            val totalLines = selectedLines.size
            if (totalLines <= CODE_PREVIEW_THRESHOLD_LINES) {
                val lineNumbers = (fileRef.startLine..fileRef.endLine).toList()
                val formatted = selectedLines.zip(lineNumbers).joinToString("\n") { (line, num) ->
                    "%4d | %s".format(num, line)
                }
                "```file:${fileRef.path} lines:${fileRef.startLine}-${fileRef.endLine}\n$formatted\n```"
            } else {
                "```file:${fileRef.path} lines:${fileRef.startLine}-${fileRef.endLine} ($totalLines lines)\n```"
            }
        } catch (e: Exception) {
            log.warn("Failed to read file reference: ${fileRef.path.substringAfterLast('/')}", e)
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
        val model = models.firstOrNull { it.id == id } ?: return
        if (model.id == selectedModel?.id) return
        val previousModel = selectedModel
        val previousGlobalModelId = modelStore.getGlobalModelId()
        val previousGlobalConfigured = modelStore.isGlobalModelConfigured()
        selectedModel = model
        // Remember the explicit per-session pick (same memory-only lifetime as
        // the draft): the backend recomputes a zero-message session's model
        // back to its default on reload, and this is what restores the pick
        // when the controller is recreated.
        viewStateStore.update(sessionId) { existing ->
            (existing ?: SessionViewState.initial()).copy(selectedModelId = model.id)
        }
        modelStore.setGlobalModelId(model.id)
        modelStore.markManuallySelected(sessionId)
        status = MyMessageBundle.message("session.model.switching", model.name)
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val configId = modelConfigId ?: return@executeOnPooledThread
                writeModelAndApplyDefault(configId, model.id)
            } catch (e: Exception) {
                // Revert to the previous model so the dropdown doesn't show
                // a selection the backend rejected (e.g. "model not found").
                selectedModel = previousModel
                // Full rollback of everything the failed click persisted: the
                // global preference (restoring its configured flag, so a
                // rejected FIRST-ever selection does not disable the first-use
                // default backfill), the per-session memory, and the manual
                // mark — otherwise one failed click would permanently exempt
                // the session from global model switches. setGlobalModelId
                // re-fires listeners, so non-manual sessions that already
                // followed the doomed value revert with it.
                modelStore.setGlobalModelId(previousGlobalModelId, previousGlobalConfigured)
                viewStateStore.update(sessionId) { existing ->
                    existing?.copy(selectedModelId = previousModel?.id)
                }
                modelStore.unmarkManuallySelected(sessionId)
                addMessage(ChatRole.SYSTEM, MyMessageBundle.message("session.message.system"), error("session.model.error", e))
            } finally {
                // A mid-turn switch must not clobber the responding status — the
                // turn is still running and owns the footer until it finishes.
                status = if (responding) MyMessageBundle.message("session.status.responding")
                    else MyMessageBundle.message("session.status.connected")
            }
        }
    }

    fun addCustomModel(id: String, name: String) {
        // No-op for the dropdown — the backend config (updated via HTTP API
        // in Settings) is the single source of truth. SESSION_REFRESH_TOPIC
        // → refreshModels() picks up the new model via set_config_option.
        log.debug("Custom model update: $id ($name)")
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
        setSelected: (T?) -> Unit,
        apply: (T) -> Unit,
    ) {
        val item = options.firstOrNull { it.id == id } ?: return
        if (item.id == selected?.id) return
        setSelected(item)
        status = MyMessageBundle.message(switchingKey, item.name)
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                apply(item)
            } catch (e: Exception) {
                // Roll the selection back, same contract as selectModel: the
                // backend kept the old mode and only pushes CurrentModeUpdate
                // on a real change, so without this the UI would show the
                // rejected mode until the session reloads.
                setSelected(selected)
                addMessage(ChatRole.SYSTEM, MyMessageBundle.message("session.message.system"), error(errorKey, e))
            } finally {
                // Simple MutableState<String> —any-thread write propagates via snapshot MVCC.
                // A mid-turn switch must not clobber the responding status.
                status = if (responding) MyMessageBundle.message("session.status.responding")
                    else MyMessageBundle.message("session.status.connected")
            }
        }
    }

    fun dispose() {
        disposed = true
        // Flush the in-memory prompt history to the view-state store so a later
        // tab reopen can restore Up/Down navigation even when the controller is
        // disposed (idle session, no turn in flight).
        persistPromptHistory()
        messageBusConnection.disconnect()
        service.removeSessionListener(listener)
        service.removePermissionHandler(permissionHandler)
        service.removeElicitationHandler(elicitationHandler)
        service.removeBackgroundSettledHandler(backgroundSettledHandler)
        service.removeOnRunningChanged(runningListener)
        service.removeQueuePositionListener(sessionStatusListener)
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
        cancelPendingElicitation()
    }

    private fun loadSession() {
        loadFromBackend(restoreUsageFromLocalStore())
        // onLoaded restores the file preview on the editor that created this controller; it
        // runs once here after state is committed. Clear it afterwards: the lambda captures
        // that editor, and a headless-cached controller would otherwise retain the (closed)
        // editor's whole UI tree. A re-attached editor restores its own preview instead.
        onLoaded?.invoke()
        onLoaded = null
        // Populate the `/` skill list now that the backend instance is loaded,
        // so the first `/` invoke already shows skills (no empty→populated flip).
        refreshCommands()
    }

    // 1. Restore token usage from the local store first (never fails, no backend IO);
    // conversation history comes from the backend's replay instead.
    private fun restoreUsageFromLocalStore(): Triple<Long, Long, Long>? {
        val persistedUsage = tokenUsageStore.getUsage(sessionId) ?: return null
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
        return persistedUsage
    }

    // 2. Contact backend to fetch config options. This may fail; the usage restored above
    // remains in effect for the user regardless.
    private fun loadFromBackend(persistedUsage: Triple<Long, Long, Long>?) {
        timelineEpoch.incrementAndGet()
        sessionLoading = true
        // 重置中断/取消标志，防止复用 controller 时残留的 stopped=true 导致
        // replay 期间所有 AgentMessageChunk 事件被丢弃
        stopped = false
        cancelled = false
        val start = System.currentTimeMillis()
        val maxAttempts = 5
        var lastError: Exception? = null
        for (attempt in 1..maxAttempts) {
            try {
                val isNew = service.isNewSession(sessionId)
                // A retry after a partial failure (or a config-stale re-load) makes the backend
                // replay the full history again; start from an empty list so nothing duplicates.
                messages.clear()
                activeAssistantMessageId = null
                lastAppliedSnapshotSignature = null
                replaySnapshotFetch = null
                replayUserMsgCount = 0
                // Replay rebuilds the sticky-debug view from the markers in order;
                // start false so a previous load's tail state cannot leak in.
                debugModeActive = false
                replayMessageIdToIndex.clear()
                replayLastNonTextMsgId = null
                // Pre-load original texts, file refs, and attachments for replay
                // to avoid flashing text-only state before chips are restored
                replayOrigTexts = SessionStorage.loadOriginalTexts(project, sessionId)
                replayFileRefs = SessionStorage.loadFileRefsByIndex(project, sessionId)
                replayAttachments = SessionStorage.loadAttachmentsByIndex(project, sessionId)
                replayInterruptedIndices = SessionStorage.loadInterruptedIndices(project, sessionId)
                // Section 21: a freshly created session has no history to
                // replay. Loading it with replay=true would create a SECOND
                // ClientSession for the same id, and the SDK holder's
                // sessionDeferred.complete() is a no-op on the second call —
                // the holder keeps pointing at the creation-time instance
                // while prompts run on the new one. Updates then route to
                // Operations.notify (UI fine) and the prompt flow starves
                // (events=0) until the idle watchdog kills a healthy turn.
                // re-opened tabs etc. keep replay=true semantics.
                val tLocalReads = System.currentTimeMillis()
                updateConfigOptions(service.loadSession(sessionId, replay = !isNew), isNew)
                val tLoadRpc = System.currentTimeMillis()
                val cachedCommands = service.getAvailableCommands(sessionId)
                val cachedUsage = service.getCachedUsage(sessionId)
                val usageToRestore = cachedUsage?.let { Triple(it.first, it.second, 0L) } ?: persistedUsage
                // Put the state change behind the replay notifications in the same
                // bounded FIFO queue; a plain invokeLater can overtake notifications
                // left for the next drain turn. The dispatch order of late replay
                // chunks vs this action is not guaranteed — appendAgent treats both
                // sides as replay (sessionLoading window / replayComplete).
                enqueueSessionUiUpdate {
                    sessionLoading = false
                    replayComplete = true
                    reconcileBackgroundCards()
                }
                if (cachedCommands.isNotEmpty()) commands = cachedCommands
                if (usageToRestore != null && cachedUsage != null) {
                    usedTokens = usageToRestore.first
                    totalTokens = usageToRestore.second
                    val effectiveTotal = effectiveTotalTokens
                    if (effectiveTotal > 0 && usageToRestore.first > 0) {
                        memoryLimitReached = usageToRestore.first.toDouble() / effectiveTotal.toDouble() >= 1.0
                    }
                }
                // A fresh project has no command cache yet. Prime it before ready
                // unlocks interactive and auto-sent prompts, otherwise the first
                // subtask command falls back to the old user-echo behaviour.
                if (service.cachedCommandEntries().isEmpty()) {
                    runCatching { service.commandEntries() }
                        .onFailure { log.warn("Failed to preload command registry for $sessionId", it) }
                }
                ready = true
                loadSucceeded = true
                status = MyMessageBundle.message("session.status.connected")
                restoreEditedFilesFromDiff()
                val tDiff = System.currentTimeMillis()
                log.info(
                    "loadSession: $sessionId ready in ${System.currentTimeMillis() - start}ms (attempt $attempt) — " +
                        "localReads=${tLocalReads - start}ms loadRpc=${tLoadRpc - tLocalReads}ms " +
                        "sessionDiff=${tDiff - tLoadRpc}ms",
                )
                // Posted before autoSendOnReady so both land on the EDT in this order: an external
                // caller settles its state first, then the parked prompt goes out.
                onReady?.let { callback ->
                    onReady = null
                    ApplicationManager.getApplication().invokeLater {
                        if (!project.isDisposed && !disposed) callback()
                    }
                }
                autoSendOnReady?.let { prompt ->
                    autoSendOnReady = null
                    ApplicationManager.getApplication().invokeLater {
                        if (!project.isDisposed) {
                            sendPrompt(prompt)
                        }
                    }
                }
                // Replayed messages are created with isComplete=false and createdAt=now();
                // the timestamp update joins the same FIFO behind all replay events.
                restoreReplayedMessageTimes()
                // Safety net in case the ordering contract above ever breaks: mark all
                // AGENT messages complete, and add a placeholder AGENT if the last
                // message is USER (backend didn't replay the interrupted response).
                enqueueSessionUiUpdate {
                    var safetyNetCompleteCount = 0
                    for (i in messages.indices) {
                        if (messages[i].role == ChatRole.AGENT && !messages[i].isComplete) {
                            safetyNetCompleteCount++
                            messages[i] = messages[i].copy(isComplete = true)
                        }
                    }
                    if (safetyNetCompleteCount > 0) {
                        log.debug("Safety net: marked $safetyNetCompleteCount AGENT message(s) as complete for session $sessionId")
                    }
                    // Restore interrupted markers using persisted indices.
                    // Track USER message index (matching backend replay order) and
                    // mark the AGENT message that follows as interrupted.
                    if (replayInterruptedIndices.isNotEmpty()) {
                        var userIdx = -1
                        for (i in messages.indices) {
                            when (messages[i].role) {
                                ChatRole.USER -> userIdx++
                                ChatRole.AGENT -> {
                                    if (userIdx in replayInterruptedIndices && !messages[i].interrupted) {
                                        log.debug("Safety net: marking AGENT message ${messages[i].id} as interrupted (userIdx=$userIdx)")
                                        messages[i] = messages[i].copy(interrupted = true)
                                    }
                                }
                                else -> {}
                            }
                        }
                    }
                    // Create a placeholder AGENT if the last message is USER or THOUGHT
                    // (no AGENT response was replayed by backend, e.g., interrupted turn).
                    val lastMsg = messages.lastOrNull()
                    if (lastMsg != null && (lastMsg.role == ChatRole.USER || lastMsg.role == ChatRole.THOUGHT)) {
                        val lastUserIdx = replayUserMsgCount - 1
                        val wasInterrupted = lastUserIdx in replayInterruptedIndices
                        log.debug("Safety net: last message is ${lastMsg.role}, creating placeholder AGENT for sessionId=$sessionId (interrupted=$wasInterrupted)")
                        messages += ChatItem(
                            "AGENT-${System.nanoTime()}",
                            ChatRole.AGENT,
                            MyMessageBundle.message("session.message.agent"),
                            "",
                            isComplete = true,
                            interrupted = wasInterrupted,
                        )
                    }
                    // Restore error info from server messages (HTTP authority data).
                    // ACP replay doesn't carry error info, but the backend persists it
                    // in the assistant message's info.error field (e.g. MessageAbortedError
                    // for interruptions, APIError for model failures). Match by message ID
                    // for replayed AGENT messages, or by parentID (the preceding USER
                    // message's server ID) for placeholder AGENTs whose synthetic ID can't match.
                    // This replaces the local-indexed persistence approach: no index
                    // offsets, no local JSON files for error texts.
                    if (serverMessageCache.isNotEmpty()) {
                        val errorById = serverMessageCache.filter { it.errorName != null }.associateBy { it.id }
                        // Compaction-part-only user messages replay as no chunk and own
                        // no local USER row, so they must not occupy an ordinal here
                        // (same exclusion as restoreReplayedMessageTimes), as do the
                        // marker-only /debug status|clear user messages.
                        val serverUserMsgs = serverMessageCache.filter {
                            it.role == "user" &&
                                !it.replayInvisibleUser() &&
                                it.hasVisibleUserParts()
                        }
                        val errorByParentID = serverMessageCache
                            .filter { it.errorName != null && it.parentID != null }
                            .associateBy { it.parentID!! }
                        // Ordinal alignment: local Nth USER = server Nth USER (same approach
                        // as restoreReplayedMessageTimes uses for timestamp restoration).
                        // Local replay USER messages have synthetic IDs (USER-${nanoTime}),
                        // so we must use the server USER's real ID to look up parentID.
                        var userOrdinal = 0
                        var lastServerUserId = ""
                        for (i in messages.indices) {
                            val msg = messages[i]
                            if (msg.role == ChatRole.USER) {
                                if (msg.internalOnly) continue
                                if (userOrdinal < serverUserMsgs.size) {
                                    lastServerUserId = serverUserMsgs[userOrdinal].id
                                }
                                userOrdinal++
                                continue
                            }
                            if (msg.turnBoundary) {
                                // Replay boundaries are keyed as TURN-<server USER id>,
                                // letting the subtask placeholder recover its own error
                                // instead of inheriting the preceding visible turn's.
                                lastServerUserId = msg.id.removePrefix("TURN-")
                                continue
                            }
                            if (msg.role != ChatRole.AGENT) continue
                            // Try matching by message ID first (for replayed AGENT messages
                            // that carry the backend ID); fall back to parentID matching using
                            // the preceding USER's server ID (for placeholder AGENTs whose
                            // synthetic ID can't match — e.g. turns where the model failed
                            // directly and the backend didn't replay any assistant content).
                            val serverError = errorById[msg.id] ?: errorByParentID[lastServerUserId]
                            if (serverError != null) {
                                val isAborted = serverError.errorName == "MessageAbortedError"
                                // MessageAbortedError → interrupted = true (rendered as
                                // "Generation cancelled" banner); intentionally don't set
                                // errorText so the interrupted flag drives the UI.
                                // Other errors → errorText = backend's error message.
                                messages[i] = msg.copy(
                                    interrupted = msg.interrupted || isAborted,
                                    errorText = if (isAborted) msg.errorText else (serverError.errorMessage ?: msg.errorText),
                                    completedAt = serverError.completedAt ?: msg.completedAt,
                                )
                            }
                        }
                        serverMessageCache = emptyList()
                    }
                    // Reorder: only move the LAST complete AGENT message to after any
                    // immediately following TOOL and THOUGHT messages. During live sessions,
                    // completeLastAgentMessageNow() moves the AGENT to the end of the list
                    // (after tool calls and thinking) so the action bar appears at the bottom.
                    // Replay doesn't do this, so we replicate the ordering here for the last
                    // AGENT only. Moving ALL complete AGENTs causes "content sinking" where
                    // all text sections get pushed to the end of the session.
                    val lastCompleteAgentIndex = messages.indexOfLast { it.role == ChatRole.AGENT && it.isComplete }
                    if (lastCompleteAgentIndex >= 0) {
                        val msg = messages[lastCompleteAgentIndex]
                        var lastIdx = lastCompleteAgentIndex
                        for (j in (lastCompleteAgentIndex + 1) until messages.size) {
                            if (messages[j].role == ChatRole.TOOL || messages[j].role == ChatRole.THOUGHT) {
                                lastIdx = j
                            } else {
                                break
                            }
                        }
                        if (lastIdx > lastCompleteAgentIndex) {
                            messages.removeAt(lastCompleteAgentIndex)
                            messages.add(lastIdx, msg)
                        }
                    }
                }
                // Clear replay maps on EDT so FIFO ordering guarantees this runs
                // AFTER all queued replay events have been processed.
                enqueueSessionUiUpdate {
                    replayOrigTexts = emptyMap()
                    replayFileRefs = emptyMap()
                    replayAttachments = emptyMap()
                    serverMessageCache = emptyList()
                    // Note: replayInterruptedIndices is NOT cleared here because
                    // late-arriving AGENT chunks (after safety net) still need it
                    // to set the interrupted flag in appendAgent.
                    replayUserMsgCount = 0
                    replayMessageIdToIndex.clear()
                    replayLastNonTextMsgId = null
                    // ACP does not replay a user-only turn after the session is reopened. Run
                    // the durable HTTP reconciliation once replay has drained so an early-stop
                    // conversation is not left as an empty new-session screen. The replay-time
                    // fetch is reused while the epoch is unchanged (no prompt started since),
                    // avoiding a second full request for the same state.
                    if (!isNew) {
                        val prefetched = replaySnapshotFetch
                            ?.takeIf { it.first == timelineEpoch.get() && it.second.isNotEmpty() }
                            ?.second
                        refreshSessionTimeline("load", prefetched)
                    }
                    replaySnapshotFetch = null
                }
                // Refresh the catalog AFTER the load RPC: these round-trips share the
                // backend's single event loop, so running them concurrently inflates the
                // load (58-285ms uncontended vs 528-1695ms contended). The dropdown
                // renders from the persisted cachedCatalog meanwhile.
                ApplicationManager.getApplication().executeOnPooledThread { applyCatalogRefresh() }
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
        // History now lives only in the backend; surface the failure in the
        // conversation so the user knows it is hidden, not lost.
        lastError?.let {
            addMessage(ChatRole.SYSTEM, MyMessageBundle.message("session.message.system"), error("session.error.load", it))
        }
        log.warn("Backend load failed after $maxAttempts attempts for session $sessionId", lastError)
    }

    // Fetches the model catalog and provider auth state after the load and caches
    // them; re-asserts the current model only when the connected-provider set
    // changed, so an unchanged set skips the set_config_option round-trip.
    private fun applyCatalogRefresh() {
        val catalog = runCatching { service.modelCatalog() }.getOrElse { emptyList() }
        val providers = runCatching { service.availableProviders() }.getOrElse { emptyList() }
        val disconnectedIds = providers.filter { !it.hasAuth }.map { it.id }.toSet()
        val safeCatalog = if (catalog.isNotEmpty() && disconnectedIds.isNotEmpty()) {
            catalog.filter { it.providerId !in disconnectedIds }
        } else {
            catalog
        }
        val previousCatalog = modelStore.getCachedCatalog()
        // Mirror reload()'s restart-guard: an empty backend result must NOT
        // overwrite a non-empty cache — a startup race that returns empty
        // mid-bootstrap would otherwise wipe a valid catalog. But when the
        // cache is also empty, feed the empty result so catalogEverFed
        // flips — "loaded, found nothing" is a legitimate terminal state,
        // distinct from "not yet loaded". Without this branch, a session
        // that loads against an empty backend keeps catalogEverFed=false
        // indefinitely (until the settings page is opened, which feeds via
        // reload()'s own guard), so the cold-start preference guards in
        // selectFallbackModel and the stale-preference clear path would
        // never fire on the session-load path.
        if (safeCatalog.isNotEmpty() || previousCatalog.isEmpty()) {
            modelStore.cacheCatalog(safeCatalog)
        }
        if (safeCatalog.isEmpty()) return
        val previousProviders = previousCatalog.map { it.providerId.lowercase() }.toSet()
        if (previousProviders == safeCatalog.map { it.providerId.lowercase() }.toSet()) return
        // Connection state changed mid-prompt: defer like refreshModels does.
        if (prompting) {
            pendingModelRefresh = true
            return
        }
        val refreshed = refreshConfigOptions()
        if (refreshed != null) {
            updateUi {
                updateConfigOptions(refreshed)
                val current = selectedModel
                if (current != null && models.none { it.id == current.id }) selectFallbackModel()
            }
        }
    }

    // Reopen path: replayed TOOL items lack live editTracker snapshots, so fetch the
    // authoritative per-file diff and reattach +A/-D counts for the Edited-files badges.
    private fun restoreEditedFilesFromDiff() {
        val diffs = runCatching { service.sessionDiff(sessionId) }.getOrElse { e ->
            log.warn("Failed to restore session diff for $sessionId", e); return
        }
        if (diffs.isEmpty()) return
        val byPath = diffs.associateBy { it.path }
        enqueueSessionUiUpdate {
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
        // the EDT. Drain a bounded batch per event-loop turn so a fast token stream
        // cannot monopolize the EDT and prevent IDE modal windows from opening.
        if (notification.sessionId.value != sessionId) return
        enqueueSessionUiUpdate {
            // Turn events flowing while a stop is pending prove the cancel lost
            // the pipe-order race: startPrompt launches asynchronously, so a
            // cancel sent around dispatch can still reach the server BEFORE the
            // prompt is written and gets processed against an idle session.
            // Flowing events prove the prompt is now admitted — a re-sent cancel
            // queues behind it and aborts the live turn. Release the stop button
            // too: if the re-send fails as well, a clickable button is the
            // user's escape hatch instead of an unstop turn.
            if (stopRequested && stopping && responding) {
                stopping = false
                ApplicationManager.getApplication().executeOnPooledThread {
                    runCatching { service.cancelSession(sessionId) }
                        .onFailure { log.warn("Cancel re-send on live turn events failed, sessionId=$sessionId", it) }
                }
            }
            // A session/update event means the backend resumed normal operation
            // (queue resolved, or 429 retry recovered). Clear the notices so
            // they don't persist through the rest of the turn.
            if (retryNotice != null) {
                retryNotice = null
            }
            handleSessionUpdate(notification.update)
        }
    }

    private val pendingSessionUiUpdates = ConcurrentLinkedQueue<() -> Unit>()
    private val sessionUpdateDrainScheduled = AtomicBoolean(false)

    private fun enqueueSessionUiUpdate(action: () -> Unit) {
        pendingSessionUiUpdates.add(action)
        scheduleSessionUpdateDrain()
    }

    private fun scheduleSessionUpdateDrain() {
        if (!sessionUpdateDrainScheduled.compareAndSet(false, true)) return
        // ModalityState.any(): a one-arg invokeLater from a background thread is
        // NON_MODAL and would be deferred while any modal dialog (e.g. IDE Settings)
        // is open, freezing live conversation updates behind it. The drain only writes
        // snapshot state, so running during modality is safe.
        ApplicationManager.getApplication().invokeLater({
            if (disposed) {
                pendingSessionUiUpdates.clear()
                sessionUpdateDrainScheduled.set(false)
                return@invokeLater
            }
            repeat(MAX_SESSION_UPDATES_PER_EDT_TURN) {
                val action = pendingSessionUiUpdates.poll() ?: return@repeat
                // One failing action must not wedge the drain: the flag reset below is
                // unreachable through an exception, and a stuck AtomicBoolean would
                // permanently freeze this session's UI updates.
                try {
                    action()
                } catch (e: Exception) {
                    log.error("Session update action failed, sessionId=$sessionId", e)
                }
            }
            sessionUpdateDrainScheduled.set(false)
            if (pendingSessionUiUpdates.isNotEmpty()) scheduleSessionUpdateDrain()
        }, ModalityState.any())
    }

    // Runs on the EDT via the bounded notification drain above.
    private fun handleSessionUpdate(update: SessionUpdate) {
        // During backend load, the server replays historical events — the only source of
        // conversation history. Message-producing events fall through to normal processing;
        // config/mode/commands/usage are handled inline and return early.
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
                // Message-producing events: fall through to normal processing below so the
                // backend's historical replay populates the UI.
                is SessionUpdate.AgentMessageChunk,
                is SessionUpdate.UserMessageChunk,
                is SessionUpdate.AgentThoughtChunk,
                is SessionUpdate.ToolCall,
                is SessionUpdate.ToolCallUpdate -> {
                }
                else -> return
            }
        } else if (!prompting && !stopped && !compacting) {
            // Message events outside replay/turn mean the ordering contract in
            // loadFromBackend() broke — warn so it surfaces in the field.
            // compacting turns run without prompting=true; stopped turns drop
            // their tail events below.
            when (update) {
                is SessionUpdate.AgentMessageChunk,
                is SessionUpdate.UserMessageChunk,
                is SessionUpdate.AgentThoughtChunk,
                is SessionUpdate.ToolCall,
                is SessionUpdate.ToolCallUpdate ->
                    log.warn(
                        "Message event outside replay/turn: ${update::class.java.simpleName} " +
                            "for sessionId=$sessionId — replay ordering contract may be violated",
                    )
                else -> Unit
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
            is SessionUpdate.AgentMessageChunk -> {
                // ACP server mirrors terminal session.error into an
                // agent_message_chunk (packages/opencode/src/acp/event.ts:
                // sessionErrorChunk). Its content.text carries the human-readable
                // message — the same field TUI's formatError reads from
                // error.data.message. Route these to the error path so the
                // GUI shows a terminal error card instead of ordinary agent
                // text, matching the TUI. Normal chunks fall through. The
                // messageId shape picks the attribution: live failures are
                // tagged "error-<eventId>" and keep the last-agent semantics;
                // replayed failures carry the server message id and must be
                // attributed to that exact message — during replay the last
                // incomplete AGENT belongs to an earlier turn, and stamping it
                // both puts the error on a successful reply and displaces that
                // item after the failed turn's prompt.
                val msgId = update.messageId?.value
                val chunkMeta = update._meta as? JsonObject
                val errorMeta = chunkMeta?.get("error") as? JsonObject
                // Sticky /debug transcript markers ride the same mirror as
                // agent chunks tagged _meta.debugState (event.ts:debugStateChunk).
                // Status lines, not model output — render a SYSTEM marker.
                val debugStateMeta = chunkMeta?.get("debugState") as? JsonObject
                val text = (update.content as? ContentBlock.Text)?.text
                when {
                    debugStateMeta != null -> appendDebugStateMarker(debugStateMeta, text)

                    errorMeta != null && !text.isNullOrEmpty() -> {
                        if (msgId != null && !msgId.startsWith("error-")) {
                            markAgentError(msgId, text)
                        } else {
                            markLastAgentWithError(text)
                        }
                    }

                    else -> (update.content as? ContentBlock.Text)?.let {
                        appendAgent(msgId ?: "streaming-agent", it.text)
                    }
                }
            }
            is SessionUpdate.UserMessageChunk -> {
                activeAssistantMessageId = null
                val textContent = update.content as? ContentBlock.Text
                val internalOnly = textContent != null && isAssistantAudience(textContent)
                // Internal notifications must be processed even mid-turn, otherwise
                // background cards keep spinning until the next reload.
                if (!prompting || internalOnly) {
                    SessionStorage.markInteracted(project, sessionId)
                    val msgId = update.messageId?.value
                    if (textContent != null) {
                        // Text content chunk
                        val isFirstChunk = msgId == null || !replayMessageIdToIndex.containsKey(msgId)
                        val userMsgIdx = if (isFirstChunk) {
                            val idx = if (internalOnly) -1 else replayUserMsgCount++
                            if (msgId != null) replayMessageIdToIndex[msgId] = idx
                            idx
                        } else {
                            replayMessageIdToIndex[msgId]!!
                        }
                        val origText = replayOrigTexts[userMsgIdx]
                        // Only create message for the first chunk of this messageId.
                        // Subsequent chunks (text or non-text) are skipped to avoid duplicates.
                        if (isFirstChunk) {
                            // Saved typed text wins; the skill reverse-match only
                            // rescues turns no local decoration covers.
                            val displayText = origText
                                ?: restoreSkillExpansion(textContent.text)
                                ?: textContent.text
                            val fileRefs = replayFileRefs[userMsgIdx] ?: emptyList()
                            val attachments = replayAttachments[userMsgIdx] ?: emptyList()
                            appendMessageNow(
                                ChatRole.USER, MyMessageBundle.message("session.message.you"), displayText, attachments, fileRefs,
                                internalOnly = internalOnly,
                                sourceMessageId = msgId,
                            )
                            if (internalOnly) {
                                // Wire text is authoritative; replay index mappings can skew.
                                mergeBackgroundNotification(textContent.text)
                            } else {
                                saveToHistory(displayText, attachments, fileRefs)
                            }
                        }
                    } else {
                        // Non-text content chunk (image, resource, resource_link).
                        // Create a message if this is a new messageId so attachment chips show.
                        if (msgId != null && msgId != replayLastNonTextMsgId && !replayMessageIdToIndex.containsKey(msgId)) {
                            replayLastNonTextMsgId = msgId
                            val userMsgIdx = replayUserMsgCount++
                            replayMessageIdToIndex[msgId] = userMsgIdx
                            val displayText = replayOrigTexts[userMsgIdx] ?: ""
                            val fileRefs = replayFileRefs[userMsgIdx] ?: emptyList()
                            val attachments = replayAttachments[userMsgIdx] ?: emptyList()
                            appendMessageNow(
                                ChatRole.USER,
                                MyMessageBundle.message("session.message.you"),
                                displayText,
                                attachments,
                                fileRefs,
                                sourceMessageId = msgId,
                            )
                            saveToHistory(displayText, attachments, fileRefs)
                        }
                    }
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
            // Per-step usage updates now arrive mid-turn; sending /compact into
            // a running turn would inject a command mid-activity, so defer to
            // turn end — when this check has always effectively run.
            if (prompting) pendingAutoCompact = true
            else startAutoCompact()
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

    private fun startAutoCompact() {
        // Re-validate the trigger guards: the deferred turn-end callers consume
        // a flag set earlier, so state may have moved on (a compaction already
        // running, or the budget spent). Without this a stale pending flag
        // could start a second /compact or exceed MAX_COMPACTIONS.
        if (compacting || compactionCount >= MAX_COMPACTIONS) return
        compacting = true
        compactionCount++
        val effectiveTotal = effectiveTotalTokens
        val pct = if (effectiveTotal > 0) (usedTokens.toDouble() / effectiveTotal * 100).toInt() else 0
        log.info("Token usage at $pct%, auto-compacting (attempt $compactionCount/$MAX_COMPACTIONS)")
        // The compact turn owns no replay index — its compaction-part-only user
        // message replays as no chunk — so the counter stays put; the divider row
        // marks the turn live and is rebuilt from the persisted part on reopen.
        appendCompactionDividerNow()
        service.prompt(sessionId, "/compact") { err ->
            if (err != null && err !is CancellationException) {
                log.warn("Auto-compaction failed", err)
            }
            compacting = false
            refreshSessionTimeline("compaction-complete")
        }
    }

    private fun appendAgent(id: String, chunk: String) {
        activeAssistantMessageId = id
        val index = messages.indexOfFirst { it.id == id }
        if (index < 0) {
            // A replayed chunk that arrives after the load response flipped
            // replayComplete: create the AGENT message immediately as complete. This
            // MUST be checked BEFORE the "drop late chunk" logic below, because the
            // safety net may have marked the previous turn's AGENT as complete, which
            // would trigger the drop and prevent the interrupted turn's AGENT message
            // from ever being created.
            if (replayComplete && !prompting) {
                // Check if this AGENT message should be marked as interrupted
                // by counting preceding USER messages to determine the index
                val userCount = messages.count { it.role == ChatRole.USER && !it.internalOnly }
                val interrupted = (userCount - 1) in replayInterruptedIndices && userCount > 0
                // If the safety net already created an empty placeholder AGENT for
                // this turn (because the AGENT chunk hadn't arrived yet), replace it
                // instead of appending a second one. An error card is never a
                // placeholder: replacing it would silently drop the failure text.
                val lastMsg = messages.lastOrNull()
                if (lastMsg != null && lastMsg.role == ChatRole.AGENT && lastMsg.text.isEmpty() && lastMsg.errorText == null) {
                    messages[messages.lastIndex] = lastMsg.copy(
                        id = id,
                        text = chunk,
                        isComplete = true,
                        interrupted = interrupted || lastMsg.interrupted,
                        sourceMessageId = id,
                    )
                    return
                }
                val message = ChatItem(
                    id,
                    ChatRole.AGENT,
                    MyMessageBundle.message("session.message.agent"),
                    chunk,
                    isComplete = true,
                    interrupted = interrupted,
                    sourceMessageId = id,
                )
                messages += message
                return
            }
            // Drop late chunks that arrive after the turn finished normally - prevents
            // new AGENT messages from appearing after the action bar of the previous turn.
            // Compaction calls service.prompt directly without setting prompting=true.
            // The sessionLoading exemption keeps the backend replay intact: every chunk
            // in the load window is history, and a failed turn's error chunk creates a
            // complete error placeholder that would otherwise make this guard drop the
            // text of every successful turn that follows it.
            val lastAgent = messages.lastOrNull { it.role == ChatRole.AGENT }
            if (lastAgent != null && lastAgent.isComplete && !prompting && !compacting && !sessionLoading) {
                log.info("appendAgent: dropping late chunk for new message id=$id, sessionId=$sessionId (turn already complete)")
                return
            }
            val message = ChatItem(
                id,
                ChatRole.AGENT,
                MyMessageBundle.message("session.message.agent"),
                chunk,
                isComplete = false,
                sourceMessageId = id,
            )
            messages += message
        } else {
            // During replay, allow appending text to a complete AGENT message
            // (late-arriving chunks after the safety net marked it complete).
            // sessionLoading exempts the load window for the same reason as above.
            if (messages[index].isComplete && !replayComplete && !sessionLoading) {
                log.info("appendAgent: dropping late chunk for already-complete message id=$id, sessionId=$sessionId")
                return
            }
            val updated = messages[index].copy(text = messages[index].text + chunk)
            messages[index] = updated
        }
    }

    // One answer is split into several AGENT items whenever a tool call separates the
    // streamed text (each text block carries its own messageId). Copy needs the turn's
    // answer re-joined across those segments without crossing the next logical turn.
    fun turnAgentText(item: ChatItem): String = collectTurnAgentText(messages, item)

    private fun appendThought(messageId: String?, chunk: String) {
        // Merge by backend message id (namespaced: the AGENT item reuses the raw id), so
        // EDT queueing delays and controller rebuilds cannot split one reasoning stream.
        val id = messageId?.let { "thought-$it" } ?: activeThoughtId ?: "thought-${System.nanoTime()}"
        val sourceMessageId = messageId ?: activeAssistantMessageId
        val index = messages.indexOfFirst { it.id == id }
        if (index >= 0) {
            val updated = messages[index].copy(
                text = messages[index].text + chunk,
                sourceMessageId = messages[index].sourceMessageId ?: sourceMessageId,
            )
            messages[index] = updated
        } else {
            val message = ChatItem(
                id,
                ChatRole.THOUGHT,
                "Thought",
                chunk,
                sourceMessageId = sourceMessageId,
            )
            messages += message
            expandedThoughts[id] = true
        }
        activeThoughtId = id
    }

    // Runs inside the same EDT drain as appendThought, so the reset stays ordered.
    private fun finishThought() {
        activeThoughtId?.let { expandedThoughts[it] = false }
        activeThoughtId = null
    }

    private fun updateTool(update: ToolUpdate) {
        val (id, title, kind, status, content, rawInput, rawOutput, locations) = update
        val itemId = "tool-$id"
        val previous = messages.firstOrNull { it.id == itemId }
        val effectiveRawOutput = rawOutput ?: previous?.toolRawOutput
        // The status stream identifies children only; the dispatch update is
        // where the child→parent edge becomes known. Later updates may carry a
        // rawOutput without the dispatch metadata, so fall back to the previous.
        val backgroundChild = AcpToolInputParser.backgroundJobId(rawOutput)
            ?: AcpToolInputParser.backgroundJobId(previous?.toolRawOutput)
        if (backgroundChild != null) {
            (AcpToolInputParser.backgroundParentId(rawOutput)
                ?: AcpToolInputParser.backgroundParentId(previous?.toolRawOutput))
                ?.let { service.noteSubagentDispatch(it, backgroundChild) }
        }
        val outputText = toolOutput(content, rawOutput, kind ?: previous?.toolKind, title) ?: previous?.text.orEmpty()
        // A completion notification is the terminal truth for a background card:
        // later updates still carry the dispatch-time "running" receipt (or a
        // forwarded child progress line with a literal in_progress) and would
        // otherwise spin the card back up and clobber the merged body.
        val merged = previous?.backgroundMerged == true
        // Background task calls complete at dispatch with a "running" receipt; keep
        // them running until the completion notification merges the terminal state.
        val toolStatus = when {
            merged -> previous?.toolStatus ?: status
            status == ToolCallStatus.COMPLETED &&
                kind == ToolKind.THINK &&
                backgroundChild != null &&
                AcpToolInputParser.parseTaskWrapper(outputText)?.state == "running" -> ToolCallStatus.IN_PROGRESS
            else -> status
        }
        if (merged && status != null && status != previous?.toolStatus) {
            log.debug("updateTool: ignoring late $status update for merged background card id=$id")
        }
        val displayText = if (merged) previous?.text.orEmpty() else outputText
        val readRange = AcpToolInputParser.readRange(rawInput)
        val path = AcpToolInputParser.readOutputPath(rawOutput)
            ?: locations?.firstOrNull()?.path
            ?: AcpToolInputParser.readPath(rawInput)
            ?: previous?.toolPath
        val running = toolStatus == null ||
            toolStatus == ToolCallStatus.PENDING ||
            toolStatus == ToolCallStatus.IN_PROGRESS

        // Compute per-file +A/-D edits. Snapshots are captured while the tool is
        // still running so the "always allow" path (no permission request) is
        // covered; on completion the snapshot is diffed against disk for a real
        // count. Protocol-provided counts take precedence when present.
        var parsedEdits = editTracker.parseEdits(kind, content, rawInput, rawOutput, locations)
        when {
            toolStatus == ToolCallStatus.FAILED -> editTracker.discard(id)
            toolStatus == ToolCallStatus.COMPLETED && parsedEdits.isNotEmpty() -> {
                val precise = editTracker.protocolCountsPrecise(rawOutput, content, rawInput)
                parsedEdits = editTracker.resolve(id, parsedEdits, precise)
            }
            running && kind == ToolKind.EDIT && parsedEdits.isNotEmpty() ->
                editTracker.capture(id, parsedEdits)
        }
        if (parsedEdits.isEmpty()) parsedEdits = previous?.toolFileEdits ?: emptyList()

        // The agent process wrote these files outside the IDE; nudge the VFS so the
        // project view and file icons catch up without waiting for the file watcher.
        // Skipped during history replay — those edits are old and already on disk.
        if (!sessionLoading && toolStatus == ToolCallStatus.COMPLETED &&
            (kind == ToolKind.EDIT || kind == ToolKind.DELETE)
        ) {
            refreshEditedFilesInVfs(parsedEdits.map { it.path } + listOfNotNull(path))
        }

        // A finished bash run (e.g. an hvigor build) leaves new artifacts and changed
        // sources on disk that fsnotifier may have missed under heavy IO; schedule the
        // platform save-and-sync refresh so the project tree and analysis converge
        // without waiting for frame activation or a manual Synchronize.
        if (!sessionLoading && toolStatus == ToolCallStatus.COMPLETED &&
            previous?.toolStatus != ToolCallStatus.COMPLETED &&
            (kind ?: previous?.toolKind) == ToolKind.EXECUTE
        ) {
            SaveAndSyncHandler.getInstance().scheduleRefresh()
        }

        val item = ChatItem(
            itemId,
            ChatRole.TOOL,
            title?.takeIf { it.isNotBlank() }
                ?: kind?.name?.lowercase()?.replace('_', ' ')
                ?: previous?.title
                ?: MyMessageBundle.message("session.tool.call"),
            displayText,
            kind ?: previous?.toolKind,
            path,
            locations?.firstOrNull()?.line?.toInt() ?: previous?.toolLine,
            readRange?.offset ?: previous?.toolOffset,
            readRange?.limit ?: previous?.toolLimit,
            toolStatus,
            rawInput,
            effectiveRawOutput,
            locations,
            parsedEdits,
            backgroundMerged = merged,
            sourceMessageId = previous?.sourceMessageId ?: activeAssistantMessageId,
        )
        val index = messages.indexOfFirst { it.id == item.id }
        val transitionedToFailure = toolStatus == ToolCallStatus.FAILED &&
            previous?.toolStatus != ToolCallStatus.FAILED
        if (index < 0) {
            messages += item
            // Tools default to collapsed; the user can expand manually to inspect output.
            expandedTools[item.id] = toolStatus == ToolCallStatus.FAILED
        } else {
            messages[index] = item
            if (transitionedToFailure) expandedTools[item.id] = true
            // Preserve the user's current expand/collapse state on updates — including
            // late background merges — so streaming parts never auto-flip a tool card.
        }
        if (isTodoTool(item)) {
            val parsed = normalizeTodoStatuses(parseTodoDockItems(item.toolRawInput, item.id))
            if (parsed.isNotEmpty()) {
                // Explicit todowrite is the highest priority; every inference
                // overlay resets (sections 10/13).
                todoDockItems = parsed
                todoInferBaseline = parsed
                todoInferredCompleted = mutableSetOf()
                todoInferredActive = -1
            }
        } else if (todoInferBaseline.isNotEmpty()) {
            if (toolStatus == ToolCallStatus.COMPLETED) {
                val matchedIdx = tryInferTodoCompletion(
                    kind, path, item.title, item.text,
                    todoInferBaseline, todoInferredCompleted,
                )
                if (matchedIdx != null) {
                    todoInferredCompleted.add(matchedIdx)
                    if (todoInferredActive == matchedIdx) todoInferredActive = -1
                }
            }
            rebuildTodoDock(path)
        }
    }

    /**
     * Sections 10-14: single place rebuilding the dock from the baseline.
     * Priority: explicit in_progress (normalized, at most one) > completion
     * inference (applied first) > activity inference (cursor + ambiguity) >
     * sequential frontier fallback. The frontier spins the first pending item
     * after the last completed one only when at least one item already
     * finished, so a fresh all-pending baseline stays still.
     */
    private fun rebuildTodoDock(toolPath: String?) {
        if (todoInferBaseline.isEmpty()) return
        var items = todoInferBaseline.mapIndexed { idx, base ->
            if (idx in todoInferredCompleted) base.copy(status = TodoDockStatus.COMPLETED) else base
        }
        if (items.none { it.status == TodoDockStatus.IN_PROGRESS }) {
            val active = inferTodoActivity(toolPath, items)
            if (active != null) {
                items = active
            } else {
                val lastCompleted = items.indexOfLast { it.status == TodoDockStatus.COMPLETED }
                val frontier = if (lastCompleted >= 0) {
                    (lastCompleted + 1 until items.size).firstOrNull { items[it].status == TodoDockStatus.PENDING } ?: -1
                } else {
                    -1
                }
                if (frontier >= 0) {
                    items = items.mapIndexed { idx, item ->
                        if (idx == frontier) item.copy(status = TodoDockStatus.IN_PROGRESS) else item
                    }
                }
            }
        }
        todoInferredActive = items.indexOfFirst { it.status == TodoDockStatus.IN_PROGRESS }
        todoDockItems = items
    }

    private fun toolOutput(
        content: List<ToolCallContent>?,
        rawOutput: Any?,
        kind: ToolKind?,
        title: String?,
    ): String? {
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
        // Output is shown exactly as the tool printed it unless the call is one of
        // the whitelisted path listings. Command output must never be reinterpreted:
        // JSON arrays such as `devecocli docs search --format json` are real output,
        // not file listings, and extracting one field per element would silently
        // drop the rest of every result. Titles outside the whitelist are never
        // parsed, so an unknown tool that prints `[{"title": …}]` stays verbatim.
        if (kind == ToolKind.EXECUTE || !isPathListingTool(title)) return rendered
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
     * Renders the JSON path listing of a whitelisted tool (see
     * [PATH_LISTING_TOOL_TITLES]) into plain text.
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
        // Only apply from a snapshot that still describes the selected model.
        // When updateModels scheduled a model write, the snapshot belongs to
        // the previous model; writeModelAndApplyDefault applies the new
        // model's default from that write's response instead.
        if (snapshotModelMatchesSelection(selects)) applyDefaultEffort(selects, isNewSession)
        updateModes(selects)
    }

    // Thin wrapper over the pure ModelPreferenceResolver: resolves a stored
    // preference against this session's filtered list, and applies the
    // silent storage-format upgrade for legacy bare names (uniqueness is
    // judged against the FULL catalog, not this session's view). See
    // ModelPreferenceResolver for the matching rules and their caveats.
    private fun resolveStoredModel(stored: String?): ModelChoice? {
        val result = ModelPreferenceResolver.resolve(stored, models, modelStore.catalogModelIds())
        result.upgradeTo?.let { modelStore.upgradeGlobalModelIdSilently(it) }
        return result.choice
    }

    private fun updateModels(selects: List<SessionConfigOption.Select>, isNewSession: Boolean = false) {
        val (option, choices) = findSelectOption(selects, "model") {
            val value = it.value.value
            val slashIdx = value.indexOf('/')
            val providerId = if (slashIdx >= 0) value.substring(0, slashIdx) else ""
            val modelId = if (slashIdx >= 0) value.substring(slashIdx + 1) else value
            ModelChoice(value, it.name, providerId, modelId)
        } ?: run {
            log.debug("updateModels: model Select not found in configOptions, selects=${selects.map { it.id.value }}")
            return
        }
        modelConfigId = option.id.value
        backendModels = choices
        log.debug("updateModels: sessionId=$sessionId backendModels=${choices.size} ids=${choices.map { it.id }}")
        rebuildRawModels()
        // A session whose model the user explicitly switched keeps that choice on
        // reload instead of being reset to the global preferred default. The
        // locally remembered pick wins over the backend's value: the backend
        // recomputes a zero-message session's model back to its default on
        // reload, which would silently discard a pick the user never
        // exercised with a prompt.
        // When the manual pick is no longer available, whatever replaces it
        // below is a CORRECTION of an invalid selection and must reach the
        // backend even though the session is manual: the manual guard exists
        // to protect a valid user choice, not to leave the backend silently
        // prompting with a model the UI has already abandoned (deleted
        // provider, edited-away model).
        var correctedFromInvalidPick = false
        if (modelStore.wasManuallySelected(sessionId)) {
            val remembered = viewStateStore.get(sessionId)?.selectedModelId
            val found = remembered?.let { rem -> models.firstOrNull { it.id == rem } }
                ?: models.firstOrNull { it.id == option.currentValue.value }
            if (found != null && (selectedModel == null || found.id == selectedModel?.id)) {
                selectedModel = found
                // The backend lost the pick (recomputed default on a
                // zero-message reload): re-assert it so the next prompt uses
                // what the user actually chose.
                if (found.id != option.currentValue.value) {
                    ApplicationManager.getApplication().executeOnPooledThread {
                        try {
                            modelConfigId?.let { writeModelAndApplyDefault(it, found.id) }
                        } catch (e: Exception) {
                            log.warn("updateModels: re-asserting remembered model failed", e)
                        }
                    }
                }
                return
            }
            // found == null: the manually selected model is no longer in the
            // session's list (edited/deleted/disconnected). Fall through to
            // the global/default selection — flagged as a correction.
            correctedFromInvalidPick = true
        }
        var globalModelId = modelStore.getGlobalModelId()
        // 首次使用（本项目从未配置过模型）时默认选择 GLM-5.3，而非 Auto/后端默认模型。
        // globalModelConfigured 用于区分"从未配置"与"用户主动选择 Auto"，后者不做默认回填。
        if (globalModelId == null && !modelStore.isGlobalModelConfigured()) {
            globalModelId = models.firstOrNull { isDefaultModelChoice(it) }?.also { default ->
                modelStore.setGlobalModelId(default.id)
            }?.id
        }
        selectedModel = when {
            globalModelId != null -> resolveStoredModel(globalModelId)
            else -> models.firstOrNull { it.id == option.currentValue.value }
        }
        // globalModelId expired: the preferred model no longer resolves in
        // this session's list. Only clear the stored preference when the
        // model is gone from the FULL catalog — a session-filtered miss
        // (blacklisted model, catalog not yet refreshed) must not wipe a
        // global-level preference; the session falls back locally and the
        // preference survives for sessions/refreshes where the model is
        // visible again.
        if (globalModelId != null && selectedModel == null) {
            val ids = modelStore.catalogModelIds()
            if (!modelStore.catalogEverFed()) {
                log.debug("updateModels: deferring stale-preference clear for globalModelId={}; catalog not yet fed", globalModelId)
            } else if (!ModelPreferenceResolver.existsInCatalog(globalModelId, ids)) {
                modelStore.setGlobalModelId(null)
            }
            selectedModel = models.firstOrNull { isDefaultModelChoice(it) } ?: models.firstOrNull()
        }
        val chosen = selectedModel ?: return
        if (correctedFromInvalidPick) {
            // Repoint the remembered pick at the replacement so reloads stop
            // retrying the deleted model.
            viewStateStore.update(sessionId) { existing ->
                (existing ?: SessionViewState.initial()).copy(selectedModelId = chosen.id)
            }
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                // Manual sessions keep their backend model — UNLESS this pass
                // replaced an invalid pick, in which case the correction must
                // reach the backend or the next prompt silently uses the
                // deleted model.
                if (modelStore.wasManuallySelected(sessionId) && !correctedFromInvalidPick) return@executeOnPooledThread
                val configId = modelConfigId ?: return@executeOnPooledThread
                // The backend already holds this value (e.g. just re-asserted
                // by refreshConfigOptions) — skip the redundant write.
                if (chosen.id == option.currentValue.value) return@executeOnPooledThread
                writeModelAndApplyDefault(configId, chosen.id)
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

    private fun snapshotModelMatchesSelection(selects: List<SessionConfigOption.Select>): Boolean {
        val selected = selectedModel ?: return false
        if (models.none { it.id == selected.id }) return false
        val model = selects.firstOrNull {
            it.category?.value.equals("model", true) || it.id.value.equals("model", true)
        } ?: return false
        return model.currentValue.value == selected.id
    }

    /** Writes the model and applies the default effort from the returned
     * config options. Every model-selection path shares this so none can
     * forget the default, and the effort write always uses the options that
     * belong to the model that was just applied. Call from a pooled thread. */
    private fun writeModelAndApplyDefault(configId: String, modelId: String): List<SessionConfigOption> {
        val options = service.setSessionConfigOption(sessionId, configId, modelId)
        ApplicationManager.getApplication().invokeLater {
            if (!disposed) applyDefaultEffort(options.filterIsInstance<SessionConfigOption.Select>())
        }
        return options
    }

    /** Applies the cloud-declared default effort ACP forwards via `_meta`.
     * There is no effort selector: this only keeps a fresh session on the
     * provider's default instead of ACP's first-tier fallback. */
    private fun applyDefaultEffort(selects: List<SessionConfigOption.Select>, isNewSession: Boolean = false) {
        val (option, choices) = findSelectOption(selects, "effort") { it.value.value } ?: return
        val target = defaultEffortToApply(
            choices,
            option.currentValue.value,
            forwardedDefaultEffort(option._meta),
            isNewSession,
        ) ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching { service.setSessionConfigOption(sessionId, option.id.value, target) }
                .onFailure { log.warn("applyDefaultEffort: failed to apply $target", it) }
        }
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

    private suspend fun onPermissionRequest(request: RequestPermissionRequest): RequestPermissionResponse? {
        if (request.sessionId.value != sessionId || disposed) return null
        // Headless (editor closed mid-turn): the permission card renders into Compose
        // state (messages + permissionChoices) that persists in this controller even
        // with no UI observing it. updateUi posts via invokeLater and only skips when
        // disposed, so the state is set while detached and surfaces automatically when
        // the editor re-attaches and the Compose tree read it. awaitCancellable
        // suspends the coroutine (no thread parked) until the user responds or until
        // stopSession/dispose cancels it. This lets concurrent sessions continue
        // running while their tabs are not focused.
        if (detached) {
            log.info("Permission request while headless, suspending for re-attach: ${request.toolCall.title}")
        }
        val toolTitle = request.toolCall.title ?: "unknown"
        log.debug("Permission request: tool=$toolTitle, mode=${permissionMode.label}, options=${request.options.size}")
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
            log.debug("No permission options available for $toolTitle, cancelling")
            return cancelledPermission()
        }

        log.debug("Showing permission prompt (${permissionMode.label}): $toolTitle")
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
            permissionChoices[messageId] = buildPermissionChoices(request, toolTitle, result, messageId)
        }
        return try {
            result.awaitCancellable()
        } finally {
            permissionChoices.remove(messageId)
            synchronized(pendingPermissions) { pendingPermissions.remove(result) }
        }
    }

    private fun handleAutoPermission(request: RequestPermissionRequest, toolTitle: String): RequestPermissionResponse {
        val firstOption = request.options.first()
        log.debug("Auto-approved (${permissionMode.label}): $toolTitle -> ${firstOption.name}")
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
                        }
                    }
                    log.debug("User rejected: $toolTitle (${permissionMode.label})")
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
                        }
                    }
                    log.debug("User approved: $toolTitle -> ${option.name} (${permissionMode.label})")
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

    // Synthetic server-side injections (e.g. background task notifications) are
    // tagged audience=[assistant]; the ACP contract keeps them out of the user view.
    private fun isAssistantAudience(content: ContentBlock.Text): Boolean {
        val audience = content.annotations?.audience ?: return false
        return audience.isNotEmpty() && Role.USER !in audience
    }

    // Sticky /debug turns persist a debug-state part as their only durable
    // record — the typed text is synthetic (enter) or absent (status/clear) —
    // and ACP mirrors it as an agent chunk tagged _meta.debugState so the turn
    // stays visible across reloads (packages/opencode/src/acp/event.ts). Render
    // it as a SYSTEM status line, matching the TUI's DebugStatePartView; the
    // chunk text is the server's English fallback, the localized line is
    // rebuilt from the meta. Markers must NOT touch replayUserMsgCount: the
    // saving side keys decorations per replayable user message and /debug
    // turns are index-free there (savesReplayableSlashText).
    private fun appendDebugStateMarker(meta: JsonObject, fallbackText: String?) {
        val state = (meta["state"] as? JsonPrimitive)?.contentOrNull
        val condition = (meta["condition"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
        // The TUI prints the typed command as a muted line above the status line
        // (DebugStatePartView renders part.command); the card title carries it here,
        // so a reopened transcript still shows what was typed for the turn.
        val command = (meta["command"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
        // The marker is the server's own statement of the sticky-debug state;
        // keep the send path's bare-/debug classification in step with it.
        when (state) {
            "set", "status" -> debugModeActive = true

            "cleared", "none" -> debugModeActive = false
        }
        val active = state == "set" || state == "status"
        val text = when {
            active && condition.isNotEmpty() -> MyMessageBundle.message("session.debug.state.active", condition)
            active -> MyMessageBundle.message("session.debug.state.active.empty")
            state == "cleared" && condition.isNotEmpty() -> MyMessageBundle.message("session.debug.state.cleared", condition)
            state == "cleared" -> MyMessageBundle.message("session.debug.state.cleared.empty")
            state == "none" -> MyMessageBundle.message("session.debug.state.none")
            else -> fallbackText ?: return
        }
        val title = command.ifEmpty { MyMessageBundle.message("session.debug.state.title") }
        appendMessageNow(ChatRole.SYSTEM, title, text)
    }

    // Fold a background completion notification into its task card: the wrapper's
    // id is the child session id carried in the card's rawOutput metadata.
    private fun mergeBackgroundNotification(text: String) {
        val wrapper = AcpToolInputParser.parseTaskWrapper(text) ?: return
        // A running wrapper is the dispatch receipt, not a terminal notice; the
        // card is already kept running for it by updateTool.
        if (wrapper.state == "running") return
        mergeBackgroundCard(wrapper.id, wrapper.body, wrapper.state)
    }

    // The backend only replays the completion notice, never pushes it live, so
    // the status stream reports the child leaving the busy set instead and the
    // body is read back from the child session.
    private val backgroundSettledHandler: (String, String, String?) -> Unit = { childSessionId, state, finalText ->
        mergeBackgroundCard(childSessionId, finalText, state)
    }

    // After an abort the backend defers a settled task's completion notice to
    // the next user prompt, so a restarted IDE replays only the dispatch
    // "running" receipt. Ask the backend once which still-running background
    // cards actually finished; busy ones keep spinning until the stream settles.
    private fun reconcileBackgroundCards() {
        val stale = messages
            .filter {
                it.role == ChatRole.TOOL &&
                    it.toolKind == ToolKind.THINK &&
                    !it.backgroundMerged &&
                    (it.toolStatus == ToolCallStatus.PENDING || it.toolStatus == ToolCallStatus.IN_PROGRESS)
            }
            .mapNotNull { AcpToolInputParser.backgroundJobId(it.toolRawOutput) }
            .toSet()
        if (stale.isNotEmpty()) service.reconcileBackgroundCards(stale)
    }

    private fun mergeBackgroundCard(id: String, body: String?, state: String) {
        updateUi {
            // Resumed tasks reuse the same jobId, so prefer a still-running card
            // over an earlier terminal card carrying the same id.
            val matches = messages.indices.filter {
                val item = messages[it]
                item.role == ChatRole.TOOL &&
                    item.toolKind == ToolKind.THINK &&
                    AcpToolInputParser.backgroundJobId(item.toolRawOutput) == id
            }
            val index = matches.firstOrNull {
                messages[it].toolStatus == ToolCallStatus.PENDING ||
                    messages[it].toolStatus == ToolCallStatus.IN_PROGRESS
            } ?: matches.lastOrNull() ?: return@updateUi
            val terminal = if (state == "completed") ToolCallStatus.COMPLETED else ToolCallStatus.FAILED
            messages[index] = messages[index].copy(
                // A blank body (e.g. an aborted child with no result text) must
                // not wipe the dispatch receipt the card already shows.
                text = body?.takeIf { it.isNotBlank() } ?: messages[index].text,
                toolStatus = terminal,
                backgroundMerged = true,
            )
            log.info(
                "mergeBackgroundCard: id=$id state=$state matches=${matches.size} " +
                    "index=$index card=${messages[index].id}",
            )
            // The dispatch receipt auto-expanded this card while it stayed "running";
            // collapse it again now that the completion notification merged the
            // terminal state, so finished background cards do not stay open.
            val mergedId = messages[index].id
            expandedTools[mergedId] = false
            expandedThoughts[mergedId] = false
        }
    }

    private fun addMessage(
        role: ChatRole,
        title: String,
        text: String,
        attachments: List<AttachmentItem> = emptyList(),
        fileRefs: List<FileReference> = emptyList(),
        internalOnly: Boolean = false,
    ) = updateUi {
        appendMessageNow(role, title, text, attachments, fileRefs, internalOnly)
    }

    private fun completeLastAgentMessage() {
        completeLastAgentMessageNow()
    }

    private fun ensureCompletedAgentPlaceholder(duration: Long) {
        val placeholder = ChatItem(
            "AGENT-" + System.nanoTime(),
            ChatRole.AGENT,
            MyMessageBundle.message("session.message.agent"),
            "",
            isComplete = true,
            duration = duration,
        )
        messages += placeholder
    }

    private fun completeLastAgentMessageNow(): Boolean {
        val lastAgentIndex = messages.indexOfLast { it.role == ChatRole.AGENT && !it.isComplete }
        if (lastAgentIndex >= 0) {
            val updated = messages[lastAgentIndex].copy(isComplete = true)
            messages.removeAt(lastAgentIndex)
            messages.add(updated)
            return true
        }
        return false
    }

    // User messages replay emits no user chunk for own no local USER row, so they
    // must not occupy an ordinal when reconciling replayed bubbles against server
    // messages: subtask-part-only, compaction-part-only, and /debug status|clear
    // marker-only (debug-state part without any text part). Sticky /debug enter
    // turns carry a synthetic text part next to the marker and replay into an
    // internal-only USER row, so they stay in the sequence.
    private fun DevEcoHttpApi.SessionMessageTime.replayInvisibleUser(): Boolean =
        hasSubtaskPart || hasCompactionPart || (hasDebugStatePart && !hasTextPart)

    /**
     * HTTP is the authority for durable messages. ACP still drives live streaming, then this
     * snapshot replaces all server-backed items at load/idle boundaries so a reopened session
     * and a completed live turn project through the same error, tool and ordering rules.
     *
     * The pipeline is fetch (pooled) → capture UI state (EDT) → project/merge (pooled) →
     * commit (EDT): hashing and rendering a full snapshot are O(session) and must not run on
     * the EDT. [prefetched] reuses an already-fetched snapshot (the post-replay "load"
     * reconciliation shares restoreReplayedMessageTimes' request) instead of fetching again.
     */
    private fun refreshSessionTimeline(
        reason: String,
        prefetched: List<DevEcoHttpApi.SessionMessageTime>? = null,
    ) {
        val targetSession = sessionId
        val epoch = timelineEpoch.get()
        if (!snapshotRefreshInFlight.compareAndSet(false, true)) {
            log.debug("Skipping duplicate session snapshot refresh ($reason): another refresh is in flight")
            return
        }
        val request = snapshotRequestSequence.incrementAndGet()
        latestSnapshotRequest.set(request)
        ApplicationManager.getApplication().executeOnPooledThread {
            val snapshot = prefetched
                ?: runCatching { service.sessionMessages(targetSession) }
                    .onFailure { log.debug("Session snapshot refresh failed ($reason)", it) }
                    .getOrNull()
            if (snapshot.isNullOrEmpty()) {
                snapshotRefreshInFlight.set(false)
                return@executeOnPooledThread
            }
            val signature = Triple(targetSession, snapshot.size, snapshot.hashCode())
            if (signature == lastAppliedSnapshotSignature) {
                log.debug("Skipping unchanged durable session snapshot ($reason): messages=${snapshot.size}, sessionId=$targetSession")
                snapshotRefreshInFlight.set(false)
                return@executeOnPooledThread
            }
            enqueueSessionUiUpdate {
                if (snapshotRequestStale(targetSession, epoch, request)) {
                    snapshotRefreshInFlight.set(false)
                    return@enqueueSessionUiUpdate
                }
                // Only the mutable transcript is read on the EDT; projection runs pooled.
                val previousItems = messages.toList()
                ApplicationManager.getApplication().executeOnPooledThread {
                    val plan = try {
                        planSessionSnapshot(snapshot, previousItems)
                    } catch (t: Throwable) {
                        snapshotRefreshInFlight.set(false)
                        throw t
                    }
                    enqueueSessionUiUpdate {
                        try {
                            if (!snapshotRequestStale(targetSession, epoch, request) &&
                                signature != lastAppliedSnapshotSignature
                            ) {
                                commitSessionSnapshot(reason, signature, snapshot.size, plan.first, plan.second)
                            }
                        } finally {
                            snapshotRefreshInFlight.set(false)
                        }
                    }
                }
            }
        }
    }

    private fun snapshotRequestStale(targetSession: String, epoch: Long, request: Long): Boolean =
        disposed ||
            sessionId != targetSession ||
            timelineEpoch.get() != epoch ||
            latestSnapshotRequest.get() != request

    /** Pure snapshot projection + local-row merge; runs on a pooled thread. */
    private fun planSessionSnapshot(
        snapshot: List<DevEcoHttpApi.SessionMessageTime>,
        previousItems: List<ChatItem>,
    ): Pair<List<ChatItem>, List<ChatItem>> {
        val currentVisibleUsers = previousItems.filter { it.role == ChatRole.USER && !it.internalOnly }
        val currentInternalUsers = previousItems.filter { it.role == ChatRole.USER && it.internalOnly }
        val serverVisibleUserCount = snapshot.count { it.hasVisibleUserParts() }
        val serverInternalUserCount = snapshot.count {
            it.role == "user" && !it.hasVisibleUserParts()
        }
        val canonical = renderSessionSnapshot(
            snapshot = snapshot,
            localUsers = currentVisibleUsers,
            originalTexts = replayOrigTexts,
            fileReferences = replayFileRefs,
            attachments = replayAttachments,
            previousItems = previousItems,
        )
        // Turn markers and compaction dividers are deliberately not carried over as
        // local rows: the snapshot re-projects them from the persisted subtask/
        // compaction/debug-state user messages, and keeping the live copies would
        // show every marker twice after the live→snapshot handover.
        val localExtras = currentVisibleUsers.drop(serverVisibleUserCount) +
            currentInternalUsers.drop(serverInternalUserCount) +
            snapshotLocalSystemRows(previousItems)
        return canonical to mergeSnapshotItems(canonical, previousItems, localExtras)
    }

    /** Applies a planned snapshot to UI state; runs on the EDT. */
    private fun commitSessionSnapshot(
        reason: String,
        signature: Triple<String, Int, Int>,
        snapshotSize: Int,
        canonical: List<ChatItem>,
        merged: List<ChatItem>,
    ) {
        lastAppliedSnapshotSignature = signature

        messages.clear()
        messages.addAll(merged)
        activeThoughtId = null
        activeAssistantMessageId = null

        canonical.filter {
            it.role == ChatRole.TOOL && it.toolStatus == ToolCallStatus.FAILED
        }.forEach {
            if (it.id !in expandedTools) expandedTools[it.id] = true
        }

        val todo = canonical.asReversed().firstOrNull {
            isTodoTool(it) && parseTodoDockItems(it.toolRawInput, it.id).isNotEmpty()
        }
        if (todo != null) {
            val parsed = normalizeTodoStatuses(parseTodoDockItems(todo.toolRawInput, todo.id))
            todoDockItems = parsed
            todoInferBaseline = parsed
            todoInferredCompleted = mutableSetOf()
            todoInferredActive = -1
        }
        log.info("Applied durable session snapshot ($reason): messages=$snapshotSize, sessionId=$sessionId")
    }

    private fun restoreReplayedMessageTimes() {
        // Fetch server messages off-EDT to avoid blocking the UI thread.
        val serverMessages = runCatching { service.sessionMessages(sessionId) }.getOrElse { emptyList() }
        // Cache for the replay safety net to restore error info (errorText / interrupted)
        // that ACP replay doesn't carry but the backend persists in info.error.
        serverMessageCache = serverMessages
        // Reused by the post-replay "load" snapshot reconciliation (same epoch only),
        // so opening a session costs one full message request instead of two.
        replaySnapshotFetch = timelineEpoch.get() to serverMessages
        enqueueSessionUiUpdate replayTimes@{
            if (serverMessages.isEmpty()) {
                for (i in messages.indices) {
                    if (messages[i].role == ChatRole.AGENT && !messages[i].isComplete) {
                        messages[i] = messages[i].copy(isComplete = true)
                    }
                }
                return@replayTimes
            }
            val subtaskUserIds = serverMessages
                .asSequence()
                .filter { it.role == "user" && it.hasSubtaskPart }
                .map { it.id }
                .toSet()
            if (subtaskUserIds.isNotEmpty()) {
                val parentByLocalItemId = buildMap {
                    serverMessages.forEach { message ->
                        put(message.id, message.parentID)
                        put("thought-${message.id}", message.parentID)
                        message.partIds.forEach { partId -> put(partId, message.parentID) }
                    }
                }
                val withBoundaries = insertSubtaskTurnBoundaries(messages, parentByLocalItemId, subtaskUserIds)
                messages.clear()
                messages.addAll(withBoundaries)
            }
            val byId = serverMessages.associateBy { it.id }
            // Subtask commands persist a user message containing only a subtask part.
            // ACP replay intentionally omits it from the visible USER sequence.
            // /compact persists the same shape (compaction part only), so it is
            // excluded here too — otherwise every USER ordinal after a compact
            // turn shifts by one against the replayed bubbles. /debug status|clear
            // persist a marker-only user message replay skips as well.
            val userTimes = serverMessages.filter {
                it.role == "user" &&
                    !it.replayInvisibleUser() &&
                    it.hasVisibleUserParts()
            }
            val localUserCount = messages.count { it.role == ChatRole.USER && !it.internalOnly }
            if (localUserCount != userTimes.size) {
                log.warn("restoreReplayedMessageTimes: local USER count ($localUserCount) != server USER count (${userTimes.size}) for session $sessionId; timestamps may be misaligned")
            }
            var userMatchIdx = 0
            for (i in messages.indices) {
                val msg = messages[i]
                when (msg.role) {
                    ChatRole.AGENT -> {
                        val server = byId[msg.id]
                        if (server != null) {
                            val duration = server.completedAt?.let { it - server.createdAt } ?: 0L
                            messages[i] = msg.copy(
                                isComplete = true,
                                createdAt = server.createdAt,
                                duration = duration,
                                completedAt = server.completedAt ?: 0L,
                            )
                        } else {
                            // Fallback: server message not found (e.g., interrupted message not stored
                            // by backend, ID mismatch, or persistence delay). Still mark as complete
                            // since replay finished.
                            log.warn("restoreReplayedMessageTimes: AGENT message ${msg.id} not found in server messages, marking as complete")
                            messages[i] = msg.copy(isComplete = true)
                        }
                    }
                    ChatRole.USER -> {
                        if (!msg.internalOnly && userMatchIdx < userTimes.size) {
                            messages[i] = msg.copy(createdAt = userTimes[userMatchIdx].createdAt)
                            userMatchIdx++
                        }
                    }
                    else -> {}
                }
            }
            val withDividers = withCompactionDividers(messages.toList(), serverMessages)
            if (withDividers.size != messages.size) {
                messages.clear()
                messages.addAll(withDividers)
            }
        }
    }

    // Replay emits no chunk for the compaction-part-only user message, so rebuild
    // the divider the live turn showed. Anchor it before the summary assistant
    // message (the compaction user message's child): an AGENT row when the summary
    // carried text, a THOUGHT row when it carried only reasoning. When the summary
    // produced no row at all (failed compaction), close the preceding turn instead:
    // the next user bubble, or the transcript end — anchoring on the next AGENT row
    // would drop the divider INSIDE the following turn.
    private fun withCompactionDividers(rows: List<ChatItem>, serverMessages: List<DevEcoHttpApi.SessionMessageTime>): List<ChatItem> {
        val compactionUsers = serverMessages.filter { it.role == "user" && it.hasCompactionPart }
        if (compactionUsers.isEmpty()) return rows
        val summaryIdByParentID = serverMessages
            .filter { it.role == "assistant" && it.parentID != null }
            .associate { it.parentID!! to it.id }
        val inserts = compactionUsers.map { user ->
            val summaryId = summaryIdByParentID[user.id]
            val summaryAnchors = listOfNotNull(
                summaryId?.let { id -> rows.indexOfFirst { row -> row.id == id }.takeIf { it >= 0 } },
                summaryId?.let { id -> rows.indexOfFirst { row -> row.id == "thought-$id" }.takeIf { it >= 0 } },
            )
            val anchor = summaryAnchors.minOrNull()
                ?: rows.indexOfFirst { row -> row.role == ChatRole.USER && row.createdAt > user.createdAt }
                    .takeIf { it >= 0 }
                ?: rows.size
            anchor to ChatItem(
                id = "TURN-${user.id}",
                role = ChatRole.SYSTEM,
                title = "",
                text = "",
                turnBoundary = true,
                compactionDivider = true,
                createdAt = user.createdAt,
            )
        }
        val result = rows.toMutableList()
        // Ascending with a running offset: compactions whose summary never landed
        // can share the tail anchor, and descending tail-inserts would reverse
        // their chronological order.
        var offset = 0
        inserts.sortedBy { it.first }.forEach { (index, divider) ->
            result.add(index + offset, divider)
            offset++
        }
        return result
    }

    private fun markLastAgentInterrupted(notBeforeMs: Long = 0) {
        if (terminalErrorHandled) return
        val idx = messages.indexOfLast {
            it.role == ChatRole.AGENT && !it.isComplete &&
                (notBeforeMs <= 0 || it.createdAt >= notBeforeMs)
        }
        if (idx >= 0) {
            val updated = messages[idx].copy(
                interrupted = true,
                isComplete = true,
                completedAt = System.currentTimeMillis(),
            )
            // Update in place: the footer anchor resolves per turn group, so moving
            // the shell to the list end would carry its marker past a later prompt's
            // boundary and stack it at the bottom of the conversation.
            messages[idx] = updated
        } else if (notBeforeMs <= 0 || messages.none {
                // A projected shell that the backend stamped complete already carries
                // this turn's marker; a second placeholder would stack two footers.
                it.role == ChatRole.AGENT && it.interrupted && it.createdAt >= notBeforeMs
            }) {
            val placeholder = ChatItem(
                "AGENT-${System.nanoTime()}",
                ChatRole.AGENT,
                MyMessageBundle.message("session.message.agent"),
                "",
                isComplete = true,
                interrupted = true,
            )
            // A bounded call inserts the marker inside its own turn (right after that
            // turn's prompt) instead of at the list end, so a later prompt's rows keep
            // their own turn grouping and footer anchor.
            val anchor = if (notBeforeMs > 0) {
                messages.indexOfLast { it.role == ChatRole.USER && it.createdAt >= notBeforeMs } + 1
            } else {
                messages.size
            }
            val at = if (anchor in 1..messages.size) anchor else messages.size
            messages.add(at, placeholder)
        }
        // 持久化中断标志：记录本轮 USER 消息在回放顺序中的索引；subtask 回合没有
        // 该索引（-1），不能借用上一条消息的索引，否则重开后会误标为中断。
        // 以便 replay 时恢复 "Generation cancelled" 标志
        val interruptedIdx = activeUserMsgIndex
        if (interruptedIdx >= 0) {
            val existing = SessionStorage.loadInterruptedIndices(project, sessionId)
            if (interruptedIdx !in existing) {
                SessionStorage.saveInterruptedIndices(project, sessionId, existing + interruptedIdx)
            }
        }
    }

    private fun markLastAgentWithError(errorText: String) {
        terminalErrorHandled = true
        val idx = messages.indexOfLast { it.role == ChatRole.AGENT && !it.isComplete }
        if (idx >= 0) {
            val updated = messages[idx].copy(
                errorText = errorText,
                isComplete = true,
                completedAt = System.currentTimeMillis(),
            )
            messages.removeAt(idx)
            messages.add(updated)
        } else {
            val placeholder = ChatItem(
                "AGENT-" + System.nanoTime(),
                ChatRole.AGENT,
                MyMessageBundle.message("session.message.agent"),
                "",
                isComplete = true,
                errorText = errorText,
            )
            messages += placeholder
        }
    }

    // A replayed failure is keyed by its server message id: stamp the error on
    // that message's own item (partial output that failed mid-stream) or create
    // the error item at the current position — during replay the arrival order
    // IS the chronological order, so unlike markLastAgentWithError nothing is
    // ever moved. The server id also lets restoreReplayedMessageTimes match
    // timestamps instead of warning about a synthetic placeholder id.
    private fun markAgentError(id: String, errorText: String) {
        terminalErrorHandled = true
        val idx = messages.indexOfFirst { it.id == id && it.role == ChatRole.AGENT }
        if (idx >= 0) {
            messages[idx] = messages[idx].copy(
                errorText = errorText,
                isComplete = true,
                completedAt = System.currentTimeMillis(),
            )
            return
        }
        messages += ChatItem(
            id,
            ChatRole.AGENT,
            MyMessageBundle.message("session.message.agent"),
            "",
            isComplete = true,
            errorText = errorText,
        )
    }

    // Section 7: the model may finish normally to ask a question or summarize
    // while IN_PROGRESS todos remain — its own message is then the
    // explanation, and no interruption card should fire.
    private fun lastAgentHasVisibleText(): Boolean {
        val last = messages.lastOrNull { it.role == ChatRole.AGENT } ?: return false
        return last.text.isNotBlank()
    }

    private fun turnFailureMessage(failure: TurnDiagnostics.StreamFailure?): String {
        if (failure == null) return MyMessageBundle.message("session.error.turnEndedIncomplete")
        return when (failure.category) {
            TurnDiagnostics.Category.TIMEOUT -> MyMessageBundle.message("session.error.turnTimeout", failure.detail)
            TurnDiagnostics.Category.NETWORK -> MyMessageBundle.message("session.error.turnNetwork", failure.detail)
            TurnDiagnostics.Category.AUTH -> MyMessageBundle.message("session.error.turnAuth", failure.detail)
            TurnDiagnostics.Category.SERVER -> MyMessageBundle.message("session.error.turnServer", failure.detail)
            TurnDiagnostics.Category.UNKNOWN -> MyMessageBundle.message("session.error.turnEndedIncomplete")
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

    private suspend fun onElicitationRequest(request: ElicitationRequest): ElicitationResponse? {
        if (request.sessionId != sessionId || disposed) return null
        // Headless is fine: the card is state-driven and renders when an editor
        // re-attaches, and awaiting below suspends instead of parking a thread.
        log.info(
            "Elicitation accepted: sessionId=$sessionId, project=${project.name}, " +
                "detached=$detached, title=${request.title}, fields=${request.fields.size}",
        )
        val result = CompletableFuture<ElicitationResponse>()
        pendingElicitationResult = result
        val unregister = service.registerQuestionCompleter(sessionId) { answers ->
            result.complete(
                if (answers == null) {
                    ElicitationResponse(answers = emptyMap(), accepted = false)
                } else {
                    ElicitationResponse(
                        answers = request.fields.mapIndexed { index, field ->
                            field.key to answers.getOrNull(index).orEmpty()
                        }.toMap(),
                        accepted = true,
                    )
                },
            )
        }
        updateUi {
            if (result.isDone) return@updateUi
            pendingElicitation.value = ElicitationItem(
                title = request.title,
                fields = request.fields.map { field ->
                    ElicitationFieldItem(
                        key = field.key,
                        title = field.title,
                        question = field.question,
                        options = field.options.map { option ->
                            ElicitationOptionItem(option.value, option.label, option.description)
                        },
                        multiple = field.multiple,
                        required = field.required,
                        allowCustom = field.allowCustom,
                    )
                },
                onSubmit = { answers ->
                    pendingElicitation.value = null
                    result.complete(
                        ElicitationResponse(
                            answers = answers.orEmpty(),
                            accepted = answers != null,
                        ),
                    )
                },
            )
        }
        return try {
            result.awaitCancellable()
        } catch (cancelled: CancellationException) {
            cancelPendingElicitation()
            throw cancelled
        } finally {
            unregister()
            if (pendingElicitationResult === result) pendingElicitationResult = null
        }
    }
    fun dismissElicitation() {
        pendingElicitation.value?.onSubmit?.invoke(null)
    }

    private fun cancelPendingElicitation() {
        pendingElicitation.value = null
        pendingElicitationResult?.complete(ElicitationResponse(answers = emptyMap(), accepted = false))
        pendingElicitationResult = null
    }

    // Suspends the ACP request coroutine instead of parking its thread: a pending
    // card costs a suspended continuation, so waiting for the user is free and
    // hundreds of concurrent sessions with open questions pin no threads.
    private suspend fun <T> CompletableFuture<T>.awaitCancellable(): T = suspendCancellableCoroutine { cont ->
        whenComplete { value, error ->
            if (error == null) cont.resume(value) else cont.resumeWithException(error)
        }
    }

    // A question asked while this controller was not the routed/visible one never reaches
    // onElicitationRequest; re-render it from the backend's pending list so (re)opening the
    // tab always surfaces an answerable card instead of an unexplained spinning turn.
    private fun recoverPendingElicitation() {
        ApplicationManager.getApplication().executeOnPooledThread {
            val pending = service.pendingQuestions().firstOrNull { it.sessionId == sessionId } ?: return@executeOnPooledThread
            updateUi {
                if (disposed || detached || pendingElicitation.value != null) return@updateUi
                pendingElicitation.value = ElicitationItem(
                    title = pending.fields.firstOrNull()?.header?.takeIf { it.isNotBlank() } ?: "Question",
                    fields = pending.fields.mapIndexed { index, field ->
                        ElicitationFieldItem(
                            key = "question_$index",
                            title = field.header,
                            question = field.question,
                            options = field.options.map { ElicitationOptionItem(it.label, it.label, it.description) },
                            multiple = field.multiple,
                            required = true,
                            allowCustom = field.custom,
                        )
                    },
                    onSubmit = { answers ->
                        pendingElicitation.value = null
                        val ordered = answers?.let { selected ->
                            pending.fields.indices.map { index -> selected["question_$index"].orEmpty() }
                        }
                        // Answer through the owner's suspended RPC when it still exists;
                        // HTTP only when no controller owns the request anymore.
                        if (!service.completeQuestion(sessionId, ordered)) {
                            ApplicationManager.getApplication().executeOnPooledThread {
                                if (ordered == null) service.rejectQuestion(pending.id)
                                else service.replyQuestion(pending.id, ordered)
                            }
                        }
                    },
                )
                log.info("Recovered pending question into UI: sessionId=$sessionId, requestID=${pending.id}")
            }
        }
    }

    // Append a SYSTEM/error message DIRECTLY to the in-memory message list (synchronous, any
    // thread safe because `messages` is a SnapshotStateList). We deliberately avoid addMessage()
    // here because that function dispatches via updateUi -> invokeLater, which may be dropped when
    // invokeLater coalescing kicks in during heavy EDT activity —leaving the user with exactly
    // zero visible UI feedback for their failed request, which is the bug reported in this session.
    // Persistent storage is best-effort via updateUi; the user seeing the error is more important.
    private fun appendErrorMessageNow(text: String, idPrefix: String? = null): ChatItem {
        // SYSTEM cards always represent a user-visible failure (unsupported attachment, 0-token
        // agent reply, send exception, —. Log at WARN so the severity is obvious in traces.
        log.debug("Showing SYSTEM error card: ${text.take(200)}")
        return appendMessageNow(ChatRole.SYSTEM, MyMessageBundle.message("session.message.system"), text, idPrefix = idPrefix)
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
        val displayText = text.ifBlank { "" }
        return appendMessageNow(ChatRole.USER, MyMessageBundle.message("session.message.you"), displayText, attachmentsForDisplay, fileRefs)
    }

    private fun appendMessageNow(
        role: ChatRole,
        title: String,
        text: String,
        attachments: List<AttachmentItem> = emptyList(),
        fileRefs: List<FileReference> = emptyList(),
        internalOnly: Boolean = false,
        idPrefix: String? = null,
        sourceMessageId: String? = null,
    ): ChatItem {
        val id = "${idPrefix ?: "${role.name}-"}${System.nanoTime()}"
        val item = ChatItem(
            id,
            role,
            title,
            text,
            attachments = attachments,
            fileReferences = fileRefs,
            internalOnly = internalOnly,
            sourceMessageId = sourceMessageId,
        )
        messages.add(item)
        log.info("appendMessageNow id=$id role=$role textLen=${text.length} attachments=${attachments.size} fileRefs=${fileRefs.size}")
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


    fun submitFeedback(messageId: String, type: String?) {
        val event = when (type) {
            "like" -> "feedback_like"
            "dislike" -> "feedback_dislike"
            else -> return
        }
        log.info("Feedback submitted: $event for message $messageId")
    }

    fun reportMessage(messageId: String, reason: String) {
        log.debug("Message reported: $messageId, reason: $reason")
    }
}
