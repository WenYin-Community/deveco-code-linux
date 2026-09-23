package org.deveco.code.util

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.project.Project
import java.nio.file.Path

val devecoStorageRoot: Path =
    Path.of(PathManager.getSystemPath(), "deveco-code", "v1").toAbsolutePath().normalize()

val opencodeConfigDir: Path = devecoStorageRoot.resolve("config")

fun Project.runInEdt(action: () -> Unit) {
    ApplicationManager.getApplication().invokeLater {
        if (!isDisposed) action()
    }
}

fun errorMessage(e: Throwable): String = e.message ?: e.javaClass.simpleName
