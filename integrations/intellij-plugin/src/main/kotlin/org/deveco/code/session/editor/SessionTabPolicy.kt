package org.deveco.code.session.editor

/**
 * Rules that keep the single chat tab alive across session switches, splits and window
 * moves. Kept pure so they can be unit-tested without an IDE fixture.
 */
internal object SessionTabPolicy {
    /** True when [targetSessionId] is another conversation than the one the tab renders. */
    fun requiresRebind(boundSessionId: String, targetSessionId: String): Boolean = boundSessionId != targetSessionId

    /**
     * The chat file to keep using: the live editor's file wins, then whatever a file editor
     * manager lists (a tab created before the registry saw it), then the remembered file.
     * A null result means no tab exists and one has to be created.
     */
    fun <T : Any> pickChatFile(liveFile: T?, listedFiles: List<T>, rememberedFile: T?): T? =
        liveFile ?: listedFiles.firstOrNull() ?: rememberedFile

    /**
     * The candidate to act on: the newest one that still has a window, else the newest live
     * one. A tab moved between windows can leave an editor that is live but detached.
     */
    fun <T> revealTarget(candidates: List<T>, hasWindow: (T) -> Boolean): T? =
        candidates.lastOrNull(hasWindow) ?: candidates.lastOrNull()
}
