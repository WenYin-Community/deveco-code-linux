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
 */
class MigrationStateStore(private val markerFile: Path) {

    data class MarkerState(
        val globalDone: Boolean,
        val projectDone: Set<String>,
        /** Projects whose prompt was dismissed ("Don't remind me"). */
        val suppressedProjects: Set<String>,
    ) {
        fun projectDone(projectId: String): Boolean = projectId in projectDone
        fun projectSuppressed(projectId: String): Boolean = projectId in suppressedProjects
    }

    private val mapper = ObjectMapper()

    fun read(): MarkerState = try {
        val root = mapper.readTree(Files.readString(markerFile))
        MarkerState(
            globalDone = root.path("global").path("completedAt").isNumber,
            projectDone = root.path("projects").fields().asSequence()
                .filter { it.value.path("completedAt").isNumber }.map { it.key }.toSet(),
            suppressedProjects = root.path("projects").fields().asSequence()
                .filter { it.value.path("suppressedAt").isNumber }
                .map { it.key }
                .toSet(),
        )
    } catch (_: Exception) {
        MarkerState(false, emptySet(), emptySet())
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
