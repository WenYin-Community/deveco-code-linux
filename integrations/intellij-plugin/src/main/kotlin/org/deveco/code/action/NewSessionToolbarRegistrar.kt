package org.deveco.code.action

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

/**
 * Adds the "New Conversation" button to the main toolbar when a project opens.
 * Dynamic plugin (re)loads are covered by [NewSessionToolbarLifecycle], since
 * project startup activities do not re-run after a disable/enable cycle.
 */
class NewSessionToolbarRegistrar : ProjectActivity {
    override suspend fun execute(project: Project) {
        NewSessionToolbarInstaller.ensureAdded()
    }
}
