package org.deveco.code.skill

import com.intellij.openapi.application.ApplicationManager
import com.intellij.serviceContainer.ComponentManagerImpl
import com.intellij.testFramework.LightPlatformTestCase
import org.deveco.code.acp.AcpClientService
import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.acp.SharedAcpBackend
import java.nio.file.Files
import java.nio.file.Path

/**
 * Platform-fixture unit tests for [SkillStore] against a disconnected backend:
 * SKILL.md description extraction, the local enabled-state stores (built-in
 * always on; project state in `.idea/deveco-skill-state.properties`; global
 * state in the user-level [GlobalSkillStateService]), deletion of project
 * skills, the on-disk project-skill directory scan, and the `/` invoke list
 * filter. HTTP-coupled paths (listAll/importSkill) are covered by the
 * backend integration, not here.
 */
class SkillStoreTest : LightPlatformTestCase() {

    private lateinit var service: AcpClientService

    override fun setUp() {
        super.setUp()
        val project = getProject()
        Files.deleteIfExists(Path.of(project.basePath!!, ".idea", "deveco-skill-state.properties"))
        (ApplicationManager.getApplication() as ComponentManagerImpl).replaceServiceInstance(
            SharedAcpBackend::class.java,
            SharedAcpBackend(),
            testRootDisposable,
        )
        // The test platform does not load plugin.xml's descriptor-registered
        // services, so the user-level global skill state service must be
        // registered explicitly.
        (ApplicationManager.getApplication() as ComponentManagerImpl).replaceServiceInstance(
            GlobalSkillStateService::class.java,
            GlobalSkillStateService(),
            testRootDisposable,
        )
        service = AcpClientService(project)
        (project as ComponentManagerImpl).replaceServiceInstance(
            AcpClientService::class.java,
            service,
            testRootDisposable,
        )
    }

    private fun writeSkill(dir: String, name: String, manifest: String, projectDir: String = ".deveco/skills"): Path {
        val skillDir = Path.of(getProject().basePath!!, projectDir, name)
        Files.createDirectories(skillDir)
        val skillMd = skillDir.resolve("SKILL.md")
        Files.writeString(skillMd, manifest)
        return skillMd
    }

    private fun entry(
        name: String,
        scope: DevEcoHttpApi.SkillScope,
        location: String = "memory://$name",
        description: String = "desc of $name",
    ) = DevEcoHttpApi.SkillEntry(name, description, location, scope, true)

    // --- extractDescription ---

    fun testExtractDescriptionPrefersFrontmatter() {
        val file = writeSkill("extract", "e1", "---\nname: e1\ndescription: Frontmatter wins\n---\n\n# Heading\n")

        assertEquals("Frontmatter wins", SkillStore.extractDescription(file))
    }

    fun testExtractDescriptionUnquotesAndFallsBackToFirstLine() {
        val quoted = writeSkill("extract", "e2", "---\ndescription: 'single quoted'\n---\n\nbody\n")
        val bare = writeSkill("extract", "e3", "# First heading\nSome body text.\n")

        assertEquals("single quoted", SkillStore.extractDescription(quoted))
        assertEquals("First heading", SkillStore.extractDescription(bare))
    }

    fun testExtractDescriptionOfEmptyFileIsEmpty() {
        val file = writeSkill("extract", "e4", "")

        assertEquals("", SkillStore.extractDescription(file))
    }

    // --- enabled state ---

    fun testBuiltinSkillIsAlwaysEnabled() {
        assertTrue(SkillStore.isSkillEnabled("never-configured", SkillType.BUILTIN, getProject()))
    }

    fun testProjectSkillEnabledStatePersistsInPropertiesFile() {
        val stateFile = Path.of(getProject().basePath!!, ".idea", "deveco-skill-state.properties")

        SkillStore.setEnabled("proj-persist", SkillType.PROJECT, false, getProject())

        assertTrue(Files.isRegularFile(stateFile))
        assertFalse(SkillStore.isSkillEnabled("proj-persist", SkillType.PROJECT, getProject()))

        SkillStore.setEnabled("proj-persist", SkillType.PROJECT, true, getProject())

        assertTrue(SkillStore.isSkillEnabled("proj-persist", SkillType.PROJECT, getProject()))
    }

