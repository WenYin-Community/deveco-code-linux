package org.deveco.code.session

import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import org.deveco.code.session.model.ChatItem
import org.deveco.code.session.model.ChatRole
import org.deveco.code.session.model.FileReference
import org.deveco.code.util.PluginStateFiles

@Service(Service.Level.PROJECT)
internal class SessionMessageStore(private val project: Project) {

    data class MessageEntry(
        var id: String = "",
        var role: String = "",
        var title: String = "",
        var text: String = "",
        var toolKind: String? = null,
        var toolPath: String? = null,
        var toolLine: Int? = null,
        var toolOffset: Int? = null,
        var toolLimit: Int? = null,
        var toolStatus: String? = null,
        var toolRawInput: String? = null,
        var toolRawOutput: String? = null,
        var isComplete: Boolean = true,
        var interrupted: Boolean = false,
        var fileReferencePath: String? = null,
        var fileReferenceStartLine: Int? = null,
        var fileReferenceEndLine: Int? = null,
        /** Additional file references (beyond the first) encoded as path\u0001start\u0001end joined by \u0002. */
        var extraFileRefs: String? = null,
        var duration: Long = 0L,
        var createdAt: Long = 0L,
    )

    data class State(var sessionMessages: MutableMap<String, MutableList<MessageEntry>> = mutableMapOf())

    private val state = PluginStateFiles.readJson(project, "messages.json", State::class.java) ?: State()
    private val log = Logger.getInstance(SessionMessageStore::class.java)

    // EDT writes vs pooled-thread session-load reads: serialize all access. Holding the
    // lock during the file write also guards the Gson serialization (no deep copy needed).
    private val lock = Any()

    fun getMessages(sessionId: String): List<ChatItem> = synchronized(lock) {
        val entries = state.sessionMessages[sessionId] ?: return emptyList()
        entries.map { it.toChatItem() }
    }

    fun saveMessages(sessionId: String, messages: List<ChatItem>) = synchronized(lock) {
        val entries = messages.map { it.toMessageEntry() }
        state.sessionMessages[sessionId] = entries.toMutableList()
        markDirty()
    }

    fun appendMessage(sessionId: String, message: ChatItem) = synchronized(lock) {
        val entries = state.sessionMessages.getOrPut(sessionId) { mutableListOf() }
        entries.add(message.toMessageEntry())
        markDirty()
    }

    fun updateMessage(sessionId: String, messageId: String, updater: (ChatItem) -> ChatItem) = synchronized(lock) {
        val entries = state.sessionMessages[sessionId] ?: return
        val index = entries.indexOfFirst { it.id == messageId }
        if (index >= 0) {
            val updated = updater(entries[index].toChatItem())
            entries[index] = updated.toMessageEntry()
            markDirty()
        }
    }

    fun removeMessagesAfter(sessionId: String, messageId: String) = synchronized(lock) {
        val entries = state.sessionMessages[sessionId] ?: return
        val index = entries.indexOfFirst { it.id == messageId }
        if (index >= 0 && index < entries.lastIndex) {
            entries.subList(index + 1, entries.size).clear()
            markDirty()
        }
    }

    fun clearMessages(sessionId: String) = synchronized(lock) {
        state.sessionMessages.remove(sessionId)
        markDirty()
    }

    private fun markDirty() {
        runCatching { PluginStateFiles.writeJson(project, "messages.json", state) }
            .onFailure { log.warn("Failed to persist session messages", it) }
    }

    companion object {
        fun getInstance(project: Project): SessionMessageStore = project.getService(SessionMessageStore::class.java)
    }

    private fun ChatItem.toMessageEntry(): MessageEntry = MessageEntry(
        id = id,
        role = role.name,
        title = title,
        text = text,
        toolKind = toolKind?.name,
        toolPath = toolPath,
        toolLine = toolLine,
        toolOffset = toolOffset,
        toolLimit = toolLimit,
        toolStatus = toolStatus?.name,
        toolRawInput = toolRawInput?.toString(),
        toolRawOutput = toolRawOutput?.toString(),
        isComplete = isComplete,
        interrupted = interrupted,
        fileReferencePath = fileReferences.firstOrNull()?.path,
        fileReferenceStartLine = fileReferences.firstOrNull()?.startLine,
        fileReferenceEndLine = fileReferences.firstOrNull()?.endLine,
        extraFileRefs = if (fileReferences.size >
            1
        ) {
            fileReferences.drop(1).joinToString("\u0002") {
                "${it.path}\u0001${it.startLine}\u0001${it.endLine}"
            }
        } else {
            null
        },
        duration = duration,
        createdAt = createdAt,
    )

    private fun MessageEntry.toChatItem(): ChatItem {
        val parsedRawInput = toolRawInput?.let { raw ->
            try {
                kotlinx.serialization.json.Json.parseToJsonElement(raw)
            } catch (e: Exception) {
                raw
            }
        }
        val parsedRawOutput = toolRawOutput?.let { raw ->
            try {
                kotlinx.serialization.json.Json.parseToJsonElement(raw)
            } catch (e: Exception) {
                raw
            }
        }
        return ChatItem(
            id = id,
            role = try {
                ChatRole.valueOf(role)
            } catch (
                e: Exception,
            ) {
                log.warn("Failed to resolve ChatRole: $role", e)
                ChatRole.SYSTEM
            },
            title = title,
            text = text,
            toolKind = toolKind?.let { name ->
                try {
                    val clazz = Class.forName("com.agentclientprotocol.model.ToolKind")
                    clazz.enumConstants?.firstOrNull {
                        (it as Enum<*>).name == name
                    } as? com.agentclientprotocol.model.ToolKind
                } catch (e: Exception) {
                    log.warn("Failed to resolve ToolKind enum: $name", e)
                    null
                }
            },
            toolPath = toolPath,
            toolLine = toolLine,
            toolOffset = toolOffset,
            toolLimit = toolLimit,
            toolStatus = toolStatus?.let { name ->
                try {
                    val clazz = Class.forName("com.agentclientprotocol.model.ToolCallStatus")
                    clazz.enumConstants?.firstOrNull {
                        (it as Enum<*>).name == name
                    } as? com.agentclientprotocol.model.ToolCallStatus
                } catch (e: Exception) {
                    log.warn("Failed to resolve ToolCallStatus enum: $name", e)
                    null
                }
            },
            toolRawInput = parsedRawInput,
            toolRawOutput = parsedRawOutput,
            isComplete = isComplete,
            interrupted = interrupted,
            fileReferences = buildList {
                val path = fileReferencePath
                val startLine = fileReferenceStartLine
                val endLine = fileReferenceEndLine
                if (path != null && startLine != null && endLine != null) {
                    add(FileReference(path, startLine, endLine))
                }
                extraFileRefs?.split("\u0002")?.forEach { ref ->
                    val parts = ref.split("\u0001")
                    if (parts.size == 3) {
                        runCatching { FileReference(parts[0], parts[1].toInt(), parts[2].toInt()) }
                            .getOrNull()?.let { add(it) }
                    }
                }
            },
            duration = duration,
            createdAt = createdAt,
        )
    }
}
