package org.deveco.code.skill

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import java.nio.file.Files
import java.nio.file.FileAlreadyExistsException
import java.nio.file.LinkOption
import java.nio.file.Path
import java.util.Properties
import org.deveco.code.MyMessageBundle
import org.deveco.code.acp.AcpClientService
import org.deveco.code.acp.DevEcoHttpApi
import org.deveco.code.session.SESSION_REFRESH_TOPIC

/**
 * Project-scoped Skill management backed by the running DevEco Code.
 *
 * Previously this stored skills in a hardcoded `Huawei/<idea.version>/Skill`
 * directory as flat `.md` files — a guessed path that the running DevEco Code
 * does not read, and a format it does not load. Skills are now resolved,
 * listed, and installed through DevEco Code itself:
 *
 * - `listAll` reads the authoritative runtime list from the DevEco Code
 *   `/skill` endpoint (each entry already reports its on-disk `location` and
 *   inferred scope).
 * - `importSkill` resolves the real global/project config directories from the
 *   DevEco Code `/path` endpoint (version-aware, decided by the running
 *   CLI), installs into `skills/<name>/SKILL.md` via `SkillInstaller`, then
 *   disposes the DevEco Code project instance so the new skill loads without a
 *   process restart.
 *
 * `enabled` is a local UI preference — DevEco Code's agent backend also
 * receives the preference via `PATCH /skill/:name` (best-effort sync to
 * `skill-preferences.json`), but the UI reads/writes local state for
 * instant feedback without depending on HTTP round-trips. Global skill
 * selection lives at the user level ([GlobalSkillStateService]); project
 * skill selection lives per-project under `.idea/deveco-skill-state.properties`;
 * built-in skills are read-only and always enabled.
 */
object SkillStore {
    private val log = Logger.getInstance(SkillStore::class.java)

    fun listAll(project: Project): List<SkillEntry> {
        val service = project.getService(AcpClientService::class.java)
        // Do NOT dispose here on every call — that re-scanned the backend on
        // each Settings open (slow, disrupts running sessions, and made
        // same-named cross-scope skills' scope oscillate). import/delete
        // already dispose; we just read /skill to a stable list (polls while
        // the post-change re-scan settles; on a plain open it's already stable).
        val backend = stableSkillEntries(service)
        // Retry skill preference PATCHes that failed earlier (e.g. right
        // after a refreshInstance, or while the backend was down) — now that
        // /skill has settled the backend has re-discovered the skills, so the
        // PATCH can finally succeed.
        syncPendingSkillPrefs(project, backend.map { it.name }.toSet())
        // DevEco Code's /skill de-duplicates skills by name across scopes,
        // preferring the built-in location: a project/global skill whose name
        // collides with a built-in is returned as built-in (built-in location)
        // and never as PROJECT/GLOBAL — so it would vanish from the Settings
        // table. Recover by also scanning the user-managed skill dirs on disk.
        val entries = backend + diskUserSkillEntries(project, service, backend)
        if (log.isDebugEnabled) {
            log.debug("listAll: backend=${backend.size} disk-merged=${entries.size} " +
                backend.joinToString { "${it.name}:${it.scope}" })
        }
        return entries
            .filter { it.scope != DevEcoHttpApi.SkillScope.BUILTIN }
            // Within-scope de-dup only: a global and a project skill may share a
            // name (cross-scope is allowed), but two skills with the same name
            // in the SAME scope are collapsed to one.
            .groupBy { it.scope to it.name }
            .map { (_, group) -> group.first() }
            .sortedWith(compareBy({ scopePriority(it.scope) }, { it.name }))
            .map { entry ->
                val type = typeOf(entry.scope)
                SkillEntry(
                    name = entry.name,
                    skillMdPath = Path.of(entry.location),
                    type = type,
                    enabled = isSkillEnabled(entry.name, type, project),
                    description = entry.description,
                )
            }
    }

    // Last known DevEco Code config dirs; cached so the skill dirs can be
    // scanned even before the ACP/HTTP bridge is connected.
    // `config` is the user-global dir (same across projects), safe to share.
    @Volatile
    private var cachedConfigPath: String? = null

