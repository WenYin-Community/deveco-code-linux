package org.deveco.code.session.editor

import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project

/**
 * Tracks the live chat editors of a project. The chat is a single tab, but splitting the
 * editor area or docking the chat makes the platform open a second editor for the same
 * file; the registry spots that second editor the moment it is constructed, without
 * depending on which file editor manager (main frame, dock window) created it.
 */
@Service(Service.Level.PROJECT)
class SessionEditorRegistry(private val project: Project) {
    private val live = LinkedHashSet<SessionFileEditor>()

    /** Returns true when [editor] is a clone and another chat editor is already open. */
    @Synchronized
    fun register(editor: SessionFileEditor): Boolean {
        // Moving a tab between windows can build a replacement without disposing the
        // predecessor; a dropped editor can never come back, so forget it here.
        live.removeIf { !it.isValid }
        val clone = live.isNotEmpty()
        live.add(editor)
        return clone
    }

    @Synchronized
    fun unregister(editor: SessionFileEditor) {
        live.remove(editor)
    }

    /** Live chat editors, oldest first, without editors the platform already dropped. */
    @Synchronized
    fun editors(): List<SessionFileEditor> = live.filter { it.isValid }

    /**
     * The live chat editor; the chat is open whenever this is non-null. It does not require a
     * resolvable window: the component of a background tab is detached from the tabbed pane.
     */
    fun chatEditor(): SessionFileEditor? = editors().lastOrNull()

    /** The live chat editor that can be revealed, i.e. one that still belongs to a window. */
    fun attachedChatEditor(): SessionFileEditor? =
        SessionTabPolicy.revealTarget(editors()) { windowOf(project, it) != null }

    /** True while a chat editor still belongs to a window; a real close removes it from the window. */
    fun hasAttachedEditor(): Boolean = editors().any { windowOf(project, it) != null }

    /** Chat editors other than [editor]; the newest one takes the chat over from them. */
    @Synchronized
    fun others(editor: SessionFileEditor): List<SessionFileEditor> = live.filter { it !== editor && it.isValid }

    companion object {
        fun getInstance(project: Project): SessionEditorRegistry = project.getService(SessionEditorRegistry::class.java)
    }
}
