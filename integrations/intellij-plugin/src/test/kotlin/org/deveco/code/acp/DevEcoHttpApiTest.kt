package org.deveco.code.acp

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Unit tests for [DevEcoHttpApi] against a loopback stub server (JDK
 * HttpServer): Basic-Auth injection on every route, `?directory=` query
 * propagation, request routing and payloads, JSON response parsing, and
 * non-2xx error mapping.
 */
class DevEcoHttpApiTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var server: StubServer
    private lateinit var api: DevEcoHttpApi

    @Before
    fun setUp() {
        server = StubServer()
        api = DevEcoHttpApi(server.baseUrl, "deveco_user", "secret-pass")
    }

    @After
    fun tearDown() {
        server.stop()
    }

    @Test
    fun sendsBasicAuthHeaderOnEveryRequest() {
        server.stub("/mcp")
        api.mcpServers("/dir")

        val request = server.recordedRequests.single()
        val expected = "Basic " + Base64.getEncoder()
            .encodeToString("deveco_user:secret-pass".toByteArray(StandardCharsets.UTF_8))
        assertEquals(expected, request.header("Authorization"))
    }

    @Test
    fun omitsAuthorizationHeaderWithoutPassword() {
        val unauthenticated = DevEcoHttpApi(server.baseUrl, "deveco_user", null)
        server.stub("/mcp")
        unauthenticated.mcpServers("/dir")

        assertNull(server.recordedRequests.single().header("Authorization"))
    }

    @Test
    fun archiveAndUnarchiveSessionPatchSessionWithDirectory() {
        api.archiveSession("s-1", "/work/dir", 42L)
        var request = server.recordedRequests.single()
        assertEquals("PATCH", request.method)
        assertEquals("/session/s-1", request.path)
        assertEquals("directory=%2Fwork%2Fdir", request.query)
        assertTrue(request.body.contains("\"archived\":42"))

        api.unarchiveSession("s-1", "/work/dir")
        request = server.recordedRequests[1]
        assertEquals("PATCH", request.method)
        assertTrue(request.body.contains("\"archived\":null"))
    }

    @Test
    fun deleteSessionMapsBackendConfirmation() {
        server.stub("/session", body = "true")
        assertTrue(api.deleteSession("s-1", "/dir"))

        server.stub("/session", body = "false")
        assertFalse(api.deleteSession("s-1", "/dir"))

        assertEquals("DELETE", server.recordedRequests.last().method)
    }

    @Test
    fun deleteSessionMapsHttpError() {
        server.stub("/session", status = 500, body = "boom")
        val error = assertThrows(IOException::class.java) {
            api.deleteSession("s-1", "/dir")
        }
        assertTrue(error.message!!.contains("HTTP 500"))
    }

    @Test
    fun sessionDiffParsesPatchTexts() {
        server.stub(
            "/session",
            body = """
                [{"file":"a.kt","additions":2,"deletions":1,
                "patch":"@@ -1,2 +1,3 @@\n line0\n-old\n+new\n+extra\n"}]
            """.trimIndent(),
        )
        val diff = api.sessionDiff("s-1", "/dir").single()
        assertEquals("a.kt", diff.path)
        assertEquals(2, diff.additions)
        assertEquals(1, diff.deletions)
        assertEquals("line0\nold\n", diff.beforeText)
        assertEquals("line0\nnew\nextra\n", diff.afterText)
    }

    @Test
    fun sessionDiffReturnsEmptyForNonArrayPayload() {
        server.stub("/session", body = "{}")
        assertTrue(api.sessionDiff("s-1", "/dir").isEmpty())
    }

    @Test
    fun activeSessionIdsSkipsArchivedSessions() {
        server.stub("/session", body = """[{"id":"live"},{"id":"gone","time":{"archived":123}}]""")
        assertEquals(setOf("live"), api.activeSessionIds("/dir"))

        val query = server.recordedRequests.single().query!!
        assertTrue(query.contains("roots=true"))
        assertTrue(query.contains("limit=1000"))
    }

    @Test
    fun mcpServersParseStatusAndError() {
        server.stub("/mcp", body = """{"mcp-a":{"status":"connected"},"mcp-b":{"status":"error","error":"boom"}}""")
        val servers = api.mcpServers("/dir")
        assertEquals(2, servers.size)
        assertEquals(DevEcoHttpApi.McpServerStatus("mcp-a", "connected", null), servers[0])
        assertEquals(DevEcoHttpApi.McpServerStatus("mcp-b", "error", "boom"), servers[1])
    }

    @Test
    fun pathsParsesCodePathsAndThrowsOnInvalidPayload() {
        server.stub("/path", body = "[]")
        val error = assertThrows(IOException::class.java) {
            api.paths("/dir")
        }
        assertTrue(error.message!!.contains("workspace paths"))

        server.stub(
            "/path",
            body = """{"home":"/h","config":"/c","projectConfig":"/pc","worktree":"/wt"}""",
        )
        val paths = api.paths("/dir")
        assertEquals("/h", paths.home)
        assertEquals("/c", paths.config)
        assertEquals("/pc", paths.projectConfig)
        assertEquals("/wt", paths.worktree)
        assertEquals("/dir", paths.directory)
    }

    @Test
    fun skillsInferScopeFromLocation() {
        val config = tmp.newFolder("config")
        val project = tmp.newFolder("project")
        server.stub(
            "/path",
            body = buildJsonObject {
                put("config", config.absolutePath)
                put("projectConfig", File(project, ".deveco/deveco.jsonc").absolutePath)
                put("worktree", project.absolutePath)
            }.toString(),
        )
        server.stub(
            "/skill/status",
            body = buildJsonArray {
                add(
                    buildJsonObject {
                        put("name", "alpha")
                        put("description", "Project skill")
                        put("location", File(project, ".deveco/skills/alpha").absolutePath)
                    },
                )
                add(
                    buildJsonObject {
                        put("name", "zeta")
                        put("location", File(config, "skills/zeta").absolutePath)
                    },
                )
                add(
                    buildJsonObject {
                        put("name", "builtin-one")
                        put("location", File(tmp.root, "b").absolutePath)
                        put("scope", "builtin")
                        put("enabled", false)
                    },
                )
            }.toString(),
        )

        val skills = api.skills("/elsewhere")
        assertEquals(listOf("alpha", "builtin-one", "zeta"), skills.map { it.name })
        assertEquals(DevEcoHttpApi.SkillScope.PROJECT, skills[0].scope)
        assertEquals("Project skill", skills[0].description)
        assertTrue(skills[0].enabled)
        assertEquals(DevEcoHttpApi.SkillScope.BUILTIN, skills[1].scope)
        assertFalse(skills[1].enabled)
        assertEquals(DevEcoHttpApi.SkillScope.GLOBAL, skills[2].scope)
    }

    @Test
    fun setSkillEnabledPatchesScopeAndEnabled() {
        api.setSkillEnabled("my skill", DevEcoHttpApi.SkillScope.GLOBAL, false, "/dir")

        val request = server.recordedRequests.single()
        assertEquals("PATCH", request.method)
        assertEquals("/skill/my%20skill", request.path)
        assertTrue(request.body.contains("\"scope\":\"global\""))
        assertTrue(request.body.contains("\"enabled\":false"))
    }

    @Test
    fun modelsKeepConnectedProvidersOnlyAndRankBuiltinFirst() {
        server.stub(
            "/provider",
            body = """
                {
                  "all": [
                    {"id": "acme", "name": "Acme", "key": "sk-1", "models": {"m1": {"id": "m1", "name": "Model One"}}},
                    {"id": "deveco", "name": "DevEco Code", "models": {"glm": {"id": "glm", "name": "GLM"}}},
                    {"id": "nokey", "name": "NoKey", "models": {"m2": {"id": "m2", "name": "M Two"}}}
                  ],
                  "connected": ["acme", "deveco", "nokey"]
                }
            """.trimIndent(),
        )
        val models = api.models("/dir")
        assertEquals(listOf("deveco", "acme"), models.map { it.providerId })
        assertEquals(listOf("glm", "m1"), models.map { it.modelId })
        assertEquals("GLM", models[0].modelName)
    }

    @Test
    fun modelsEmptyWithoutConnectedProviders() {
        server.stub("/provider", body = """{"all":[{"id":"acme","models":{"m1":{"id":"m1"}}}],"connected":[]}""")
        assertTrue(api.models("/dir").isEmpty())
    }

    @Test
    fun mcpConfigPatchPersistsWithoutRuntimeRegistration() {
        api.addMcpConfigPatch(
            buildJsonObject {
                put(
                    "mcp",
                    buildJsonObject {
                        put("srv", buildJsonObject { put("type", "remote") })
                    },
                )
            },
            "/dir",
        )

        val request = server.recordedRequests.single()
        assertEquals("PATCH", request.method)
        assertEquals("/config", request.path)
        assertEquals("directory=%2Fdir", request.query)
    }

    @Test
    fun updateGlobalConfigPatchesGlobalEndpoint() {
        api.updateGlobalConfig(buildJsonObject { put("disabled_providers", buildJsonArray {}) })

        val request = server.recordedRequests.single()
        assertEquals("PATCH", request.method)
        assertEquals("/global/config", request.path)
    }

    private class Recorded(
        val method: String,
        val path: String,
        val query: String?,
        val body: String,
        val headers: Map<String, List<String>>,
    ) {
        fun header(name: String): String? =
            headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value?.firstOrNull()
    }

    /**
     * Loopback HTTP stub: records every incoming request and answers from the
     * longest matching path-prefix stub; unstubbed paths get `200 {}` so that
     * write-style calls succeed without per-test boilerplate.
     */
    private class StubServer {
        private val responses = ConcurrentHashMap<String, Pair<Int, String>>()
        private val requests = CopyOnWriteArrayList<Recorded>()
        private val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)

        val baseUrl: String
            get() = "http://127.0.0.1:${http.address.port}"

        val recordedRequests: List<Recorded>
            get() = requests

        init {
            http.createContext("/") { exchange -> dispatch(exchange) }
            http.start()
        }

        fun stub(pathPrefix: String, status: Int = 200, body: String = "{}") {
            responses[pathPrefix] = status to body
        }

        fun stop() {
            http.stop(0)
        }

        private fun dispatch(exchange: HttpExchange) {
            val body = exchange.requestBody.readAllBytes().toString(StandardCharsets.UTF_8)
            val recorded = Recorded(
                exchange.requestMethod,
                exchange.requestURI.rawPath,
                exchange.requestURI.rawQuery,
                body,
                exchange.requestHeaders,
            )
            requests.add(recorded)
            val response = responses.entries
                .filter { recorded.path.startsWith(it.key) }
                .maxByOrNull { it.key.length }
                ?.value ?: (200 to "{}")
            val bytes = response.second.toByteArray(StandardCharsets.UTF_8)
            exchange.sendResponseHeaders(response.first, if (bytes.isEmpty()) -1L else bytes.size.toLong())
            if (bytes.isNotEmpty()) {
                exchange.responseBody.use { it.write(bytes) }
            }
            exchange.close()
        }
    }
}
