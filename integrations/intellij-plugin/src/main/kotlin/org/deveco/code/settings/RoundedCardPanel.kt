package org.deveco.code.settings

import com.intellij.ui.JBColor
import java.awt.Color
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.LayoutManager
import java.awt.Rectangle
import java.awt.RenderingHints
import java.awt.geom.Area
import java.awt.geom.RoundRectangle2D
import javax.swing.JPanel
import javax.swing.border.EmptyBorder

/**
 * Card panel with [ARC]-px rounded corners and a 1px outline, shared by the
 * model settings card and the dialog info banners.
 *
 * JComponent.paint() runs paintComponent → paintBorder → paintChildren, so an
 * outline drawn before the children is covered by any opaque child (trees,
 * scroll panes, and header rows all paint plain rectangles flush to their
 * bounds). The outline is therefore stroked in [paint] *after* super.paint() —
 * on top of the children — and the square corner cutouts the children leave
 * behind are erased with the surrounding parent background first. When [fill]
 * is given, the rounded interior is additionally filled in [paintComponent]
 * before the children paint, for cards whose children are translucent.
 *
 * The corner erasure paints with `parent.background`, which assumes the parent
 * is opaque — true for both current usages (the settings page card and the
 * dialog banners). On a transparent or image-backed parent the erased corners
 * would show that background color instead of what is actually behind them.
 */
internal class RoundedCardPanel(
    layout: LayoutManager,
    private val fill: Color? = null,
    private val outline: Color = JBColor.border(),
) : JPanel(layout) {
    init {
        isOpaque = false
        // 1px inset so children never sit directly under the stroke.
        border = EmptyBorder(1, 1, 1, 1)
    }

    override fun paintComponent(g: Graphics) {
        val f = fill
        if (f != null) {
            val g2 = g.create() as Graphics2D
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g2.color = f
            g2.fillRoundRect(0, 0, width - 1, height - 1, ARC, ARC)
            g2.dispose()
        }
        super.paintComponent(g)
    }

    override fun paint(g: Graphics) {
        super.paint(g)
        val g2 = g.create() as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        val arc = ARC.toFloat()
        val cut = Area(Rectangle(0, 0, width, height))
        cut.subtract(Area(RoundRectangle2D.Float(0f, 0f, width.toFloat(), height.toFloat(), arc, arc)))
        g2.color = parent?.background ?: background
        g2.fill(cut)
        g2.color = outline
        // Half-pixel shift centers the 1px stroke on whole pixels; without it
        // antialiasing splits the line across two pixels and it renders fuzzy.
        g2.translate(0.5, 0.5)
        g2.drawRoundRect(0, 0, width - 1, height - 1, ARC, ARC)
        g2.dispose()
    }

    private companion object {
        const val ARC = 8
    }
}
