package org.deveco.code.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

/**
 * Backstop for [ToolWindowPreloader]: both lifecycle listeners normally schedule the
 * preload long before the first project finishes opening; this covers a startup in which
 * neither fired early enough. Schedule is once-only, so this is a no-op when the preload
 * is already running.
 */
class ToolWindowPreloadRegistrar : ProjectActivity {
    override suspend fun execute(project: Project) {
        ToolWindowPreloader.schedule()
    }
}
