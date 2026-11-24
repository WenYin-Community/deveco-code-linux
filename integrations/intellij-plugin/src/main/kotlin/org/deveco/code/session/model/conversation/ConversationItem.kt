/*
 * Conversation content model
 * --------------------------
 * ConversationItem is the sealed conversation entry itself; there is no wrapper or Content layer.
 * User and System remain immutable values. Streaming Text/Thought and tool variants are stable
 * state nodes so their content can update without replacing their containing activity or group.
 */

package org.deveco.code.session.model.conversation

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentclientprotocol.model.SessionUpdate
import com.agentclientprotocol.model.ToolCallLocation
import org.deveco.code.acp.AcpToolInputParser
import org.deveco.code.session.model.FileReference
import org.deveco.code.session.model.prompt.Prompt
import org.deveco.code.session.model.prompt.PromptPart
import org.deveco.code.session.model.prompt.toFileReferences
import org.deveco.code.session.tool.ToolEditTracker

internal sealed interface ConversationItem {
    val id: String
    val text: String
    val createdAt: Long
    val completedAt: Long

    fun toolCall(): Assistant.ToolItem? = this as? Assistant.ToolItem

    fun reduceToolUpdate(update: SessionUpdate.ToolCallUpdate): ConversationItem {
        val tool = toolCall() ?: return this
        if (tool.callId() != update.toolCallId.value) return this
        return reduceConversationToolItem(tool, update)
    }

    data class User(val input: ConversationInput, val internalOnly: Boolean = false) : ConversationItem {
        override val id: String get() = input.id
        override val text: String get() = input.prompt.text
        val fileReferences: List<FileReference> get() = input.prompt.toFileReferences()
        override val createdAt: Long get() = input.createdAt
        override val completedAt: Long get() = 0

        fun withCreatedAt(value: Long): User = copy(input = input.copy(createdAt = value))
    }

    sealed interface Assistant : ConversationItem {
        sealed interface Content : Assistant {
            val state: AssistantContentState

            val isComplete: Boolean get() = state !is AssistantContentState.Streaming
            val interrupted: Boolean get() = state is AssistantContentState.Interrupted
            val errorText: String?
                get() = when (val value = state) {
                    is AssistantContentState.Interrupted -> value.errorText
                    is AssistantContentState.Failed -> value.errorText
                    AssistantContentState.Completed, AssistantContentState.Streaming -> null
                }
        }

        @Stable
        class Text(
            override val id: String,
            text: String,
            state: AssistantContentState = AssistantContentState.Completed,
            createdAt: Long = java.lang.System.currentTimeMillis(),
            completedAt: Long = 0,
        ) : Content {
            override var text: String by mutableStateOf(text)
                private set

            override var state: AssistantContentState by mutableStateOf(state)
                private set

            override var createdAt: Long by mutableStateOf(createdAt)
                internal set

            override var completedAt: Long by mutableStateOf(completedAt)
                internal set

            internal fun appendText(chunk: String) {
                text += chunk
            }

            internal fun replaceText(value: String) {
                text = value
            }

            internal fun setState(value: AssistantContentState) {
                state = value
            }

            internal fun updateCreatedAt(value: Long) {
                createdAt = value
            }

            internal fun updateCompletedAt(value: Long) {
                completedAt = value
            }
        }

        @Stable
        class Thought(
            override val id: String,
            text: String,
            state: AssistantContentState = AssistantContentState.Streaming,
            createdAt: Long = java.lang.System.currentTimeMillis(),
            completedAt: Long = 0,
            expanded: Boolean = false,
        ) : Content {
            override var text: String by mutableStateOf(text)
                private set

            override var state: AssistantContentState by mutableStateOf(state)
                private set

            override var createdAt: Long by mutableStateOf(createdAt)
                internal set

            override var completedAt: Long by mutableStateOf(completedAt)
                internal set

            var expanded: Boolean by mutableStateOf(expanded)
                private set

            internal fun appendText(chunk: String) {
                text += chunk
            }

            internal fun replaceText(value: String) {
                text = value
            }

            internal fun setState(value: AssistantContentState) {
                state = value
            }

            internal fun updateCreatedAt(value: Long) {
                createdAt = value
            }

            internal fun updateCompletedAt(value: Long) {
                completedAt = value
            }

            internal fun setExpanded(value: Boolean) {
                expanded = value
            }

            internal fun toggleExpanded() {
                expanded = !expanded
            }
        }

