package org.deveco.code.session.model

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

/**
 * The slash-command name the server would detect in [text]: the first
 * whitespace-delimited token after a leading `/`, or null when [text] is not a
 * slash invocation. [text] must be the string the server sees as its first
 * text part (see [isSubtaskCommand]).
 */
internal fun slashCommandName(text: String): String? {
    val trimmed = text.trimStart()
    if (!trimmed.startsWith("/")) return null
    return trimmed.substring(1).takeWhile { !it.isWhitespace() }.ifEmpty { null }
}

/**
 * The argument string of the slash invocation in [text] (trimmed, empty when
 * the command is bare), mirroring the server's name/argument split.
 */
internal fun slashCommandArgs(text: String): String {
    val trimmed = text.trimStart()
    if (!trimmed.startsWith("/")) return ""
    return trimmed.substring(1).trim().split(Regex("\\s+"), limit = 2).getOrElse(1) { "" }.trim()
}

private val TEMPLATE_PLACEHOLDER_REGEX = Regex("""\$(\d+)""")

// Mirrors the server's argument tokenizer (packages/core/src/session/template.ts):
// an "[Image N]" marker, a quoted string, or a bare non-space run — quotes trimmed.
private val TEMPLATE_ARGS_REGEX =
    Regex("""(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)""", RegexOption.IGNORE_CASE)
private val TEMPLATE_QUOTE_TRIM_REGEX = Regex("""^["']|["']$""")

// The server runs "!`cmd`" inline and substitutes the output before persisting
// (packages/opencode/src/session/prompt.ts). A client cannot reproduce that, so
// templates carrying it are detected and expansion is skipped.
private val TEMPLATE_SHELL_REGEX = Regex("!`[^`]+`")

/** True when [body] contains a server-executed "!`cmd`" inline shell substitution. */
internal fun hasShellSubstitution(body: String): Boolean = TEMPLATE_SHELL_REGEX.containsMatchIn(body)

/**
 * Deletes every "!`cmd`" block from [body], modeling a command that produced no
 * output — the local rendering the TUI's reverse matcher verifies against
 * (packages/tui/src/util/skill-match.ts).
 */
internal fun stripShellSubstitutions(body: String): String = body.replace(TEMPLATE_SHELL_REGEX, "")

/**
 * Expands a command [body] with [rawArgs], mirroring the server's
 * `SessionTemplate.expand` (packages/core/src/session/template.ts) so the client
 * can render the same text the backend persists as the turn's user message.
 *
 * Numbered `$1`..`$n` placeholders pull positional arguments (the highest
 * placeholder absorbs the remainder), `$ARGUMENTS` injects the raw string, and a
 * body with no placeholders at all appends the raw arguments. The caller trims
 * the result to match the server, which trims after inline-shell substitution.
 *
 * Inline shell (`!`cmd``) is NOT handled here — the server executes it and a
 * client cannot; callers must gate on [hasShellSubstitution] and fall back.
 */
internal fun expandCommandTemplate(body: String, rawArgs: String): String {
    val args = TEMPLATE_ARGS_REGEX.findAll(rawArgs)
        .map { it.value.replace(TEMPLATE_QUOTE_TRIM_REGEX, "") }
        .toList()
    val placeholders = TEMPLATE_PLACEHOLDER_REGEX.findAll(body)
        .map { it.groupValues[1].toIntOrNull() ?: 0 }
        .toList()
    val last = placeholders.maxOrNull() ?: 0
    val withArgs = TEMPLATE_PLACEHOLDER_REGEX.replace(body) { match ->
        val position = match.groupValues[1].toIntOrNull() ?: return@replace match.value
        val argIndex = position - 1
        when {
            // A negative index ("$0") is degenerate — real templates are 1-based —
            // and JS would emit "undefined"; treat it as missing so arbitrary
            // skill bodies containing "$0" cannot crash subList/index access.
            argIndex < 0 || argIndex >= args.size -> ""

            position == last -> args.subList(argIndex, args.size).joinToString(" ")

            else -> args[argIndex]
        }
    }
    val template = withArgs.replace("\$ARGUMENTS", rawArgs)
    val appends = placeholders.isEmpty() && !body.contains("\$ARGUMENTS") && rawArgs.trim().isNotEmpty()
    return if (appends) template + "\n\n" + rawArgs else template
}