    // `projectConfig` is per-project (deveco-studio: <config>/projects/<id>/.deveco;
    // CLI: <worktree>/.deveco). A single object-level cache would leak project
    // A's projectConfig into project B when B's /path lookup temporarily fails —
    // surfacing, or even deleting, A's skills from B's Settings. Keyed by the
    // project worktree path so each project keeps its own cache.
    private val cachedProjectConfigPaths = java.util.concurrent.ConcurrentHashMap<String, String>()

    private fun projectKey(project: Project): String = project.basePath ?: ""

    // Skill preference PATCHes that failed (HTTP 404 right after a
    // refreshInstance before the backend re-discovered the skill, a transient
    // 5xx, or the backend being down during apply). Retried on the next /skill
    // read (syncPendingSkillPrefs) so the backend preference doesn't stay
    // permanently out of sync with local UI state. apply() already waits for
    // re-discovery before PATCHing after a structural change, so this only
    // catches the rare residual.
    private val pendingSkillSync = java.util.concurrent.ConcurrentHashMap<String, MutableMap<String, PendingSkillPref>>()

    private data class PendingSkillPref(val type: SkillType, val enabled: Boolean)

    private fun pendingFor(project: Project): MutableMap<String, PendingSkillPref> =
        pendingSkillSync.computeIfAbsent(projectKey(project)) { java.util.concurrent.ConcurrentHashMap() }

    // Serializes all skill preference PATCHes for a project. apply()'s
    // setEnabled and the background retry (syncPendingSkillPrefs) both go
    // through this, so a retry can never overlap a new apply's PATCH on the
    // same skill — two in-flight PATCHes to the same skill could otherwise
    // reorder at the HTTP layer (Java HttpClient uses multiple connections) and
    // leave backend/local permanently out of sync. Held only across the PATCH
    // and pending bookkeeping, never across the /skill re-discovery poll, so
    // apply never blocks on a settling scan.
    private val patchLocks = java.util.concurrent.ConcurrentHashMap<String, Any>()

    private fun patchLock(project: Project): Any =
        patchLocks.computeIfAbsent(projectKey(project)) { Any() }

    /**
     * Scans the on-disk user-managed skill directories (`<config>/skills` and
     * `<worktree>/.deveco/skills`) to recover project/global skills that the
     * `/skill` endpoint shadowed behind same-named built-ins. PROJECT uses
     * `project.basePath` (no HTTP) so it works before connection; GLOBAL uses
     * the config dir from /path, falling back to a cached value.
     */
    internal fun diskUserSkillEntries(
        project: Project,
        service: AcpClientService,
        backend: List<DevEcoHttpApi.SkillEntry>,
    ): List<DevEcoHttpApi.SkillEntry> {
        val paths = runCatching { service.skillPaths() }.getOrNull()
        val key = projectKey(project)
        if (paths != null) {
            cachedConfigPath = paths.config ?: cachedConfigPath
            paths.projectConfig?.let { cachedProjectConfigPaths[key] = it }
        }
        val result = mutableListOf<DevEcoHttpApi.SkillEntry>()
        fun scan(base: String?, subPath: List<String>, scope: DevEcoHttpApi.SkillScope) {
            if (base == null) return
            var dir = java.nio.file.Path.of(base)
            for (s in subPath) dir = dir.resolve(s)
            if (!java.nio.file.Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) return
            java.nio.file.Files.list(dir).use { stream ->
                stream.filter(java.nio.file.Files::isDirectory).forEach { skillDir ->
                    val skillMd = skillDir.resolve("SKILL.md")
                    if (java.nio.file.Files.isRegularFile(skillMd, LinkOption.NOFOLLOW_LINKS)) {
                        val name = skillDir.fileName.toString()
                        val matching = backend.firstOrNull { it.name == name }
                        val desc = matching?.description ?: extractDescription(skillMd)
                        result += DevEcoHttpApi.SkillEntry(name, desc, skillMd.toString(), scope, true)
                    }
                }
            }
        }
        scan(cachedConfigPath, listOf("skills"), DevEcoHttpApi.SkillScope.GLOBAL)
        // Project skills: the backend reports projectConfig (in deveco-studio
        // mode this is <config>/projects/<id>/.deveco; in CLI mode <worktree>/.deveco).
        // Also scan the old worktree-based path for skills imported before the
        // projectConfig migration — both are de-duped by (scope, name) in listAll.
        scan(paths?.projectConfig ?: cachedProjectConfigPaths[key], listOf("skills"), DevEcoHttpApi.SkillScope.PROJECT)
        scan(paths?.worktree ?: project.basePath, listOf(".deveco", "skills"), DevEcoHttpApi.SkillScope.PROJECT)
        return result
    }

