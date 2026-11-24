package org.deveco.code.session.model.command

/**
 * True when [text] invokes one of the [subtaskCommands] (e.g. `/analyze`, `/review`).
 *
 * The server runs those commands as an isolated subtask: it replaces the typed
 * text with a `subtask` part, so the persisted user message carries no text for
 * clients to replay. Echoing the command locally would therefore show a bubble
 * the transcript can never restore, while the TUI shows only the delegation
 * card.
 *
 * [text] must be the string the server will see as its **first text part**
 * (the session controller's `promptText`), not the user's raw input: the
 * server only inspects that part, and file-reference content is prepended to
 * it. Passing the raw input would suppress the echo for a prompt the server
 * actually persists as a plain message.
 *
 * Parsing mirrors the server's slash-command detection: the name is the first
 * whitespace-delimited token after a leading `/`. Only commands explicitly
 * marked with `subtask: true` are handled here. Commands that become subtasks
 * through a subagent configuration remain out of scope until the registry
 * exposes their effective mode.
 */
internal fun isSubtaskCommand(text: String, subtaskCommands: Set<String>): Boolean {
    if (subtaskCommands.isEmpty()) return false
    val trimmed = text.trimStart()
    if (!trimmed.startsWith("/")) return false
    val name = trimmed.substring(1).takeWhile { !it.isWhitespace() }
    return name.isNotEmpty() && name in subtaskCommands
}
