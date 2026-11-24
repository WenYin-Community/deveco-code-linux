package org.deveco.code.announcement

import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.notification.impl.NotificationsManagerImpl
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.ui.popup.JBPopupListener
import com.intellij.openapi.ui.popup.LightweightWindowEvent
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.IconLoader
import com.intellij.openapi.util.Ref
import com.intellij.openapi.util.registry.Registry
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.wm.IdeFrame
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.BalloonImpl
import com.intellij.ui.BalloonLayoutData
import com.intellij.ui.BalloonLayoutImpl
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import org.deveco.code.MyMessageBundle
import java.awt.Rectangle
import javax.swing.SwingUtilities
import javax.swing.event.HyperlinkEvent

private val log = logger<AnnouncementBalloons>()

/** Owns this project's announcement entries in the IDE's native balloon layout. EDT only. */
internal class AnnouncementBalloons(
    val frame: IdeFrame,
    private val layout: BalloonLayoutImpl,
    private val dismiss: (AnnouncementKey) -> Unit,
    requestRender: () -> Unit,
) {
    private val visible = mutableMapOf<AnnouncementKey, BalloonImpl>()
    private val layoutChanged = Runnable(requestRender)

    init {
        layout.addListener(layoutChanged)
    }

    fun show(unread: Map<AnnouncementKey, Announcement>) {
        visible.keys.filterNot(unread::containsKey).forEach { key -> visible.remove(key)?.hide() }
        val limit = Registry.intValue("ide.notification.visible.count", 2).coerceAtLeast(1)
        val project = frame.project ?: return
        val height = SwingUtilities.getRootPane(frame.component)?.layeredPane?.height ?: return
        if (height <= 0) return

        for ((key, announcement) in unread) {
            if (key in visible) continue
            val count = layout.balloonCount
            if (count >= limit) break
            val data = BalloonLayoutData.createEmpty().apply {
                this.project = project
                type = NotificationType.INFORMATION
            }
            val icon = project.getServiceIfCreated(ToolWindowManager::class.java)?.getToolWindow("DevEco Code")?.icon
                ?: IconLoader.getIcon(
                    if (JBColor.isBright()) "/icons/icon-light.svg" else "/icons/icon-dark.svg",
                    AnnouncementBalloons::class.java,
                )
            val notification = NotificationGroupManager.getInstance().getNotificationGroup("DevEco Code Announcements")
                .createNotification(
                    StringUtil.escapeXmlEntities(
                        announcement.title.ifBlank { MyMessageBundle.message("announcement.balloon.title") },
                    ),
                    announcement.balloonHtml,
                    NotificationType.INFORMATION,
                )
                .setIcon(icon)
                .setListener { _, event ->
                    if (event.eventType != HyperlinkEvent.EventType.ACTIVATED) return@setListener
                    val uri = announcementLink(event.description) ?: return@setListener
                    ApplicationManager.getApplication().executeOnPooledThread {
                        runCatching { BrowserUtil.browse(uri) }.onFailure {
                            log.warn("Could not open announcement link", it)
                        }
                    }
                }
            // The native factory renders the notification without starting the bus's fadeout timer.
            val balloon = NotificationsManagerImpl.createBalloon(frame, notification, false, false, Ref(data), project)
                as BalloonImpl
            val otherCount = (count - visible.size).coerceAtLeast(0)
            val otherHeight = layout.topBalloonComponent?.height?.coerceAtLeast(JBUI.scale(80)) ?: JBUI.scale(80)
            val occupied = visible.values.sumOf { it.preferredSize.height } + otherCount * otherHeight
            // Leave space for the layout's insets. An announcement without room stays unread in the queue.
            if (occupied + balloon.preferredSize.height > height - JBUI.scale(32)) {
                Disposer.dispose(balloon)
                break
            }
            balloon.setActionProvider(
                CloseAction(balloon) {
                    if (visible[key] === balloon) {
                        dismiss(key)
                        balloon.hide(true)
                    }
                },
            )
            balloon.addListener(object : JBPopupListener {
                override fun onClosed(event: LightweightWindowEvent) {
                    // The IDE can also remove a balloon when the window shrinks or another notification arrives.
                    visible.remove(key, balloon)
                }
            })
            visible[key] = balloon
            data.groupId = null
            layout.add(balloon, data)
        }
    }

    fun detach() {
        layout.removeListener(layoutChanged)
        val balloons = visible.values.toList()
        visible.clear()
        balloons.forEach { it.hide() }
    }

    private class CloseAction(balloon: BalloonImpl, close: () -> Unit) : BalloonImpl.ActionProvider {
        private val button = balloon.ActionButton(
            AllIcons.Ide.Notification.Close,
            AllIcons.Ide.Notification.CloseHover,
            MyMessageBundle.message("announcement.balloon.close"),
        ) { close() }
        private val insets = balloon.shadowBorderInsets

        override fun createActions() = listOf(button)

        override fun layout(bounds: Rectangle) {
            val size = button.preferredSize
            val offset = JBUI.scale(4)
            button.setBounds(
                bounds.x + bounds.width - insets.right - size.width - offset,
                bounds.y + insets.top + offset,
                size.width,
                size.height,
            )
        }
    }
}
