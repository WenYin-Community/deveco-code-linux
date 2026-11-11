package org.deveco.code.migration

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files
import java.nio.file.Path

/**
 * Unit tests for [MigrationStateStore]: marker-file round trips, the
 * project-scoped "Don't remind me" suppression (gates the WHOLE prompt for
 * that project), corruption self-healing and the shouldShowPrompt formula.
 */
class MigrationStateStoreTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun store(): MigrationStateStore = MigrationStateStore(markerFile())

    private fun markerFile(): Path = tmp.root.toPath().resolve("config").resolve("codegenie-migration.json")

    private fun globalSource(): MigrationInventory = MigrationInventory(
        globalSkills = emptyList(),
        projectSkills = emptyList(),
        globalMcps = listOf(McpItem("srv", "{}", MigrationScope.GLOBAL)),
        projectMcps = emptyList(),
        mcpAuths = emptyList(),
        mcpFailures = emptyList(),
        missingScopes = emptySet(),
    )

    private fun projectSource(): MigrationInventory = MigrationInventory(
        globalSkills = emptyList(),
        projectSkills = listOf(
            SkillItem("p", tmp.root.toPath(), tmp.root.toPath(), "hash", MigrationScope.PROJECT),
        ),
        globalMcps = emptyList(),
        projectMcps = emptyList(),
        mcpAuths = emptyList(),
        mcpFailures = emptyList(),
        missingScopes = emptySet(),
    )

    private fun emptySource(): MigrationInventory = MigrationInventory(
        globalSkills = emptyList(),
        projectSkills = emptyList(),
        globalMcps = emptyList(),
        projectMcps = emptyList(),
        mcpAuths = emptyList(),
        mcpFailures = emptyList(),
        missingScopes = emptySet(),
    )

    @Test
    fun readAbsentMarkerYieldsDefaults() {
        val state = store().read()

        assertFalse(state.globalDone)
        assertTrue(state.projectDone.isEmpty())
        assertTrue(state.suppressedProjects.isEmpty())
    }

    @Test
    fun markGlobalAndProjectDoneRoundTrip() {
        val store = store()

        store.markGlobalDone()
        store.markProjectDone("proj-1")
        store.markProjectDone("proj-2")

        val state = store.read()
        assertTrue(state.globalDone)
        assertEquals(setOf("proj-1", "proj-2"), state.projectDone)
        assertTrue(state.projectDone("proj-1"))
        assertTrue(state.suppressedProjects.isEmpty())
    }

    @Test
    fun deletingMarkerResetsState() {
        val store = store()
        store.markGlobalDone()
        store.markProjectDone("proj-1")
        assertTrue(store.read().globalDone)

        Files.delete(markerFile())

        val state = store().read()
        assertFalse(state.globalDone)
        assertTrue(state.projectDone.isEmpty())
    }

    @Test
    fun corruptMarkerSelfHealsToDefaultsAndIsRewritten() {
        Files.createDirectories(markerFile().parent)
        Files.writeString(markerFile(), "{ this is not json")
        val store = store()

        val state = store.read()

        assertFalse(state.globalDone)
        assertTrue(state.projectDone.isEmpty())
        assertTrue(state.suppressedProjects.isEmpty())
        // The next mutation rewrites a valid marker over the corrupt bytes.
        store.markGlobalDone()
        assertTrue(store().read().globalDone)
    }

    @Test
    fun setSuppressionPersistsPerProject() {
        val store = store()

        store.setSuppression("proj-1")

        val state = store.read()
        assertTrue(state.projectSuppressed("proj-1"))
        assertFalse(state.projectSuppressed("proj-2"))
    }

    @Test
    fun shouldShowPromptTrueWhileGlobalSourcePending() {
        val store = store()

        assertTrue(store.shouldShowPrompt(globalSource(), "proj-1"))

        store.markGlobalDone()
        assertFalse(store.shouldShowPrompt(globalSource(), "proj-1"))
    }

    @Test
    fun shouldShowPromptTrueWhileProjectSourcePending() {
        val store = store()

        assertTrue(store.shouldShowPrompt(projectSource(), "proj-1"))

        store.markProjectDone("proj-1")
        assertFalse(store.shouldShowPrompt(projectSource(), "proj-1"))
        // Other projects still see their own pending project source.
        assertTrue(store.shouldShowPrompt(projectSource(), "proj-2"))
    }

    @Test
    fun suppressionHidesWholePromptIncludingGlobalPart() {
        val store = store()
        store.setSuppression("proj-1")

        // AD9: suppressed in this project -> the whole prompt stays hidden,
        // even while global work is still pending.
        assertFalse(store.shouldShowPrompt(globalSource(), "proj-1"))
        // Other projects keep surfacing the global work.
        assertTrue(store.shouldShowPrompt(globalSource(), "proj-2"))
    }

    @Test
    fun shouldShowPromptFalseWithoutAnySource() {
        assertFalse(store().shouldShowPrompt(emptySource(), "proj-1"))
    }
}
