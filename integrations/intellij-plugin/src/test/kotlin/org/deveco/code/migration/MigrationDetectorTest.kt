package org.deveco.code.migration

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.sql.Connection
import java.sql.DriverManager
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Unit tests for [MigrationDetector]: read-only detection of old-CodeGenie
 * data — global/project skills, encrypted Model_Management.db MCP entries
 * (built end-to-end with a synthetic material key store), failure surfacing
 * (P1-3), newest-root-wins selection and target-side queries.
 */
class MigrationDetectorTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private val password = "test-password-16"
    private val component = hexBytes("31f30973d6af5bb8d3beb1586583c077")

    private fun newDetector(
        codegenieRoots: List<Path> = emptyList(),
        projectBase: Path = tmp.root.toPath(),
        worktreeRoot: Path = tmp.root.toPath(),
        targetConfigDir: Path = tmp.root.toPath().resolve("target-config"),
        targetProjectConfigDir: Path? = null,
        builtinSkillNames: Set<String> = emptySet(),
    ): MigrationDetector = MigrationDetector(
        codegenieRoots = codegenieRoots,
        projectBase = projectBase,
        worktreeRoot = worktreeRoot,
        targetConfigDir = targetConfigDir,
        targetDataDir = tmp.root.toPath().resolve("target-data"),
        targetProjectConfigDir = targetProjectConfigDir,
        builtinSkillNames = builtinSkillNames,
    )

    private fun writeSkill(skillsRoot: Path, dirName: String, nameLine: String?, body: String = "skill body"): Path {
        val skillDir = skillsRoot.resolve(dirName)
        Files.createDirectories(skillDir)
        val manifest = skillDir.resolve("SKILL.md")
        val content = if (nameLine == null) body else "---\nname: $nameLine\n---\n$body"
        Files.writeString(manifest, content, StandardCharsets.UTF_8)
        return manifest
    }

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

    // ---------- material key fixtures (mirror of CodeGenieKeyStore layout) ----------

    private fun rootKeyFor(salt: ByteArray): ByteArray {
        val spec = PBEKeySpec(password.toCharArray(), salt, 10_000, 128)
        try {
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
        }
    }

    private fun gcmEncrypt(key: ByteArray, plaintext: ByteArray): ByteArray {
        val iv = ByteArray(12) { (it + 1).toByte() }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        val encrypted = cipher.doFinal(plaintext)
        val out = ByteArray(4 + iv.size + encrypted.size)
        out[0] = ((encrypted.size shr 24) and 0xFF).toByte()
        out[1] = ((encrypted.size shr 16) and 0xFF).toByte()
        out[2] = ((encrypted.size shr 8) and 0xFF).toByte()
        out[3] = (encrypted.size and 0xFF).toByte()
        iv.copyInto(out, 4)
        encrypted.copyInto(out, 4 + iv.size)
        return out
    }

    /** Builds a valid `material/` directory; returns the data key it encrypts to. */
    private fun buildMaterial(materialDir: Path, salt: ByteArray): ByteArray {
        val dataKey = ByteArray(16) { (it * 11).toByte() }
        val passwordBytes = password.toByteArray(StandardCharsets.UTF_8)
        val fd0 = ByteArray(passwordBytes.size) { (passwordBytes[it].toInt() xor component[it].toInt()).toByte() }
        writePayload(materialDir.resolve("fd").resolve("0"), fd0)
        writePayload(materialDir.resolve("fd").resolve("1"), ByteArray(16))
        writePayload(materialDir.resolve("fd").resolve("2"), ByteArray(16))
        writePayload(materialDir.resolve("ac"), salt)
        writePayload(materialDir.resolve("ce"), gcmEncrypt(rootKeyFor(salt), dataKey))
        return dataKey
    }

    private fun writePayload(dir: Path, payload: ByteArray) {
        Files.createDirectories(dir)
        Files.write(dir.resolve("payload"), payload)
    }

    private fun toHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    /** Creates a Model_Management.db under <root>/<user>/<project>/<account>/ with the given rows. */
    private fun createModelDb(root: Path, user: String, rows: List<Triple<String, String, ByteArray>>): Path {
        val accountDir = root.resolve(user).resolve("p-hash").resolve("a-hash")
        Files.createDirectories(accountDir)
        val db = accountDir.resolve("Model_Management.db")
        DriverManager.getConnection("jdbc:sqlite:${db.toUri()}").use { connection: Connection ->
            connection.createStatement().use { statement ->
                statement.execute("CREATE TABLE mcp_config (server_name TEXT, created_time TEXT, info TEXT)")
            }
            connection.prepareStatement(
                "INSERT INTO mcp_config (server_name, created_time, info) VALUES (?, ?, ?)",
            ).use { insert ->
                for ((name, created, info) in rows) {
                    insert.setString(1, name)
                    insert.setString(2, created)
                    insert.setString(3, toHex(info))
                    insert.executeUpdate()
                }
            }
        }
        return db
    }

    // ---------- detection ----------

    @Test
    fun detectWithoutSourcesReportsBothScopesMissing() {
        val inventory = newDetector().detect()

        assertTrue(inventory.globalSkills.isEmpty())
        assertTrue(inventory.projectSkills.isEmpty())
        assertTrue(inventory.globalMcps.isEmpty())
        assertTrue(inventory.mcpFailures.isEmpty())
        assertEquals(setOf(MigrationScope.GLOBAL, MigrationScope.PROJECT), inventory.missingScopes)
        assertFalse(inventory.hasGlobalSource)
        assertFalse(inventory.hasProjectSource)
    }

    @Test
    fun detectGlobalSkillsFromCodegenieRoot() {
        val ideDir = tmp.root.toPath().resolve("Huawei").resolve("DevEcoStudio6.1")
        val manifest = writeSkill(ideDir.resolve("codegenie").resolve("skills"), "my-skill", "my-skill")

        val inventory = newDetector(
            codegenieRoots = listOf(ideDir.resolve("codegenie")),
        ).detect()

        val skill = inventory.globalSkills.single()
        assertEquals("my-skill", skill.name)
        assertEquals(manifest, skill.skillMdPath)
        assertEquals(sha256Hex(manifest), skill.skillMdSha256)
        assertEquals(MigrationScope.GLOBAL, skill.scope)
        assertFalse(inventory.missingScopes.contains(MigrationScope.GLOBAL))
        // Raw origin version is always recorded; the render layer decides annotation.
        assertEquals("6.1", inventory.skillsSourceVersion)
    }

    @Test
    fun newestRootCarryingSkillsWins() {
        val huawei = tmp.root.toPath().resolve("Huawei")
        val newerRoot = huawei.resolve("DevEcoStudio26.0").resolve("codegenie")
        val olderRoot = huawei.resolve("DevEcoStudio6.1").resolve("codegenie")
        writeSkill(newerRoot.resolve("skills"), "new-skill", "new-skill")
        writeSkill(olderRoot.resolve("skills"), "old-skill", "old-skill")

        val inventory = newDetector(codegenieRoots = listOf(newerRoot, olderRoot)).detect()

        assertEquals(listOf("new-skill"), inventory.globalSkills.map { it.name })
        assertEquals("26.0", inventory.skillsSourceVersion)
    }

    @Test
    fun detectProjectSkillsAboveTheProjectDirectory() {
        val worktree = tmp.root.toPath().resolve("worktree")
        val projectBase = worktree.resolve("project")
        val manifest = writeSkill(worktree.resolve(".codegenie").resolve("skills"), "proj-skill", "proj-skill")

        val inventory = newDetector(
            projectBase = projectBase,
            worktreeRoot = worktree,
        ).detect()

        val skill = inventory.projectSkills.single()
        assertEquals("proj-skill", skill.name)
        assertEquals(MigrationScope.PROJECT, skill.scope)
        assertEquals(sha256Hex(manifest), skill.skillMdSha256)
        assertFalse(inventory.missingScopes.contains(MigrationScope.PROJECT))
    }

    @Test
    fun projectSkillSearchStopsAtTheWorktreeRoot() {
        val worktree = tmp.root.toPath().resolve("worktree")
        writeSkill(tmp.root.toPath().resolve(".codegenie").resolve("skills"), "outside", "outside")

        val inventory = newDetector(
            projectBase = worktree.resolve("project"),
            worktreeRoot = worktree,
        ).detect()

        assertTrue(inventory.projectSkills.isEmpty())
    }

    @Test
    fun skillWithoutFrontmatterIsDetectedWithNullName() {
        val ideDir = tmp.root.toPath().resolve("Huawei").resolve("DevEcoStudio26.0")
        writeSkill(ideDir.resolve("codegenie").resolve("skills"), "broken", nameLine = null, body = "no frontmatter")

        val inventory = newDetector(codegenieRoots = listOf(ideDir.resolve("codegenie"))).detect()

        assertNull(inventory.globalSkills.single().name)
    }

    @Test
    fun quotedFrontmatterNameIsTrimmed() {
        val ideDir = tmp.root.toPath().resolve("Huawei").resolve("DevEcoStudio26.0")
        writeSkill(ideDir.resolve("codegenie").resolve("skills"), "quoted", nameLine = "\"quoted name\"")

        val inventory = newDetector(codegenieRoots = listOf(ideDir.resolve("codegenie"))).detect()

        assertEquals("quoted name", inventory.globalSkills.single().name)
    }

    // ---------- encrypted MCP database ----------

    @Test
    fun detectReadsAndConvertsEncryptedMcpEntries() {
        val root = tmp.root.toPath().resolve("codegenie")
        val dataKey = buildMaterial(root.resolve("material"), ByteArray(16) { it.toByte() })
        val config = """{"command":"npx","args":["-y","mcp-server-fetch"],"env":{"K":"V"},"type":"stdio"}"""
        createModelDb(
            root,
            user = "u1",
            rows = listOf(Triple("fetch", "1000", gcmEncrypt(dataKey, config.toByteArray(StandardCharsets.UTF_8)))),
        )

        val inventory = newDetector(codegenieRoots = listOf(root)).detect()

        val mcp = inventory.globalMcps.single()
        assertEquals("fetch", mcp.name)
        assertEquals(MigrationScope.GLOBAL, mcp.scope)
        val expected = """{"type":"local","command":["npx","-y","mcp-server-fetch"],"environment":{"K":"V"}}"""
        assertEquals(
            com.fasterxml.jackson.databind.ObjectMapper().readTree(expected),
            com.fasterxml.jackson.databind.ObjectMapper().readTree(mcp.configJson),
        )
        assertTrue(inventory.mcpFailures.isEmpty())
        assertFalse(inventory.missingScopes.contains(MigrationScope.GLOBAL))
    }

    @Test
    fun multipleDatabasesMergeByServerNameWithLatestCreatedTimeWinning() {
        val root = tmp.root.toPath().resolve("codegenie")
        val dataKey = buildMaterial(root.resolve("material"), ByteArray(16) { 1 })
        val older = """{"command":"old-command","type":"stdio"}"""
        val newer = """{"command":"new-command","type":"stdio"}"""
        createModelDb(root, "u1", rows = listOf(Triple("fetch", "100", gcmEncrypt(dataKey, older.toByteArray()))))
        createModelDb(root, "u2", rows = listOf(Triple("fetch", "200", gcmEncrypt(dataKey, newer.toByteArray()))))

        val inventory = newDetector(codegenieRoots = listOf(root)).detect()

        val mcp = inventory.globalMcps.single()
        assertTrue(mcp.configJson.contains("new-command"))
        assertFalse(mcp.configJson.contains("old-command"))
    }

    @Test
    fun keyDerivationFailureSurfacesAsMcpFailureAndKeepsScopePresent() {
        val root = tmp.root.toPath().resolve("codegenie")
        // A database exists but the material directory is missing entirely.
        createModelDb(root, user = "u1", rows = listOf(Triple("fetch", "1", ByteArray(48))))

        val inventory = newDetector(codegenieRoots = listOf(root)).detect()

        assertTrue(inventory.globalMcps.isEmpty())
        val failure = inventory.mcpFailures.single()
        assertNull(failure.name)
        assertTrue(failure.reason.contains("key derivation failed"))
        // P1-3: "could not read" must not masquerade as "nothing to migrate".
        assertTrue(inventory.hasGlobalSource)
        assertFalse(inventory.missingScopes.contains(MigrationScope.GLOBAL))
    }

    @Test
    fun unreadableDatabaseSurfacesAsMcpFailure() {
        val root = tmp.root.toPath().resolve("codegenie")
        buildMaterial(root.resolve("material"), ByteArray(16) { 2 })
        val accountDir = root.resolve("u1").resolve("p-hash").resolve("a-hash")
        Files.createDirectories(accountDir)
        Files.write(accountDir.resolve("Model_Management.db"), "not a sqlite database".toByteArray())

        val inventory = newDetector(codegenieRoots = listOf(root)).detect()

        assertTrue(inventory.globalMcps.isEmpty())
        val failure = inventory.mcpFailures.single()
        assertTrue(failure.reason.contains("unreadable database"))
    }

    @Test
    fun undecryptableInfoSurfacesAsNamedMcpFailure() {
        val root = tmp.root.toPath().resolve("codegenie")
        buildMaterial(root.resolve("material"), ByteArray(16) { 3 })
        // Encrypted under a different key: decrypt fails per row (P1-3).
        val foreignKey = ByteArray(16) { 9 }
        val config = """{"command":"npx","type":"stdio"}"""
        createModelDb(
            root,
            user = "u1",
            rows = listOf(Triple("fetch", "1", gcmEncrypt(foreignKey, config.toByteArray()))),
        )

        val inventory = newDetector(codegenieRoots = listOf(root)).detect()

        assertTrue(inventory.globalMcps.isEmpty())
        val failure = inventory.mcpFailures.single()
        assertEquals("fetch", failure.name)
        assertTrue(inventory.hasGlobalSource)
    }

    // ---------- convertMcpConfig (internal) ----------

    @Test
    fun convertMcpConfigMapsStdioCommandToLocalAndEnvToEnvironment() {
        val dataKey = ByteArray(16)
        val config = """{"command":"npx","args":["-y","mcp-server-fetch",1],"env":{"K":"V"},"type":"stdio"}"""
        val infoHex = toHex(gcmEncrypt(dataKey, config.toByteArray()))

        val item = newDetector().convertMcpConfig("fetch", infoHex, dataKey)

        assertEquals("fetch", item.name)
        assertEquals(MigrationScope.GLOBAL, item.scope)
        assertTrue(item.configJson.contains("\"type\":\"local\""))
        assertTrue(item.configJson.contains(""""command":["npx","-y","mcp-server-fetch"]"""))
        assertTrue(item.configJson.contains("\"environment\":{\"K\":\"V\"}"))
        assertFalse(item.configJson.contains("\"type\":\"stdio\""))
    }

    @Test
    fun convertMcpConfigMapsUrlToRemoteWithHeaders() {
        val dataKey = ByteArray(16)
        val config = """{"url":"https://example.com","headers":{"H":"V"}}"""
        val infoHex = toHex(gcmEncrypt(dataKey, config.toByteArray()))

        val item = newDetector().convertMcpConfig("remote-srv", infoHex, dataKey)

        assertTrue(item.configJson.contains("\"type\":\"remote\""))
        assertTrue(item.configJson.contains("\"url\":\"https://example.com\""))
        assertTrue(item.configJson.contains("\"headers\":{\"H\":\"V\"}"))
    }

    @Test
    fun convertMcpConfigRejectsNullCommand() {
        val dataKey = ByteArray(16)
        val infoHex = toHex(gcmEncrypt(dataKey, """{"command":null}""".toByteArray()))

        val error = assertThrows(java.io.IOException::class.java) {
            newDetector().convertMcpConfig("srv", infoHex, dataKey)
        }

        assertEquals("command is not a non-empty string", error.message)
    }

    @Test
    fun convertMcpConfigRejectsUnrecognizedShape() {
        val dataKey = ByteArray(16)
        val infoHex = toHex(gcmEncrypt(dataKey, """{"unknown":"shape"}""".toByteArray()))

        val error = assertThrows(java.io.IOException::class.java) {
            newDetector().convertMcpConfig("srv", infoHex, dataKey)
        }

        assertEquals("unrecognized MCP config shape (no url/command)", error.message)
    }

    // ---------- root discovery (companion) ----------

    @Test
    fun discoverCodegenieRootsSortsVersionsNumericallyNewestFirst() {
        val huawei = tmp.root.toPath().resolve("Huawei")
        for (version in listOf("DevEcoStudio6.1", "DevEcoStudio26.0", "DevEcoStudio10.0")) {
            Files.createDirectories(huawei.resolve(version).resolve("codegenie"))
        }
        Files.createDirectories(huawei.resolve("Unrelated"))
        Files.writeString(huawei.resolve("DevEcoStudio6.1.txt"), "file, not a directory")

        val roots = MigrationDetector.discoverCodegenieRoots(huawei)

        assertEquals(
            listOf("DevEcoStudio26.0", "DevEcoStudio10.0", "DevEcoStudio6.1"),
            roots.map { it.parent.fileName.toString() },
        )
    }

    @Test
    fun discoverCodegenieRootsSkipsVersionsWithoutCodegenieDirAndMissingVendor() {
        val huawei = tmp.root.toPath().resolve("Huawei")
        Files.createDirectories(huawei.resolve("DevEcoStudio26.0"))

        assertTrue(MigrationDetector.discoverCodegenieRoots(huawei).isEmpty())
        assertTrue(
            MigrationDetector.discoverCodegenieRoots(tmp.root.toPath().resolve("absent")).isEmpty(),
        )
    }

    // ---------- target-side queries ----------

    @Test
    fun targetMcpEntryReadsGlobalConfigAndIgnoresProjectScope() {
        val targetConfigDir = tmp.root.toPath().resolve("target-config")
        Files.createDirectories(targetConfigDir)
        Files.writeString(
            targetConfigDir.resolve("deveco.jsonc"),
            """{"mcp":{"srv":{"type":"remote","url":"https://x"}}}""",
        )
        val detector = newDetector(targetConfigDir = targetConfigDir)

        val entry = detector.targetMcpEntry(MigrationScope.GLOBAL, "srv")

        assertNotNull(entry)
        assertEquals("remote", entry!!.path("type").asText())
        assertNull(detector.targetMcpEntry(MigrationScope.GLOBAL, "absent"))
        assertNull(detector.targetMcpEntry(MigrationScope.PROJECT, "srv"))
    }

    @Test
    fun jsonEquivalentComparesStructurally() {
        val detector = newDetector()
        val target = com.fasterxml.jackson.databind.ObjectMapper().readTree("""{"a":1,"b":[2,3]}""")

        assertTrue(detector.jsonEquivalent(target, """{"b":[2,3],"a":1}"""))
        assertFalse(detector.jsonEquivalent(target, """{"a":1}"""))
        assertFalse(detector.jsonEquivalent(target, "not json at all"))
    }

    @Test
    fun builtinAndTargetDirQueriesFollowScope() {
        val targetConfigDir = tmp.root.toPath().resolve("target-config")
        val projectConfigDir = tmp.root.toPath().resolve("project-config")
        val detector = newDetector(
            targetConfigDir = targetConfigDir,
            targetProjectConfigDir = projectConfigDir,
            builtinSkillNames = setOf("builtin-skill"),
        )

        assertEquals(targetConfigDir.resolve("skills"), detector.skillTargetDir(MigrationScope.GLOBAL))
        assertEquals(projectConfigDir.resolve("skills"), detector.skillTargetDir(MigrationScope.PROJECT))
        assertTrue(detector.isBuiltinSkill("builtin-skill"))
        assertFalse(detector.isBuiltinSkill("user-skill"))
    }

    private fun hexBytes(value: String): ByteArray {
        val out = ByteArray(value.length / 2)
        for (i in out.indices) {
            out[i] = ((Character.digit(value[i * 2], 16) shl 4) or Character.digit(value[i * 2 + 1], 16)).toByte()
        }
        return out
    }
}
