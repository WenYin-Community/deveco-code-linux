package org.deveco.code.session.model

import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.snapshots.SnapshotStateMap
import com.agentclientprotocol.model.ToolCallLocation
import com.agentclientprotocol.model.ToolCallStatus
import com.agentclientprotocol.model.ToolKind
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.ToolEditTracker

internal enum class ChatRole { USER, AGENT, THOUGHT, SYSTEM, TOOL }

internal data class ChatItem(
    val id: String,
    val role: ChatRole,
    val title: String,
    val text: String,
    val toolKind: ToolKind? = null,
    val toolPath: String? = null,
    val toolLine: Int? = null,
    val toolOffset: Int? = null,
    val toolLimit: Int? = null,
    val toolStatus: ToolCallStatus? = null,
    val toolRawInput: Any? = null,
    val toolRawOutput: Any? = null,
    val toolLocations: List<ToolCallLocation>? = null,
    val toolFileEdits: List<ToolEditTracker.FileEdit> = emptyList(),
    val isComplete: Boolean = true,
    val interrupted: Boolean = false,
    val internalOnly: Boolean = false,
    // Invisible logical turn boundary for turns that intentionally have no USER
    // bubble (subtask commands). Unlike a hidden USER item, it does not change
    // USER ordinals used by replay reconciliation.
    val turnBoundary: Boolean = false,
    // Visible "Compaction" rule standing in for a /compact turn's missing USER
    // bubble (TUI parity): the backend persists a compaction-part-only user
    // message ACP replay emits no chunk for, so live draws this row and replay
    // rebuilds it from the persisted part. It doubles as the turn boundary, and
    // its id carries the server turn key ("TURN-<id>") like subtask boundaries.
    val compactionDivider: Boolean = false,
    val backgroundMerged: Boolean = false,
    val errorText: String? = null,
    val attachments: List<AttachmentItem> = emptyList(),
    val fileReferences: List<FileReference> = emptyList(),
    val duration: Long = 0,
    val createdAt: Long = System.currentTimeMillis(),
    // Wall-clock time the turn reached its terminal state (stop/error); 0 when not
    // recorded. The status-prefixed footer timestamp formats this instead of
    // createdAt, which is only when the footer text segment started streaming.
    val completedAt: Long = 0,
    // Assistant message that owns this part. ACP text/reasoning events carry it directly;
    // tools inherit the active assistant message until the backend snapshot replaces them.
    val sourceMessageId: String? = null,
)

internal data class ModelChoice(
    override val id: String,
    override val name: String,
    val providerId: String = "",
    val modelId: String = "",
) : LabeledChoice

internal data class ModeChoice(override val id: String, override val name: String) : LabeledChoice

internal interface LabeledChoice {
    val id: String
    val name: String
}

internal data class CommandChoice(
    val name: String,
    val description: String,
    val kind: CommandKind = CommandKind.COMMAND,
    // Subtask commands persist a user message replay emits no chunk for; see
    // SessionController.savesReplayableSlashText.
    val subtask: Boolean = false,
)

internal enum class CommandKind { COMMAND, SKILL, MCP }

internal object CommandKindInference {
    private val DEVECO_DEFAULT_SKILLS = setOf(
        "customize-deveco",
        "deveco-cli",
    )

    fun infer(name: String, source: String? = null): CommandKind = when {
        source.equals("skill", true) -> CommandKind.SKILL
        source.equals("mcp", true) -> CommandKind.MCP
        source != null -> CommandKind.COMMAND
        name in DEVECO_DEFAULT_SKILLS -> CommandKind.SKILL
        else -> CommandKind.COMMAND
    }
}

internal data class AttachmentItem(
    val name: String,
    val path: String,
    val mimeType: String,
    val isImage: Boolean,
    val thumbnail: ByteArray? = null,
    val originalBytes: ByteArray? = null,
    // Send payload compressed at ADD time (方案一): the send path reads this cache
    // instead of re-running decode/scale/encode, shrinking the seconds-long
    // attachment-prep window — during which an immediate stop was swallowed — to
    // milliseconds. Derived cache, not identity: excluded from equals/hashCode and
    // stripped before persistence (prompt history / view state) and before message
    // rendering (ChatItems keep render-only copies — see appendUserAndTitle).
    val optimizedBytes: ByteArray? = null,
    // Mime of the cached payload, decided at add time against the add-time
    // original ("image/jpeg" when re-encoded, source mime when kept as-is).
    // Lets the send path pick the mime without re-reading the file.
    val optimizedMime: String? = null,
) {
    // Structural equality for List.contains() etc. — data class with ByteArray needs manual fix.
    // optimizedBytes is deliberately excluded: it is a derived send cache, not identity.
    override fun equals(other: Any?): Boolean = other is AttachmentItem &&
        other.name == name && other.path == path && other.mimeType == mimeType &&
        other.isImage == isImage &&
        other.thumbnail?.contentEquals(thumbnail ?: ByteArray(0)) != false &&
        other.originalBytes?.contentEquals(originalBytes ?: ByteArray(0)) != false
    override fun hashCode(): Int = name.hashCode() * 31 + path.hashCode() * 17 + mimeType.hashCode()
}

internal data class PermissionChoice(val name: String, val select: () -> Unit)

internal data class ElicitationOptionItem(val value: String, val label: String, val description: String? = null)

internal data class ElicitationFieldItem(
    val key: String,
    val title: String,
    val question: String,
    val options: List<ElicitationOptionItem>,
    val multiple: Boolean,
    val required: Boolean,
    val allowCustom: Boolean,
)

internal data class ElicitationItem(
    val title: String,
    val fields: List<ElicitationFieldItem>,
    val onSubmit: (Map<String, List<String>>?) -> Unit,
    // Draft answer state lives on the item (controller-owned) so a tab switch,
    // which disposes the dialog composition, keeps selections and custom text.
    val selections: SnapshotStateMap<String, Set<String>> = mutableStateMapOf(),
    val customAnswers: SnapshotStateMap<String, String> = mutableStateMapOf(),
)

internal enum class PermissionMode(val id: String, private val labelKey: String) {
    RECOMMENDED("recommended", "permission.mode.recommended"),
    SANDBOX("sandbox", "permission.mode.default"),
    AUTO("auto", "permission.mode.auto"),
    ;

    val label: String get() = MyMessageBundle.message(labelKey)
}
