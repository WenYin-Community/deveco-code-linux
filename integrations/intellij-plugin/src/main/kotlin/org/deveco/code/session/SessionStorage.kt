package org.deveco.code.session

import com.agentclientprotocol.annotations.UnstableApi
import com.agentclientprotocol.model.SessionInfo
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import org.deveco.code.session.model.AttachmentItem
import org.deveco.code.session.model.FileReference
import org.deveco.code.util.PluginStateFiles

private val log = Logger.getInstance("SessionStorage")

data class FavoriteRecord(
    val sessionId: String,
    val updatedAt: String?,
    val title: String?,
    val archivedAt: Long? = null,
)

object SessionStorage {
    private const val FAVORITE_KEY = "deveco.sessions.favorites"
    private const val ARCHIVED_KEY = "deveco.sessions.archived"
    private const val NEW_SESSION_KEY = "deveco.sessions.new"
    private const val INTERACTED_KEY = "deveco.sessions.interacted"
    private const val ABNORMAL_KEY = "deveco.sessions.abnormal"
    private const val UNREAD_KEY = "deveco.sessions.unread"
    private const val TITLE_KEY = "deveco.sessions.titles"
    private const val LAST_ACTIVE_KEY = "deveco.sessions.lastActive"
    private const val ATTACHMENTS_KEY = "deveco.sessions.attachments"
    private const val FILE_REFS_KEY = "deveco.sessions.filerefs"
    private const val ORIG_TEXT_KEY = "deveco.sessions.origtext"
    private const val BACKEND_MSG_COUNT_KEY = "deveco.sessions.backendmsgcount"
    private const val PROMPT_HISTORY_KEY = "deveco.sessions.prompthistory"
    private const val INTERRUPTED_KEY = "deveco.sessions.interrupted"
    private const val ITEM_SEP = "\n"
    private const val FIELD_SEP = "\t"
    private const val STATE_FILE = "sessions.properties"
    private const val DURATION_FILE = "durations.properties"

    fun lastActiveSessionId(project: Project): String? = value(project, LAST_ACTIVE_KEY)?.takeIf { it.isNotBlank() }

    fun setLastActiveSessionId(project: Project, sessionId: String?) {
        putValue(project, LAST_ACTIVE_KEY, sessionId?.takeIf { it.isNotBlank() })
    }

    @OptIn(UnstableApi::class)
    fun toggleFavorite(project: Project, info: SessionInfo, favorite: Boolean? = null) {
        val map = readMap(project, FAVORITE_KEY).toMutableMap()
        val id = info.sessionId.value
        val shouldAdd = favorite ?: (id !in map)
        if (shouldAdd) map[id] = FavoriteRecord(id, info.updatedAt, info.title) else map.remove(id)
        writeMap(project, FAVORITE_KEY, map)
    }

    fun removeFavorite(project: Project, sessionId: String) {
        val map = readMap(project, FAVORITE_KEY).toMutableMap()
        if (map.remove(sessionId) != null) writeMap(project, FAVORITE_KEY, map)
    }

    fun favoriteIds(project: Project): Set<String> = readMap(project, FAVORITE_KEY).keys

    @OptIn(UnstableApi::class)
    fun archive(project: Project, info: SessionInfo) {
        val map = readMap(project, ARCHIVED_KEY).toMutableMap()
        val id = info.sessionId.value
        map[id] = FavoriteRecord(id, info.updatedAt, info.title, System.currentTimeMillis())
        writeMap(project, ARCHIVED_KEY, map)
    }

    fun unarchive(project: Project, sessionId: String) {
        val map = readMap(project, ARCHIVED_KEY).toMutableMap()
        if (map.remove(sessionId) != null) writeMap(project, ARCHIVED_KEY, map)
    }

    fun archived(project: Project): Map<String, FavoriteRecord> = readMap(project, ARCHIVED_KEY)

    fun archivedIds(project: Project): Set<String> = readMap(project, ARCHIVED_KEY).keys

    fun setCustomTitle(project: Project, sessionId: String, title: String) {
        val map = readTitleMap(project).toMutableMap()
        val trimmed = title.trim()
        if (trimmed.isEmpty()) map.remove(sessionId) else map[sessionId] = trimmed
        writeTitleMap(project, map)
    }

