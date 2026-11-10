package org.deveco.code.session.model

/**
 * Kotlin port of the TUI's stateless skill-expansion reverse matcher
 * (`packages/tui/src/util/skill-match.ts`), built on the shared
 * [expandCommandTemplate] port of the server's `SessionTemplate.expand`.
 *
 * The backend persists a `/skill-name args` turn as the EXPANDED skill
 * template text (ACP delegates slash commands to session/command). The TUI
 * recovers the typed invocation at render time by re-expanding every known
 * skill body and comparing against the persisted text; this port gives the
 * plugin the same recovery for replayed skill messages that have no locally
 * saved original text — messages sent from another client (TUI/CLI), persisted
 * before the origText decoration existed, or sent through the pendingPrompt
 * path (#1388), which claims no replay index.
 *
 * Known deviations from the JS original, all fail-closed (the final
 * re-expansion verification rejects and the caller falls back to the wire
 * text):
 *  - JS `replaceAll("$ARGUMENTS", rawArgs)` interprets `$&`/`$$`-style
 *    replacement patterns inside rawArgs; Kotlin replaces literally.
 *  - Placeholder numbers beyond Int range keep their literal text instead of
 *    becoming JS doubles.
 */

private val POSITIONAL_REGEX = Regex("\\$\\d")

/** A skill's name plus its full SKILL.md body (frontmatter stripped), as served by /skill/status. */
internal data class SkillBody(val name: String, val content: String)

/** A persisted user text that is the expansion of [name]'s body with [args] (already trimmed). */
internal data class SkillExpansionMatch(val name: String, val args: String) {
    /** The typed invocation shape the composer would have sent, matching the live echo. */
    fun toTypedText(): String = if (args.isEmpty()) "/$name" else "/$name $args"
}

/**
 * Precomputed matcher over a set of skill bodies. Built on a background thread
 * (each entry caches its zero-arg rendering and body scans) so per-message
 * matching on the EDT is dominated by equality/prefix checks; the full
 * [expandCommandTemplate] pipeline only runs for candidates that pass those
 * gates.
 */
internal class SkillExpansionIndex private constructor(private val entries: List<Entry>) {

    /**
     * Mirrors `matchSkillExpansion`: first match in list order wins; empty text
     * and empty bodies never match.
     */
    fun match(text: String): SkillExpansionMatch? {
        if (text.isEmpty()) return null
        for (entry in entries) {
            val args = matchArgs(text, entry) ?: continue
            return SkillExpansionMatch(entry.name, args)
        }
        return null
    }

    // Port of matchArgs: ordered gates exactly as the TUI — zero-arg exact
    // match, positional-placeholder bail-out (non-invertible), "\n\n"-append
    // match for bodies without $ARGUMENTS, then the $ARGUMENTS solver.
    private fun matchArgs(text: String, entry: Entry): String? {
        if (entry.base == text) return ""
        if (entry.hasPositional) return null
        if (!entry.hasArguments) {
            if (!text.startsWith(entry.base + "\n\n")) return null
            return text.substring(entry.base.length + 2).trim()
        }
        return solveArguments(text, entry)
    }

    // Port of solveArguments: shell-block bodies are not invertible (the real
    // command output is unknown). One $ARGUMENTS site → prefix/suffix middle
    // slice; multiple sites → equal-length heuristic. Every candidate must
    // re-expand byte-identically to the persisted text.
    private fun solveArguments(text: String, entry: Entry): String? {
        if (entry.hasShell) return null
        val segments = entry.body.split(ARGUMENTS)
        val candidate = if (segments.size == 2) {
            if (text.startsWith(segments[0]) && text.endsWith(segments[1])) {
                jsSlice(text, segments[0].length, text.length - segments[1].length)
            } else {
                null
            }
        } else {
            argumentsFromLength(text, segments)
        } ?: return null
        if (localExpand(entry.body, candidate) != text) return null
        return candidate.trim()
    }

    // Port of argumentsFromLength: all sites must have received the same raw
    // string, so the per-site length follows from the total length difference.
    private fun argumentsFromLength(text: String, segments: List<String>): String? {
        val sites = segments.size - 1
        val total = segments.sumOf { it.length }
        val diff = text.length - total
        if (diff < 0 || diff % sites != 0) return null
        return jsSlice(text, segments[0].length, segments[0].length + diff / sites)
    }

    private class Entry(
        val name: String,
        val body: String,
        val base: String,
        val hasPositional: Boolean,
        val hasArguments: Boolean,
        val hasShell: Boolean,
    )

    companion object {
        private const val ARGUMENTS = "\$ARGUMENTS"

        val EMPTY = SkillExpansionIndex(emptyList())

        fun build(skills: List<SkillBody>): SkillExpansionIndex = SkillExpansionIndex(
            skills.mapNotNull { skill ->
                val body = skill.content.trim()
                if (body.isEmpty()) return@mapNotNull null
                Entry(
                    name = skill.name,
                    body = body,
                    base = localExpand(body, ""),
                    hasPositional = POSITIONAL_REGEX.containsMatchIn(body),
                    hasArguments = body.contains(ARGUMENTS),
                    hasShell = hasShellSubstitution(body),
                )
            },
        )
    }
}

// The matcher's local rendering, port of the TUI wrapper: expand, delete every
// shell block (modeling "the command produced no output"), trim.
private fun localExpand(body: String, rawArgs: String): String =
    stripShellSubstitutions(expandCommandTemplate(body, rawArgs)).trim()

// JS String.prototype.slice clamping: out-of-range ends clamp, end <= start
// yields "" instead of throwing like Kotlin's substring.
private fun jsSlice(text: String, start: Int, end: Int): String {
    val from = start.coerceIn(0, text.length)
    val to = end.coerceIn(0, text.length)
    if (to <= from) return ""
    return text.substring(from, to)
}
