package org.deveco.code.action

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.actionSystem.Presentation
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.serviceContainer.ComponentManagerImpl
import com.intellij.testFramework.LightPlatformTestCase
import com.intellij.testFramework.LightVirtualFile
import com.intellij.util.ui.UIUtil
import org.deveco.code.acp.AcpClientService
import org.deveco.code.acp.SharedAcpBackend
import org.deveco.code.session.SessionControllerRegistry
import org.deveco.code.session.SessionModelStore
import org.deveco.code.session.SessionViewStateStore
import org.deveco.code.session.TokenUsageStore
import org.deveco.code.session.editor.SessionEditorRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Tests for the IDE entry-point actions against a replaced
 * [DevEcoSessionActions] service with recording handlers (no ACP backend):
 *  - [NewSessionAction] availability depends on the project being present in
 *    the event, and actionPerformed delegates to the configured handler.
 *  - [NewSessionToolbarAction] update() disables while [DevEcoSessionActions.busy].
 *  - [DevEcoSessionActions.newSession] busy-guard semantics (skip when busy,
 *    reset busy when the handler throws).
 *  - [QuickChatAction] turns the current selection into a pending file
 *    reference and requires editor, file, and selection.
 *  - [JumpToChatAction] visibility follows the selection.
 */
class ActionsTest : LightPlatformTestCase() {

    private lateinit var actions: DevEcoSessionActions
    private lateinit var action: NewSessionAction
    private lateinit var invoked: AtomicBoolean
    private val releasedEditors = mutableListOf<Editor>()

    override fun setUp() {
        super.setUp()
        val project = getProject()
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
            SessionModelStore::class.java,
            SessionModelStore(project),
            testRootDisposable,
        )
        (project as ComponentManagerImpl).replaceServiceInstance(
            TokenUsageStore::class.java,
            TokenUsageStore(project),
            testRootDisposable,
        )
        (project as ComponentManagerImpl).replaceServiceInstance(
            SessionControllerRegistry::class.java,
            SessionControllerRegistry(project),
            testRootDisposable,
        )
        (project as ComponentManagerImpl).replaceServiceInstance(
            SessionEditorRegistry::class.java,
            SessionEditorRegistry(project),
            testRootDisposable,
        )
        (project as ComponentManagerImpl).replaceServiceInstance(
            DevEcoSessionActions::class.java,
            DevEcoSessionActions(project),
            testRootDisposable,
        )
        actions = project.getService(DevEcoSessionActions::class.java)!!
        action = NewSessionAction()
        invoked = AtomicBoolean(false)
        actions.newSessionHandler = { invoked.set(true) }
    }

    override fun tearDown() {
        releasedEditors.forEach(EditorFactory.getInstance()::releaseEditor)
        super.tearDown()
    }

    private fun event(project: Project?, editor: Editor? = null, virtualFile: VirtualFile? = null): AnActionEvent =
        AnActionEvent(
            null,
            DataContext { dataId ->
                when (dataId) {
                    CommonDataKeys.PROJECT.name -> project
                    CommonDataKeys.EDITOR.name -> editor
                    CommonDataKeys.VIRTUAL_FILE.name -> virtualFile
                    else -> null
                }
            },
            ActionPlaces.EDITOR_POPUP,
            Presentation(),
            ActionManager.getInstance(),
            0,
        )

    private fun editorWithSelection(content: String, selection: Pair<Int, Int>, select: Boolean): Editor {
        val document = EditorFactory.getInstance().createDocument(content)
        val editor = EditorFactory.getInstance().createEditor(document, getProject())
        releasedEditors.add(editor)
        if (select) {
            editor.selectionModel.setSelection(selection.first, selection.second)
        }
        return editor
    }

    fun testNewSessionActionUpdateFollowsProjectPresence() {
        val withProject = event(getProject())
        action.update(withProject)
        assertTrue(withProject.presentation.isEnabledAndVisible)
        assertNotNull(withProject.presentation.text)

        val withoutProject = event(null)
        action.update(withoutProject)
        assertFalse(withoutProject.presentation.isEnabledAndVisible)
    }

    fun testNewSessionActionInvokesConfiguredHandler() {
        action.actionPerformed(event(getProject()))

        assertTrue(invoked.get())
    }

    fun testNewSessionActionWithoutProjectIsANoOp() {
        action.actionPerformed(event(null))

        assertFalse(invoked.get())
    }

    fun testNewSessionBusyFlagGuardsConcurrentTriggers() {
        actions.busy = true
        actions.newSession()
        assertFalse(invoked.get())

        actions.busy = false
        actions.newSession()
        assertTrue(invoked.get())
    }

    fun testNewSessionResetsBusyWhenHandlerThrows() {
        actions.newSessionHandler = { throw IllegalStateException("handler failed") }

        assertThrows(IllegalStateException::class.java) { actions.newSession() }

        assertFalse(actions.busy)
    }

    fun testToolbarActionUpdateDisablesWhileBusy() {
        val toolbarAction = NewSessionToolbarAction()

        actions.busy = true
        val whileBusy = event(getProject())
        toolbarAction.update(whileBusy)
        assertFalse(whileBusy.presentation.isEnabled)
        assertTrue(whileBusy.presentation.isVisible)

        actions.busy = false
        val whileIdle = event(getProject())
        toolbarAction.update(whileIdle)
        assertTrue(whileIdle.presentation.isEnabled)
    }

    fun testQuickChatActionStagesSelectionAsNextSessionHandoff() {
        val editor = editorWithSelection("first\nsecond\nthird", 6 to 12, select = true)
        val virtualFile = LightVirtualFile("sample.txt", "first\nsecond\nthird")

        QuickChatAction().actionPerformed(event(getProject(), editor, virtualFile))

        assertTrue(invoked.get())
        val reference = actions.takeHandoff("unused-session")?.fileReference
        assertNotNull(reference)
        assertEquals(virtualFile.path, reference!!.path)
        assertEquals(2, reference.startLine)
        assertEquals(2, reference.endLine)
    }

    fun testQuickChatActionRequiresASelection() {
        val editor = editorWithSelection("first\nsecond", 0 to 0, select = false)
        val virtualFile = LightVirtualFile("sample.txt", "first\nsecond")

        QuickChatAction().actionPerformed(event(getProject(), editor, virtualFile))

        assertFalse(invoked.get())
        assertNull(actions.takeHandoff("unused-session"))
    }

    fun testQuickChatActionRequiresEditorAndFile() {
        val virtualFile = LightVirtualFile("sample.txt", "content")
        QuickChatAction().actionPerformed(event(getProject(), null, virtualFile))
        QuickChatAction().actionPerformed(event(getProject(), null, null))

        assertFalse(invoked.get())
        assertNull(actions.takeHandoff("unused-session"))
    }

    fun testJumpToChatActionVisibilityAndChildrenFollowSelection() {
        val group = JumpToChatAction()
        val withSelection = event(
            getProject(),
            editorWithSelection("first\nsecond", 0 to 5, select = true),
        )
        group.update(withSelection)
        assertTrue(withSelection.presentation.isEnabledAndVisible)
        assertEquals(1, group.getChildren(withSelection).size)
        assertTrue(group.getChildren(withSelection).first() is QuickChatAction)

        val withoutSelection = event(
            getProject(),
            editorWithSelection("first\nsecond", 0 to 0, select = false),
        )
        group.update(withoutSelection)
        assertFalse(withoutSelection.presentation.isEnabledAndVisible)

        UIUtil.dispatchAllInvocationEvents()
    }
}
