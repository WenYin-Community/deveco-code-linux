package org.deveco.code.session.model.command

import org.junit.Assert.assertEquals
import org.junit.Test

class CommandCatalogTest {

    private fun server(name: String, source: String? = null, description: String? = "$name description") =
        CommandCatalog.ServerCommand(name, description, source)

    private fun choice(name: String, kind: CommandKind = CommandKind.COMMAND) =
        CommandChoice(name, "$name description", kind)

    @Test
    fun `http registry wins and available commands are only fallback`() {
        val http = listOf(server("init"))
        val fallback = listOf(server("review"))

        assertEquals(http, selectServerCommands(http, fallback))
        assertEquals(fallback, selectServerCommands(emptyList(), fallback))
    }

    @Test
    fun `catalog excludes known skills source skills and internal templates`() {
        val skills = listOf(
            choice("skill-a", CommandKind.SKILL),
            choice("skill-b", CommandKind.SKILL),
        )
        val catalog = buildCommandCatalog(
            serverCommands = listOf(
                server("init"),
                server("known-skill"),
                server("tagged-skill", source = "SKILL"),
                server("prompt:template"),
                server("mcp-tool", source = "mcp", description = null),
            ),
            skillCommands = skills,
            knownSkillNames = setOf("known-skill"),
            subtaskCommandNames = setOf("review"),
        )

        assertEquals(listOf("init", "mcp-tool"), catalog.nonSkillCommands.map { it.name })
        assertEquals(CommandKind.MCP, catalog.nonSkillCommands.last().kind)
        assertEquals("", catalog.nonSkillCommands.last().description)
        assertEquals(skills, catalog.skillCommands)
        assertEquals(listOf("init", "mcp-tool", "skill-a", "skill-b"), catalog.commands.map { it.name })
        assertEquals(setOf("review"), catalog.subtaskCommandNames)
    }

    @Test
    fun `command kind inference preserves source and builtin fallback rules`() {
        assertEquals(CommandKind.SKILL, CommandKindInference.infer("anything", "skill"))
        assertEquals(CommandKind.MCP, CommandKindInference.infer("anything", "MCP"))
        assertEquals(CommandKind.COMMAND, CommandKindInference.infer("anything", "custom"))
        assertEquals(CommandKind.SKILL, CommandKindInference.infer("customize-deveco"))
        assertEquals(CommandKind.SKILL, CommandKindInference.infer("deveco-cli"))
        assertEquals(CommandKind.COMMAND, CommandKindInference.infer("init"))
    }

    @Test
    fun `subtask names aggregate only explicitly marked commands`() {
        val names = buildSubtaskCommandNames(
            listOf(
                "analyze" to true,
                "init" to false,
                "review" to true,
                "analyze" to true,
            ),
        )

        assertEquals(setOf("analyze", "review"), names)
    }
}
