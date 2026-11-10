package org.deveco.code.platform

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import org.jetbrains.jewel.bridge.JewelComposePanel
import javax.swing.JComponent

internal fun devEcoComposePanel(content: @Composable () -> Unit): JComponent = JewelComposePanel {
    CompositionLocalProvider(LocalDevEcoComposeFocusLost provides false) {
        content()
    }
}