    fun customTitle(project: Project, sessionId: String): String? = readTitleMap(project)[sessionId]

    fun customTitles(project: Project): Map<String, String> = readTitleMap(project)

    fun removeCustomTitle(project: Project, sessionId: String) {
        val map = readTitleMap(project).toMutableMap()
        if (map.remove(sessionId) != null) writeTitleMap(project, map)
    }

    fun addNewSession(project: Project, sessionId: String) {
        val ids = newSessionIds(project).toMutableSet()
        if (ids.add(sessionId)) persistNewSessionIds(project, ids)
    }

    fun removeNewSession(project: Project, sessionId: String) {
        val ids = newSessionIds(project)
        if (sessionId in ids) persistNewSessionIds(project, ids - sessionId)
    }

    fun newSessionIds(project: Project): Set<String> {
        val raw = value(project, NEW_SESSION_KEY).orEmpty()
        return if (raw.isBlank()) emptySet() else raw.split(ITEM_SEP).filter { it.isNotBlank() }.toSet()
    }

    fun rebuildNewSessionIds(project: Project, liveIds: Set<String>) {
        val interacted = interactedIds(project)
        val hasDuration = loadLastDurations(project).keys
        val existingNew = newSessionIds(project)
        val notYetInBackend = existingNew - interacted - hasDuration - liveIds
        persistNewSessionIds(project, (liveIds - interacted - hasDuration) + notYetInBackend)
    }

    fun interactedIds(project: Project): Set<String> {
        val raw = value(project, INTERACTED_KEY).orEmpty()
        return if (raw.isBlank()) emptySet() else raw.split(ITEM_SEP).filter { it.isNotBlank() }.toSet()
    }

    fun markInteracted(project: Project, sessionId: String) {
        val ids = interactedIds(project).toMutableSet()
        if (ids.add(sessionId)) persistInteractedIds(project, ids)
        removeNewSession(project, sessionId)
    }

    fun markInteractedBatch(project: Project, sessionIds: Set<String>) {
        if (sessionIds.isEmpty()) return
        val ids = interactedIds(project).toMutableSet()
        if (ids.addAll(sessionIds)) persistInteractedIds(project, ids)
    }

    fun pruneInteractedIds(project: Project, liveIds: Set<String>) {
        val ids = interactedIds(project)
        val pruned = ids.filter { it in liveIds }
        if (pruned.size != ids.size) persistInteractedIds(project, pruned.toSet())
    }

    private fun persistNewSessionIds(project: Project, ids: Set<String>) {
        putValue(project, NEW_SESSION_KEY, ids.takeIf { it.isNotEmpty() }?.joinToString(ITEM_SEP))
    }

    fun abnormalIds(project: Project): Set<String> = readSet(project, ABNORMAL_KEY)

    fun markAbnormal(project: Project, sessionId: String) {
        val ids = abnormalIds(project).toMutableSet()
        if (ids.add(sessionId)) persistSet(project, ABNORMAL_KEY, ids)
    }

    fun clearAbnormal(project: Project, sessionId: String) {
        val ids = abnormalIds(project).toMutableSet()
        if (ids.remove(sessionId)) persistSet(project, ABNORMAL_KEY, ids)
    }

    fun pruneAbnormalIds(project: Project, liveIds: Set<String>) = pruneSet(project, ABNORMAL_KEY, liveIds)

    fun unreadIds(project: Project): Set<String> = readSet(project, UNREAD_KEY)

    fun markUnread(project: Project, sessionId: String) {
        val ids = unreadIds(project).toMutableSet()
        if (ids.add(sessionId)) persistSet(project, UNREAD_KEY, ids)
    }

    fun markRead(project: Project, sessionId: String) {
        val ids = unreadIds(project)
        if (sessionId in ids) persistSet(project, UNREAD_KEY, ids - sessionId)
    }

    fun pruneUnreadIds(project: Project, liveIds: Set<String>) = pruneSet(project, UNREAD_KEY, liveIds)

    private fun readSet(project: Project, key: String): Set<String> {
        val raw = value(project, key).orEmpty()
        return if (raw.isBlank()) emptySet() else raw.split(ITEM_SEP).filter { it.isNotBlank() }.toSet()
    }

