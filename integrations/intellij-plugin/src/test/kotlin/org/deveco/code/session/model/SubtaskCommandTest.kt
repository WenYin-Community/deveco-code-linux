package org.deveco.code.session.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    @Test
    fun `slashCommandName extracts the first token`() {
        assertEquals("analyze", slashCommandName("/analyze crash.log"))
        assertEquals("compact", slashCommandName("  /compact"))
        assertEquals("review", slashCommandName("/review\ncheck line 42"))
    }

    @Test
    fun `slashCommandName returns null for non-invocations`() {
        assertNull(slashCommandName("analyze crash.log"))
        assertNull(slashCommandName("@src/Foo.ets\n\n/analyze crash.log"))
        assertNull(slashCommandName("/"))
        assertNull(slashCommandName(""))
    }

    @Test
    fun `slashCommandArgs extracts the remainder`() {
        assertEquals("status", slashCommandArgs("/debug status"))
        assertEquals("clear", slashCommandArgs("/debug  clear"))
        assertEquals("crash.log", slashCommandArgs("/analyze crash.log"))
        assertEquals("line 42", slashCommandArgs("/review\nline 42"))
    }

    @Test
    fun `slashCommandArgs is empty for bare commands and plain text`() {
        assertEquals("", slashCommandArgs("/compact"))
        assertEquals("", slashCommandArgs("/debug"))
        assertEquals("", slashCommandArgs("plain text"))
    }

    @Test
    fun `expandCommandTemplate injects raw arguments at the ARGUMENTS marker`() {
        assertEquals(
            "Create AGENTS.md\n\nfocus on build docs",
            expandCommandTemplate("Create AGENTS.md\n\n\$ARGUMENTS", "focus on build docs"),
        )
    }

    @Test
    fun `expandCommandTemplate leaves an empty ARGUMENTS marker blank`() {
        // Mirrors the server: $ARGUMENTS becomes the raw (empty) string; the
        // send path trims the result to match the persisted text.
        assertEquals(
            "Create AGENTS.md\n\n",
            expandCommandTemplate("Create AGENTS.md\n\n\$ARGUMENTS", ""),
        )
    }

    @Test
    fun `expandCommandTemplate appends arguments when the body has no placeholder`() {
        assertEquals(
            "Summarize the repo\n\nextra guidance",
            expandCommandTemplate("Summarize the repo", "extra guidance"),
        )
        assertEquals(
            "Summarize the repo",
            expandCommandTemplate("Summarize the repo", "   "),
        )
    }

    @Test
    fun `expandCommandTemplate fills numbered placeholders and the last absorbs the rest`() {
        assertEquals(
            "a=one b=two three",
            expandCommandTemplate("a=\$1 b=\$2", "one two three"),
        )
        assertEquals(
            "a=one b=",
            expandCommandTemplate("a=\$1 b=\$2", "one"),
        )
    }

    @Test
    fun `expandCommandTemplate keeps quoted arguments together`() {
        assertEquals(
            "file=two words rest",
            expandCommandTemplate("file=\$1 \$2", "\"two words\" rest"),
        )
    }

    @Test
    fun `hasShellSubstitution detects server-executed inline shell`() {
        assertTrue(hasShellSubstitution("state: !`git status` done"))
        assertFalse(hasShellSubstitution("no shell here \$ARGUMENTS"))
    }

    @Test
    fun `stripShellSubstitutions deletes inline shell blocks`() {
        assertEquals("state:  done", stripShellSubstitutions("state: !`git status` done"))
        assertEquals("no shell here \$ARGUMENTS", stripShellSubstitutions("no shell here \$ARGUMENTS"))
    }

    @Test
    fun `expandCommandTemplate treats a degenerate zero placeholder as missing`() {
        // "$0" yields a negative index; JS would stringify undefined here, but
        // arbitrary skill bodies can contain "$0" and must not crash subList /
        // index access — the reverse matcher expands every loaded body.
        assertEquals("a= b=one", expandCommandTemplate("a=\$0 b=\$1", "one"))
        assertEquals("run  done", expandCommandTemplate("run \$0 done", "x"))
    }
}
