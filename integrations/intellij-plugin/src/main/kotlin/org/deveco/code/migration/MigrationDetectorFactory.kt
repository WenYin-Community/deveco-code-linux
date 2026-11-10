package org.deveco.code.migration

import com.intellij.openapi.application.PathManager
import org.deveco.code.acp.AcpClientService
import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.util.devecoStorageRoot
import java.nio.file.Path

/** Assembles the detector from the live service, tolerating a down backend (legacy fallback). */
internal object MigrationDetectorFactory {
    fun create(service: AcpClientService, storageConfig: Path): MigrationDetector {
        val paths = runCatching { service.migrationPaths() }.getOrNull()
        val workingDir = runCatching { service.migrationWorkingDirectory() }.getOrNull()
            ?: System.getProperty("user.dir")
        val ideConfigDir = Path.of(PathManager.getConfigPath())
        return MigrationDetector(
            codegenieRoots = MigrationDetector.discoverCodegenieRoots(ideConfigDir),
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
     * Running IDE's own version-dir name ("26.1" for .../DevEcoStudio26.1), or
     * null when the config path carries no version component (it points at the
     * "Huawei" vendor root, or names something other than DevEcoStudio*). Null
     * means "unknown current version": callers must fail safe toward
     * ANNOTATING origins, never suppressing them.
     */
    fun currentVersionName(): String? = versionNameOf(Path.of(PathManager.getConfigPath()))

    /**
     * CURRENT-IDE side of the version comparison (config dir → bare version).
     * Deliberately NOT shared with MigrationDetector.rootVersion, which walks
     * the opposite direction (origin root → bare version) and keeps a raw name
     * for non-DevEcoStudio* roots instead of yielding null.
     */
    private fun versionNameOf(ideConfigDir: Path): String? {
        val name = ideConfigDir.fileName?.toString() ?: return null
        if (name == "Huawei") return null
        return name.removePrefix("DevEcoStudio").takeIf { it != name }
    }

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
