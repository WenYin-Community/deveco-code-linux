package org.deveco.code.util

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.application.WriteAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import java.nio.file.Path

val devecoStorageRoot: Path =
    Path.of(PathManager.getSystemPath(), "deveco-code", "v1").toAbsolutePath().normalize()

val opencodeConfigDir: Path = devecoStorageRoot.resolve("config")

fun Project.runInEdt(action: () -> Unit) {
    ApplicationManager.getApplication().invokeLater {
        if (!isDisposed) action()
    }
}

/**
 * Resolves [path] to a VirtualFile, forcing a synchronous VFS refresh so files
 * just written by external processes (the agent CLI, shell commands) become
 * visible even when the file watcher has not caught up. Relative paths are
 * resolved against the project base path.
 *
 * Must not be called on the EDT — it blocks until the EDT write action completes.
 */
fun Project.resolveVirtualFileWithRefresh(path: String): VirtualFile? {
    val trimmed = path.trim()
    if (trimmed.isEmpty()) return null
    val rawPath = Path.of(trimmed)
    val resolved = if (rawPath.isAbsolute) {
        rawPath
    } else {
        val base = basePath ?: return null
        Path.of(base).resolve(rawPath)
    }.normalize().toString().replace('\\', '/')
    // The sync VFS refresh must run on the EDT inside a full write action: on a background
    // thread it deadlocks with the EDT, and a write-intent read action is not write-safe —
    // when the refresh has to fire VFS events for a file missing from the VFS,
    // TransactionGuard rejects it with "Write-unsafe context!".
    return WriteAction.computeAndWait<VirtualFile?, Exception>({
        LocalFileSystem.getInstance().refreshAndFindFileByPath(resolved)
    }, ModalityState.nonModal())
}

fun errorMessage(e: Throwable): String = e.message ?: e.javaClass.simpleName
