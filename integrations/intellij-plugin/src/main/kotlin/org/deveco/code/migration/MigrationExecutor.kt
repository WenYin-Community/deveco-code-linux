package org.deveco.code.migration

import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.UUID

/**
 * Executes the migration item by item (functional-design §3.2 pipeline):
 * skills -> project MCP -> global MCP -> refresh -> verify -> marker.
 * (mcp-auth stage removed: the old plugin has no such source — RESERVED.)
 *
 * Every item is atomic (staging dir + ATOMIC_MOVE for skills, temp+rename for
 * mcp-auth); each item checks the cancel token first, so a cancel finishes only
 * the in-flight item (S7). A crash simply leaves the marker unset — the next
 * run re-detects and skips everything already migrated (S3 idempotence).
 */
class MigrationExecutor(
    private val detector: MigrationDetector,
    private val stateStore: MigrationStateStore,
    private val projectId: String,
    /** HTTP façade; every non-null call throws on failure. */
    private val backend: Backend,
    private val storageRoot: Path,
) {

    private val LOG = com.intellij.openapi.diagnostic.Logger.getInstance("deveco-migration")

    /** Narrow seam implemented by the UI layer over DevEcoHttpApi — keeps this class IDE-free. */
    interface Backend {
        fun ensureConnected()
        fun patchProjectConfig(patch: kotlinx.serialization.json.JsonObject)
        fun patchGlobalConfig(patch: kotlinx.serialization.json.JsonObject)
        fun refreshInstance()
    }

    interface Progress {
        fun onTotal(total: Int)
        fun onTick()
    }

    class CancelToken {
        @Volatile var cancelled: Boolean = false
    }

    fun execute(
        inventory: MigrationInventory,
        progress: Progress,
        cancel: CancelToken,
    ): MigrationReport {
        val startedAt = System.currentTimeMillis()
        backend.ensureConnected()

        val locksDir = storageRoot.resolve("state").resolve("locks")
        // One lock for the whole migration run (multi-window mutual exclusion, §4).
        return FlockKit.withLock(locksDir, "codegenie-migration") {
            sweepOrphanStaging()
            runPipeline(inventory, progress, cancel, startedAt)
        }
    }

    private fun runPipeline(
        inventory: MigrationInventory,
        progress: Progress,
        cancel: CancelToken,
        startedAt: Long,
    ): MigrationReport {
        // Item model: every atomic unit is a () -> ReportItem; total is known upfront (N/M determinism).
        val items = buildItems(inventory)
        progress.onTotal(items.size)

        val results = mutableListOf<ReportItem>()
        for (item in items) {
            if (cancel.cancelled) {
                results.add(ReportItem(item.kind, item.scope, item.name, ReportStatus.NOT_STARTED))
                continue
            }
            results.add(executeGuarded(item))
            progress.onTick()
        }

        val report = MigrationReport(
            startedAt = startedAt,
            finishedAt = System.currentTimeMillis(),
            items = results,
            cancelled = cancel.cancelled,
            refreshFailed = false,
        )

        // refreshInstance lets the backend rescan; failure is a warning, not a
        // migration failure (AD8) — data is already on disk and the marker must
        // still be placed so the prompt disappears (review D3).
        var refreshed = report
        try {
            backend.refreshInstance()
        } catch (_: Exception) {
            refreshed = report.copy(refreshFailed = true)
        }
        try {
            writeMarkers(refreshed)
        } catch (e: Exception) {
            // The marker is an optimization, not a correctness requirement
            // (S3 idempotence): losing it just re-shows the prompt and the
            // next run re-skips everything. Never let it discard the report
            // (review P0-1).
            LOG.warn("codegenie migration: failed to write migration marker: ${e.message}")
        }
        return refreshed
    }

    // ---------- item construction ----------

    private class Pending(
        val kind: ConflictKind,
        val scope: MigrationScope,
        val name: String,
        val run: () -> Outcome,
    )

    /** One item's outcome; successes may carry a note for the report detail column. */
    private class Outcome(val status: ReportStatus, val detail: String? = null)

    private fun buildItems(inventory: MigrationInventory): List<Pending> = buildList {
        // Source-read failures (review P1-3) become FAILED items: they block
        // the GLOBAL marker (retryable after the source is fixed) and appear
        // in the report by name instead of vanishing into a log line.
        inventory.mcpFailures.forEach { failure ->
            add(
                Pending(ConflictKind.MCP, MigrationScope.GLOBAL, failure.name ?: "-") {
                    throw IOException(failure.reason)
                },
            )
        }
        inventory.globalSkills.forEach { add(skillPending(it)) }
        inventory.projectSkills.forEach { add(skillPending(it)) }
        inventory.globalMcps.forEach { add(mcpPending(it)) }
        inventory.projectMcps.forEach { add(mcpPending(it)) }
    }

    private fun executeGuarded(item: Pending): ReportItem = try {
        val outcome = item.run()
        ReportItem(item.kind, item.scope, item.name, outcome.status, outcome.detail)
    } catch (e: Exception) {
        ReportItem(item.kind, item.scope, item.name, ReportStatus.FAILED, e.message ?: e.javaClass.simpleName)
    }

    // ---------- skill items (T2.2) ----------

    private fun skillPending(skill: SkillItem): Pending {
        val name = skill.name
        val kind = ConflictKind.SKILL
        // Anonymous name means broken frontmatter — cannot be placed, fail fast.
        if (name == null) {
            return Pending(kind, skill.scope, skill.sourceDir.fileName.toString()) {
                throw IOException("SKILL.md has invalid frontmatter (missing name)")
            }
        }
        // Reject path-shaped names before they escape the skills root (S2).
        if (name.contains('/') || name.contains('\\') || name == ".." || name == ".") {
            return Pending(kind, skill.scope, name) {
                throw IOException("Skill name is not a safe directory name: $name")
            }
        }
        // D11/S5 (review P1-1): a source skill shadowing a BUILTIN is skipped
        // (keep-builtin) — copying it would silently override the built-in at
        // load time. Checked here, at execution time, because the detector
        // used by the executor is built AFTER the backend connects and so
        // actually has the BUILTIN list (the prompt-time detector may not).
        if (name != null && detector.isBuiltinSkill(name)) {
            return Pending(kind, skill.scope, name) { Outcome(ReportStatus.SKIPPED_CONFLICT) }
        }
        return Pending(kind, skill.scope, name) { Outcome(migrateSkill(skill, name)) }
    }

    /** Staging + ATOMIC_MOVE mirrors SkillInstaller.install (AD7 naming). */
    private fun migrateSkill(skill: SkillItem, name: String): ReportStatus {
        val targetRoot = detector.skillTargetDir(skill.scope)
            ?: throw IOException("Target skill directory unavailable for scope ${skill.scope}")
        val targetDir = targetRoot.resolve(name)
        val targetManifest = targetDir.resolve("SKILL.md")

        if (Files.isRegularFile(targetManifest)) {
            // S3 equivalence: same SKILL.md hash => already migrated.
            if (sha256(targetManifest) == skill.skillMdSha256) return ReportStatus.SKIPPED_EQUIVALENT
            // S5 conflict default: keep DevEco Code's existing data.
            return ReportStatus.SKIPPED_CONFLICT
        }

        Files.createDirectories(targetRoot)
        // Own staging prefix (review P2-1): the backend's SkillInstaller uses
        // `.<name>.import-<uuid>` for user installs; sharing it meant the
        // orphan sweep could delete a concurrently installing skill's staging.
        val staging = targetRoot.resolve(".$name.migrate-${UUID.randomUUID()}")
        try {
            copyTree(skill.sourceDir, staging)
            try {
                Files.move(staging, targetDir, StandardCopyOption.ATOMIC_MOVE)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(staging, targetDir)
            }
        } finally {
            deleteTree(staging)
        }

        // Post-write verification (design §6): hash must match or the item failed.
        if (sha256(targetManifest) != skill.skillMdSha256) {
            throw IOException("Verification failed: SKILL.md hash mismatch after copy")
        }
        return ReportStatus.MIGRATED
    }

    // ---------- MCP items (T2.3, AD2 dual-endpoint routing) ----------

    private fun mcpPending(mcp: McpItem): Pending =
        Pending(ConflictKind.MCP, mcp.scope, mcp.name) { migrateMcp(mcp) }

    private fun migrateMcp(mcp: McpItem): Outcome {
        // Re-check the live target before PATCHing: Config.update mergeDeep would
        // partially overwrite a same-name entry, breaking S2 add-only semantics.
        val target = detector.targetMcpEntry(mcp.scope, mcp.name)
        if (target != null) {
            return if (detector.jsonEquivalent(target, mcp.configJson)) {
                Outcome(ReportStatus.SKIPPED_EQUIVALENT)
            } else {
                Outcome(ReportStatus.SKIPPED_CONFLICT)
            }
        }
        // Build the payload with kotlinx.serialization so names containing quotes
        // stay valid JSON (S1).
        val entry = kotlinx.serialization.json.Json.parseToJsonElement(mcp.configJson)
        val payload = kotlinx.serialization.json.buildJsonObject {
            put("mcp", kotlinx.serialization.json.buildJsonObject { put(mcp.name, entry) })
        }
        when (mcp.scope) {
            MigrationScope.PROJECT -> backend.patchProjectConfig(payload)
            MigrationScope.GLOBAL -> backend.patchGlobalConfig(payload)
        }
        // Read-back verification (review P2-2): the Flock excludes other
        // MIGRATIONS only — the backend can concurrently merge a same-name
        // entry the re-check just missed (e.g. the MCP settings page). If the
        // resulting entry differs from what we intended, add-only was broken:
        // surface a failure instead of trusting the 2xx.
        val after = detector.targetMcpEntry(mcp.scope, mcp.name)
        if (after == null || !detector.jsonEquivalent(after, mcp.configJson)) {
            throw IOException("concurrent modification: target mcp entry '${mcp.name}' differs from the migrated value")
        }
        // Plaintext-storage hint (user decision 2026-09-09): the new backend
        // stores MCP config as plaintext JSONC (0600; credentials live in the
        // separate encrypted token.dek). Entries carrying env vars or request
        // headers — the fields that CAN hold credentials — get a note in the
        // report so the user can verify nothing sensitive was written.
        val carriesSecrets = (entry as? kotlinx.serialization.json.JsonObject)
            ?.let { it.containsKey("environment") || it.containsKey("headers") } == true
        return Outcome(
            ReportStatus.MIGRATED,
            if (carriesSecrets) org.deveco.code.MyMessageBundle.message("migration.report.hint.plaintextSecrets") else null,
        )
    }

    // ---------- marker placement (requirements §4.1) ----------

    private fun writeMarkers(report: MigrationReport) {
        val globalItems = report.items.filter { it.scope == MigrationScope.GLOBAL }
        val projectItems = report.items.filter { it.scope == MigrationScope.PROJECT }

        // Marker per scope only when that scope fully settled (zero failed,
        // zero not-started). Unsettled scopes write nothing: the prompt stays
        // and the next run is a fully idempotent retry (P3-7 removed the
        // failure-list persistence — the report dialog carries the details).
        if (globalItems.isNotEmpty() && globalItems.all { it.status != ReportStatus.FAILED && it.status != ReportStatus.NOT_STARTED }) {
            stateStore.markGlobalDone()
        }
        if (projectItems.isNotEmpty() && projectItems.all { it.status != ReportStatus.FAILED && it.status != ReportStatus.NOT_STARTED }) {
            stateStore.markProjectDone(projectId)
        }
    }

    // ---------- crash hygiene (S7) ----------

    /** Removes staging leftovers from an interrupted run: `.*.migrate-*` skill
     *  dirs (own prefix — see migrateSkill, review P2-1) and mcp-auth `*.tmp`
     *  files (design §3.2, review D9). */
    private fun sweepOrphanStaging() {
        for (root in listOfNotNull(
                detector.skillTargetDir(MigrationScope.GLOBAL),
                detector.skillTargetDir(MigrationScope.PROJECT),
            )) {
            if (!Files.isDirectory(root)) continue
            try {
                Files.newDirectoryStream(root, ".*.migrate-*").use { stream ->
                    stream.forEach { dir -> if (Files.isDirectory(dir)) deleteTree(dir) }
                }
            } catch (_: IOException) {
                // best effort — a busy directory just keeps its leftovers until next run
            }
        }
        // RESERVED: mcp-auth staging no longer has a producer (old plugin has no
        // mcp-auth.json); the sweep stays as crash hygiene for any legacy leftovers.
        val dataDir = storageRoot.resolve("data")
        if (Files.isDirectory(dataDir)) {
            try {
                Files.newDirectoryStream(dataDir, "mcp-auth*.tmp").use { stream ->
                    stream.forEach { Files.deleteIfExists(it) }
                }
            } catch (_: IOException) {
            }
        }
    }

    // ---------- fs helpers ----------

    private fun sha256(file: Path): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        Files.newInputStream(file).use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun copyTree(source: Path, destination: Path) {
        Files.walkFileTree(source, object : java.nio.file.SimpleFileVisitor<Path>() {
            override fun preVisitDirectory(dir: Path, attrs: java.nio.file.attribute.BasicFileAttributes): java.nio.file.FileVisitResult {
                // Old-plugin project skills were installed via git clone and carry a
                // .git directory — exclude it from the copy (harmless but dirty).
                if (dir.fileName?.toString() == ".git") return java.nio.file.FileVisitResult.SKIP_SUBTREE
                Files.createDirectories(destination.resolve(source.relativize(dir)))
                return java.nio.file.FileVisitResult.CONTINUE
            }

            override fun visitFile(file: Path, attrs: java.nio.file.attribute.BasicFileAttributes): java.nio.file.FileVisitResult {
                Files.copy(file, destination.resolve(source.relativize(file)), StandardCopyOption.COPY_ATTRIBUTES)
                return java.nio.file.FileVisitResult.CONTINUE
            }
        })
    }

    private fun deleteTree(root: Path) {
        if (!Files.exists(root)) return
        try {
            Files.walk(root).use { paths ->
                for (path in paths.sorted(Comparator.reverseOrder())) Files.deleteIfExists(path)
            }
        } catch (_: IOException) {
        }
    }
}
