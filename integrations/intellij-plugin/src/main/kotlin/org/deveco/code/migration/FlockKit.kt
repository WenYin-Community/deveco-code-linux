package org.deveco.code.migration

import kotlinx.serialization.json.put
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.FileTime
import java.security.MessageDigest
import java.util.UUID
import kotlin.io.path.deleteIfExists
import kotlin.io.path.pathString

/**
 * Kotlin port of the CLI's application-level file-lock protocol
 * (`packages/core/src/util/flock.ts`). Cross-process mutual exclusion between
 * plugin windows (and the backend CLI for shared keys) relies on lock
 * directories + meta.json + heartbeat files under `<state>/locks/` — the same
 * on-disk protocol, so a Kotlin lock holder and a CLI lock holder exclude each
 * other correctly.
 *
 * Semantics (must stay aligned with flock.ts):
 *  - lock file = `<locksDir>/<sha1(key)>.lock/` directory, created atomically
 *  - inside: `meta.json` (token/pid/hostname/createdAt) + `heartbeat` file
 *  - stale when heartbeat (or meta, or dir) mtime is older than staleMs
 *  - stale takeover goes through a `<lock>.breaker` directory so exactly one contender cleans up
 *  - heartbeat keeps long migrations from being evicted: touch every staleMs/3
 *  - release only deletes the lock dir when meta.json still carries our token
 */
object FlockKit {

    private val LOG = com.intellij.openapi.diagnostic.Logger.getInstance("deveco-migration")

    class LockTimeoutException(message: String) : IOException(message)

    /** Auto-closable lease; [close] releases the lock. */
    class Lease internal constructor(
        private val lockDir: Path,
        private val token: String,
        heartbeatFile: Path?,
        heartbeatIntervalMs: Long,
    ) : AutoCloseable {
        private val heartbeat: Heartbeat? =
            if (heartbeatFile != null) Heartbeat(heartbeatFile, heartbeatIntervalMs) else null
        fun start() {
            heartbeat?.start()
        }

        override fun close() {
            heartbeat?.stop()
            // Never throw here: close() runs in withLock's finally, and an
            // exception from a finally block would discard the migration
            // report the body just produced (review P0-1 path 4). A refusal
            // is logged instead; the leftover lock dir goes stale and is
            // taken over by the breaker within staleMs.
            try {
                release(lockDir, token)
            } catch (e: IOException) {
                LOG.warn("codegenie migration: ${e.message} (lock dir ${lockDir.fileName})")
            }
        }
    }

    private class Heartbeat(private val file: Path, private val intervalMs: Long) {
        @Volatile private var running = true
        private val thread = Thread {
            while (running) {
                try {
                    val now = FileTime.fromMillis(System.currentTimeMillis())
                    Files.setLastModifiedTime(file, now)
                } catch (_: IOException) {
                    // best effort, same as flock.ts
                }
                try {
                    Thread.sleep(intervalMs)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return@Thread
                }
            }
        }

        fun start() {
            thread.isDaemon = true
            thread.name = "deveco-flock-heartbeat"
            thread.start()
        }

        fun stop() {
            running = false
            thread.interrupt()
        }
    }

    /**
     * Acquire the lock for [key], waiting with jittered exponential backoff
     * until [timeoutMs]. Throws [LockTimeoutException] on timeout.
     */
    fun <T> withLock(
        locksDir: Path,
        key: String,
        staleMs: Long = 60_000,
        timeoutMs: Long = 5 * 60_000,
        baseDelayMs: Long = 100,
        maxDelayMs: Long = 2_000,
        body: () -> T,
    ): T {
        val lease = acquire(locksDir, key, staleMs, timeoutMs, baseDelayMs, maxDelayMs)
        try {
            return body()
        } finally {
            lease.close()
        }
    }

    fun acquire(
        locksDir: Path,
        key: String,
        staleMs: Long = 60_000,
        timeoutMs: Long = 5 * 60_000,
        baseDelayMs: Long = 100,
        maxDelayMs: Long = 2_000,
    ): Lease {
        Files.createDirectories(locksDir)
        val lockDir = locksDir.resolve(sha1(key) + ".lock")
        val deadline = System.currentTimeMillis() + timeoutMs
        var delay = baseDelayMs
        while (true) {
            tryAcquire(lockDir, staleMs)?.let { owned ->
                return Lease(lockDir, owned.token, owned.heartbeatPath, maxOf(100, staleMs / 3)).also { it.start() }
            }
            if (System.currentTimeMillis() >= deadline) {
                throw LockTimeoutException("Timed out acquiring lock for key '$key' after ${timeoutMs}ms")
            }
            try {
                Thread.sleep(jitter(delay))
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                throw IOException("Interrupted while waiting for lock '$key'", InterruptedException())
            }
            delay = (delay * 1.7).toLong().coerceAtMost(maxDelayMs)
        }
    }

    private class Owned(val token: String, val heartbeatPath: Path)

