package org.deveco.code.session

import com.agentclientprotocol.annotations.UnstableApi
import com.agentclientprotocol.model.SessionInfo
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
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

    fun deleteLocalSession(project: Project, sessionId: String) {
        unarchive(project, sessionId)
        removeFavorite(project, sessionId)
        removeCustomTitle(project, sessionId)
        removeNewSession(project, sessionId)
        removeLastDuration(project, sessionId)
        runCatching { project.getService(SessionMessageStore::class.java)?.clearMessages(sessionId) }
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
