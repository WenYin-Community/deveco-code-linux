package org.deveco.code.session

import org.deveco.code.session.model.SessionViewState
import java.util.concurrent.ConcurrentHashMap

internal class SessionViewStateStore {
    private val states = ConcurrentHashMap<String, SessionViewState>()
    private val promptHistories = ConcurrentHashMap<String, List<PromptHistoryEntry>>()

    fun get(sessionId: String): SessionViewState? = states[sessionId]

    fun save(sessionId: String, state: SessionViewState) {
        states[sessionId] = state
    }

    // Atomic read-modify-write: multiple writers touch one session's state
    // (draft from the editor, selectedModelId from the controller), and a
    // plain get+save pair could drop a concurrent field update. A null
    // return removes the entry.
    fun update(sessionId: String, transform: (SessionViewState?) -> SessionViewState?) {
        states.compute(sessionId) { _, existing -> transform(existing) }
    }

    fun remove(sessionId: String) {
        states.remove(sessionId)
        promptHistories.remove(sessionId)
    }

    fun getPromptHistory(sessionId: String): List<PromptHistoryEntry>? = promptHistories[sessionId]

    fun savePromptHistory(sessionId: String, history: List<PromptHistoryEntry>) {
        promptHistories[sessionId] = history
    }
}