    /**
     * Reads `/skill` repeatedly until the returned `(name, scope)` set stops
     * changing (or the attempt budget runs out), so callers never see a
     * half-scanned or scope-oscillating list.
     */
    internal fun stableSkillEntries(service: AcpClientService): List<DevEcoHttpApi.SkillEntry> {
        var current = runCatching { service.skillEntries() }.getOrElse { emptyList() }
        var prevKeys = current.map { it.name to it.scope }.toSet()
        var attempts = 0
        while (attempts < 4) {
            try { Thread.sleep(200) } catch (_: InterruptedException) {}
            val next = runCatching { service.skillEntries() }.getOrElse { emptyList() }
            val nextKeys = next.map { it.name to it.scope }.toSet()
            current = next
            if (nextKeys == prevKeys) break
            prevKeys = nextKeys
            attempts++
        }
        return current
    }

    /**
     * Synchronous on-disk check for whether a skill with [name] already
     * exists in [type]'s target directory. Used at selection time so a
     * same-scope duplicate is rejected immediately (before Apply) even if the
     * async Settings reload hasn't populated `currentSkills` yet — Apply's
     * SkillInstaller would otherwise hit FileAlreadyExists and report a
     * "duplicate" error for a skill that is already on disk.
     */
    fun targetExists(name: String, type: SkillType, project: Project): Boolean {
        // PROJECT resolves from projectConfig (deveco-studio: <config>/projects/<id>/.deveco;
        // CLI: <worktree>/.deveco); GLOBAL from /path with a cached-config fallback —
        // both work before the ACP/HTTP bridge is up via cached values.
        val dir = when (type) {
            SkillType.PROJECT -> {
                val service = project.getService(AcpClientService::class.java)
                val paths = runCatching { service.skillPaths() }.getOrNull()
                val key = projectKey(project)
                if (paths != null) paths.projectConfig?.let { cachedProjectConfigPaths[key] = it }
                val projectConfig = paths?.projectConfig ?: cachedProjectConfigPaths[key]
                if (projectConfig != null) {
                    Path.of(projectConfig).resolve("skills").resolve(name)
                } else {
                    project.basePath?.let { Path.of(it).resolve(".deveco").resolve("skills").resolve(name) }
                }
            }
            SkillType.GLOBAL -> {
                val service = project.getService(AcpClientService::class.java)
                val config = runCatching { service.skillPaths() }.getOrNull()?.config
                if (config != null) cachedConfigPath = config
                (config ?: cachedConfigPath)?.let { Path.of(it).resolve("skills").resolve(name) }
            }
            SkillType.BUILTIN -> null
        } ?: return false
        return Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)
    }

    fun importSkill(file: Path, type: SkillType, project: Project, refresh: Boolean = true): ImportResult {
        val service = project.getService(AcpClientService::class.java)
        // Ensure the ACP/HTTP bridge is up so /path can resolve the skill dir;
        // otherwise users see "DevEco Code is not connected" intermittently.
        if (!service.isConnected()) service.connect()
        val paths = runCatching { service.skillPaths() }.getOrNull()
            ?: return ImportResult(ImportOutcome.IO_ERROR, "DevEco Code is not connected; open a DevEco Code session first")
        val targetBase = when (type) {
            SkillType.GLOBAL -> paths.config
            SkillType.PROJECT -> paths.projectConfig
            SkillType.BUILTIN -> return ImportResult(ImportOutcome.IO_ERROR, "Built-in skills cannot be imported")
        } ?: return ImportResult(ImportOutcome.IO_ERROR, "DevEco Code did not report its ${type.name.lowercase()} directory")
        val target = Path.of(targetBase).resolve("skills").toAbsolutePath().normalize()

        // Cross-scope duplicate detection runs at selection time (see
        // SkillSettingsConfigurable.importSkill) using the built-in + current
        // names, so by the time Apply installs the row it has already been
        // validated. SkillInstaller still guards same-scope on-disk collisions.
        val installed = try {
            SkillInstaller.install(file, target)
        } catch (e: SkillInstaller.SkillImportException) {
            return ImportResult(ImportOutcome.INVALID_CONTENT, e.message ?: "Invalid Skill")
        } catch (e: FileAlreadyExistsException) {
            return ImportResult(ImportOutcome.DUPLICATE_NAME, MyMessageBundle.message("skill.import.duplicate"))
        } catch (e: Exception) {
            log.warn("Failed to import skill", e)
            return ImportResult(ImportOutcome.IO_ERROR, MyMessageBundle.message("skill.import.error", e.message ?: e.javaClass.simpleName))
        }
        if (refresh) {
            val targets = if (type == SkillType.GLOBAL) {
                com.intellij.openapi.project.ProjectManager.getInstance().openProjects.toList()
            } else {
                listOf(project)
            }
            for (p in targets) {
                runCatching {
                    p.getService(AcpClientService::class.java)?.refreshInstance()
                    publishSkillChanged(p)
                }.onFailure { log.warn("Skill installed but instance refresh failed in ${p.name}", it) }
            }
        }
        return ImportResult(ImportOutcome.SUCCESS)
    }

    fun delete(entry: SkillEntry, project: Project, refresh: Boolean = true) {
        if (entry.type == SkillType.BUILTIN) return
        try {
            val skillDir = entry.skillMdPath.parent
            if (skillDir != null && !skillDir.endsWith("skills") && Files.isDirectory(skillDir, LinkOption.NOFOLLOW_LINKS)) {
                deleteTreeSafe(skillDir)
            } else {
                runCatching { Files.deleteIfExists(entry.skillMdPath) }.onFailure {
                    log.warn("Could not delete ${entry.skillMdPath} (locked?)", it)
                }
            }
        } catch (e: Exception) {
            log.warn("Partial delete failure for '${entry.name}'", e)
        }
        when (entry.type) {
            SkillType.PROJECT -> {
                val state = loadState(project).toMutableMap()
                state.remove(stateKey(entry.name, entry.type))
                saveState(project, state)
            }
            SkillType.GLOBAL -> GlobalSkillStateService.getInstance().remove(entry.name)
            SkillType.BUILTIN -> {}
        }
        if (refresh) {
            val targets = if (entry.type == SkillType.GLOBAL) {
                com.intellij.openapi.project.ProjectManager.getInstance().openProjects.toList()
            } else {
                listOf(project)
            }
            for (p in targets) {
                runCatching {
                    p.getService(AcpClientService::class.java)?.refreshInstance()
                    publishSkillChanged(p)
                }.onFailure { log.warn("Failed to refresh instance after deleting '${entry.name}' in ${p.name}", it) }
            }
        }
    }

    fun setEnabled(name: String, type: SkillType, enabled: Boolean, project: Project) {
        // Local state — instant, reliable, survives backend re-scan delays.
        when (type) {
            SkillType.GLOBAL -> GlobalSkillStateService.getInstance().setEnabled(name, enabled)
            SkillType.PROJECT -> {
                val state = loadState(project).toMutableMap()
                state[stateKey(name, type)] = enabled
                saveState(project, state)
            }
            SkillType.BUILTIN -> return
        }
        // Best-effort backend sync. apply() already waits for the backend to
        // re-discover skills after a structural change (stableSkillEntries)
        // before calling this, so the PATCH lands against a discovered skill
        // instead of 404ing against a half-scanned instance. A residual
        // failure (transient 5xx, backend down) is recorded for a serialized
        // retry on the next /skill read — the local state still persists, so
        // the UI is correct. The patchLock serializes this PATCH with the
        // background retry so two PATCHes for the same skill can never be
        // in-flight at once (HTTP reordering would otherwise desync
        // backend/local permanently).
        val scope = when (type) {
            SkillType.GLOBAL -> DevEcoHttpApi.SkillScope.GLOBAL
            SkillType.PROJECT -> DevEcoHttpApi.SkillScope.PROJECT
            SkillType.BUILTIN -> return
        }
        val service = project.getService(AcpClientService::class.java)
        synchronized(patchLock(project)) {
            runCatching { service.setSkillEnabled(name, scope, enabled) }
                .onSuccess { pendingFor(project).remove(name) }
                .onFailure {
                    log.warn("Backend sync failed for skill '$name'; will retry on next refresh", it)
                    pendingFor(project)[name] = PendingSkillPref(type, enabled)
                }
        }
    }

    /**
     * Retries skill preference PATCHes that previously failed (recorded by
     * [setEnabled]). Call this after a /skill read so [discoveredNames]
     * reflects skills the backend has actually loaded — retrying against a
     * not-yet-discovered skill would just 404 again. Each retry PATCH is
     * serialized with [setEnabled] under the per-project [patchLock], so a
     * background retry can never overlap a concurrent apply's PATCH on the
     * same skill (which would let the two PATCHes reorder at the HTTP layer
     * and desync backend/local). A successful PATCH clears the pending entry;
     * a failed one stays for the next refresh.
     */
    internal fun syncPendingSkillPrefs(project: Project, discoveredNames: Set<String>) {
        val pending = pendingFor(project)
        if (pending.isEmpty()) return
        val service = project.getService(AcpClientService::class.java)
        val lock = patchLock(project)
        for (name in pending.keys.toList()) {
            synchronized(lock) {
                // Re-read fresh: a concurrent setEnabled may have cleared or
                // updated this entry since the snapshot.
                val pref = pending[name] ?: return@synchronized
                if (name !in discoveredNames) return@synchronized
                val scope = when (pref.type) {
                    SkillType.GLOBAL -> DevEcoHttpApi.SkillScope.GLOBAL
                    SkillType.PROJECT -> DevEcoHttpApi.SkillScope.PROJECT
                    SkillType.BUILTIN -> { pending.remove(name); return@synchronized }
                }
                runCatching { service.setSkillEnabled(name, scope, pref.enabled) }
                    // Atomic remove only if the entry is still this pref — a
                    // concurrent setEnabled can't have changed it under the
                    // same lock, but this is cheap defense.
                    .onSuccess { pending.remove(name, pref) }
            }
        }
    }

    fun isSkillEnabled(name: String, type: SkillType, project: Project): Boolean = when (type) {
        SkillType.BUILTIN -> true
        SkillType.GLOBAL -> GlobalSkillStateService.getInstance().isEnabled(name)
        SkillType.PROJECT -> loadState(project)[stateKey(name, type)] ?: true
    }

    /**
     * Skills that should appear in the `/` invoke list: every built-in skill
     * plus user skills selected in any scope they exist in on disk.
     *
     * DevEco Code's `/skill` de-duplicates by name across scopes and returns a
     * single (non-deterministic) scope per name — so a skill the user selected
     * in the GLOBAL scope might be reported as PROJECT, and the filter would
     * look up the wrong store. We resolve selection from the on-disk truth
     * (`disk` carries every scope a user skill actually exists in) instead of
     * the backend's single scope. De-dup stays by name (one entry per name),
     * matching DevEco Code's behaviour.
     */
    internal fun filterSlashSkills(
        backend: List<DevEcoHttpApi.SkillEntry>,
        disk: List<DevEcoHttpApi.SkillEntry>,
        project: Project,
        availableCommandNames: Set<String> = emptySet(),
    ): List<DevEcoHttpApi.SkillEntry> {
        val diskNames = disk.map { it.name }.toSet()
        val builtin = backend
            .filter { it.scope == DevEcoHttpApi.SkillScope.BUILTIN }
            .map { DevEcoHttpApi.SkillEntry(it.name, it.description, "", DevEcoHttpApi.SkillScope.BUILTIN, true) }
        // User skills: from disk scan, filtered by local enabled state.
        // Only show skills the backend has loaded (in available_commands).
        val loadedNames = if (backend.isNotEmpty()) backend.map { it.name }.toSet() else availableCommandNames
        val selectedUser = disk.filter {
            it.name in loadedNames && isSkillEnabled(it.name, typeOf(it.scope), project)
        }
        val byName = (builtin + selectedUser)
            .groupBy { it.name }
            .map { (_, group) -> group.first() }
        return byName.sortedWith(compareBy({ scopePriority(it.scope) }, { it.name }))
    }

    private fun scopePriority(scope: DevEcoHttpApi.SkillScope): Int = when (scope) {
        DevEcoHttpApi.SkillScope.BUILTIN -> 0
        DevEcoHttpApi.SkillScope.GLOBAL -> 1
        DevEcoHttpApi.SkillScope.PROJECT -> 2
    }

    fun extractDescription(file: Path): String {
        return try {
            val content = Files.readString(file)
            // Prefer YAML frontmatter `description:`; fall back to the first
            // non-blank line so the table still shows something for bare .md.
            val frontmatter = parseFrontmatterDescription(content)
            if (!frontmatter.isNullOrBlank()) frontmatter else firstLine(content)
        } catch (e: Exception) {
            log.warn("Failed to extract description", e); ""
        }
    }

    private fun parseFrontmatterDescription(text: String): String? {
        val lines = text.replace("\r\n", "\n").split("\n")
        if (lines.isEmpty() || lines[0].trim() != "---") return null
        for (i in 1 until lines.size) {
            val line = lines[i]
            if (line.trim() == "---" || line.trim() == "...") break
            val m = Regex("^description\\s*:\\s*(.*)$").matchEntire(line) ?: continue
            var v = m.groupValues[1].trim()
            if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) {
                v = v.substring(1, v.length - 1)
            }
            return v
        }
        return null
    }

    private fun firstLine(text: String): String {
        for (line in text.lineSequence()) {
            val trimmed = line.trim()
            if (trimmed.isEmpty()) continue
            return trimmed.removePrefix("#").trim()
        }
        return ""
    }

    private fun typeOf(scope: DevEcoHttpApi.SkillScope): SkillType = when (scope) {
        DevEcoHttpApi.SkillScope.GLOBAL -> SkillType.GLOBAL
        DevEcoHttpApi.SkillScope.PROJECT -> SkillType.PROJECT
        DevEcoHttpApi.SkillScope.BUILTIN -> SkillType.BUILTIN
    }

    private fun stateKey(name: String, type: SkillType): String = "${type.name.lowercase()}.$name"

    private fun stateFile(project: Project): Path? {
        val base = project.basePath ?: return null
        val ideaDir = java.io.File(base, ".idea")
        if (!ideaDir.isDirectory) ideaDir.mkdirs()
        return ideaDir.toPath().resolve("deveco-skill-state.properties")
    }

    private fun loadState(project: Project): Map<String, Boolean> {
        val file = stateFile(project) ?: return emptyMap()
        val props = Properties()
        try {
            if (Files.isRegularFile(file)) Files.newInputStream(file).use { props.load(it) }
        } catch (e: Exception) {
            log.warn("Failed to load skill state", e)
        }
        return props.mapKeys { it.key.toString() }.mapValues { it.value.toString() == "true" }
    }

    private fun saveState(project: Project, state: Map<String, Boolean>) {
        val file = stateFile(project) ?: return
        try {
            Files.createDirectories(file.parent)
            val props = Properties()
            state.forEach { (k, v) -> props[k] = v.toString() }
            Files.newOutputStream(file).use { props.store(it, "Skill enabled state (UI preference)") }
        } catch (e: Exception) {
            log.warn("Failed to save skill state", e)
        }
    }

    fun notifyChanged(project: Project) {
        publishSkillChanged(project)
    }

    private fun deleteTreeSafe(root: Path) {
        Files.walkFileTree(root, object : java.nio.file.SimpleFileVisitor<Path>() {
            override fun preVisitDirectory(dir: Path, attrs: java.nio.file.attribute.BasicFileAttributes): java.nio.file.FileVisitResult {
                if (Files.isSymbolicLink(dir)) return java.nio.file.FileVisitResult.SKIP_SUBTREE
                return java.nio.file.FileVisitResult.CONTINUE
            }
            override fun visitFile(file: Path, attrs: java.nio.file.attribute.BasicFileAttributes): java.nio.file.FileVisitResult {
                if (!Files.isSymbolicLink(file)) {
                    runCatching { Files.deleteIfExists(file) }.onFailure {
                        log.warn("Could not delete $file (locked?)", it)
                    }
                }
                return java.nio.file.FileVisitResult.CONTINUE
            }
            override fun postVisitDirectory(dir: Path, exc: java.io.IOException?): java.nio.file.FileVisitResult {
                runCatching { Files.deleteIfExists(dir) }.onFailure {
                    log.warn("Could not delete $dir (locked?)", it)
                }
                return java.nio.file.FileVisitResult.CONTINUE
            }
        })
    }

    private fun publishSkillChanged(project: com.intellij.openapi.project.Project) {
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            project.messageBus.syncPublisher(SESSION_REFRESH_TOPIC).onSessionsChanged()
        }
    }
}
