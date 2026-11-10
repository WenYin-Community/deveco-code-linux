package org.deveco.code.action

import com.intellij.ide.plugins.DynamicPluginListener
import com.intellij.ide.plugins.IdeaPluginDescriptor
import com.intellij.ide.plugins.PluginManagerCore

/**
 * Keeps the "New Conversation" toolbar button in sync with this plugin's dynamic
 * lifecycle: re-adds it when the plugin is re-enabled while projects are open
 * (project startup activities do not re-run after a disable/enable cycle), and
 * removes it before a dynamic unload. `pluginLoaded` fires after the plugin's
 * actions are registered, and `beforePluginUnload` fires before ActionManager
 * unregisters them, so both can act on the action directly.
 *
 * Registered via `<applicationListeners>` so the platform subscribes and
 * unsubscribes it with the plugin's own lifetime.
 */
class NewSessionToolbarLifecycle : DynamicPluginListener {
    override fun pluginLoaded(pluginDescriptor: IdeaPluginDescriptor) {
        // Idempotent: a no-op when other plugins load, and when this plugin is
        // disabled its action id is not registered.
        NewSessionToolbarInstaller.ensureAdded()
    }

    override fun beforePluginUnload(pluginDescriptor: IdeaPluginDescriptor, updateServices: Boolean) {
        if (!isOurPlugin(pluginDescriptor)) return
        NewSessionToolbarInstaller.removeFromGroup()
    }

    private fun isOurPlugin(pluginDescriptor: IdeaPluginDescriptor): Boolean =
        PluginManagerCore.getPluginByClassName(NewSessionToolbarLifecycle::class.java.name) ==
            pluginDescriptor.pluginId
}
