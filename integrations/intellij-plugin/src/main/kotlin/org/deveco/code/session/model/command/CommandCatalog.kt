package org.deveco.code.session.model.command

internal data class CommandCatalog(
    val commands: List<CommandChoice> = emptyList(),
    val nonSkillCommands: List<CommandChoice> = emptyList(),
    val skillCommands: List<CommandChoice> = emptyList(),
    val subtaskCommandNames: Set<String> = emptySet(),
) {
    data class ServerCommand(val name: String, val description: String?, val source: String?)

    companion object {
        fun empty(): CommandCatalog = CommandCatalog()
    }
}

internal fun selectServerCommands(
    httpCommands: List<CommandCatalog.ServerCommand>,
    fallbackCommands: List<CommandCatalog.ServerCommand>,
): List<CommandCatalog.ServerCommand> = httpCommands.takeIf { it.isNotEmpty() } ?: fallbackCommands

internal fun buildCommandCatalog(
    serverCommands: List<CommandCatalog.ServerCommand>,
    skillCommands: List<CommandChoice>,
    knownSkillNames: Set<String>,
    subtaskCommandNames: Set<String>,
): CommandCatalog {
    val allSkillNames = knownSkillNames +
        serverCommands.filter { it.source.equals("skill", true) }.map { it.name }
    val nonSkillCommands = serverCommands
        .filter { it.name !in allSkillNames && !it.name.contains(':') }
        .map {
            CommandChoice(
                name = it.name,
                description = it.description ?: "",
                kind = CommandKindInference.infer(it.name, it.source),
            )
        }
    return CommandCatalog(
        commands = nonSkillCommands + skillCommands,
        nonSkillCommands = nonSkillCommands,
        skillCommands = skillCommands,
        subtaskCommandNames = subtaskCommandNames,
    )
}

internal fun buildSubtaskCommandNames(commands: Iterable<Pair<String, Boolean>>): Set<String> =
    commands.filter { it.second }.map { it.first }.toSet()
