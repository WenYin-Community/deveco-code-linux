package org.deveco.code.session

import com.intellij.openapi.components.Service
import org.deveco.code.session.model.SessionViewState
import java.util.concurrent.ConcurrentHashMap

@Service(Service.Level.PROJECT)
internal class SessionViewStateStore {
    private val states = ConcurrentHashMap<String, SessionViewState>()

    fun get(sessionId: String): SessionViewState? = states[sessionId]

    fun save(sessionId: String, state: SessionViewState) {
        states[sessionId] = state
    }

    fun remove(sessionId: String) {
        states.remove(sessionId)
    }
}
