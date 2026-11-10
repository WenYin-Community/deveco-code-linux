package org.deveco.code.migration

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest

/**
 * Detects old-CodeGenie-plugin user data and builds the migration inventory.
 *
 * Source model (verified against real user data on 2026-09-08, requirements §3.1):
 *  - Global skills:  <ideConfig>/Huawei/DevEcoStudio&#42;/codegenie/skills/<name>/SKILL.md
 *    (multiple versioned roots may coexist — e.g. DevEcoStudio6.1 and 26.0; the
 *    newest root carrying skills wins)
 *  - Project skills: <worktree-up>/.codegenie/skills/<name>/SKILL.md
 *  - Global MCP:     Model_Management.db → mcp_config(server_name, info) where
 *    info is AES-GCM hex encrypted with the local material key (CodeGenieKeyStore);
 *    DB lives at <codegenie-root>/<userHash>/<projectHash>/<accountHash>/ — multiple
 *    DBs are merged by server_name (latest created_time wins); across versioned
 *    roots the newest one whose DBs carry rows (or fail to read) wins, and
 *    zero-row roots fall through to older ones
 *  - There is NO project-level MCP and NO mcp-auth.json in the old plugin.
 *
 * Detection is read-only and must never create files (S4).
 */
class MigrationDetector(
    /** CodeGenie plugin roots, e.g. <ideConfig>/Huawei/DevEcoStudio26.0/codegenie — newest-first. */
    private val codegenieRoots: List<Path>,
    /** Open project directory (worktree search start for .codegenie sources). */
    private val projectBase: Path,
    /** Worktree root (search stop boundary). */
    private val worktreeRoot: Path,
    /** DevEco Code target config dir (<storageRoot>/config). */
    private val targetConfigDir: Path,
    /** DevEco Code target data dir (<storageRoot>/data) — reserved, unused now. */
    private val targetDataDir: Path,
    /** Project config dir reported by the backend (studio mode projects/<id>/.deveco). */
    private val targetProjectConfigDir: Path?,
    /** BUILTIN skill names (D11): same-name sources shadow built-ins and conflict (S5). */
    private val builtinSkillNames: Set<String> = emptySet(),
) {

    fun detect(): MigrationInventory {
        val globalSkills = scanGlobalSkills()
        val (globalMcps, mcpFailures) = readGlobalMcps()
        val projectSourceDir = findProjectSourceDir()
        val projectSkills: List<SkillItem> =
            if (projectSourceDir != null) scanSkillRoots(projectSourceDir, MigrationScope.PROJECT) else emptyList()

        // Source versions (方案 B): which codegenie root carried each data
        // kind? The pick is per kind and newest-first, so skills and MCP can
        // come from different versions — record both so the prompt bar can
        // name each accurately instead of collapsing them into one value
        // that hides the other's origin. The value is the bare version
        // number ("6.1", not "DevEcoStudio6.1"); the i18n template adds the
        // "DevEco Studio" prefix. This is the RAW origin, not a display
        // decision: the rendering layer decides whether to annotate it at
        // all (a version matching the running IDE's is not annotated on its
        // own, but it still appears in the paired "both" template when the
        // other kind is foreign).
        // MCP counts as sourced only when its root actually contributed
        // items or failures; a root chosen just because DB files exist
        // (zero rows, zero failures) contributes nothing to annotate.
        val skillsSourceVersion = rootVersion(globalSkillsRoot)
        val mcpSourceVersion = if (globalMcps.isEmpty() && mcpFailures.isEmpty()) null else rootVersion(mcpsRoot)

        val missing = mutableSetOf<MigrationScope>()
        // P1-3: unreadable MCP sources are NOT "absent" — mcpFailures keeps the
        // GLOBAL scope present so the failures surface as report items instead
        // of the scope settling as done.
        if (globalSkills.isEmpty() && globalMcps.isEmpty() && mcpFailures.isEmpty()) missing.add(MigrationScope.GLOBAL)
        if (projectSkills.isEmpty()) missing.add(MigrationScope.PROJECT)

        return MigrationInventory(
            globalSkills = globalSkills,
            projectSkills = projectSkills,
            globalMcps = globalMcps,
            projectMcps = emptyList(), // old plugin has no project-level MCP
            mcpAuths = emptyList(),    // old plugin has no mcp-auth.json
            mcpFailures = mcpFailures,
            missingScopes = missing,
            skillsSourceVersion = skillsSourceVersion,
            mcpSourceVersion = mcpSourceVersion,
        )
    }

    /** Root that provided global skills (set by scanGlobalSkills, newest-first wins). */
    private var globalSkillsRoot: Path? = null
    /** Root that provided global MCP data (set by readGlobalMcps, newest-first wins). */
    private var mcpsRoot: Path? = null

    /**
     * ORIGIN side of the version comparison (codegenie root → bare version).
     * Deliberately NOT shared with MigrationDetectorFactory.versionNameOf,
     * which walks the opposite direction (current config dir → version name)
     * and yields null for non-DevEcoStudio* dirs; here a raw name is kept so an
     * oddly named origin still annotates instead of silently dropping out.
     */
    private fun rootVersion(root: Path?): String? = root?.parent?.fileName?.toString()?.removePrefix("DevEcoStudio")

    // ---------- global roots ----------

    /** Versioned roots newest-first: prefer the latest DevEcoStudio* that has skills. */
    private fun scanGlobalSkills(): List<SkillItem> {
        for (root in codegenieRoots) {
            val skills = scanSkillRoots(root, MigrationScope.GLOBAL)
            if (skills.isNotEmpty()) {
                globalSkillsRoot = root
                return skills
            }
        }
        return emptyList()
    }

    /**
     * Newest-first root scan: a root "carries" the MCP data only when its
     * DBs actually contribute items or read failures; only then does it
     * claim [mcpsRoot] and stop the scan. A root with merely zero-row DBs
     * (the user never configured MCP in that version — the common
     * Beta-trial case, verified on real machines) falls through to older
     * roots that do hold config.
     * Trade-off vs review D3: a user who DELETED every server in the newer
     * version also leaves zero rows, so the older root's servers resurface —
     * accepted because silently losing the older config was worse, and the
     * prompt now annotates the MCP source version, making the origin visible
     * and declinable. Cross-root MERGING stays forbidden (D3): once the
     * newest root does carry data it wins alone, so servers deleted there
     * stay deleted. A key-derivation failure on a root WITH databases still
     * must NOT fall back (P3-2) — it surfaces as a failure instead, because
     * the unreadable root may hold the user's newest state.
     * Within the winning root, multiple DBs (user/project/account hashes)
     * merge by server_name with latest created_time winning.
     *
     * Returns items plus read failures (P1-3) — "could not read" must never
     * masquerade as "nothing to migrate".
     */
    private fun readGlobalMcps(): Pair<List<McpItem>, List<McpFailure>> {
        for (root in codegenieRoots) {
            val dbs = listModelDbs(root)
            if (dbs.isEmpty()) continue
            val dataKey = try {
                CodeGenieKeyStore.deriveDataKey(root.resolve("material"))
            } catch (e: Exception) {
                // Never silent: the failure blocks the GLOBAL marker (P1-3)
                // instead of silently skipping every MCP entry — and blocks
                // the fallback too: the unreadable root may be the newest state.
                mcpsRoot = root
                LOG.warn("codegenie migration: key derivation failed for ${root.fileName}: ${e.javaClass.simpleName}: ${e.message}")
                return emptyList<McpItem>() to listOf(
                    McpFailure(null, "MCP key derivation failed for ${root.fileName}: ${e.message}"),
                )
            }
            val (items, failures) = readMcpsFrom(dbs, dataKey)
            if (items.isNotEmpty() || failures.isNotEmpty()) {
                mcpsRoot = root
                return items to failures
            }
            // Zero rows and zero failures: this root holds no MCP config —
            // keep scanning older roots instead of shadowing their data.
        }
        return emptyList<McpItem>() to emptyList<McpFailure>()
    }

    private fun readMcpsFrom(dbs: List<Path>, dataKey: ByteArray): Pair<List<McpItem>, List<McpFailure>> {
        val failures = mutableListOf<McpFailure>()
        // Merge by server_name, latest created_time wins (multi-project/account DBs).
        // Deterministic order (P3-1): Files.list order is filesystem-dependent;
        // sorted paths make equal created_time ties resolve identically every run.
        val latest = LinkedHashMap<String, Pair<String, String>>()
        for (db in dbs.sortedBy { it.toString() }) {
            val rows = try {
                readMcpRows(db)
            } catch (e: Exception) {
                // Database-level failure (P1-3): unreadable DB means unknown
                // servers — record the failure and continue with the rest.
                LOG.warn("codegenie migration: ${e.message}")
                failures += McpFailure(null, e.message ?: "unreadable database ${db.fileName}")
                continue
            }
            rows.forEach { (name, created, infoHex) ->
                val existing = latest[name]
                if (existing == null || newerTime(created, existing.first)) latest[name] = created to infoHex
            }
        }
        val items = mutableListOf<McpItem>()
        for ((name, entry) in latest) {
            try {
                items += convertMcpConfig(name, entry.second, dataKey)
            } catch (e: Exception) {
                failures += McpFailure(name, "decrypt/convert failed: ${e.message}")
            }
        }
        // D4 observability with the correct denominator (P3-12): unique server
        // names, not raw rows — merged duplicates across DBs are not failures.
        if (items.size < latest.size) {
            LOG.warn("codegenie migration: ${items.size} of ${latest.size} MCP entries converted (${latest.size - items.size} failed decrypt/convert)")
        }
        return items to failures
    }

    /** created_time may be an epoch number (text) or a timestamp string;
     *  numeric text would misorder under lexicographic comparison (P3-1). */
    private fun newerTime(candidate: String, incumbent: String): Boolean {
        val a = candidate.toLongOrNull()
        val b = incumbent.toLongOrNull()
        return if (a != null && b != null) a > b else candidate > incumbent
    }

    /** <codegenie>/<userHash>/<projectHash>/<accountHash>/Model_Management.db. Fail-soft per directory (D5). */
    private fun listModelDbs(root: Path): List<Path> {
        if (!Files.isDirectory(root)) return emptyList()
        val result = mutableListOf<Path>()
        // Each level is independently guarded so one unreadable directory never
        // aborts the whole detection (review D5).
        runCatching {
            Files.list(root).use { users ->
                users.filter(Files::isDirectory).forEach { user ->
                    runCatching {
                        Files.list(user).use { projects ->
                            projects.filter(Files::isDirectory).forEach { project ->
                                runCatching {
                                    Files.list(project).use { accounts ->
                                        accounts.filter(Files::isDirectory).forEach { account ->
                                            val db = account.resolve("Model_Management.db")
                                            if (Files.isRegularFile(db)) result.add(db)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return result
    }

    private fun readMcpRows(db: Path): List<Triple<String, String, String>> = try {
        // Read-only open (S4: detection must never create files — a read-write
        // handle could create -wal/-shm or trigger journal recovery writes).
        // toUri() percent-encodes spaces in "Application Support".
        // NOTE: connect through the Driver instance directly. DriverManager only
        // ServiceLoader-scans the system classpath — inside the IntelliJ plugin
        // classloader it throws "No suitable driver" (verified against a real
        // install; the standalone JVM probe masked this).
        val url = "jdbc:sqlite:${db.toUri()}?mode=ro"
        org.sqlite.JDBC.createConnection(url, java.util.Properties()).use { conn ->
            conn.createStatement().use { stmt ->
                stmt.executeQuery("SELECT server_name, created_time, info FROM mcp_config").use { rs ->
                    buildList {
                        while (rs.next()) {
                            val name = rs.getString(1) ?: continue
                            val created = rs.getString(2) ?: ""
                            val info = rs.getString(3) ?: continue
                            add(Triple(name, created, info))
                        }
                    }
                }
            }
        }
    } catch (e: Exception) {
        // Throws instead of returning empty (P1-3): an unreadable DB held
        // UNKNOWN servers — "no rows" would let the scope settle as done.
        throw IOException("unreadable database ${db.fileName}: ${e.javaClass.simpleName}: ${e.message}")
    }

    /**
     * Old format (verified samples): `{"command":"npx","args":[...],"type":"stdio"}`.
     * New format (ConfigMCPV1): `{type:"local", command:[command, *args]}`.
     * Remote/http variants map to `{type:"remote", url}` when present.
     *
     * Throws on any failure (P1-3) — the caller turns it into a named FAILED
     * report item; failures are never silently dropped.
     */
    internal fun convertMcpConfig(name: String, infoHex: String, dataKey: ByteArray): McpItem {
        val json = String(CodeGenieKeyStore.decryptInfo(dataKey, infoHex), Charsets.UTF_8)
        val source = MAPPER.readTree(json)
        val converted: ObjectNode = when {
            source.has("url") -> MAPPER.createObjectNode().apply {
                put("type", "remote")
                put("url", source.path("url").asText())
                source.path("headers").takeIf { it.isObject }?.let { set<ObjectNode>("headers", it) }
            }
            source.has("command") -> {
                // D6: a JSON null command must not become the literal string "null".
                val commandNode = source.path("command")
                if (!commandNode.isTextual || commandNode.asText().isBlank()) {
                    throw IOException("command is not a non-empty string")
                }
                MAPPER.createObjectNode().apply {
                    put("type", "local")
                    val command = MAPPER.createArrayNode()
                    command.add(commandNode.asText())
                    source.path("args").takeIf { it.isArray }?.forEach { arg ->
                        if (arg.isTextual) command.add(arg)
                    }
                    set<ObjectNode>("command", command)
                    source.path("env").takeIf { it.isObject }?.let { set<ObjectNode>("environment", it) }
                }
            }
            else -> throw IOException("unrecognized MCP config shape (no url/command)")
        }
        return McpItem(name, converted.toString(), MigrationScope.GLOBAL)
    }

    // ---------- project sources ----------

    private fun findProjectSourceDir(): Path? {
        var current = projectBase.toAbsolutePath().normalize()
        val stop = worktreeRoot.toAbsolutePath().normalize()
        while (true) {
            val candidate = current.resolve(".codegenie")
            if (Files.isDirectory(candidate)) return candidate
            if (current == stop || current.parent == null) return null
            current = current.parent
        }
    }

    // ---------- skill scanning (old plugin layout: codegenie/skills/<name>/SKILL.md) ----------

    private fun scanSkillRoots(root: Path, scope: MigrationScope): List<SkillItem> {
        val result = mutableListOf<SkillItem>()
        val skillsDir = root.resolve("skills")
        if (!Files.isDirectory(skillsDir)) return result
        // Fail-soft per manifest AND per root (D10/review P2-5): a manifest that
        // becomes unreadable (deleted mid-walk, permissions, I/O error) is
        // skipped with a warning — one bad file must not abort detection and
        // hide the prompt for the whole session.
        try {
            Files.walk(skillsDir, 6).use { stream ->
                stream.filter { Files.isRegularFile(it) && it.fileName.toString() == "SKILL.md" }.forEach { manifest ->
                    runCatching { result.add(skillItem(manifest, scope)) }
                        .onFailure {
                            LOG.warn(
                                "codegenie migration: skipping unreadable skill manifest ${manifest.parent.fileName}: ${it.message}",
                            )
                        }
                }
            }
        } catch (_: java.io.UncheckedIOException) {
        }
        return result
    }

    private fun skillItem(manifest: Path, scope: MigrationScope): SkillItem = SkillItem(
        name = frontmatterName(manifest),
        sourceDir = manifest.parent,
        skillMdPath = manifest,
        skillMdSha256 = sha256(manifest),
        scope = scope,
    )

    // ---------- target-side queries ----------

    fun skillTargetDir(scope: MigrationScope): Path? = when (scope) {
        MigrationScope.GLOBAL -> targetConfigDir.resolve("skills")
        MigrationScope.PROJECT -> targetProjectConfigDir?.resolve("skills")
    }

    /** S5/D11 (review P1-1): a source skill shadowing a BUILTIN must be
     *  skipped — the executor consults this before copying. */
    fun isBuiltinSkill(name: String): Boolean = name in builtinSkillNames

    /** Target-side mcp entry for [name], or null when absent. Executor re-checks before PATCHing. */
    fun targetMcpEntry(scope: MigrationScope, name: String): JsonNode? {
        if (scope != MigrationScope.GLOBAL) return null // only global MCP exists now
        val section = readMcpSection(targetGlobalConfigFile()) ?: return null
        val entry = section.path(name)
        return if (entry.isMissingNode) null else entry
    }

    fun jsonEquivalent(target: JsonNode, sourceJson: String): Boolean {
        val source = try {
            MAPPER.readTree(sourceJson)
        } catch (_: Exception) {
            return false
        }
        return target == source
    }

    private fun targetGlobalConfigFile(): Path {
        for (name in listOf("deveco.jsonc", "deveco.json")) {
            val file = targetConfigDir.resolve(name)
            if (Files.isRegularFile(file)) return file
        }
        return targetConfigDir.resolve("deveco.jsonc")
    }

    private fun readMcpSection(file: Path): JsonNode? = try {
        JsoncParser.readFile(file).path("mcp")
    } catch (_: Exception) {
        null
    }

    // ---------- helpers ----------

    private fun frontmatterName(manifest: Path): String? = try {
        // Frontmatter lives at the top; bounded head read (S9).
        val head = ByteArray(8 * 1024)
        val read = Files.newInputStream(manifest).use { it.read(head) }
        val text = String(head, 0, read.coerceAtLeast(0), Charsets.UTF_8)
        // P2-6: the buffer-full tail line may be cut mid-name (and a split
        // multi-byte char decodes to U+FFFD) — a match there is a truncated
        // value, never a real name. Fail the item instead of migrating it
        // under a wrong directory name.
        val truncatedTail = read == head.size && !text.endsWith("\n")
        val lines = text.lineSequence().toList()
        if (lines.isEmpty() || lines[0].trim() != "---") return null
        for (i in 1 until lines.size) {
            if (lines[i].trim() == "---" || lines[i].trim() == "...") break
            val match = Regex("^name\\s*:\\s*(.+)$").find(lines[i]) ?: continue
            val value = match.groupValues[1].trim().trim('"', '\'')
            return if (truncatedTail && i == lines.lastIndex) null else value.ifEmpty { null }
        }
        null
    } catch (_: Exception) {
        null
    }

    private fun sha256(file: Path): String {
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

    private val LOG = com.intellij.openapi.diagnostic.Logger.getInstance("deveco-migration")

    companion object {
        private val MAPPER = ObjectMapper()

        /**
         * Enumerates old-plugin config roots, newest version first.
         *
         * PathManager.getConfigPath() already points at the current IDE's own
         * versioned dir (e.g. .../Huawei/DevEcoStudio26.0) — the vendor root is
         * its PARENT (.../Huawei), which contains the sibling versioned dirs of
         * older CodeGenie installs. Version numbers sort numerically
         * (26.0 > 6.1), not lexicographically.
         */
        fun discoverCodegenieRoots(ideConfigDir: Path): List<Path> {
            val vendorRoot = if (ideConfigDir.fileName?.toString() == "Huawei") {
                ideConfigDir
            } else {
                ideConfigDir.parent ?: ideConfigDir
            }
            return discoverIn(vendorRoot)
        }

        private fun discoverIn(huawei: Path): List<Path> {
            if (!Files.isDirectory(huawei)) return emptyList()
            val entries = try {
                Files.list(huawei).use { stream ->
                    stream.filter(Files::isDirectory).map { it.fileName.toString() }.toList()
                }
            } catch (_: java.io.IOException) {
                return emptyList()
            }
            data class Root(val name: String, val version: List<Int>)

            fun compareVersions(a: List<Int>, b: List<Int>): Int {
                val n = minOf(a.size, b.size)
                for (i in 0 until n) {
                    val c = a[i].compareTo(b[i])
                    if (c != 0) return c
                }
                return a.size.compareTo(b.size)
            }

            return entries
                .filter { it.startsWith("DevEcoStudio") }
                .map { name ->
                    Root(name, Regex("\\d+").findAll(name.removePrefix("DevEcoStudio")).map { it.value.toInt() }.toList())
                }
                .sortedWith { a, b -> compareVersions(b.version, a.version) } // newest first
                .map { huawei.resolve(it.name).resolve("codegenie") }
                .filter(Files::isDirectory)
        }
    }
}
