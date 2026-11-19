package org.deveco.code.session.editor

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.serviceContainer.ComponentManagerImpl
import com.intellij.testFramework.LightPlatformTestCase
import com.intellij.testFramework.LightVirtualFile
import com.intellij.util.ui.UIUtil
import org.deveco.code.acp.AcpClientService
import org.deveco.code.acp.SharedAcpBackend
import org.deveco.code.action.DevEcoSessionActions
import org.deveco.code.session.SessionControllerRegistry
import org.deveco.code.session.SessionModelStore
import org.deveco.code.session.SessionViewStateStore
import org.deveco.code.session.TokenUsageStore
import org.deveco.code.util.PluginStateFiles
import java.nio.file.Files

/**
 * Platform-fixture unit tests for the chat editor machinery: the fixed-title
 * [SessionVirtualFile], [SessionFileEditorProvider]'s accept/reject contract,
 * [SessionFileIconProvider], [SessionEditorRegistry]'s clone tracking, and the
 * [SessionFileEditor] lifecycle (create → registry tracking → re-bind → dispose)
 * against a disconnected backend.
 */
class SessionEditorTest : LightPlatformTestCase() {

    private lateinit var viewStateStore: SessionViewStateStore
    private lateinit var controllerRegistry: SessionControllerRegistry

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
        viewStateStore = SessionViewStateStore()
        (project as ComponentManagerImpl).replaceServiceInstance(
            SessionViewStateStore::class.java,
            viewStateStore,
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
    }

    override fun tearDown() {
        controllerRegistry.dispose()
        super.tearDown()
    }

    private fun sessionFile(sessionId: String, project: Project = getProject()) =
        SessionVirtualFile(sessionId, "Title for $sessionId", project)

    fun testVirtualFileKeepsFixedTabTitleAndAllowsSessionRebind() {
        val file = sessionFile("s1")

        assertEquals("DevEco Code", file.name)
        assertFalse(file.isWritable)
        assertEquals("s1", file.sessionId)

        file.sessionId = "s2"
        assertEquals("s2", file.sessionId)

        file.updateTitle("Ignored session title")
        assertEquals("DevEco Code", file.name)
    }

    fun testProviderAcceptsOnlySessionVirtualFiles() {
        val provider = SessionFileEditorProvider()

        assertTrue(provider.accept(getProject(), sessionFile("s1")))
        assertFalse(provider.accept(getProject(), LightVirtualFile("plain.md")))
    }

    fun testProviderExposesStableIdAndHidesTheDefaultEditor() {
        val provider = SessionFileEditorProvider()

        assertEquals("deveco-session-chat", provider.getEditorTypeId())
        assertEquals(FileEditorPolicy.HIDE_DEFAULT_EDITOR, provider.getPolicy())
        assertTrue(provider is DumbAware)
    }

    fun testIconProviderIconsOnlySessionFiles() {
        val icons = SessionFileIconProvider()

        assertNotNull(icons.getIcon(sessionFile("s1"), 0, getProject()))
        assertNull(icons.getIcon(LightVirtualFile("plain.md"), 0, getProject()))
    }

    fun testCreateEditorTracksRegistryAndDisposesCleanly() {
        val file = sessionFile("s1")
        val editor = SessionFileEditorProvider().createEditor(getProject(), file) as SessionFileEditor

        assertTrue(editor.isValid)
        assertFalse(editor.isModified)
        assertSame(file, editor.getFile())
        assertSame(file, editor.sessionFile)
        assertTrue(editor.name.isNotBlank())

        val registry = SessionEditorRegistry.getInstance(getProject())
        assertSame(editor, registry.chatEditor())

        editor.dispose()

        assertFalse(editor.isValid)
        assertTrue(registry.editors().isEmpty())
        assertNull(registry.chatEditor())
    }

    fun testSecondEditorIsARegisteredCloneAndOthersListIt() {
        val first = SessionFileEditor(getProject(), sessionFile("s1"))
        val second = SessionFileEditor(getProject(), sessionFile("s1"))

        // A fresh registry reports the first registration as the original and
        // every later one as a clone of an already-open chat editor.
        val registry = SessionEditorRegistry(getProject())
        assertFalse(registry.register(first))
        assertTrue(registry.register(second))

        assertEquals(listOf(second), registry.others(first))
        assertEquals(listOf(first, second), registry.editors())
        assertSame(second, registry.chatEditor())

        first.dispose()
        second.dispose()
        UIUtil.dispatchAllInvocationEvents()

        assertTrue(registry.editors().isEmpty())
    }

    fun testSwitchToRebindsFileAndControllerAndPersistsPreviousState() {
        val file = sessionFile("s1")
        val editor = SessionFileEditor(getProject(), file)
        val originalController = editor.controller

        editor.switchTo("s2")

        assertEquals("s2", file.sessionId)
        assertEquals("s2", editor.sessionFile.sessionId)
        assertNotSame(originalController, editor.controller)
        assertNotNull(viewStateStore.get("s1"))
        assertNull(viewStateStore.get("s2"))

        editor.dispose()
    }

    fun testDisposePersistsViewStateForTheBoundSession() {
        val editor = SessionFileEditor(getProject(), sessionFile("s1"))

        editor.dispose()

        val state = viewStateStore.get("s1")
        assertNotNull(state)
        assertTrue(state!!.followTail)
    }
}