    private fun persistSet(project: Project, key: String, ids: Set<String>) {
        putValue(project, key, ids.takeIf { it.isNotEmpty() }?.joinToString(ITEM_SEP))
    }

    private fun pruneSet(project: Project, key: String, liveIds: Set<String>) {
        val ids = readSet(project, key)
        val pruned = ids.filter { it in liveIds }
        if (pruned.size != ids.size) persistSet(project, key, pruned.toSet())
    }

    private fun persistInteractedIds(project: Project, ids: Set<String>) {
        putValue(project, INTERACTED_KEY, ids.takeIf { it.isNotEmpty() }?.joinToString(ITEM_SEP))
    }

    fun saveLastDuration(project: Project, sessionId: String, duration: Long) {
        val props = runCatching { PluginStateFiles.readProperties(project, DURATION_FILE) }
            .onFailure { log.warn("Failed to load durations", it) }
            .getOrDefault(java.util.Properties())
        props.setProperty(sessionId, duration.toString())
        runCatching { PluginStateFiles.writeProperties(project, DURATION_FILE, props) }
            .onFailure { log.warn("Failed to save durations", it) }
    }

    fun removeLastDuration(project: Project, sessionId: String) {
        val props = runCatching { PluginStateFiles.readProperties(project, DURATION_FILE) }
            .getOrDefault(java.util.Properties())
        if (props.remove(sessionId) != null) {
            runCatching { PluginStateFiles.writeProperties(project, DURATION_FILE, props) }
                .onFailure { log.warn("Failed to save durations", it) }
        }
    }

    /**
     * Saves attachments for a session, keyed by USER message index (0-based).
     * Each attachment is stored as a line: index|name|path|mimeType|isImage
     */
    internal fun saveAttachments(
        project: Project,
        sessionId: String,
        attachmentsByIndex: Map<Int, List<AttachmentItem>>,
    ) {
        if (attachmentsByIndex.isEmpty()) {
            putValue(project, "$ATTACHMENTS_KEY.$sessionId", null)
            return
        }
        val lines = mutableListOf<String>()
        for ((idx, items) in attachmentsByIndex) {
            for (item in items) {
                val safeName = item.name.replace("%", "%25").replace("|", "%7C")
                val safePath = item.path.replace("%", "%25").replace("|", "%7C")
                lines.add("$idx|$safeName|$safePath|${item.mimeType}|${item.isImage}")
            }
        }
        putValue(project, "$ATTACHMENTS_KEY.$sessionId", lines.joinToString("\n"))
    }

    internal fun loadAttachmentsByIndex(project: Project, sessionId: String): Map<Int, List<AttachmentItem>> {
        val raw = value(project, "$ATTACHMENTS_KEY.$sessionId").orEmpty()
        if (raw.isBlank()) return emptyMap()
        val result = mutableMapOf<Int, MutableList<AttachmentItem>>()
        for (line in raw.split("\n").filter { it.isNotBlank() }) {
            val parts = line.split("|")
            if (parts.size < 5) continue
            val idx = parts[0].toIntOrNull() ?: continue
            val name = parts[1].replace("%7C", "|").replace("%25", "%")
            val path = parts[2].replace("%7C", "|").replace("%25", "%")
            val mimeType = parts[3]
            val isImage = parts[4].toBoolean()
            result.getOrPut(idx) {
                mutableListOf()
            }.add(AttachmentItem(name = name, path = path, mimeType = mimeType, isImage = isImage))
        }
        return result.mapValues { it.value.toList() }.toMap()
    }

    internal fun removeAttachments(project: Project, sessionId: String) {
        putValue(project, "$ATTACHMENTS_KEY.$sessionId", null)
    }

    /**
     * Saves file references for a session, keyed by USER message index (0-based).
     * Each file reference is stored as a line: index|path|startLine|endLine
     */
    internal fun saveFileRefs(project: Project, sessionId: String, fileRefsByIndex: Map<Int, List<FileReference>>) {
        if (fileRefsByIndex.isEmpty()) {
            putValue(project, "$FILE_REFS_KEY.$sessionId", null)
            return
        }
        val lines = mutableListOf<String>()
        for ((idx, refs) in fileRefsByIndex) {
            for (ref in refs) {
                val safePath = ref.path.replace("%", "%25").replace("|", "%7C")
                lines.add("$idx|$safePath|${ref.startLine}|${ref.endLine}")
            }
        }
        putValue(project, "$FILE_REFS_KEY.$sessionId", lines.joinToString("\n"))
    }

