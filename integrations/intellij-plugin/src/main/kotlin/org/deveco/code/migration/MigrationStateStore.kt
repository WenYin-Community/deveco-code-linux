package org.deveco.code.migration

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import java.nio.channels.FileChannel
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

/**
 * Reads/writes the migration marker file
 * `<storageRoot>/config/codegenie-migration.json` (functional-design §2.2).
 *
 * Corruption self-heals: any read failure is treated as "nothing marked"
 * (requirements §4.1) — the prompt re-appears, a re-run is fully idempotent,
 * and the marker gets rewritten.
 *
 * Suppression ("Don't remind me") is PROJECT-scoped (v3.2): it hides the
 * WHOLE prompt in that project — global part included (review P1-2) — while
 * other projects keep surfacing global work. Reset = delete the marker file
 * (documented in README).
 *
 * Besides the done/suppressed markers above, the file carries failure
 * markers (`failedAt`, R5): the prompt bar labels its action "Retry
 * Migration" while the previous run has unsettled items, including after the
 * tool window was rebuilt.
 */
class MigrationStateStore(private val markerFile: Path) {

    data class MarkerState(
        val globalDone: Boolean,
        val projectDone: Set<String>,
        /** Projects whose prompt was dismissed ("Don't remind me"). */
        val suppressedProjects: Set<String>,
        /** The GLOBAL scope was left unsettled by the last finished run (R5). */
        val globalFailed: Boolean,
        /** Projects whose last finished run left project-scope items unsettled (R5). */
        val failedProjects: Set<String>,
    ) {
        fun projectDone(projectId: String): Boolean = projectId in projectDone
        fun projectSuppressed(projectId: String): Boolean = projectId in suppressedProjects

        /**
         * Retry-label rule (R5): the prompt bar offers "Retry Migration"
         * instead of "Start Migration" while the last finished run still has
         * unsettled items. A DONE scope wins over a stale failure marker —
         * "忽略失败项" in the report dialog writes the done marker without
         * clearing the failure one, and done must not resurrect the retry
         * label (the user explicitly dismissed those items).
         */
        fun retryNeeded(projectId: String): Boolean = (!globalDone && globalFailed) ||
            (!projectDone(projectId) && projectId in failedProjects)
    }

    private val mapper = ObjectMapper()

    fun read(): MarkerState = try {
        val root = mapper.readTree(Files.readString(markerFile))
        // Every field goes through .path(...): markers written by an older
        // plugin version carry no failedAt at all and must degrade to
        // "nothing failed", never throw (same tolerance as completedAt).
        MarkerState(
            globalDone = root.path("global").path("completedAt").isNumber,
            projectDone = root.path("projects").fields().asSequence()
                .filter { it.value.path("completedAt").isNumber }.map { it.key }.toSet(),
            suppressedProjects = root.path("projects").fields().asSequence()
                .filter { it.value.path("suppressedAt").isNumber }
                .map { it.key }
                .toSet(),
            globalFailed = root.path("global").path("failedAt").isNumber,
            failedProjects = root.path("projects").fields().asSequence()
                .filter { it.value.path("failedAt").isNumber }
                .map { it.key }
                .toSet(),
        )
    } catch (_: Exception) {
        MarkerState(false, emptySet(), emptySet(), false, emptySet())
    }

    /**
     * Prompt visibility (requirements §5.1; AD9 bracket semantics):
     * show = ((globalPending || projectPending) && !suppressed(projectId)).
     *
     * Suppression is stored per project but gates the WHOLE prompt for that
     * project — global part included (AD9: "全局源存在且抑制时不显示"). The
     * earlier v3.1 implementation gated only the project part, which made the
     * "Don't remind" click a visible no-op whenever global work was pending
     * (e.g. one permanently-failing source item keeping globalDone unset):
     * the bar reappeared on the next recomposition (sidebar collapse/expand
     * recreates the tool window and re-runs this formula). Other projects
     * keep their own suppression state and still surface global work.
     */
    fun shouldShowPrompt(inventory: MigrationInventory, projectId: String): Boolean {
        val state = read()
        if (state.projectSuppressed(projectId)) return false
        val globalPending = inventory.hasGlobalSource && !state.globalDone
        val projectPending = inventory.hasProjectSource && !state.projectDone(projectId)
        return globalPending || projectPending
    }

