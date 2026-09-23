package org.deveco.code.session.editor

import com.intellij.openapi.project.Project
import com.intellij.testFramework.LightVirtualFile

class SessionVirtualFile(sessionId: String, title: String, val project: Project?) : LightVirtualFile(title) {
    val sessionId: String = sessionId

    init {
        isWritable = false
    }

    fun updateTitle(title: String) {
        if (title.isBlank() || title == getName()) return
        isWritable = true
        try {
            rename(this, title)
        } catch (_: Exception) {
        } finally {
            isWritable = false
        }
    }
}
