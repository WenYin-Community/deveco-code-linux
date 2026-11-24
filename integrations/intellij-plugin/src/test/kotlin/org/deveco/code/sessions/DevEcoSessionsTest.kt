package org.deveco.code.sessions

import com.intellij.openapi.application.ApplicationManager
import com.intellij.serviceContainer.ComponentManagerImpl
import com.intellij.testFramework.LightPlatformTestCase
import org.deveco.code.acp.AcpClientService
import org.deveco.code.acp.SharedAcpBackend
import org.deveco.code.action.DevEcoSessionActions
import org.deveco.code.session.SessionControllerRegistry
import org.deveco.code.session.SessionModelStore
import org.deveco.code.session.SessionStorage
import org.deveco.code.session.SessionViewStateStore
import org.deveco.code.session.TokenUsageStore
import org.deveco.code.session.editor.SessionEditorRegistry
import org.deveco.code.session.editor.SessionFileEditor
import org.deveco.code.session.editor.SessionVirtualFile
import org.deveco.code.session.model.FileReference
import org.deveco.code.util.PluginStateFiles
import java.nio.file.Files

/**
 * Platform-fixture unit tests for the session-ops layer behind the sessions
 * sidebar, all against a disconnected ACP backend:
 *  - [SessionOps.openSession] cold path (no live editor): last-active
 *    persistence, unread → read transition, activation reporting.
 *  - [SessionOps.openSession] re-bind path with a live chat editor: the open
 *    editor's file is switched to the new session in place.
 *  - [SessionOps.jumpToSession] fast path (tab already open): synchronous
 *    re-bind plus [DevEcoSessionActions.lastJumpSessionId] bookkeeping, no
 *    backend round-trip.
 *
 * The tab-placement helpers (placeChatTabFirst/revealChatTab) are silent
 * no-ops under the test editor manager (TestEditorManagerImpl is not a
 * FileEditorManagerImpl), so these tests drive openSession with live editors
 * constructed directly — which register into the replaced
 * [SessionEditorRegistry] exactly like platform-opened ones — and assert on
 * the re-bind state instead of on FileEditorManager's open-file list.
 */
class DevEcoSessionsTest : LightPlatformTestCase() {

    private lateinit var actions: DevEcoSessionActions
    private lateinit var controllerRegistry: SessionControllerRegistry
    private lateinit var activatedIds: MutableList<String>

    override fun setUp() {
        super.setUp()
        val project = getProject()
        Files.deleteIfExists(PluginStateFiles.path(project, "sessions.properties"))
        Files.deleteIfExists(PluginStateFiles.path(project, "token-usage.json"))
        Files.deleteIfExists(PluginStateFiles.globalPath("models.json"))
        (ApplicationManager.getApplication() as ComponentManagerImpl).replaceServiceInstance(
            SharedAcpBackend::class.java,
            SharedAcpBackend(),
            testRootDisposable,
        )
        (project as ComponentManagerImpl).replaceServiceInstance(
            AcpClientService::class.java,
            AcpClientService(project),
            testRootDisposable,
        )
        (project as ComponentManagerImpl).replaceServiceInstance(
            SessionViewStateStore::class.java,
            SessionViewStateStore(),
            testRootDisposable,
        )
        (project as ComponentManagerImpl).replaceServiceInstance(
            DevEcoSessionActions::class.java,
            DevEcoSessionActions(project),
            testRootDisposable,
        )
        (project as ComponentManagerImpl).replaceServiceInstance(
            SessionModelStore::class.java,
            SessionModelStore(project),
            testRootDisposable,
        )
        (project as ComponentManagerImpl).replaceServiceInstance(
            TokenUsageStore::class.java,
            TokenUsageStore(project),
            testRootDisposable,
        )
        controllerRegistry = SessionControllerRegistry(project)
        (project as ComponentManagerImpl).replaceServiceInstance(
            SessionControllerRegistry::class.java,
            controllerRegistry,
            testRootDisposable,
        )
        (project as ComponentManagerImpl).replaceServiceInstance(
            SessionEditorRegistry::class.java,
            SessionEditorRegistry(project),
            testRootDisposable,
        )
        actions = project.getService(DevEcoSessionActions::class.java)!!
        activatedIds = mutableListOf()
        actions.ops.onSessionActivated = { id -> activatedIds.add(id) }
    }

    override fun tearDown() {
        controllerRegistry.dispose()
        super.tearDown()
    }

    private fun openLiveEditor(sessionId: String): SessionFileEditor =
        SessionFileEditor(getProject(), SessionVirtualFile(sessionId, "Title for $sessionId", getProject()))

    fun testOpenSessionPersistsLastActiveAndReportsActivation() {
        actions.ops.openSession("s1", "First conversation")

        assertEquals("s1", SessionStorage.lastActiveSessionId(getProject()))
        assertEquals(listOf("s1"), activatedIds)
    }

    fun testOpenSessionMarksUnreadSessionRead() {
        SessionStorage.markUnread(getProject(), "s1")
        assertTrue(SessionStorage.unreadIds(getProject()).contains("s1"))

        actions.ops.openSession("s1", "First conversation")

        assertFalse(SessionStorage.unreadIds(getProject()).contains("s1"))
    }

    fun testOpenSessionRebindsLiveEditorInPlace() {
        val editor = openLiveEditor("s1")
        val originalFile = editor.sessionFile

        actions.ops.openSession("s2", "Second conversation")

        // The live chat editor keeps its file instance, re-bound to s2.
        assertSame(originalFile, editor.sessionFile)
        assertEquals("s2", editor.sessionFile.sessionId)
        assertEquals("s2", SessionEditorRegistry.getInstance(getProject()).chatEditor()?.sessionFile?.sessionId)
        assertEquals("s2", SessionStorage.lastActiveSessionId(getProject()))
        assertEquals(listOf("s2"), activatedIds)
    }

    fun testJumpToSessionFastPathRebindsOpenTabWithoutBackend() {
        val editor = openLiveEditor("s1")

        actions.ops.jumpToSession(
            sessionId = "s2",
            fileRef = FileReference("a.txt", 1, 2),
            onStateChange = { },
            onRefresh = { },
        )

        assertEquals("s2", actions.lastJumpSessionId)
        assertEquals("s2", editor.sessionFile.sessionId)
        assertEquals("s2", SessionStorage.lastActiveSessionId(getProject()))
        assertEquals(listOf("s2"), activatedIds)
    }
}
