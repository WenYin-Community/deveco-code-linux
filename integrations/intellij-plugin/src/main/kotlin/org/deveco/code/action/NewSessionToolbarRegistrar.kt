package org.deveco.code.action

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

class NewSessionToolbarRegistrar : ProjectActivity {
    private val log = Logger.getInstance(NewSessionToolbarRegistrar::class.java)
    private val ACTION_ID = "org.deveco.code.action.NewSessionToolbarAction"

    override suspend fun execute(project: Project) {
        ApplicationManager.getApplication().invokeLater {
            try {
                val am = ActionManager.getInstance()
                val action = am.getAction(ACTION_ID) ?: return@invokeLater

                val vcsGroup = am.getAction("MainToolbarVCSGroup")
                if (vcsGroup is DefaultActionGroup) {
                    val alreadyAdded = vcsGroup.childActionsOrStubs.any {
                        am.getId(it) == ACTION_ID
                    }
                    if (!alreadyAdded) {
                        vcsGroup.add(action)
                        log.info("NewSessionToolbarAction added to MainToolbarVCSGroup")
                    }
                    return@invokeLater
                }
                log.warn("MainToolbarVCSGroup not found")
            } catch (e: Exception) {
                log.warn("Failed to register NewSessionToolbarAction", e)
            }
        }
    }
}
