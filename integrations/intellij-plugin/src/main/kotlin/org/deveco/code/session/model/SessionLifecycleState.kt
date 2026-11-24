package org.deveco.code.session.model

internal data class SessionLifecycleState(
    val started: Boolean = false,
    val phase: SessionPhase = SessionPhase.NEW,
    val hasAttachedEditor: Boolean = false,
    internal val onIdle: (() -> Unit)? = null,
) {
    val isStarted: Boolean get() = started

    val isLoaded: Boolean get() = phase == SessionPhase.READY

    val isHeadless: Boolean get() = !hasAttachedEditor

    val isDisposed: Boolean get() = phase == SessionPhase.DISPOSED
}

internal enum class SessionPhase {
    NEW,
    LOADING,
    READY,
    FAILED,
    DISPOSED,
}
