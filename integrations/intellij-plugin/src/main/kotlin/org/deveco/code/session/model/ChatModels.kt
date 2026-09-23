package org.deveco.code.session.model

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
    val attachments: List<AttachmentItem> = emptyList(),
    val fileReferences: List<FileReference> = emptyList(),
    val duration: Long = 0,
    val createdAt: Long = System.currentTimeMillis(),
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
)

internal enum class CommandKind { COMMAND, SKILL, MCP }

internal object CommandKindInference {
    private val DEVECO_DEFAULT_SKILLS = setOf(
        "arkts-error-fixes",
        "arkts-grammar-standards",
        "arkts-runtime-fix",
        "customize-deveco",
        "deveco-cli",
        "deveco-create-project",
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
) {
    // Structural equality for List.contains() etc. — data class with ByteArray needs manual fix.
    override fun equals(other: Any?): Boolean = other is AttachmentItem &&
        other.name == name && other.path == path && other.mimeType == mimeType &&
        other.isImage == isImage &&
        other.thumbnail?.contentEquals(thumbnail ?: ByteArray(0)) != false &&
        other.originalBytes?.contentEquals(originalBytes ?: ByteArray(0)) != false
    override fun hashCode(): Int = name.hashCode() * 31 + path.hashCode() * 17 + mimeType.hashCode()
}

internal data class PermissionChoice(val name: String, val select: () -> Unit)

internal enum class PermissionMode(val id: String, private val labelKey: String) {
    RECOMMENDED("recommended", "permission.mode.recommended"),
    SANDBOX("sandbox", "permission.mode.default"),
    AUTO("auto", "permission.mode.auto"),
    ;

    val label: String get() = MyMessageBundle.message(labelKey)
}
