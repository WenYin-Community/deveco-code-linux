package org.deveco.code.announcement

import org.deveco.code.acp.CliBinaryExtractor
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

internal class AnnouncementHttp(private val endpoint: () -> URI, private val version: () -> String) {
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()

    @Volatile private var pending: CompletableFuture<HttpResponse<String>>? = null

    fun fetch(): AnnouncementResponse {
        val clientVersion = URLEncoder.encode(version(), Charsets.UTF_8)
        val uri = URI.create("${endpoint()}?clientName=deveco-code&clientVersion=$clientVersion")
        val request = HttpRequest.newBuilder(uri)
            .timeout(Duration.ofSeconds(10)).header("Accept", "application/json").GET().build()
        // This client has no authenticator or sidecar credentials.
        val future = client.sendAsync(request, HttpResponse.BodyHandlers.ofString(Charsets.UTF_8))
        pending = future
        try {
            val response = future.get(10, TimeUnit.SECONDS)
            require(response.statusCode() in 200..299) {
                "Announcement request failed with HTTP ${response.statusCode()}"
            }
            return AnnouncementResponse.parse(response.body())
        } finally {
            future.cancel(true)
            pending = null
        }
    }

    fun cancel() {
        pending?.cancel(true)
        client.shutdownNow()
    }

    companion object {
        fun endpoint(): URI = URI.create("https://cn.devecostudio.huawei.com/sse/codeGenie/announcement")

        fun installedVersion(): String {
            val process = ProcessBuilder(
                CliBinaryExtractor.extract(),
                "--version",
            ).redirectError(ProcessBuilder.Redirect.DISCARD).start()
            try {
                check(process.waitFor(10, TimeUnit.SECONDS)) { "Timed out reading the client version" }
                check(process.exitValue() == 0) { "Failed to read the client version" }
                return process.inputStream.bufferedReader().use { it.readText().trim() }.also {
                    require(it.isNotBlank() && it.length < 200) { "Invalid client version" }
                }
            } finally {
                process.destroyForcibly()
            }
        }
    }
}
