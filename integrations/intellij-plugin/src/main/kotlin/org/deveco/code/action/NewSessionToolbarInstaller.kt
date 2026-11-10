package org.deveco.code.action

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger

/**
 * Owns the "New Conversation" button's membership in the IDE main toolbar
 * (`MainToolbarVCSGroup`). The action itself is declared in plugin.xml, but the
 * group membership is added at runtime, so it must be restored after a dynamic
 * re-enable (project startup activities do not re-run) and dropped before a
 * dynamic unload (ActionManager unregisters declared actions but not runtime
 * group memberships). Both directions are driven by [NewSessionToolbarLifecycle].
 */
internal object NewSessionToolbarInstaller {
    private const val ACTION_ID = "org.deveco.code.action.NewSessionToolbarAction"
    private const val TOOLBAR_GROUP_ID = "MainToolbarVCSGroup"

    private val log = Logger.getInstance(NewSessionToolbarInstaller::class.java)

    /** Adds the action to the main toolbar group if absent; safe from any thread. */
    fun ensureAdded() {
        ApplicationManager.getApplication().invokeLater(::addToGroup)
    }

    private fun addToGroup() {
        try {
            val am = ActionManager.getInstance()
            val action = am.getAction(ACTION_ID) ?: return
            val group = am.getAction(TOOLBAR_GROUP_ID)
            if (group !is DefaultActionGroup) {
                log.warn("$TOOLBAR_GROUP_ID not found")
                return
            }
            if (group.childActionsOrStubs.none { am.getId(it) == ACTION_ID }) {
                group.add(action)
                log.info("$ACTION_ID added to $TOOLBAR_GROUP_ID")
            }
        } catch (e: Exception) {
            log.warn("Failed to register $ACTION_ID", e)
        }
    }

    /**
     * Removes the action from the main toolbar group before a dynamic unload.
     * Children are matched by action id and by class, so removal still works if
     * ActionManager has already unregistered the id.
     */
    fun removeFromGroup() {
        val app = ApplicationManager.getApplication()
        if (app.isDispatchThread) {
            removeFromGroupOnEdt()
        } else {
            app.invokeLater(::removeFromGroupOnEdt)
        }
    }

    private fun removeFromGroupOnEdt() {
        try {
            val am = ActionManager.getInstance()
            val group = am.getAction(TOOLBAR_GROUP_ID)
            if (group !is DefaultActionGroup) {
                log.warn("$TOOLBAR_GROUP_ID not found")
                return
            }
            val stale = group.childActionsOrStubs.filter {
                it is NewSessionToolbarAction || am.getId(it) == ACTION_ID
            }
            if (stale.isEmpty()) return
            for (child in stale) {
                group.remove(child)
            }
            log.info("$ACTION_ID removed from $TOOLBAR_GROUP_ID")
        } catch (e: Exception) {
            log.warn("Failed to unregister $ACTION_ID", e)
        }
    }
}