    internal fun loadFileRefsByIndex(project: Project, sessionId: String): Map<Int, List<FileReference>> {
        val raw = value(project, "$FILE_REFS_KEY.$sessionId").orEmpty()
        if (raw.isBlank()) return emptyMap()
        val result = mutableMapOf<Int, MutableList<FileReference>>()
        for (line in raw.split("\n").filter { it.isNotBlank() }) {
            val parts = line.split("|")
            if (parts.size < 4) continue
            val idx = parts[0].toIntOrNull() ?: continue
            val path = parts[1].replace("%7C", "|").replace("%25", "%")
            val startLine = parts[2].toIntOrNull() ?: 0
            val endLine = parts[3].toIntOrNull() ?: 0
            result.getOrPut(idx) {
                mutableListOf()
            }.add(FileReference(path = path, startLine = startLine, endLine = endLine))
        }
        return result.mapValues { it.value.toList() }.toMap()
    }

    internal fun removeFileRefs(project: Project, sessionId: String) {
        putValue(project, "$FILE_REFS_KEY.$sessionId", null)
    }

    /**
     * Saves original user message texts, keyed by USER message index (0-based).
     * Used during replay to replace promptText (which includes file content) with the original text.
     * Format: index\toriginalText (tab-separated, index is numeric)
     */
    internal fun saveOriginalTexts(project: Project, sessionId: String, textsByIndex: Map<Int, String>) {
        if (textsByIndex.isEmpty()) {
            putValue(project, "$ORIG_TEXT_KEY.$sessionId", null)
            return
        }
        val lines = textsByIndex.entries.sortedBy { it.key }.map { (idx, text) ->
            "$idx\t${escapeText(text)}"
        }
        putValue(project, "$ORIG_TEXT_KEY.$sessionId", lines.joinToString("\n"))
    }

    internal fun loadOriginalTexts(project: Project, sessionId: String): Map<Int, String> {
        val raw = value(project, "$ORIG_TEXT_KEY.$sessionId").orEmpty()
        if (raw.isBlank()) return emptyMap()
        val result = mutableMapOf<Int, String>()
        for (line in raw.split("\n").filter { it.isNotBlank() }) {
            val tabIdx = line.indexOf("\t")
            if (tabIdx <= 0) continue
            val idx = line.substring(0, tabIdx).toIntOrNull() ?: continue
            val text = unescapeText(line.substring(tabIdx + 1))
            result[idx] = text
        }
        return result.toMap()
    }

    internal fun removeOriginalTexts(project: Project, sessionId: String) {
        putValue(project, "$ORIG_TEXT_KEY.$sessionId", null)
    }

    /**
     * Persistent counter for user messages actually sent to the backend.
     * Used as the save key for fileRefs/attachments/origTexts so it matches
     * the replay index (which only counts backend-replayed messages, not
     * local-only messages like failed prompts or rejected attachments).
     */
    internal fun getBackendUserMsgCount(project: Project, sessionId: String): Int =
        value(project, "$BACKEND_MSG_COUNT_KEY.$sessionId")?.toIntOrNull() ?: 0

    internal fun setBackendUserMsgCount(project: Project, sessionId: String, count: Int) {
        putValue(project, "$BACKEND_MSG_COUNT_KEY.$sessionId", count.toString())
    }

    /**
     * Saves prompt history entries so Up/Down navigation survives IDE restart.
     * Each entry is a line: text<TAB>attachments<TAB>fileReferences
     * Attachments joined by ";;", fields by "|"; file references likewise.
     * Text/paths escape backslash, newline, pipe, tab to avoid delimiter collision.
     */
    internal fun savePromptHistory(project: Project, sessionId: String, history: List<PromptHistoryEntry>) {
        if (history.isEmpty()) {
            putValue(project, "$PROMPT_HISTORY_KEY.$sessionId", null)
            return
        }
        val lines = history.map { entry ->
            val text = escapeDelimiters(entry.text)
            val atts = entry.attachments.joinToString(";;") { a ->
                listOf(a.name, a.path, a.mimeType, a.isImage.toString()).joinToString("|") { escapeDelimiters(it) }
            }
            val refs = entry.fileReferences.joinToString(";;") { r ->
                listOf(r.path, r.startLine.toString(), r.endLine.toString()).joinToString("|") { escapeDelimiters(it) }
            }
            "$text\t$atts\t$refs"
        }
        putValue(project, "$PROMPT_HISTORY_KEY.$sessionId", lines.joinToString("\n"))
    }

