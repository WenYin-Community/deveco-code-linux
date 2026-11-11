package org.deveco.code.migration

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Path

/**
 * Unit tests for the pure migration data model: source-presence flags,
 * report summary counting and marker placement semantics
 * ([MigrationInventory], [MigrationReport], [MigrationSummary]).
 */
class MigrationModelsTest {

    private fun inventory(
        globalSkills: List<SkillItem> = emptyList(),
        projectSkills: List<SkillItem> = emptyList(),
        globalMcps: List<McpItem> = emptyList(),
        projectMcps: List<McpItem> = emptyList(),
        mcpAuths: List<McpAuthItem> = emptyList(),
        mcpFailures: List<McpFailure> = emptyList(),
    ): MigrationInventory = MigrationInventory(
        globalSkills = globalSkills,
        projectSkills = projectSkills,
        globalMcps = globalMcps,
        projectMcps = projectMcps,
        mcpAuths = mcpAuths,
        mcpFailures = mcpFailures,
        missingScopes = emptySet(),
    )

    private fun skill(scope: MigrationScope) = SkillItem("s", Path.of("s"), Path.of("s", "SKILL.md"), "hash", scope)

    private fun mcp(scope: MigrationScope) = McpItem("m", "{}", scope)

    @Test
    fun emptyInventoryHasNeitherSource() {
        val inventory = inventory()

        assertFalse(inventory.hasGlobalSource)
        assertFalse(inventory.hasProjectSource)
    }

    @Test
    fun hasGlobalSourceCountsSkillsMcpsAuthsAndFailures() {
        assertTrue(inventory(globalSkills = listOf(skill(MigrationScope.GLOBAL))).hasGlobalSource)
        assertTrue(inventory(globalMcps = listOf(mcp(MigrationScope.GLOBAL))).hasGlobalSource)
        assertTrue(inventory(mcpAuths = listOf(McpAuthItem("a", "{}"))).hasGlobalSource)
        // P1-3: an unreadable MCP source still counts as "global source present".
        assertTrue(inventory(mcpFailures = listOf(McpFailure(null, "db unreadable"))).hasGlobalSource)
        // Project-side data alone does not make the global source present.
        assertFalse(inventory(projectSkills = listOf(skill(MigrationScope.PROJECT))).hasGlobalSource)
    }

    @Test
    fun hasProjectSourceRequiresProjectData() {
        assertTrue(inventory(projectSkills = listOf(skill(MigrationScope.PROJECT))).hasProjectSource)
        assertTrue(inventory(projectMcps = listOf(mcp(MigrationScope.PROJECT))).hasProjectSource)
        assertFalse(inventory(globalSkills = listOf(skill(MigrationScope.GLOBAL))).hasProjectSource)
    }

    @Test
    fun reportSummaryCountsAcrossStatuses() {
        val report = MigrationReport(
            startedAt = 1,
            finishedAt = 2,
            items = listOf(
                ReportItem(ConflictKind.SKILL, MigrationScope.GLOBAL, "a", ReportStatus.MIGRATED),
                ReportItem(ConflictKind.SKILL, MigrationScope.GLOBAL, "b", ReportStatus.MIGRATED),
                ReportItem(ConflictKind.SKILL, MigrationScope.PROJECT, "c", ReportStatus.SKIPPED_EQUIVALENT),
                ReportItem(ConflictKind.MCP, MigrationScope.GLOBAL, "d", ReportStatus.SKIPPED_CONFLICT),
                ReportItem(ConflictKind.MCP, MigrationScope.GLOBAL, "e", ReportStatus.FAILED, "reason"),
                ReportItem(ConflictKind.MCP, MigrationScope.GLOBAL, "f", ReportStatus.NOT_STARTED),
            ),
            cancelled = false,
            refreshFailed = false,
        )

        val summary = report.summary
        assertEquals(2, summary.migrated)
        assertEquals(1, summary.skippedEquivalent)
        assertEquals(1, summary.skippedConflict)
        assertEquals(1, summary.failed)
        assertEquals(1, summary.notStarted)
    }

    @Test
    fun skippedTotalSumsEquivalentAndConflict() {
        val summary =
            MigrationSummary(migrated = 0, skippedEquivalent = 2, skippedConflict = 3, failed = 0, notStarted = 0)

        assertEquals(5, summary.skippedTotal)
    }

    @Test
    fun allSettledRequiresZeroFailedAndZeroNotStarted() {
        fun report(vararg statuses: ReportStatus) = MigrationReport(
            startedAt = 0,
            finishedAt = 0,
            items = statuses.map { ReportItem(ConflictKind.SKILL, MigrationScope.GLOBAL, "x", it) },
            cancelled = false,
            refreshFailed = false,
        )

        assertTrue(
            report(ReportStatus.MIGRATED, ReportStatus.SKIPPED_CONFLICT, ReportStatus.SKIPPED_EQUIVALENT).allSettled,
        )
        assertFalse(report(ReportStatus.MIGRATED, ReportStatus.FAILED).allSettled)
        assertFalse(report(ReportStatus.MIGRATED, ReportStatus.NOT_STARTED).allSettled)
        assertTrue(report().allSettled)
    }

    @Test
    fun reportItemCarriesDefaultDetailAndDataClassEquality() {
        val item = ReportItem(ConflictKind.SKILL, MigrationScope.PROJECT, "name", ReportStatus.MIGRATED)

        assertEquals(null, item.detail)
        assertEquals(
            item,
            ReportItem(ConflictKind.SKILL, MigrationScope.PROJECT, "name", ReportStatus.MIGRATED),
        )
        assertFalse(
            item ==
                ReportItem(ConflictKind.SKILL, MigrationScope.PROJECT, "name", ReportStatus.MIGRATED, "detail"),
        )
    }
}
