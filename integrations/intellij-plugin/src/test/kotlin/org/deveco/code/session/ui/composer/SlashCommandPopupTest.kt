package org.deveco.code.session.ui.composer

import org.deveco.code.MyMessageBundle
import org.deveco.code.session.model.CommandChoice
import org.deveco.code.session.model.CommandKind
import org.deveco.code.session.model.ModelChoice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the slash-command popup filtering of SlashCommandPopup.kt:
 * [computeSlashItems] client-command prefix filtering, server-command
 * dedupe/sorting/tagging, description localization fallback, and the
 * "/models" sub-list (including the trailing-space rule: a trailing space
 * keeps command completions for every command except "models", where it
 * opens the model list instead).
 */
class SlashCommandPopupTest {

    private val noModels = emptyList<ModelChoice>()
    private val noCommands = emptyList<CommandChoice>()

    private fun model(id: String, name: String) = ModelChoice(id = id, name = name)

    // --- basic gating ---

    @Test
    fun testNonSlashTextYieldsNoItems() {
        assertTrue(computeSlashItems("hello", noModels, noCommands).isEmpty())
    }

    @Test
    fun testEmptyTextYieldsNoItems() {
        assertTrue(computeSlashItems("", noModels, noCommands).isEmpty())
    }

    // --- client commands ---

    @Test
    fun testBareSlashOffersBothClientCommands() {
        val items = computeSlashItems("/", noModels, noCommands)

        assertEquals(listOf("/compact", "/new"), items.map { it.displayText })
        assertTrue(items.all { it.kind == SlashItemKind.COMMAND })
        assertEquals(listOf("compact", "new"), items.map { it.payload })
    }

    @Test
    fun testClientCommandFilterByPrefix() {
        assertEquals("/compact", computeSlashItems("/c", noModels, noCommands).single().displayText)
        assertEquals("/new", computeSlashItems("/n", noModels, noCommands).single().displayText)
        assertTrue(computeSlashItems("/x", noModels, noCommands).isEmpty())
    }

    @Test
    fun testLeadingWhitespaceIsIgnored() {
        assertEquals("/compact", computeSlashItems("  /c", noModels, noCommands).single().displayText)
    }

    // --- server commands ---

    @Test
    fun testServerCommandsAreSortedByKindAndTagged() {
        val commands = listOf(
            CommandChoice("zz-mcp", "mcp-desc", CommandKind.MCP),
            CommandChoice("zz-skill", "skill-desc", CommandKind.SKILL),
            CommandChoice("zz-cmd", "cmd-desc", CommandKind.COMMAND),
        )

        val items = computeSlashItems("/zz", noModels, commands)

        assertEquals(listOf("/zz-cmd", "/zz-skill", "/zz-mcp"), items.map { it.displayText })
        assertTrue(items.all { it.kind == SlashItemKind.SERVER_COMMAND })
        assertEquals(listOf(null, "Skill", "MCP"), items.map { it.tag })
    }

    @Test
    fun testServerCommandMatchingClientNameIsExcluded() {
        val commands = listOf(CommandChoice("compact", "server-compact", CommandKind.COMMAND))

        val items = computeSlashItems("/compact", noModels, commands)

        assertEquals(1, items.size)
        assertEquals(SlashItemKind.COMMAND, items.single().kind)
    }

    @Test
    fun testKnownServerCommandDescriptionIsLocalized() {
        val commands = listOf(CommandChoice("review", "fallback", CommandKind.COMMAND))

        val item = computeSlashItems("/review", noModels, commands).single()

        assertEquals(MyMessageBundle.message("slash.command.review.desc"), item.description)
    }

    @Test
    fun testUnknownServerCommandFallsBackToItsOwnDescription() {
        val commands = listOf(CommandChoice("zz-unknown", "fallback-desc", CommandKind.COMMAND))

        val item = computeSlashItems("/zz-unknown", noModels, commands).single()

        assertEquals("fallback-desc", item.description)
    }

    @Test
    fun testServerCommandFilterIsCaseInsensitive() {
        val commands = listOf(CommandChoice("Review", "fallback", CommandKind.COMMAND))

        val item = computeSlashItems("/rev", noModels, commands).single()

        assertEquals("/Review", item.displayText)
        assertEquals("Review", item.payload)
    }

    // --- trailing-space rule ---

    @Test
    fun testTrailingSpaceKeepsCompletionsForNonModelCommands() {
        val items = computeSlashItems("/compact ", noModels, noCommands)

        assertEquals(listOf("/compact"), items.map { it.displayText })
    }

    @Test
    fun testTrailingSpaceOnModelsOpensModelList() {
        val models = listOf(model("m1", "Claude Big"), model("m2", "GPT Wide"))

        val items = computeSlashItems("/models ", models, noCommands)

        assertEquals(listOf("Claude Big", "GPT Wide"), items.map { it.displayText })
        assertTrue(items.all { it.kind == SlashItemKind.MODEL })
        assertEquals(listOf("m1", "m2"), items.map { it.payload })
        assertEquals(
            MyMessageBundle.message("slash.command.model"),
            items.first().description,
        )
    }

    @Test
    fun testBareModelsCommandDoesNotOpenModelList() {
        val models = listOf(model("m1", "Claude"))

        assertTrue(computeSlashItems("/models", models, noCommands).isEmpty())
    }

    // --- model sub-list filtering ---

    @Test
    fun testModelFilterMatchesName() {
        val models = listOf(model("m1", "Claude Big"), model("m2", "GPT Wide"))

        val item = computeSlashItems("/models cla", models, noCommands).single()

        assertEquals("Claude Big", item.displayText)
    }

    @Test
    fun testModelFilterMatchesId() {
        val models = listOf(model("m1", "Claude Big"), model("anthropic/opus", "Opus"))

        val item = computeSlashItems("/models anthropic", models, noCommands).single()

        assertEquals("Opus", item.displayText)
    }

    @Test
    fun testModelFilterIsCaseInsensitive() {
        val models = listOf(model("m1", "Claude Big"))

        assertEquals(1, computeSlashItems("/models BIG", models, noCommands).size)
    }

    @Test
    fun testModelFilterNoMatchIsEmpty() {
        val models = listOf(model("m1", "Claude"))

        assertTrue(computeSlashItems("/models nomatch", models, noCommands).isEmpty())
    }

    @Test
    fun testUnknownCommandWithArgumentYieldsNoItems() {
        val models = listOf(model("m1", "Claude"))

        assertTrue(computeSlashItems("/compact extra", models, noCommands).isEmpty())
    }
}
