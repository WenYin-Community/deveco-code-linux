package org.deveco.code.migration

import java.nio.file.Path

/**
 * Data model for the CodeGenie -> DevEco Code migration.
 *
 * Pure Kotlin (no IntelliJ Platform dependency) so the whole migration core
 * stays unit-testable on the JVM. Field shapes mirror functional-design.md §2.
 */

/** One source skill (directory containing SKILL.md) discovered by the detector. */
data class SkillItem(
    /** Frontmatter `name`; null when frontmatter is missing/invalid (execution then fails that item). */
    val name: String?,
    val sourceDir: Path,
    val skillMdPath: Path,
    val skillMdSha256: String,
    val scope: MigrationScope,
)

/** One MCP server entry parsed from a source config file's `mcp` section. */
data class McpItem(
    val name: String,
    /** Raw config object (kept as JSON text to stay library-agnostic in the model layer). */
    val configJson: String,
    val scope: MigrationScope,
)

/** One mcp-auth.json entry — RESERVED: the old CodeGenie plugin has no such file,
 *  so sources are always empty; the field stays for report/UI compatibility. */
data class McpAuthItem(
    val name: String,
    val entryJson: String,
)

enum class MigrationScope { GLOBAL, PROJECT }

/**
 * A source-side MCP read failure (review P1-3). Distinguishes "confirmed
 * absent" (no failure, no items) from "could not be read": whole-database
 * (name == null — unreadable DB, key derivation failure) or per-row (a
 * server that failed decrypt/convert). Becomes FAILED report items so the
 * scope's marker is blocked and the user can retry after fixing the source.
 */
data class McpFailure(
    /** Row server_name, or null when the failure is database-level. */
    val name: String?,
    val reason: String,
)

enum class ConflictKind { SKILL, MCP, MCP_AUTH }

/** Everything the detector found on the source side, plus pre-checked conflicts. */
data class MigrationInventory(
    val globalSkills: List<SkillItem>,
    val projectSkills: List<SkillItem>,
    val globalMcps: List<McpItem>,
    val projectMcps: List<McpItem>,
    val mcpAuths: List<McpAuthItem>,
    val mcpFailures: List<McpFailure>,
    /** Scopes whose source side was looked for but not present (report "not found"). */
    val missingScopes: Set<MigrationScope>,
    /**
     * IDE version directory name that actually carried the detected data
     * (e.g. "DevEcoStudio6.1"), when it differs from the currently running
     * IDE version. Null when data comes from the current IDE (or no data).
     * Used by the prompt bar to annotate the source (方案 B) so the user
     * understands why the migration prompt appeared.
     */
    val sourceVersion: String? = null,
) {
    // mcpFailures counts as "global source present": the user HAS CodeGenie
    // MCP data that could not be read — the prompt must surface that, not
    // silently skip it (review P1-3).
    val hasGlobalSource: Boolean
        get() = globalSkills.isNotEmpty() || globalMcps.isNotEmpty() ||
            mcpAuths.isNotEmpty() || mcpFailures.isNotEmpty()
    val hasProjectSource: Boolean get() = projectSkills.isNotEmpty() || projectMcps.isNotEmpty()
}

/** Outcome of a single atomic migration item. */
enum class ReportStatus {
    MIGRATED,
    SKIPPED_EQUIVALENT,
    SKIPPED_CONFLICT,
    FAILED,
    NOT_STARTED,
}

data class ReportItem(
    val kind: ConflictKind,
    val scope: MigrationScope,
    val name: String,
    val status: ReportStatus,
    /** Failure reason / conflict detail; English-only (goes to log too). */
    val detail: String? = null,
)

data class MigrationSummary(
    val migrated: Int,
    val skippedEquivalent: Int,
    val skippedConflict: Int,
    val failed: Int,
    val notStarted: Int,
) {
    /**
     * Everything "not written because the target already has that name" —
     * identical content (idempotent re-run) AND differing content (S5 keep-target).
     * This is the number the widget/notification show as "跳过"; the split stays
     * per-item in the report dialog.
     */
    val skippedTotal: Int get() = skippedEquivalent + skippedConflict
}

data class MigrationReport(
    val startedAt: Long,
    val finishedAt: Long,
    val items: List<ReportItem>,
    val cancelled: Boolean,
    /** True when refreshInstance() failed after data was already written (AD8: not a migration failure). */
    val refreshFailed: Boolean,
) {
    val summary: MigrationSummary by lazy {
        MigrationSummary(
            migrated = items.count { it.status == ReportStatus.MIGRATED },
            skippedEquivalent = items.count { it.status == ReportStatus.SKIPPED_EQUIVALENT },
            skippedConflict = items.count { it.status == ReportStatus.SKIPPED_CONFLICT },
            failed = items.count { it.status == ReportStatus.FAILED },
            notStarted = items.count { it.status == ReportStatus.NOT_STARTED },
        )
    }

    /** Marker placement rule (requirements §4.1): only when nothing failed and nothing is left unstarted. */
    val allSettled: Boolean get() = summary.failed == 0 && summary.notStarted == 0
}