    /** Zero-failure completion (requirements §4.1). */
    fun markGlobalDone() {
        mutate { root ->
            root.with("global").put("completedAt", System.currentTimeMillis())
        }
    }

    fun markProjectDone(projectId: String) {
        mutate { root ->
            root.with("projects").with(projectId).put("completedAt", System.currentTimeMillis())
        }
    }

    /**
     * Failure marker (R5): the last finished run left items unsettled, so the
     * prompt bar keeps offering "Retry Migration" after the tool window is
     * rebuilt — the in-memory [MigrationReport] is long gone by then.
     *
     * Purely additive: [clearFailed] is the only thing that drops a marker
     * (a run that never touched a scope must not silently un-flag it).
     *
     * [global] marks the GLOBAL scope too. A global failure is not
     * project-specific, so every open project's bar shows the retry label —
     * the retry re-runs the same global work.
     */
    fun markFailed(projectId: String, global: Boolean) {
        mutate { root ->
            val now = System.currentTimeMillis()
            root.with("projects").with(projectId).put("failedAt", now)
            if (global) root.with("global").put("failedAt", now)
        }
    }

    /**
     * Drops the failure markers after a run in which everything settled (R5).
     * BOTH scopes are cleared: [MigrationReport.allSettled] is a statement
     * about the whole report, so no stale global/scoped failure survives it.
     * Lookups are read-only here — clearing must not create empty nodes.
     */
    fun clearFailed(projectId: String) {
        mutate { root ->
            (root.get("projects") as? ObjectNode)?.let { projects ->
                (projects.get(projectId) as? ObjectNode)?.remove("failedAt")
            }
            (root.get("global") as? ObjectNode)?.remove("failedAt")
        }
    }

    /** Project-scoped suppression (v3.2): permanently hides the prompt for this project. */
    fun setSuppression(projectId: String) {
        mutate { root ->
            root.with("projects").with(projectId).put("suppressedAt", System.currentTimeMillis())
        }
    }

    // ---------- internal ----------

    /** Gets or creates a child object node under [field]. */
    private fun ObjectNode.with(field: String): ObjectNode {
        val existing = get(field)
        if (existing is ObjectNode) return existing
        val created = mapper.createObjectNode()
        set<ObjectNode>(field, created)
        return created
    }

    private fun mutate(body: (ObjectNode) -> Unit) {
        // Cross-process read-modify-write exclusion (review P2-3): the marker
        // is written from two sides — migration completion (writeMarkers) and
        // "Don't remind me" (setSuppression) — potentially from different IDE
        // windows; a plain RMW loses one side's update. An OS-level exclusive
        // lock on a sibling .lock file serializes the whole section and
        // auto-releases on JVM crash. (writeMarkers already runs under the
        // FlockKit migration lock; lock ordering is always migration-lock ->
        // marker-lock, so no deadlock.)
        Files.createDirectories(markerFile.parent)
        val lockFile = markerFile.resolveSibling(markerFile.fileName.toString() + ".lock")
        FileChannel.open(lockFile, StandardOpenOption.CREATE, StandardOpenOption.WRITE).use { channel ->
            channel.lock().use {
                val root = try {
                    mapper.readTree(Files.readString(markerFile)) as? ObjectNode ?: mapper.createObjectNode()
                } catch (_: Exception) {
                    mapper.createObjectNode()
                }
                if (!root.has("version")) root.put("version", 1)
                body(root)
                // Atomic write: temp + rename (non-functional requirements — never a torn JSON).
                val tmp = Files.createTempFile(markerFile.parent, "codegenie-migration", ".tmp")
                try {
                    Files.writeString(tmp, mapper.writerWithDefaultPrettyPrinter().writeValueAsString(root))
                    try {
                        Files.move(tmp, markerFile, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                    } catch (_: AtomicMoveNotSupportedException) {
                        Files.move(tmp, markerFile, StandardCopyOption.REPLACE_EXISTING)
                    }
                } finally {
                    Files.deleteIfExists(tmp)
                }
            }
        }
    }
}
