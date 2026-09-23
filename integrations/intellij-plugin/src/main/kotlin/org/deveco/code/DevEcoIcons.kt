package org.deveco.code

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.luminance
import org.jetbrains.jewel.ui.icon.IconKey
import org.jetbrains.jewel.ui.icon.PathIconKey

object DevEcoIcons {
    private val isDark: Boolean get() = DevEcoTheme.panel.luminance() < 0.5f
    private val loaderClass: Class<*> get() = DevEcoIcons::class.java

    @Composable
    fun iconKey(name: String, ext: String = "svg"): IconKey {
        val dark = isDark
        return remember(name, dark, ext) {
            val variant = if (dark) "dark" else "light"
            PathIconKey("/icons/$name-$variant.$ext", loaderClass)
        }
    }
}
