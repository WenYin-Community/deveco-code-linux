package org.deveco.code.skill

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/**
 * Application-scoped (user-level) store for global skill selection state.
 *
 * Global skills are shared across projects, so their enabled/selected flag
 * must live at the user level rather than under a project's `.idea/`. This
 * service persists `skill name -> enabled` in `deveco-skill-state.xml` in the
 * IDE config directory. Project-scoped skills keep using the per-project
 * `.idea/deveco-skill-state.properties` file handled by [SkillStore].
 *
 * Declared as an applicationService in plugin.xml (not a light service): see
 * the service declarations there for the dynamic-reload rationale.
 */
@State(name = "DevEcoGlobalSkillState", storages = [Storage("deveco-skill-state.xml")])
internal class GlobalSkillStateService : PersistentStateComponent<GlobalSkillStateService.MyState> {
    private var state = MyState()

    override fun getState(): MyState = state
    override fun loadState(loaded: MyState) {
        state = loaded
    }

    fun isEnabled(name: String): Boolean = state.enabled[name] ?: true

    fun setEnabled(name: String, enabled: Boolean) {
        state.enabled[name] = enabled
    }

    fun remove(name: String) {
        state.enabled.remove(name)
    }

    class MyState {
        var enabled: MutableMap<String, Boolean> = java.util.concurrent.ConcurrentHashMap()
    }

    companion object {
        fun getInstance(): GlobalSkillStateService =
            ApplicationManager.getApplication().getService(GlobalSkillStateService::class.java)
    }
}
