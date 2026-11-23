package org.deveco.code.session.model.command

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
