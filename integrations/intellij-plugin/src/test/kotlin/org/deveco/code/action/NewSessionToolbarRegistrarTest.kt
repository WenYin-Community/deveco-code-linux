package org.deveco.code.action

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.testFramework.LightPlatformTestCase
import com.intellij.util.ui.UIUtil
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue

/**
 * Tests for the "New Conversation" main-toolbar membership lifecycle
 * ([NewSessionToolbarInstaller] as driven by [NewSessionToolbarRegistrar] and
 * [NewSessionToolbarLifecycle]): ensureAdded() adds the action to
 * MainToolbarVCSGroup exactly once (idempotent), removeFromGroup() drops it
 * again.
 *
 * When the test platform has not registered the plugin's declared actions or
 * groups, the test registers them under their plugin.xml ids first so the
 * installer finds the same registry entries the real IDE has; anything
 * registered here is unregistered again in tearDown to keep the shared
 * ActionManager clean across tests.
 */
class NewSessionToolbarRegistrarTest : LightPlatformTestCase() {

    private val actionId = "org.deveco.code.action.NewSessionToolbarAction"
    private val groupId = "MainToolbarVCSGroup"
    private val registeredHere = mutableListOf<String>()

    override fun tearDown() {
        val am = ActionManager.getInstance()
        NewSessionToolbarInstaller.removeFromGroup()
        registeredHere.reversed().forEach(am::unregisterAction)
        registeredHere.clear()
        super.tearDown()
    }

    private fun ensureActionRegistered() {
        val am = ActionManager.getInstance()
        if (am.getAction(actionId) == null) {
            am.registerAction(actionId, NewSessionToolbarAction())
            registeredHere.add(actionId)
        }
    }

    private fun ensureGroupRegistered(): DefaultActionGroup {
        val am = ActionManager.getInstance()
        val existing = am.getAction(groupId)
        if (existing is DefaultActionGroup) return existing
        val group = DefaultActionGroup()
        am.registerAction(groupId, group)
        registeredHere.add(groupId)
        return group
    }

    private fun occurrences(group: DefaultActionGroup): Int {
        val am = ActionManager.getInstance()
        return group.childActionsOrStubs.count { am.getId(it) == actionId }
    }

    fun testEnsureAddedAddsTheActionToTheToolbarGroupOnce() {
        ensureActionRegistered()
        val group = ensureGroupRegistered()

        NewSessionToolbarInstaller.ensureAdded()
        UIUtil.dispatchAllInvocationEvents()
        assertEquals(1, occurrences(group))

        NewSessionToolbarInstaller.ensureAdded()
        UIUtil.dispatchAllInvocationEvents()
        assertEquals(1, occurrences(group))
    }

    fun testRemoveFromGroupDropsTheActionAgain() {
        ensureActionRegistered()
        val group = ensureGroupRegistered()

        NewSessionToolbarInstaller.ensureAdded()
        UIUtil.dispatchAllInvocationEvents()
        assertTrue(occurrences(group) > 0)

        NewSessionToolbarInstaller.removeFromGroup()
        UIUtil.dispatchAllInvocationEvents()
        assertEquals(0, occurrences(group))
        assertFalse(group.childActionsOrStubs.any { it is NewSessionToolbarAction })
    }
}
