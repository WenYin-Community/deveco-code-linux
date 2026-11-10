package org.deveco.code.toolwindow

import com.intellij.ide.AppLifecycleListener
import com.intellij.ide.plugins.DynamicPluginListener
import com.intellij.ide.plugins.IdeaPluginDescriptor
import com.intellij.ide.plugins.PluginManagerCore

/**
 * Starts the background UI class preload once per plugin classloader lifetime: at app
 * creation for a normal startup, and again when this plugin is dynamically (re)loaded with
 * a fresh classloader (the preloader's once-guard lives in the old loader and cannot carry
 * over). Registered via `<applicationListeners>` so the platform subscribes and
 * unsubscribes it with the plugin's own lifetime.
 */
class ToolWindowPreloadLifecycle :
    AppLifecycleListener,
    DynamicPluginListener {
    override fun appFrameCreated(commandLineArgs: List<String>) {
        ToolWindowPreloader.schedule()
    }

    override fun pluginLoaded(pluginDescriptor: IdeaPluginDescriptor) {
        // Gated on this plugin's own descriptor so other plugins' loads stay no-ops.
        if (PluginManagerCore.getPluginByClassName(ToolWindowPreloadLifecycle::class.java.name) ==
            pluginDescriptor.pluginId
        ) {
            ToolWindowPreloader.schedule()
        }
    }
}
