package org.deveco.code.session

import com.intellij.testFramework.LightPlatformTestCase
import org.deveco.code.util.devecoStorageRoot
import java.nio.file.Files
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.io.path.exists

/**
 * Platform-fixture unit tests for [TurnDiagnostics]: dead-turn cause extraction
 * from the CLI log tail — timestamp-window filtering, category classification,
 * title-stream (small=true) suppression, retry-success suppression and detail
 * truncation. The sandbox log file is rewritten per test.
 */
class TurnDiagnosticsTest : LightPlatformTestCase() {

    private val logFile
        get() = devecoStorageRoot.resolve("data").resolve("log").resolve("deveco.log")

    private val tsFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")

    override fun setUp() {
        super.setUp()
        Files.deleteIfExists(logFile)
    }

    private fun epochMs(ts: String): Long =
        LocalDateTime.parse(ts, tsFormat).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()

    private fun writeLog(vararg lines: String) {
        Files.createDirectories(logFile.parent)
        Files.write(logFile, lines.joinToString("\n").toByteArray())
    }

    /** logfmt-shaped line as the CLI emits it: fields are quoted key="value". */
    private fun streamError(ts: String, sessionId: String, error: String, extra: String = "") =
        "logger=stream level=ERROR msg=\"stream error\" sessionID=\"$sessionId\" $extra" +
            "timestamp=\"$ts\" error.error=\"$error\""

    fun testMissingLogFileYieldsNoFailure() {
        assertFalse(logFile.exists())

        assertNull(TurnDiagnostics.diagnose("s1", epochMs("2026-11-11 10:00:00")))
    }

    fun testNonPositiveSinceMsYieldsNoFailure() {
        writeLog(streamError("2026-11-11 10:00:00", "s1", "connect ECONNREFUSED"))

        assertNull(TurnDiagnostics.diagnose("s1", 0L))
        assertNull(TurnDiagnostics.diagnose("s1", -5L))
    }

    fun testConnectErrorClassifiedAsNetwork() {
        val since = epochMs("2026-11-11 10:00:00")
        writeLog(streamError("2026-11-11 10:00:05", "s1", "connect ECONNREFUSED 127.0.0.1:443"))

        assertEquals(
            TurnDiagnostics.StreamFailure(TurnDiagnostics.Category.NETWORK, "connect ECONNREFUSED 127.0.0.1:443"),
            TurnDiagnostics.diagnose("s1", since),
        )
    }

    fun testTimeoutErrorClassifiedAsTimeout() {
        val since = epochMs("2026-11-11 10:00:00")
        writeLog(streamError("2026-11-11 10:00:05", "s1", "request timeout after 60000ms"))

        assertEquals(
            TurnDiagnostics.StreamFailure(TurnDiagnostics.Category.TIMEOUT, "request timeout after 60000ms"),
            TurnDiagnostics.diagnose("s1", since),
        )
    }

    fun testUnauthorizedErrorClassifiedAsAuth() {
        val since = epochMs("2026-11-11 10:00:00")
        writeLog(streamError("2026-11-11 10:00:05", "s1", "401 Unauthorized"))

        assertEquals(
            TurnDiagnostics.StreamFailure(TurnDiagnostics.Category.AUTH, "401 Unauthorized"),
            TurnDiagnostics.diagnose("s1", since),
        )
    }

    fun testRateLimitErrorClassifiedAsServer() {
        val since = epochMs("2026-11-11 10:00:00")
        writeLog(streamError("2026-11-11 10:00:05", "s1", "429 rate limit exceeded"))

        assertEquals(
            TurnDiagnostics.StreamFailure(TurnDiagnostics.Category.SERVER, "429 rate limit exceeded"),
            TurnDiagnostics.diagnose("s1", since),
        )
    }

    fun testUnclassifiedErrorFallsBackToUnknown() {
        val since = epochMs("2026-11-11 10:00:00")
        writeLog(streamError("2026-11-11 10:00:05", "s1", "something exploded"))

        assertEquals(
            TurnDiagnostics.StreamFailure(TurnDiagnostics.Category.UNKNOWN, "something exploded"),
            TurnDiagnostics.diagnose("s1", since),
        )
    }

    fun testTitleGenerationStreamErrorsAreIgnored() {
        val since = epochMs("2026-11-11 10:00:00")
        writeLog(streamError("2026-11-11 10:00:05", "s1", "connect ECONNREFUSED", extra = "small=true "))

        assertNull(TurnDiagnostics.diagnose("s1", since))
    }

    fun testNonErrorLevelsAndOtherSessionsAreIgnored() {
        val since = epochMs("2026-11-11 10:00:00")
        writeLog(
            "level=INFO msg=\"stream error\" sessionID=\"s1\" timestamp=\"2026-11-11 10:00:05\" error.error=\"connect ECONNREFUSED\"",
            streamError("2026-11-11 10:00:05", "other-session", "connect ECONNREFUSED"),
            "level=ERROR msg=\"unrelated failure\" sessionID=\"s1\" timestamp=\"2026-11-11 10:00:05\" error.error=\"boom\"",
        )

        assertNull(TurnDiagnostics.diagnose("s1", since))
    }

    fun testOldTimestampsOutsideWindowAreIgnored() {
        // Window floor is sinceMs - 2s; a line 60s before the turn is out.
        val since = epochMs("2026-11-11 10:00:00")
        writeLog(streamError("2026-11-11 09:59:00", "s1", "connect ECONNREFUSED"))

        assertNull(TurnDiagnostics.diagnose("s1", since))
    }

    fun testLastFailureInWindowWins() {
        val since = epochMs("2026-11-11 10:00:00")
        writeLog(
            streamError("2026-11-11 10:00:01", "s1", "connect ECONNREFUSED"),
            streamError("2026-11-11 10:00:02", "s1", "request timeout after 60000ms"),
        )

        assertEquals(
            TurnDiagnostics.StreamFailure(TurnDiagnostics.Category.TIMEOUT, "request timeout after 60000ms"),
            TurnDiagnostics.diagnose("s1", since),
        )
    }

    fun testSuccessfulRetrySuppressesStreamFailures() {
        val since = epochMs("2026-11-11 10:00:00")
        writeLog(
            streamError("2026-11-11 10:00:01", "s1", "connect ECONNREFUSED"),
            "level=INFO msg=\"retryable error matched\" attempt=1",
        )

        assertNull(TurnDiagnostics.diagnose("s1", since))
    }

    fun testDetailIsTruncatedToLimit() {
        val since = epochMs("2026-11-11 10:00:00")
        val longError = "x".repeat(300)
        writeLog(streamError("2026-11-11 10:00:05", "s1", longError))

        val failure = TurnDiagnostics.diagnose("s1", since)

        assertNotNull(failure)
        assertEquals(160, failure!!.detail.length)
    }
}
