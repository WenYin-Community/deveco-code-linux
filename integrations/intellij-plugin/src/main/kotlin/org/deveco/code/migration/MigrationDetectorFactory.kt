package org.deveco.code.migration

import org.deveco.code.acp.AcpClientService
import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.util.devecoStorageRoot
import java.nio.file.Files
import java.nio.file.Path

/** Assembles the detector from the live service, tolerating a down backend (legacy fallback). */
internal object MigrationDetectorFactory {
    fun create(service: AcpClientService, storageConfig: Path): MigrationDetector {
        val paths = runCatching { service.migrationPaths() }.getOrNull()
        val workingDir = runCatching { service.migrationWorkingDirectory() }.getOrNull()
            ?: System.getProperty("user.dir")
        val ideConfigDir = Path.of(com.intellij.openapi.application.PathManager.getConfigPath())
        return MigrationDetector(
            codegenieRoots = MigrationDetector.discoverCodegenieRoots(ideConfigDir),
            currentIdeVersionName = ideConfigDir.fileName?.toString() ?: "",
            projectBase = Path.of(workingDir),
            worktreeRoot = Path.of(paths?.worktree ?: workingDir),
            targetConfigDir = storageConfig,
            targetDataDir = devecoStorageRoot.resolve("data"),
            targetProjectConfigDir = paths?.projectConfig?.let(Path::of),
            builtinSkillNames = builtinSkillNames(service),
        )
    }

    /** D11: BUILTIN names from the backend /skill/status (empty when disconnected). */
    private fun builtinSkillNames(service: AcpClientService): Set<String> =
        runCatching { service.skillEntries() }.getOrNull()
            ?.filter { it.scope == DevEcoHttpApi.SkillScope.BUILTIN }
            ?.map { it.name }
            ?.toSet()
            ?: emptySet()

    /**
     * Deterministic project key: the sanitized worktree path. This is used for
     * MARKER file identity only (prompt visibility / suppression) — it does NOT
     * need to match the backend's projectConfig hash (which determines where
     * skills are WRITTEN during execution). Keeping the key backend-independent
     * makes the prompt instant (no HTTP round-trip) and immune to backend
     * reconnection races. Pathless projects (e.g. the default project) fall
     * back to the project NAME — otherwise every one of them would share the
     * "" key (review P3-6).
     */
    fun resolveProjectKey(project: com.intellij.openapi.project.Project): String =
        (project.basePath ?: project.name).replace(Regex("[^a-zA-Z0-9._-]"), "_")
}