    internal fun loadPromptHistory(project: Project, sessionId: String): List<PromptHistoryEntry> {
        val raw = value(project, "$PROMPT_HISTORY_KEY.$sessionId").orEmpty()
        if (raw.isBlank()) return emptyList()
        val result = mutableListOf<PromptHistoryEntry>()
        for (line in raw.split("\n").filter { it.isNotBlank() }) {
            val parts = line.split("\t")
            if (parts.size < 3) continue
            val text = unescapeDelimiters(parts[0])
            val attachments = parts[1].split(";;").filter { it.isNotBlank() }.mapNotNull { att ->
                val f = att.split("|")
                if (f.size < 4) return@mapNotNull null
                AttachmentItem(
                    name = unescapeDelimiters(f[0]),
                    path = unescapeDelimiters(f[1]),
                    mimeType = unescapeDelimiters(f[2]),
                    isImage = f[3].toBoolean(),
                )
            }
            val fileRefs = parts[2].split(";;").filter { it.isNotBlank() }.mapNotNull { ref ->
                val f = ref.split("|")
                if (f.size < 3) return@mapNotNull null
                FileReference(
                    path = unescapeDelimiters(f[0]),
                    startLine = f[1].toIntOrNull() ?: 0,
                    endLine = f[2].toIntOrNull() ?: 0,
                )
            }
            result.add(PromptHistoryEntry(text, attachments, fileRefs))
        }
        return result
    }

    internal fun loadInterruptedIndices(project: Project, sessionId: String): Set<Int> {
        val raw = value(project, "$INTERRUPTED_KEY.$sessionId").orEmpty()
        if (raw.isBlank()) return emptySet()
        return raw.split(",").mapNotNull { it.trim().toIntOrNull() }.toSet()
    }

    internal fun saveInterruptedIndices(project: Project, sessionId: String, indices: Set<Int>) {
        if (indices.isEmpty()) {
            putValue(project, "$INTERRUPTED_KEY.$sessionId", null)
        } else {
            putValue(project, "$INTERRUPTED_KEY.$sessionId", indices.joinToString(","))
        }
    }

    fun deleteLocalSession(project: Project, sessionId: String) {
        unarchive(project, sessionId)
        removeFavorite(project, sessionId)
        removeCustomTitle(project, sessionId)
        removeNewSession(project, sessionId)
        removeLastDuration(project, sessionId)
        removeAttachments(project, sessionId)
        removeFileRefs(project, sessionId)
        removeOriginalTexts(project, sessionId)
        putValue(project, "$INTERRUPTED_KEY.$sessionId", null)
        putValue(project, "$BACKEND_MSG_COUNT_KEY.$sessionId", null)
        runCatching { project.getService(TokenUsageStore::class.java)?.clearUsage(sessionId) }
        runCatching { project.getService(SessionModelStore::class.java)?.removeSession(sessionId) }
        runCatching { project.getService(SessionViewStateStore::class.java)?.remove(sessionId) }
    }

    fun loadLastDurations(project: Project): Map<String, Long> {
        val props = runCatching { PluginStateFiles.readProperties(project, DURATION_FILE) }
            .onFailure { log.warn("Failed to load durations", it) }
            .getOrDefault(java.util.Properties())
        return props.entries.mapNotNull { (k, v) ->
            val id = k.toString()
            val dur = v.toString().toLongOrNull() ?: return@mapNotNull null
            id to dur
        }.toMap()
    }

    private fun readMap(project: Project, key: String): Map<String, FavoriteRecord> {
        val raw = value(project, key).orEmpty()
        if (raw.isBlank()) return emptyMap()
        return raw.split(ITEM_SEP).mapNotNull { item ->
            val parts = item.split(FIELD_SEP, limit = 4)
            val id = parts.getOrNull(0)?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val title = parts.getOrNull(1)?.takeIf { it.isNotBlank() }
            val updatedAt = parts.getOrNull(2)?.takeIf { it.isNotBlank() }
            val archivedAt = parts.getOrNull(3)?.takeIf { it.isNotBlank() }?.toLongOrNull()
            FavoriteRecord(id, updatedAt, title, archivedAt)
        }.associateBy { it.sessionId }
    }