        @Stable
        sealed class ToolItem(
            native: SessionUpdate.ToolCall,
            createdAt: Long = java.lang.System.currentTimeMillis(),
            completedAt: Long = 0,
            backgroundMerged: Boolean = false,
            expanded: Boolean = false,
        ) : Assistant {
            var native: SessionUpdate.ToolCall by mutableStateOf(native)
                internal set

            override var createdAt: Long by mutableStateOf(createdAt)
                internal set

            override var completedAt: Long by mutableStateOf(completedAt)
                internal set

            var backgroundMerged: Boolean by mutableStateOf(backgroundMerged)
                private set

            var expanded: Boolean by mutableStateOf(expanded)
                private set

            override val id: String = "tool-${native.toolCallId.value}"
            override val text: String get() = outputText

            open fun displayTitle(): String? = conversationToolDisplayTitle(native)

            internal fun setEnvelope(
                createdAt: Long = this.createdAt,
                completedAt: Long = this.completedAt,
                backgroundMerged: Boolean = this.backgroundMerged,
            ) {
                this.createdAt = createdAt
                this.completedAt = completedAt
                this.backgroundMerged = backgroundMerged
            }

            internal fun setExpanded(value: Boolean) {
                expanded = value
            }

            internal fun toggleExpanded() {
                expanded = !expanded
            }

            @Stable
            class Generic(
                native: SessionUpdate.ToolCall,
                createdAt: Long = java.lang.System.currentTimeMillis(),
                completedAt: Long = 0,
                backgroundMerged: Boolean = false,
            ) : ToolItem(native, createdAt, completedAt, backgroundMerged)

            @Stable
            class Read(
                native: SessionUpdate.ToolCall,
                createdAt: Long = java.lang.System.currentTimeMillis(),
                completedAt: Long = 0,
                backgroundMerged: Boolean = false,
            ) : ToolItem(native, createdAt, completedAt, backgroundMerged),
                PrimaryFileLocation {
                private val primaryLocation: ToolCallLocation?
                    get() = locations().firstOrNull { !it.path.isNullOrBlank() }

                override val primaryPath: String?
                    get() = primaryLocation?.path?.takeIf { it.isNotBlank() }

                override val primaryLine: Int?
                    get() = primaryLocation?.line?.toInt()
            }

            @Stable
            class FileMutation(
                native: SessionUpdate.ToolCall,
                createdAt: Long = java.lang.System.currentTimeMillis(),
                completedAt: Long = 0,
                backgroundMerged: Boolean = false,
            ) : ToolItem(native, createdAt, completedAt, backgroundMerged),
                PrimaryFileLocation {
                var fileEdits: List<ToolEditTracker.FileEdit> by mutableStateOf(emptyList())
                    private set

                private val primaryLocation: ToolCallLocation?
                    get() = locations().firstOrNull { !it.path.isNullOrBlank() }

                override val primaryPath: String?
                    get() = primaryLocation?.path?.takeIf { it.isNotBlank() }

                override val primaryLine: Int?
                    get() = primaryLocation?.line?.toInt()

                internal fun setFileEdits(edits: List<ToolEditTracker.FileEdit>) {
                    fileEdits = edits
                }
            }

            @Stable
            class Subagent(
                native: SessionUpdate.ToolCall,
                description: String?,
                createdAt: Long = java.lang.System.currentTimeMillis(),
                completedAt: Long = 0,
                backgroundMerged: Boolean = false,
            ) : ToolItem(native, createdAt, completedAt, backgroundMerged) {
                var description: String? by mutableStateOf(description)
                    internal set

                override fun displayTitle(): String? = description ?: super.displayTitle()

                fun backgroundJobId(): String? = AcpToolInputParser.backgroundJobId(native.rawOutput)

                fun backgroundParentId(): String? = AcpToolInputParser.backgroundParentId(native.rawOutput)
            }
        }
    }

    data class System(
        override val id: String,
        val title: String,
        override val text: String,
        val internalOnly: Boolean = false,
        val turnBoundary: Boolean = false,
        override val createdAt: Long = java.lang.System.currentTimeMillis(),
        override val completedAt: Long = 0,
    ) : ConversationItem

    companion object {
        fun user(
            id: String,
            text: String,
            internalOnly: Boolean = false,
            createdAt: Long = java.lang.System.currentTimeMillis(),
            completedAt: Long = 0,
        ): User = user(
            input = ConversationInput.text(id = id, text = text, createdAt = createdAt),
            internalOnly = internalOnly,
        )

        fun user(input: ConversationInput, internalOnly: Boolean = false): User = User(
            input = input,
            internalOnly = internalOnly,
        )

        fun agent(
            id: String,
            text: String,
            state: AssistantContentState = AssistantContentState.Completed,
            createdAt: Long = java.lang.System.currentTimeMillis(),
            completedAt: Long = 0,
        ): Assistant.Text = Assistant.Text(id, text, state, createdAt, completedAt)

        fun thought(
            id: String,
            text: String,
            state: AssistantContentState = AssistantContentState.Streaming,
            createdAt: Long = java.lang.System.currentTimeMillis(),
            completedAt: Long = 0,
        ): Assistant.Thought = Assistant.Thought(id, text, state, createdAt, completedAt)

        fun tool(tool: Assistant.ToolItem): Assistant.ToolItem = tool

        fun system(
            id: String,
            title: String,
            text: String,
            createdAt: Long = java.lang.System.currentTimeMillis(),
            internalOnly: Boolean = false,
            turnBoundary: Boolean = false,
        ): System = System(
            id = id,
            title = title,
            text = text,
            createdAt = createdAt,
            internalOnly = internalOnly,
            turnBoundary = turnBoundary,
        )
    }
}

internal sealed interface AssistantContentState {
    data object Streaming : AssistantContentState
    data object Completed : AssistantContentState
    data class Interrupted(val errorText: String? = null) : AssistantContentState
    data class Failed(val errorText: String) : AssistantContentState
}