    fun testGlobalSkillEnabledStateLivesAtUserLevel() {
        SkillStore.setEnabled("glob-user-level", SkillType.GLOBAL, false, getProject())

        assertFalse(SkillStore.isSkillEnabled("glob-user-level", SkillType.GLOBAL, getProject()))
        assertFalse(GlobalSkillStateService.getInstance().isEnabled("glob-user-level"))

        GlobalSkillStateService.getInstance().remove("glob-user-level")

        // No entry means the default: enabled.
        assertTrue(SkillStore.isSkillEnabled("glob-user-level", SkillType.GLOBAL, getProject()))
    }

    // --- delete ---

    fun testDeleteRemovesProjectSkillDirectoryAndState() {
        val skillMd = writeSkill("delete", "del-me", "---\nname: del-me\ndescription: x\n---\n\nbody\n")
        SkillStore.setEnabled("del-me", SkillType.PROJECT, false, getProject())
        val doomed = SkillEntry("del-me", skillMd, SkillType.PROJECT, false, "x")

        SkillStore.delete(doomed, getProject(), refresh = false)

        assertFalse(Files.exists(skillMd.parent))
        assertTrue(SkillStore.isSkillEnabled("del-me", SkillType.PROJECT, getProject()))
    }

    fun testDeleteIgnoresBuiltinSkills() {
        val skillMd = writeSkill("delete", "builtin-keep", "body")
        val builtin = SkillEntry("builtin-keep", skillMd, SkillType.BUILTIN, true, "x")

        SkillStore.delete(builtin, getProject(), refresh = false)

        assertTrue(Files.isRegularFile(skillMd))
    }

    // --- targetExists / disk scan ---

    fun testTargetExistsChecksTheProjectSkillDirectory() {
        writeSkill("target", "exists-on-disk", "body")

        assertTrue(SkillStore.targetExists("exists-on-disk", SkillType.PROJECT, getProject()))
        assertFalse(SkillStore.targetExists("missing-on-disk", SkillType.PROJECT, getProject()))
    }

    fun testDiskUserSkillEntriesScanProjectSkillDir() {
        val skillMd = writeSkill(
            "scan",
            "scan-me",
            "---\nname: scan-me\ndescription: Scanned skill\n---\n\nbody\n",
        )

        val entries = SkillStore.diskUserSkillEntries(getProject(), service, emptyList())

        val scanned = entries.firstOrNull { it.name == "scan-me" }
        assertNotNull(scanned)
        assertEquals(DevEcoHttpApi.SkillScope.PROJECT, scanned!!.scope)
        assertEquals(skillMd, Path.of(scanned.location))
        assertEquals("Scanned skill", scanned.description)
    }

    // --- filterSlashSkills ---

    fun testFilterSlashSkillsKeepsBuiltinsAndLoadedSelectedUserSkills() {
        val builtin = entry("b-keep", DevEcoHttpApi.SkillScope.BUILTIN)
        val backendUser = entry("u-loaded", DevEcoHttpApi.SkillScope.PROJECT)
        val diskUser = entry("u-loaded", DevEcoHttpApi.SkillScope.PROJECT, location = "disk://u-loaded")

        val kept = SkillStore.filterSlashSkills(listOf(builtin, backendUser), listOf(diskUser), getProject())

        assertEquals(listOf("b-keep", "u-loaded"), kept.map { it.name })
        assertEquals(DevEcoHttpApi.SkillScope.BUILTIN, kept[0].scope)
    }

    fun testFilterSlashSkillsDropsUnloadedOrDisabledUserSkills() {
        val loadedButDisabled = entry("u-off", DevEcoHttpApi.SkillScope.PROJECT)
        SkillStore.setEnabled("u-off", SkillType.PROJECT, false, getProject())
        val notLoaded = entry("u-ghost", DevEcoHttpApi.SkillScope.PROJECT)

        val kept = SkillStore.filterSlashSkills(
            backend = listOf(loadedButDisabled),
            disk = listOf(
                entry("u-off", DevEcoHttpApi.SkillScope.PROJECT, location = "disk://u-off"),
                notLoaded,
            ),
            project = getProject(),
        )

        assertTrue(kept.none { it.name == "u-off" || it.name == "u-ghost" })
    }

    fun testFilterSlashSkillsDeduplicatesByNamePreferringBuiltin() {
        val builtin = entry("dup", DevEcoHttpApi.SkillScope.BUILTIN)
        val projectCopy = entry("dup", DevEcoHttpApi.SkillScope.PROJECT, location = "disk://dup")

        val kept = SkillStore.filterSlashSkills(listOf(builtin), listOf(projectCopy), getProject())

        assertEquals(1, kept.size)
        assertEquals(DevEcoHttpApi.SkillScope.BUILTIN, kept.single().scope)
    }
}
