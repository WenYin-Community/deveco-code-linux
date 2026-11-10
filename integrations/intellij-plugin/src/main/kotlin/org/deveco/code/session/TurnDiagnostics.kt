package org.deveco.code.session

import com.intellij.openapi.diagnostic.Logger
import org.deveco.code.util.devecoStorageRoot
import java.io.RandomAccessFile
import java.nio.file.Path
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Extracts the real cause of a dead turn from the CLI's log file. The CLI
 * captures stream exceptions internally and still answers ACP `session/prompt`
 * with a normal end_turn, so the plugin cannot see the failure on the wire —
 * the only trace is the log at
 * `<DEVECO_STORAGE_ROOT>/data/log/deveco.log`.
 *
 * Any parse failure degrades silently to "no failure found".
 */
internal object TurnDiagnostics {
    private val log = Logger.getInstance(TurnDiagnostics::class.java)

    // RandomAccessFile window: read only the tail, never the whole file.
    private const val TAIL_BYTES = 256 * 1024
    private const val WINDOW_BEFORE_MS = 2_000L
    private const val MAX_DETAIL = 160
    private val TS_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")

    enum class Category { TIMEOUT, NETWORK, AUTH, SERVER, UNKNOWN }

    data class StreamFailure(val category: Category, val detail: String)

    /**
     * Scans the CLI log tail for stream errors of [sessionId] recorded at or
     * after [sinceMs] (the turn's start). Returns the last matching failure in
     * the window, or null when the turn looks healthy.
     */
    fun diagnose(sessionId: String, sinceMs: Long): StreamFailure? {
        if (sinceMs <= 0) return null
        return try {
            val logFile = devecoStorageRoot.resolve("data").resolve("log").resolve("deveco.log")
            if (!logFile.toFile().isFile) return null
            parse(tail(logFile) ?: return null, sessionId, sinceMs)
        } catch (e: Exception) {
            log.warn("TurnDiagnostics failed to inspect the CLI log", e)
            null
        }
    }

    private fun tail(file: Path): String? = RandomAccessFile(file.toFile(), "r").use { raf ->
        val size = raf.length()
        if (size == 0L) return null
        val start = maxOf(0L, size - TAIL_BYTES)
        val buffer = ByteArray((size - start).toInt())
        raf.seek(start)
        raf.readFully(buffer)
        String(buffer, Charsets.UTF_8)
    }

    private fun parse(text: String, sessionId: String, sinceMs: Long): StreamFailure? {
        val floor = sinceMs - WINDOW_BEFORE_MS
        var found: StreamFailure? = null
        var retriedSuccessfully = false

        // First pass: check if any retry succeeded.
        // The "retryable error matched" line doesn't contain sessionId,
        // but it's only logged when a retry succeeds, so any occurrence
        // means the backend recovered from stream errors.
        for (line in text.lineSequence()) {
            if (line.contains("retryable error matched")) {
                retriedSuccessfully = true
                break
            }
        }

        // Second pass: find stream errors for this session.
        for (line in text.lineSequence()) {
            if (!line.contains("level=ERROR")) continue
            if (!line.contains("stream error")) continue
            if (!line.contains(sessionId)) continue
            // The title-generation side stream fails in parallel with healthy
            // main turns — its errors say nothing about the user's turn.
            if (line.contains("small=true")) continue
            val timestamp = parseQuotedField(line, "timestamp") ?: continue
            val millis = try {
                LocalDateTime.parse(timestamp, TS_FORMAT)
                    .atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
            } catch (_: Exception) {
                continue
            }
            if (millis < floor) continue
            val detail = parseQuotedField(line, "error.error") ?: continue
            // Keep scanning: the last error in the window is the most recent.
            found = StreamFailure(classify(detail), detail.take(MAX_DETAIL))
        }
        if (retriedSuccessfully) return null
        return found
    }

    private fun parseQuotedField(line: String, key: String): String? {
        val needle = "$key=\""
        val index = line.indexOf(needle)
        if (index < 0) return null
        return line.substring(index + needle.length).takeWhile { it != '"' }.ifBlank { null }
    }

    private fun classify(detail: String): Category {
        val d = detail.lowercase()
        return when {
            "timeout" in d -> Category.TIMEOUT

            "connect" in d || "unreachable" in d || "proxy" in d ||
                "econnrefused" in d || "enotfound" in d -> Category.NETWORK

            "401" in d || "403" in d || "unauthorized" in d || "api key" in d ||
                "token expired" in d -> Category.AUTH

            "429" in d || "502" in d || "503" in d || "504" in d ||
                "rate limit" in d || "overloaded" in d -> Category.SERVER

            else -> Category.UNKNOWN
        }
    }
}
