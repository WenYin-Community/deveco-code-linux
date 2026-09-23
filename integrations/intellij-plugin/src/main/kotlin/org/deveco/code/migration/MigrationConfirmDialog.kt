package org.deveco.code.migration

import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import org.deveco.code.MyMessageBundle
import java.awt.BorderLayout
import javax.swing.JComponent
import javax.swing.JPanel

/** Centered confirmation dialog (requirements §5.2): cancel/close = zero side effects. */

/** Swing labels don't wrap; HTML with a fixed width is the standard workaround. */
private fun wrapHtml(text: String): String = "<html><body style='width: 400px'>" + text + "</body></html>"
class MigrationConfirmDialog : DialogWrapper(true) {
    init {
        title = MyMessageBundle.message("migration.confirm.title")
        setOKButtonText(MyMessageBundle.message("migration.confirm.ok"))
        setCancelButtonText(MyMessageBundle.message("migration.confirm.cancel"))
        init()
    }

    override fun createCenterPanel(): JComponent =
        JPanel(BorderLayout(0, 0)).apply {
            border = JBUI.Borders.empty(4, 8)
            add(
                JBLabel(wrapHtml(MyMessageBundle.message("migration.confirm.text"))),
                BorderLayout.CENTER,
            )
        }
}
