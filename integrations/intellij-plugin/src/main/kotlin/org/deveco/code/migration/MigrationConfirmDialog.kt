package org.deveco.code.migration

import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.util.IconLoader
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import org.deveco.code.MyMessageBundle
import java.awt.BorderLayout
import javax.swing.Icon
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingConstants

/** Centered confirmation dialog (requirements §5.2): cancel/close = zero side effects. */

/**
 * Swing labels don't wrap; HTML with a fixed width is the standard workaround.
 *
 * Do not "round up" this number. Swing's legacy CSS length model maps 1px to 1.3 device
 * pixels (JDK CSS.LengthUnit.lengthMapping: `lengthMapping.put("px", 1.3f)`), so 286px lays
 * the body out at 371 actual pixels. That is what sets the zh_CN copy in three lines with the
 * first break right after "CodeGenie中": measured against the real macOS system font at 13px,
 * the matching band is 279-296px, centred on 287.5, and 286 sits inside it. The previous 400px
 * laid out at 520px and collapsed the copy into two overlong lines - the very problem this
 * width fixes.
 *
 * Headroom is thin, so treat 296 as the safe upper bound rather than something to approach: at
 * 12px the width that collapses the copy into two lines depends on the font face - 297, 305 and
 * 309 were each measured - which leaves as little as 3.85% above 286.
 *
 * The width is the only knob. No line break is hard-coded here or in the bundle, so both
 * locales still wrap naturally against their own length.
 */
private fun wrapHtml(text: String): String = "<html><body style='width: 286px'>" + text + "</body></html>"

/**
 * migration-info-light/dark.svg are the design twins shipped in resources/icons. They are
 * byte-identical — both carry the authored #3574F0 disc — so resolving a variant per call follows
 * the same rule as ArchivedSessionsConfigurable.restoreIcon() rather than producing a different
 * glyph: the badge does not change with the theme today.
 */
private fun infoIcon(): Icon {
    val bg = JBColor.background()
    val brightness = (bg.red * 0.299 + bg.green * 0.587 + bg.blue * 0.114) / 255.0
    val variant = if (brightness < 0.5) "dark" else "light"
    return IconLoader.getIcon("/icons/migration-info-$variant.svg", MigrationConfirmDialog::class.java)
}

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
            // WEST is the badge column and CENTER is the copy column, so the wrapped lines stay
            // in their own column and can never reflow underneath the badge. WEST is stretched to
            // the full panel height, hence the nested top-anchored strip: a bare JLabel in WEST
            // would centre the glyph against the whole text block instead of its first line.
            add(
                JPanel(BorderLayout()).apply {
                    border = JBUI.Borders.emptyRight(8)
                    add(JBLabel(infoIcon()), BorderLayout.NORTH)
                },
                BorderLayout.WEST,
            )
            // verticalAlignment TOP keeps the first line flush with the badge once the dialog
            // hands the label more height than it asked for (JLabel centres vertically by default).
            add(
                JBLabel(wrapHtml(MyMessageBundle.message("migration.confirm.text"))).apply {
                    horizontalAlignment = SwingConstants.LEFT
                    verticalAlignment = SwingConstants.TOP
                },
                BorderLayout.CENTER,
            )
        }
}