    private fun writeMap(project: Project, key: String, map: Map<String, FavoriteRecord>) {
        if (map.isEmpty()) {
            putValue(project, key, null)
        } else {
            putValue(
                project,
                key,
                map.values.joinToString(ITEM_SEP) { r ->
                    val title = r.title?.replace("\n", " ")?.replace("\t", " ").orEmpty()
                    val updatedAt = r.updatedAt?.replace("\n", " ")?.replace("\t", " ").orEmpty()
                    val archivedAt = (r.archivedAt ?: "").toString()
                    "${r.sessionId}$FIELD_SEP$title$FIELD_SEP$updatedAt$FIELD_SEP$archivedAt"
                },
            )
        }
    }

    private fun readTitleMap(project: Project): Map<String, String> {
        val raw = value(project, TITLE_KEY).orEmpty()
        if (raw.isBlank()) return emptyMap()
        return raw.split(ITEM_SEP).mapNotNull { item ->
            val idx = item.indexOf(FIELD_SEP)
            if (idx <= 0) null else item.substring(0, idx) to item.substring(idx + 1)
        }.toMap().filterKeys { it.isNotBlank() }
    }

    private fun writeTitleMap(project: Project, map: Map<String, String>) {
        if (map.isEmpty()) {
            putValue(project, TITLE_KEY, null)
        } else {
            putValue(
                project,
                TITLE_KEY,
                map.entries.joinToString(ITEM_SEP) { (k, v) ->
                    "${k}$FIELD_SEP${v.replace("\n", " ").replace("\t", " ")}"
                },
            )
        }
    }

    // Escape text for pipe/tab-delimited storage: backslash first, then newline.
    // Prevents literal \n in user text from being confused with escaped newlines.
    private fun escapeText(s: String): String = s.replace("\\", "\\\\").replace("\n", "\\n")

    // Escape for prompt-history pipe/tab-delimited storage: backslash, newline, pipe, tab.
    private fun escapeDelimiters(s: String): String =
        s.replace("\\", "\\\\").replace("\n", "\\n").replace("|", "\\p").replace("\t", "\\t")

    private fun unescapeDelimiters(s: String): String {
        val sb = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            if (s[i] == '\\' && i + 1 < s.length) {
                when (s[i + 1]) {
                    '\\' -> {
                        sb.append('\\')
                        i += 2
                    }

                    'n' -> {
                        sb.append('\n')
                        i += 2
                    }

                    'p' -> {
                        sb.append('|')
                        i += 2
                    }

                    't' -> {
                        sb.append('\t')
                        i += 2
                    }

                    else -> {
                        sb.append(s[i])
                        i++
                    }
                }
            } else {
                sb.append(s[i])
                i++
            }
        }
        return sb.toString()
    }

    private fun unescapeText(s: String): String {
        val sb = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            if (s[i] == '\\' && i + 1 < s.length) {
                when (s[i + 1]) {
                    '\\' -> {
                        sb.append('\\')
                        i += 2
                    }

                    'n' -> {
                        sb.append('\n')
                        i += 2
                    }

                    else -> {
                        sb.append(s[i])
                        i++
                    }
                }
            } else {
                sb.append(s[i])
                i++
            }
        }
        return sb.toString()
    }

    @Synchronized
    private fun value(project: Project, key: String): String? =
        runCatching { PluginStateFiles.readProperties(project, STATE_FILE).getProperty(key) }
            .onFailure { log.warn("Failed to read plugin session state", it) }
            .getOrNull()

    @Synchronized
    private fun putValue(project: Project, key: String, value: String?) {
        runCatching {
            val properties = PluginStateFiles.readProperties(project, STATE_FILE)
            if (value == null) properties.remove(key) else properties.setProperty(key, value)
            PluginStateFiles.writeProperties(project, STATE_FILE, properties)
        }.onFailure { log.warn("Failed to persist plugin session state", it) }
    }
}
