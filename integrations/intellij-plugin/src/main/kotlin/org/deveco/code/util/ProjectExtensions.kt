package org.deveco.code.util

import com.intellij.ide.actions.ShowSettingsUtilImpl
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
 * Opens a DevEco Studio product settings page (e.g. "ai.coding.models") on the
 * next top-level EDT dispatch instead of inside the caller's dispatch.
 * showSettingsDialog builds the whole configurable tree on the EDT — seconds
 * of work that must not run inside a Compose pointer/key handler from the chat
 * panel (the nested modal's event pump would then interleave with the model
 * dropdown popup's disposal and focus handoff). Dropped if the project closes
 * before the dispatch runs.
 */
fun Project.openProductSettings(id: String) {
    runInEdt { ShowSettingsUtilImpl.showSettingsDialog(this, id, null) }
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
    // Search rows keep the grep "<path>:" header verbatim, so persisted toolPath values carry
    // exactly one separator colon; Windows Path.of rejects any colon outside the drive letter,
    // so strip that one colon and degrade any other malformed path to "not found" instead of
    // throwing. Stripping a single colon keeps a POSIX file whose name really ends in ":"
    // (header "<path::>") resolvable.
    val trimmed = path.trim().removeSuffix(":")
    if (trimmed.isEmpty()) return null
    val rawPath = runCatching { Path.of(trimmed) }.getOrNull() ?: return null
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
