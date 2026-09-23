package org.deveco.code.sidebar

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.intellij.openapi.diagnostic.Logger
import java.nio.file.Files
import java.nio.file.Path
import java.util.LinkedHashMap

class OpencodeConfig(
    private val userConfigDir: Path,
    private val projectBase: Path,
    // DevEco-Code-reported project config dir (studio mode: <storageRoot>/config/projects/<id>/.deveco).
    // Null keeps legacy behavior (CLI-mode worktree .deveco only).
    private val projectConfigDir: Path? = null,
) {

    fun listAgents(): List<AgentInfo> {
        val result = ArrayList<AgentInfo>()
        for (cfg in configs()) {
            val agents = cfg.path("agent")
            if (agents.isArray) {
                for (a in agents) {
                    result.add(AgentInfo(a.path("name").asText("?"), a.path("description").asText("")))
                }
            }
        }
        return result
    }

    fun listMcpServers(): List<McpServerInfo> {
        val byName = LinkedHashMap<String, McpServerInfo>()
        for (cfg in configs()) {
            val mcp = cfg.path("mcp")
            if (mcp.isObject) collectMcpFrom(mcp, byName)
        }
        return byName.values.toList()
    }

    fun listSkills(): List<SkillInfo> {
        val byName = LinkedHashMap<String, SkillInfo>()
        scanSkills(userConfigDir.resolve("skills"), byName)
        // Studio-mode project skills live in the isolated projectConfig dir; the
        // worktree .deveco only applies to terminal-CLI runs of the same repo.
        projectConfigDir?.let { scanSkills(it.resolve("skills"), byName) }
        scanSkills(projectBase.resolve(".deveco").resolve("skills"), byName)
        return byName.values.toList()
    }

    private val cachedConfigs: List<JsonNode> by lazy {
        val result = ArrayList<JsonNode>()
        addConfigDir(userConfigDir, result)
        // Studio-mode project config (projects/<id>/.deveco) — migrated and
        // marketplace-installed MCP entries live here.
        projectConfigDir?.let { addConfigDir(it, result) }
        addConfigDir(projectBase, result)
        addConfigDir(projectBase.resolve(".deveco"), result)
        result
    }

    private fun configs(): List<JsonNode> = cachedConfigs

    private fun addConfigDir(dir: Path, out: MutableList<JsonNode>) {
        for (file in CONFIG_FILES) {
            val path = dir.resolve(file)
            if (Files.isRegularFile(path)) {
                parseConfig(path)?.let { out.add(it) }
            }
        }
    }

    private fun collectMcpFrom(mcp: JsonNode, byName: MutableMap<String, McpServerInfo>) {
        val fields = mcp.fields()
        while (fields.hasNext()) {
            val entry = fields.next()
            if (entry.value.isObject) {
                byName.putIfAbsent(
                    entry.key,
                    McpServerInfo(
                        entry.key,
                        entry.value.path("command").asText(""),
                        entry.value.path("enabled").asBoolean(true),
                    ),
                )
            }
        }
    }

    private fun scanSkills(dir: Path, out: MutableMap<String, SkillInfo>) {
        if (!Files.isDirectory(dir)) return
        try {
            Files.newDirectoryStream(dir).use { stream ->
                for (entry in stream) {
                    if (!isSkillEntry(entry)) continue
                    val name = skillName(entry.fileName.toString())
                    out.putIfAbsent(name, SkillInfo(name, entry.toString()))
                }
            }
        } catch (e: Exception) {
            log.warn("Failed to scan skills in $dir", e)
        }
    }

    private fun isSkillEntry(entry: Path): Boolean {
        val name = entry.fileName.toString()
        return !name.startsWith(".") && name != "node_modules" && name != "package.json"
    }

    private fun skillName(fileName: String): String {
        val dot = fileName.lastIndexOf('.')
        return if (dot > 0) fileName.substring(0, dot) else fileName
    }

    companion object {
        private val log = Logger.getInstance(OpencodeConfig::class.java)
        private val MAPPER = ObjectMapper()

        // deveco.json(c) is the current brand name; opencode.json(c) kept for legacy data.
        private val CONFIG_FILES = listOf("deveco.jsonc", "deveco.json", "opencode.jsonc", "opencode.json")

        private fun parseConfig(path: Path): JsonNode? = try {
            MAPPER.readTree(stripComments(Files.readString(path)))
        } catch (e: Exception) {
            log.warn("Failed to parse config: $path", e)
            null
        }

        private fun stripComments(source: String): String {
            val sb = StringBuilder(source.length)
            var inString = false
            var escaped = false
            var i = 0
            while (i < source.length) {
                val c = source[i]
                if (inString) {
                    sb.append(c)
                    if (escaped) {
                        escaped = false
                    } else if (c == '\\') {
                        escaped = true
                    } else if (c == '"') {
                        inString = false
                    }
                    i++
                } else if (c == '/' && i + 1 < source.length && source[i + 1] == '/') {
                    while (i < source.length && source[i] != '\n') i++
                } else {
                    if (c == '"') inString = true
                    sb.append(c)
                    i++
                }
            }
            return sb.toString()
        }
    }
}
