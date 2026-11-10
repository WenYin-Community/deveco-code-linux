package org.deveco.code.session.editor

import com.intellij.openapi.project.Project
import com.intellij.testFramework.LightVirtualFile

class SessionVirtualFile(sessionId: String, title: String, val project: Project?) : LightVirtualFile(FIXED_TAB_TITLE) {
    // The chat is a single tab that re-binds to another conversation instead of being
    // closed and reopened, so the rendered session is mutable and tracks the tab's content.
    var sessionId: String = sessionId

    init {
        isWritable = false
    }

    fun updateTitle(title: String) {
        // Tab title is fixed to "DevEco Code"; session titles are intentionally ignored.
    }

    companion object {
        private const val FIXED_TAB_TITLE = "DevEco Code"
    }
}
