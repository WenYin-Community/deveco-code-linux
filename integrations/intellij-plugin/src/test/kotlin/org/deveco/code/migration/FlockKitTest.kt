package org.deveco.code.migration

import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Unit tests for [FlockKit]: lock-directory acquire/release, mutual exclusion
 * per key, jittered waiting with [FlockKit.LockTimeoutException], stale-takeover
 * through the breaker, and token-checked release.
 */
class FlockKitTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun locksDir(): Path = tmp.root.toPath().resolve("locks")

    private fun lockDirFor(key: String): Path = locksDir().resolve(sha1Hex(key) + ".lock")

    private fun sha1Hex(value: String): String =
        MessageDigest.getInstance("SHA-1").digest(value.toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    private fun backdate(path: Path, millisAgo: Long) {
        Files.setLastModifiedTime(path, FileTime.fromMillis(System.currentTimeMillis() - millisAgo))
    }

    @Test
    fun withLockAcquiresAndReleasesTheLockDirectory() {
        val held = arrayOf(false)

        FlockKit.withLock(locksDir(), "codegenie-migration") {
            held[0] = Files.isDirectory(lockDirFor("codegenie-migration"))
        }

        assertTrue(held[0])
        assertFalse(Files.exists(lockDirFor("codegenie-migration")))
    }

    @Test
    fun secondAcquirerTimesOutWhileKeyIsHeld() {
        val lease = FlockKit.acquire(locksDir(), "codegenie-migration")
        try {
            assertThrows(FlockKit.LockTimeoutException::class.java) {
                FlockKit.withLock(
                    locksDir(),
                    "codegenie-migration",
                    timeoutMs = 500,
                    baseDelayMs = 50,
                    maxDelayMs = 100,
                ) {
                }
            }
        } finally {
            lease.close()
        }
        assertFalse(Files.exists(lockDirFor("codegenie-migration")))
    }

    @Test
    fun differentKeysDoNotExcludeEachOther() {
        FlockKit.withLock(locksDir(), "key-a") {
            FlockKit.withLock(locksDir(), "key-b") {
                assertTrue(Files.isDirectory(lockDirFor("key-a")))
                assertTrue(Files.isDirectory(lockDirFor("key-b")))
            }
        }
        assertFalse(Files.exists(lockDirFor("key-a")))
        assertFalse(Files.exists(lockDirFor("key-b")))
    }

    @Test
    fun secondAcquirerWaitsForReleaseAndThenSucceeds() {
        val released = CountDownLatch(1)
        val holder = Thread {
            FlockKit.withLock(locksDir(), "codegenie-migration") {
                released.await(10, TimeUnit.SECONDS)
            }
        }
        holder.start()
        // Wait until the holder actually owns the lock, then queue behind it.
        while (!Files.isDirectory(lockDirFor("codegenie-migration"))) Thread.sleep(10)
        val acquired = arrayOf(false)
        val waiter = Thread {
            FlockKit.withLock(
                locksDir(),
                "codegenie-migration",
                timeoutMs = 10_000,
                baseDelayMs = 20,
                maxDelayMs = 100,
            ) {
                acquired[0] = true
            }
        }

        waiter.start()
        Thread.sleep(300)
        // While the holder still owns the key, the waiter must not have run.
        assertFalse(acquired[0])

        released.countDown()
        waiter.join(TimeUnit.SECONDS.toMillis(15))
        holder.join(TimeUnit.SECONDS.toMillis(15))

        assertTrue(acquired[0])
        assertFalse(Files.exists(lockDirFor("codegenie-migration")))
    }

    @Test
    fun staleLockIsTakenOverThroughTheBreaker() {
        val lockDir = lockDirFor("codegenie-migration")
        Files.createDirectories(lockDir)
        Files.writeString(lockDir.resolve("heartbeat"), "")
        Files.writeString(lockDir.resolve("meta.json"), """{"token":"stale-holder","pid":1}""")
        backdate(lockDir, 60_000)

        val acquired = FlockKit.acquire(locksDir(), "codegenie-migration", staleMs = 300, timeoutMs = 5_000)

        try {
            val meta = Files.readString(lockDir.resolve("meta.json"))
            assertFalse(meta.contains("stale-holder"))
        } finally {
            acquired.close()
        }
        assertFalse(Files.exists(lockDir))
    }

    @Test
    fun leftoverLockDirectoryWithoutHeartbeatIsTakenOverWhenStale() {
        // Simulates a holder that crashed between mkdir and meta.json write.
        val lockDir = lockDirFor("codegenie-migration")
        Files.createDirectories(lockDir)
        backdate(lockDir, 60_000)

        val lease = FlockKit.acquire(locksDir(), "codegenie-migration", staleMs = 300, timeoutMs = 5_000)

        lease.close()
        assertFalse(Files.exists(lockDir))
    }

    @Test
    fun releaseRefusesForeignTokenAndKeepsTheLockDirectory() {
        val lease = FlockKit.acquire(locksDir(), "codegenie-migration")
        val lockDir = lockDirFor("codegenie-migration")
        // Another process re-acquired the stale lock and owns it now.
        Files.writeString(lockDir.resolve("meta.json"), """{"token":"foreign-token","pid":2}""")

        // close() never throws (review P0-1 path 4) — the refusal is logged.
        lease.close()

        assertTrue(Files.isDirectory(lockDir))
    }
}
