package org.deveco.code.migration

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger

/**
 * Unit tests for [MigrationExecutor] with a recording [MigrationExecutor.Backend]
 * fake: skill staging-copy + ATOMIC_MOVE, idempotent re-runs, conflict/builtin
 * skipping, MCP PATCH payload + read-back verification, cancel/refresh/marker
 * semantics, staging sweep and progress determinism.
 */
class MigrationExecutorTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var sourceDir: Path
    private lateinit var targetConfigDir: Path
    private lateinit var storageRoot: Path
    private lateinit var markerFile: Path
    private lateinit var stateStore: MigrationStateStore
    private lateinit var detector: MigrationDetector

    private val projectId = "proj-key"

    @Before
    fun setUp() {
        sourceDir = tmp.root.toPath().resolve("source")
        targetConfigDir = tmp.root.toPath().resolve("target-config")
        storageRoot = tmp.root.toPath().resolve("storage")
        markerFile = storageRoot.resolve("config").resolve("codegenie-migration.json")
        stateStore = MigrationStateStore(markerFile)
        detector = MigrationDetector(
            codegenieRoots = emptyList(),
            projectBase = tmp.root.toPath(),
            worktreeRoot = tmp.root.toPath(),
            targetConfigDir = targetConfigDir,
            targetDataDir = storageRoot.resolve("data"),
            targetProjectConfigDir = tmp.root.toPath().resolve("project").resolve(".deveco"),
            builtinSkillNames = emptySet(),
        )
    }

    // ---------- fixtures ----------

    private class RecordingProgress : MigrationExecutor.Progress {
        var total = -1
        val ticks = AtomicInteger()

        override fun onTotal(total: Int) {
            this.total = total
        }

        override fun onTick() {
            ticks.incrementAndGet()
        }
    }

    /** Records every backend call and merges patches into deveco.jsonc so the
     *  executor's read-back verification sees the "written" config. */
    private class FakeBackend(private val configDir: Path, private val refreshFails: Boolean = false) :
        MigrationExecutor.Backend {
        val ensureConnectedCount = AtomicInteger()
        val globalPatches = mutableListOf<JsonObject>()
        val projectPatches = mutableListOf<JsonObject>()
        val refreshCount = AtomicInteger()
        private val mapper = ObjectMapper()

        override fun ensureConnected() {
            ensureConnectedCount.incrementAndGet()
        }

        override fun patchProjectConfig(patch: JsonObject) {
            projectPatches.add(patch)
            applyPatch(patch)
        }

        override fun patchGlobalConfig(patch: JsonObject) {
            globalPatches.add(patch)
            applyPatch(patch)
        }

        override fun refreshInstance() {
            refreshCount.incrementAndGet()
            if (refreshFails) throw IOException("refresh boom")
        }

        private fun applyPatch(patch: JsonObject) {
            val file = configDir.resolve("deveco.jsonc")
            val root = (
                if (Files.isRegularFile(
                        file,
                    )
                ) {
                    JsoncParser.readFile(file)
                } else {
                    mapper.createObjectNode()
                }
                ) as ObjectNode
            for ((key, value) in patch) {
                val jsonNode = mapper.readTree(value.toString())
                if (value is JsonObject && jsonNode.isObject) {
                    val section = root.with(key)
                    for ((innerKey, innerValue) in value) {
                        section.set<JsonNode>(innerKey, mapper.readTree(innerValue.toString()))
                    }
                } else {
                    root.set<JsonNode>(key, jsonNode)
                }
            }
            Files.createDirectories(configDir)
            mapper.writerWithDefaultPrettyPrinter().writeValue(file.toFile(), root)
        }
    }

    private fun writeSourceSkill(dirName: String, body: String, extraFile: String? = null): SkillItem {
        val skillDir = sourceDir.resolve(dirName)
        Files.createDirectories(skillDir)
        val manifest = skillDir.resolve("SKILL.md")
        val content = "---\nname: $dirName\n---\n$body"
        Files.writeString(manifest, content, StandardCharsets.UTF_8)
        if (extraFile != null) {
            Files.writeString(skillDir.resolve(extraFile), "extra content")
        }
        return SkillItem(dirName, skillDir, manifest, sha256Hex(manifest), MigrationScope.GLOBAL)
    }

    private fun inventory(
        globalSkills: List<SkillItem> = emptyList(),
        projectSkills: List<SkillItem> = emptyList(),
        globalMcps: List<McpItem> = emptyList(),
        mcpFailures: List<McpFailure> = emptyList(),
    ): MigrationInventory = MigrationInventory(
        globalSkills = globalSkills,
        projectSkills = projectSkills,
        globalMcps = globalMcps,
        projectMcps = emptyList(),
        mcpAuths = emptyList(),
        mcpFailures = mcpFailures,
        missingScopes = emptySet(),
    )

    private fun execute(
        backend: FakeBackend,
        inventory: MigrationInventory,
        progress: RecordingProgress = RecordingProgress(),
        cancel: MigrationExecutor.CancelToken = MigrationExecutor.CancelToken(),
    ): MigrationReport = MigrationExecutor(detector, stateStore, projectId, backend, storageRoot)
        .execute(inventory, progress, cancel)

    private fun sha256Hex(file: Path): String {
        val digest = MessageDigest.getInstance("SHA-256")
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

    private fun globalSkillTarget(name: String): Path = targetConfigDir.resolve("skills").resolve(name)

    private fun writeTargetSkill(name: String, body: String) {
        val dir = globalSkillTarget(name)
        Files.createDirectories(dir)
        Files.writeString(dir.resolve("SKILL.md"), "---\nname: $name\n---\n$body")
    }

    // ---------- skills ----------

    @Test
    fun migratesGlobalSkillToTargetAndWritesMarker() {
        val skill = writeSourceSkill("my-skill", "original body", extraFile = "extra.md")
        val backend = FakeBackend(targetConfigDir)

        val report = execute(backend, inventory(globalSkills = listOf(skill)))

        assertEquals(ReportStatus.MIGRATED, report.items.single().status)
        val manifest = globalSkillTarget("my-skill").resolve("SKILL.md")
        val copied = Files.readString(manifest)
        assertTrue(copied.contains("original body"))
        assertTrue(Files.isRegularFile(globalSkillTarget("my-skill").resolve("extra.md")))
        assertTrue(stateStore.read().globalDone)
        assertEquals(1, backend.ensureConnectedCount.get())
        assertEquals(1, backend.refreshCount.get())
        assertFalse(report.refreshFailed)
    }

    @Test
    fun rerunIsIdempotentAndSkipsEquivalent() {
        val skill = writeSourceSkill("my-skill", "stable body")
        val backend = FakeBackend(targetConfigDir)
        execute(backend, inventory(globalSkills = listOf(skill)))

        val second = execute(FakeBackend(targetConfigDir), inventory(globalSkills = listOf(skill)))

        assertEquals(ReportStatus.SKIPPED_EQUIVALENT, second.items.single().status)
        assertEquals(
            "stable body",
            Files.readString(globalSkillTarget("my-skill").resolve("SKILL.md")).substringAfter("\n---\n"),
        )
        assertTrue(stateStore.read().globalDone)
    }

    @Test
    fun conflictingTargetSkillIsKeptAndReportedAsConflict() {
        writeTargetSkill("my-skill", "existing target body")
        val skill = writeSourceSkill("my-skill", "source body")
        val backend = FakeBackend(targetConfigDir)

        val report = execute(backend, inventory(globalSkills = listOf(skill)))

        assertEquals(ReportStatus.SKIPPED_CONFLICT, report.items.single().status)
        assertTrue(Files.readString(globalSkillTarget("my-skill").resolve("SKILL.md")).contains("existing target body"))
        // A settled conflict still writes the scope marker.
        assertTrue(stateStore.read().globalDone)
    }

    @Test
    fun skillShadowingABuiltinIsSkipped() {
        val skill = writeSourceSkill("builtin-skill", "source body")
        detector = MigrationDetector(
            codegenieRoots = emptyList(),
            projectBase = tmp.root.toPath(),
            worktreeRoot = tmp.root.toPath(),
            targetConfigDir = targetConfigDir,
            targetDataDir = storageRoot.resolve("data"),
            targetProjectConfigDir = tmp.root.toPath().resolve("project").resolve(".deveco"),
            builtinSkillNames = setOf("builtin-skill"),
        )

        val report = execute(FakeBackend(targetConfigDir), inventory(globalSkills = listOf(skill)))

        assertEquals(ReportStatus.SKIPPED_CONFLICT, report.items.single().status)
        assertFalse(Files.exists(globalSkillTarget("builtin-skill")))
    }

    @Test
    fun unsafeSkillNameFailsAndBlocksTheMarker() {
        val skillDir = sourceDir.resolve("unsafe")
        Files.createDirectories(skillDir)
        val manifest = skillDir.resolve("SKILL.md")
        Files.writeString(manifest, "---\nname: ../escape\n---\nbody")
        val unsafe = SkillItem("../escape", skillDir, manifest, sha256Hex(manifest), MigrationScope.GLOBAL)

        val report = execute(FakeBackend(targetConfigDir), inventory(globalSkills = listOf(unsafe)))

        assertEquals(ReportStatus.FAILED, report.items.single().status)
        assertTrue(report.items.single().detail!!.contains("not a safe directory name"))
        assertFalse(stateStore.read().globalDone)
    }

    @Test
    fun anonymousSkillNameFailsUnderTheSourceDirectoryName() {
        val skillDir = sourceDir.resolve("broken-skill")
        Files.createDirectories(skillDir)
        val manifest = skillDir.resolve("SKILL.md")
        Files.writeString(manifest, "no frontmatter at all")
        val anonymous = SkillItem(null, skillDir, manifest, sha256Hex(manifest), MigrationScope.GLOBAL)

        val report = execute(FakeBackend(targetConfigDir), inventory(globalSkills = listOf(anonymous)))

        val item = report.items.single()
        assertEquals(ReportStatus.FAILED, item.status)
        assertEquals("broken-skill", item.name)
        assertTrue(item.detail!!.contains("invalid frontmatter"))
        assertFalse(stateStore.read().globalDone)
    }

    @Test
    fun skillCopyExcludesTheGitDirectory() {
        val skill = writeSourceSkill("cloned-skill", "body")
        val gitDir = skill.sourceDir.resolve(".git")
        Files.createDirectories(gitDir)
        Files.writeString(gitDir.resolve("config"), "[core]")

        val report = execute(FakeBackend(targetConfigDir), inventory(globalSkills = listOf(skill)))

        assertEquals(ReportStatus.MIGRATED, report.items.single().status)
        assertFalse(Files.exists(globalSkillTarget("cloned-skill").resolve(".git")))
    }

    @Test
    fun projectSkillMigratesIntoTheProjectConfigDirAndMarksProjectScope() {
        val skillDir = sourceDir.resolve("proj-skill")
        Files.createDirectories(skillDir)
        val manifest = skillDir.resolve("SKILL.md")
        Files.writeString(manifest, "---\nname: proj-skill\n---\nproject body")
        val projectSkill = SkillItem("proj-skill", skillDir, manifest, sha256Hex(manifest), MigrationScope.PROJECT)

        val report = execute(FakeBackend(targetConfigDir), inventory(projectSkills = listOf(projectSkill)))

        assertEquals(ReportStatus.MIGRATED, report.items.single().status)
        val projectSkills = tmp.root.toPath().resolve(
            "project",
        ).resolve(".deveco").resolve("skills").resolve("proj-skill")
        assertTrue(Files.readString(projectSkills.resolve("SKILL.md")).contains("project body"))
        val state = stateStore.read()
        assertTrue(state.projectDone(projectId))
        assertFalse(state.globalDone)
    }

    // ---------- MCP ----------

    @Test
    fun migratesGlobalMcpViaBackendPatchWithVerifiedReadBack() {
        val configJson = """{"type":"local","command":["npx","mcp-server-fetch"]}"""
        val mcp = McpItem("fetch", configJson, MigrationScope.GLOBAL)
        val backend = FakeBackend(targetConfigDir)

        val report = execute(backend, inventory(globalMcps = listOf(mcp)))

        assertEquals(ReportStatus.MIGRATED, report.items.single().status)
        val patch = backend.globalPatches.single()
        assertEquals(setOf("mcp"), patch.keys)
        val entry = (patch["mcp"] as JsonObject)["fetch"] as JsonObject
        assertEquals("local", (entry["type"] as kotlinx.serialization.json.JsonPrimitive).content)
        assertTrue(backend.projectPatches.isEmpty())
        // The payload the backend received is exactly the target-side entry.
        assertEquals(
            ObjectMapper().readTree(configJson),
            JsoncParser.readFile(targetConfigDir.resolve("deveco.jsonc")).path("mcp").path("fetch"),
        )
        assertTrue(stateStore.read().globalDone)
    }

    @Test
    fun mcpCarryingEnvironmentGetsThePlaintextSecretsHint() {
        val configJson = """{"type":"local","command":["npx","x"],"environment":{"TOKEN":"v"}}"""
        val mcp = McpItem("secret-srv", configJson, MigrationScope.GLOBAL)

        val report = execute(FakeBackend(targetConfigDir), inventory(globalMcps = listOf(mcp)))

        assertNotNull(report.items.single().detail)
    }

    @Test
    fun equivalentMcpIsSkippedWithoutPatching() {
        val configJson = """{"type":"remote","url":"https://x"}"""
        Files.createDirectories(targetConfigDir)
        Files.writeString(
            targetConfigDir.resolve("deveco.jsonc"),
            """{"mcp":{"srv":{"type":"remote","url":"https://x"}}}""",
        )
        val mcp = McpItem("srv", configJson, MigrationScope.GLOBAL)
        val backend = FakeBackend(targetConfigDir)

        val report = execute(backend, inventory(globalMcps = listOf(mcp)))

        assertEquals(ReportStatus.SKIPPED_EQUIVALENT, report.items.single().status)
        assertTrue(backend.globalPatches.isEmpty())
    }

    @Test
    fun conflictingMcpIsSkippedAndTargetIsKept() {
        Files.createDirectories(targetConfigDir)
        Files.writeString(
            targetConfigDir.resolve("deveco.jsonc"),
            """{"mcp":{"srv":{"type":"remote","url":"https://existing"}}}""",
        )
        val mcp = McpItem("srv", """{"type":"remote","url":"https://source"}""", MigrationScope.GLOBAL)
        val backend = FakeBackend(targetConfigDir)

        val report = execute(backend, inventory(globalMcps = listOf(mcp)))

        assertEquals(ReportStatus.SKIPPED_CONFLICT, report.items.single().status)
        assertTrue(backend.globalPatches.isEmpty())
        assertTrue(
            JsoncParser.readFile(targetConfigDir.resolve("deveco.jsonc"))
                .path("mcp").path("srv").path("url").asText() == "https://existing",
        )
    }

    @Test
    fun mcpFailureBecomesAFailedReportItemAndBlocksTheMarker() {
        val failure = McpFailure("broken-srv", "decrypt/convert failed: bad tag")

        val report = execute(FakeBackend(targetConfigDir), inventory(mcpFailures = listOf(failure)))

        val item = report.items.single()
        assertEquals(ReportStatus.FAILED, item.status)
        assertEquals(ConflictKind.MCP, item.kind)
        assertEquals("broken-srv", item.name)
        assertTrue(item.detail!!.contains("decrypt/convert failed"))
        assertFalse(stateStore.read().globalDone)
    }

    // ---------- pipeline behavior ----------

    @Test
    fun cancelledRunMarksRemainingItemsNotStartedAndWritesNoMarker() {
        val skill = writeSourceSkill("my-skill", "body")
        val cancel = MigrationExecutor.CancelToken()
        cancel.cancelled = true
        val progress = RecordingProgress()

        val report = execute(FakeBackend(targetConfigDir), inventory(globalSkills = listOf(skill)), progress, cancel)

        assertEquals(ReportStatus.NOT_STARTED, report.items.single().status)
        assertTrue(report.cancelled)
        assertFalse(Files.exists(globalSkillTarget("my-skill")))
        assertFalse(stateStore.read().globalDone)
        // Progress total is known upfront (N/M determinism); no tick for a
        // never-started item.
        assertEquals(1, progress.total)
        assertEquals(0, progress.ticks.get())
    }

    @Test
    fun refreshFailureSetsTheFlagButStillWritesMarkers() {
        val skill = writeSourceSkill("my-skill", "body")
        val backend = FakeBackend(targetConfigDir, refreshFails = true)

        val report = execute(backend, inventory(globalSkills = listOf(skill)))

        assertTrue(report.refreshFailed)
        assertEquals(ReportStatus.MIGRATED, report.items.single().status)
        assertTrue(stateStore.read().globalDone)
    }

    @Test
    fun progressTotalAndTicksMatchExecutedItems() {
        val skill1 = writeSourceSkill("skill-a", "body a")
        val skill2 = writeSourceSkill("skill-b", "body b")
        val mcp = McpItem("srv", """{"type":"remote","url":"https://x"}""", MigrationScope.GLOBAL)
        val progress = RecordingProgress()

        val report = execute(
            FakeBackend(targetConfigDir),
            inventory(globalSkills = listOf(skill1, skill2), globalMcps = listOf(mcp)),
            progress,
        )

        assertEquals(3, progress.total)
        assertEquals(3, progress.ticks.get())
        assertEquals(3, report.items.size)
    }

    @Test
    fun reportItemsFollowThePipelineOrderFailuresSkillsThenMcps() {
        val skill = writeSourceSkill("my-skill", "body")
        val mcp = McpItem("srv", """{"type":"remote","url":"https://x"}""", MigrationScope.GLOBAL)
        val failure = McpFailure("bad-srv", "unreadable")

        val report = execute(
            FakeBackend(targetConfigDir),
            inventory(globalSkills = listOf(skill), globalMcps = listOf(mcp), mcpFailures = listOf(failure)),
        )

        assertEquals(
            listOf(ConflictKind.MCP, ConflictKind.SKILL, ConflictKind.MCP),
            report.items.map { it.kind },
        )
        assertEquals(
            listOf(ReportStatus.FAILED, ReportStatus.MIGRATED, ReportStatus.MIGRATED),
            report.items.map { it.status },
        )
    }

    // ---------- crash hygiene ----------

    @Test
    fun sweepsOrphanSkillStagingAndLegacyMcpAuthTempFiles() {
        val orphan = targetConfigDir.resolve("skills").resolve(".my-skill.migrate-abc")
        Files.createDirectories(orphan)
        Files.writeString(orphan.resolve("SKILL.md"), "leftover")
        val legacyTmp = storageRoot.resolve("data").resolve("mcp-auth-1.tmp")
        Files.createDirectories(legacyTmp.parent)
        Files.writeString(legacyTmp, "leftover")

        val report = execute(FakeBackend(targetConfigDir), inventory())

        assertFalse(Files.exists(orphan))
        assertFalse(Files.exists(legacyTmp))
        assertTrue(report.items.isEmpty())
        // An empty inventory settles no scope: no marker is written.
        assertFalse(stateStore.read().globalDone)
    }
}
