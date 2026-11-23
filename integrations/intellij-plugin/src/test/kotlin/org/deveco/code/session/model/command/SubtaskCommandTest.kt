package org.deveco.code.session.model.command

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SubtaskCommandTest {

    private val subtaskCommands = setOf("analyze", "review")

    @Test
    fun `command with arguments is a subtask`() {
        assertTrue(isSubtaskCommand("/analyze crash.log", subtaskCommands))
    }

    @Test
    fun `bare command is a subtask`() {
        assertTrue(isSubtaskCommand("/analyze", subtaskCommands))
        assertTrue(isSubtaskCommand("/review", subtaskCommands))
    }

    @Test
    fun `multiline input is parsed from its first token`() {
        assertTrue(isSubtaskCommand("/analyze app freeze\nplease check line 42", subtaskCommands))
    }

    @Test
    fun `leading whitespace does not hide the command`() {
        assertTrue(isSubtaskCommand("  /analyze crash.log", subtaskCommands))
    }

    @Test
    fun `prefix collision is not a subtask`() {
        assertFalse(isSubtaskCommand("/analyzer crash.log", subtaskCommands))
        assertFalse(isSubtaskCommand("/reviews", subtaskCommands))
    }

    @Test
    fun `other slash commands are not subtasks`() {
        assertFalse(isSubtaskCommand("/init", subtaskCommands))
        assertFalse(isSubtaskCommand("/commit msg", subtaskCommands))
    }

    @Test
    fun `plain text is not a subtask`() {
        assertFalse(isSubtaskCommand("analyze crash.log", subtaskCommands))
        assertFalse(isSubtaskCommand("please /analyze crash.log", subtaskCommands))
        assertFalse(isSubtaskCommand("", subtaskCommands))
        assertFalse(isSubtaskCommand("/", subtaskCommands))
    }

    @Test
    fun `empty registry keeps every prompt visible`() {
        assertFalse(isSubtaskCommand("/analyze crash.log", emptySet()))
    }

    @Test
    fun `file reference content in front of the command is a plain prompt`() {
        // The server only inspects the first text part, and a file-reference chip
        // is prepended to it. The caller must probe that same string; when the
        // content comes first the server persists a normal user message, so the
        // transcript must keep its bubble. The same command without a chip stays
        // a subtask and must stay silent.
        assertFalse(isSubtaskCommand("@src/Foo.ets\n\n/analyze crash.log", subtaskCommands))
        assertFalse(
            isSubtaskCommand("```file:src/Foo.ets\nentry()\n```\n\n/review", subtaskCommands),
        )
        assertTrue(isSubtaskCommand("/analyze crash.log", subtaskCommands))
    }
}
