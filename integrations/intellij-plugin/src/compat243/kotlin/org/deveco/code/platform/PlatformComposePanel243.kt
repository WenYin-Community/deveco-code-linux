package org.deveco.code.platform

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.awt.ComposePanel
import org.jetbrains.jewel.bridge.JewelComposePanel
import java.awt.AWTEvent
import java.awt.BorderLayout
import java.awt.Component
import java.awt.KeyboardFocusManager
import java.awt.Toolkit
import java.awt.Window
import java.awt.event.AWTEventListener
import java.awt.event.FocusEvent
import java.awt.event.MouseEvent
import java.awt.event.WindowEvent
import java.awt.event.WindowFocusListener
import java.beans.PropertyChangeListener
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingUtilities

// Jewel 0.27's 243 bridge lacks focusOnClickInside, so returning from another
// application can leave keyboard focus in the previously focused Swing editor.
internal fun devEcoComposePanel(content: @Composable () -> Unit): JComponent {
    lateinit var composePanel: ComposePanel
    val composeFocusLost = mutableStateOf(false)
    val jewelPanel = JewelComposePanel(
        config = { composePanel = this },
        content = {
            CompositionLocalProvider(LocalDevEcoComposeFocusLost provides composeFocusLost.value) {
                content()
            }
        },
    )
    return FocusOnClickPanel(composePanel) { composeFocusLost.value = it }.apply {
        add(jewelPanel, BorderLayout.CENTER)
    }
}

private class FocusOnClickPanel(
    private val composePanel: ComposePanel,
    private val onComposeFocusLostChanged: (Boolean) -> Unit,
) : JPanel(BorderLayout()) {
    private val mouseListener = AWTEventListener { event ->
        if (
            event is MouseEvent &&
            event.id == MouseEvent.MOUSE_PRESSED &&
            SwingUtilities.isLeftMouseButton(event) &&
            isInsideComposePanel(event.component)
        ) {
            val keyboardFocusManager = KeyboardFocusManager.getCurrentKeyboardFocusManager()
            if (focusRecoveryRequired || !isInsideComposePanel(keyboardFocusManager.focusOwner)) {
                keyboardFocusManager.clearGlobalFocusOwner()
                focusRecoveryRequired = false
                composePanel.requestFocus(FocusEvent.Cause.MOUSE_EVENT)
            }
        }
    }
    private val focusOwnerListener = PropertyChangeListener { event ->
        val focusOwner = event.newValue as? Component
        val focusLost = focusOwner == null || !isInsideComposePanel(focusOwner)
        if (!focusLost) focusRecoveryRequired = false
        onComposeFocusLostChanged(focusLost)
    }
    private val windowFocusListener = object : WindowFocusListener {
        override fun windowGainedFocus(event: WindowEvent) = Unit

        override fun windowLostFocus(event: WindowEvent) {
            focusRecoveryRequired = true
            onComposeFocusLostChanged(true)
        }
    }
    private var window: Window? = null
    private var focusRecoveryRequired = false
    private var listenersInstalled = false

    override fun addNotify() {
        super.addNotify()
        if (!listenersInstalled) {
            Toolkit.getDefaultToolkit()
                .addAWTEventListener(mouseListener, AWTEvent.MOUSE_EVENT_MASK)
            KeyboardFocusManager.getCurrentKeyboardFocusManager()
                .addPropertyChangeListener("focusOwner", focusOwnerListener)
            window = SwingUtilities.getWindowAncestor(this).also {
                it?.addWindowFocusListener(windowFocusListener)
            }
            listenersInstalled = true
        }
    }

    override fun removeNotify() {
        if (listenersInstalled) {
            Toolkit.getDefaultToolkit().removeAWTEventListener(mouseListener)
            KeyboardFocusManager.getCurrentKeyboardFocusManager()
                .removePropertyChangeListener("focusOwner", focusOwnerListener)
            window?.removeWindowFocusListener(windowFocusListener)
            window = null
            listenersInstalled = false
        }
        super.removeNotify()
    }

    private fun isInsideComposePanel(component: Component?): Boolean = component != null &&
        (component === composePanel || SwingUtilities.isDescendingFrom(component, composePanel))
}