    private fun tryAcquire(lockDir: Path, staleMs: Long): Owned? {
        val metaPath = lockDir.resolve("meta.json")
        val heartbeatPath = lockDir.resolve("heartbeat")

        // Fast path: only the process that actually created the directory claims
        // ownership (flock.ts atomicMkdir semantics). EEXIST never claims — the
        // holder may still be between mkdir and meta.json write.
        val created = try {
            Files.createDirectory(lockDir)
            true
        } catch (_: java.nio.file.FileAlreadyExistsException) {
            false
        }
        if (created) {
            val token = UUID.randomUUID().toString()
            if (claimOwnership(lockDir, metaPath, heartbeatPath, token)) return Owned(token, heartbeatPath)
            // Lost the claim race (heartbeat/meta already existed — compromised
            // state); claimOwnership already cleaned up. Fall through to retry.
            return null
        }

        if (!Files.isDirectory(lockDir)) {
            // Lock dir vanished between create attempt and check — retry outer loop.
            return null
        }
        if (!isStale(lockDir, heartbeatPath, metaPath, staleMs)) return null

        // Stale takeover under breaker arbitration (single contender cleans up).
        val breakerPath = lockDir.resolveSibling(lockDir.fileName.pathString + ".breaker")
        try {
            Files.createDirectory(breakerPath)
        } catch (_: Exception) {
            // Someone else holds the breaker; clean an ancient one, then back off.
            val breakerMtime = mtimeOf(breakerPath)
            if (breakerMtime != null && System.currentTimeMillis() - breakerMtime > staleMs) {
                deleteTree(breakerPath)
            }
            return null
        }
        try {
            if (!isStale(lockDir, heartbeatPath, metaPath, staleMs)) return null
            deleteTree(lockDir)
            try {
                Files.createDirectory(lockDir)
            } catch (_: Exception) {
                return null
            }
            val token = UUID.randomUUID().toString()
            if (claimOwnership(lockDir, metaPath, heartbeatPath, token)) return Owned(token, heartbeatPath)
            return null
        } finally {
            deleteTree(breakerPath)
        }
    }

    /** Writes heartbeat + meta.json exclusively (create-new); rolls back on race loss. */
    private fun claimOwnership(lockDir: Path, metaPath: Path, heartbeatPath: Path, token: String): Boolean {
        try {
            Files.writeString(heartbeatPath, "", java.nio.file.StandardOpenOption.CREATE_NEW)
        } catch (_: Exception) {
            deleteTree(lockDir)
            return false
        }
        // Serialize with kotlinx.serialization, not a string template: the
        // hostname can contain quotes/backslashes that would produce invalid
        // JSON and break the token regex in release() (lock stuck forever).
        val meta = kotlinx.serialization.json.buildJsonObject {
            put("token", token)
            put("pid", ProcessHandle.current().pid())
            put("hostname", hostLabel())
            put("createdAt", java.time.Instant.now().toString())
        }.toString()
        try {
            Files.writeString(metaPath, meta, java.nio.file.StandardOpenOption.CREATE_NEW)
        } catch (_: Exception) {
            deleteTree(lockDir)
            return false
        }
        return true
    }

    /** Token-checked release: never delete a lock re-acquired by another process. */
    private fun release(lockDir: Path, token: String) {
        val metaPath = lockDir.resolve("meta.json")
        val raw = try {
            Files.readString(metaPath)
        } catch (e: IOException) {
            throw IOException("Refusing to release: lock is compromised (metadata missing).", e)
        }
        val currentToken = Regex(""""token"\s*:\s*"([^"]+)"""").find(raw)?.groupValues?.get(1)
        if (currentToken != token) {
            // flock.ts semantics: a foreign token means the lock was re-acquired
            // by another process — deleting it would break their exclusion.
            throw IOException("Refusing to release: lock token mismatch")
        }
        deleteTree(lockDir)
    }

    private fun isStale(lockDir: Path, heartbeatPath: Path, metaPath: Path, staleMs: Long): Boolean {
        val now = System.currentTimeMillis()
        mtimeOf(heartbeatPath)?.let { return now - it > staleMs }
        mtimeOf(metaPath)?.let { return now - it > staleMs }
        mtimeOf(lockDir)?.let { return now - it > staleMs }
        return false
    }

    private fun mtimeOf(path: Path): Long? = try {
        Files.getLastModifiedTime(path).toMillis()
    } catch (_: IOException) {
        null
    }

    private fun hostLabel(): String = try {
        java.net.InetAddress.getLocalHost().hostName
    } catch (_: Exception) {
        "unknown"
    }

    private fun sha1(value: String): String {
        val digest = MessageDigest.getInstance("SHA-1")
        return digest.digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    private fun jitter(ms: Long): Long {
        val j = (ms * 0.3).toLong()
        val d = (Math.random() * (2 * j + 1)).toLong() - j
        return (ms + d).coerceAtLeast(0)
    }

    private fun deleteTree(root: Path) {
        if (!Files.exists(root)) return
        try {
            Files.walk(root).use { paths ->
                for (path in paths.sorted(Comparator.reverseOrder())) path.deleteIfExists()
            }
        } catch (_: IOException) {
            // best effort, mirrors flock.ts rm(..., {force:true}).catch(()=>undefined)
        }
    }
}
