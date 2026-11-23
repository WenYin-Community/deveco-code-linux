package org.deveco.code.session.model.command

internal data class CommandChoice(
    val name: String,
    val description: String,
    val kind: CommandKind = CommandKind.COMMAND,
)
