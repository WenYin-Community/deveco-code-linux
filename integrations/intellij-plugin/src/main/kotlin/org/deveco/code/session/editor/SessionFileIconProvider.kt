package org.deveco.code.session.editor

import com.intellij.ide.FileIconProvider
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.IconLoader
import com.intellij.openapi.vfs.VirtualFile
import org.deveco.code.acp.AcpClientService
import org.deveco.code.session.SessionStorage
import javax.swing.Icon

class SessionFileIconProvider : FileIconProvider {
    override fun getIcon(file: VirtualFile, flags: Int, project: Project?): Icon? {
        if (file !is SessionVirtualFile) return null
        val proj = project ?: return null
        val sid = file.sessionId

        // 获取 session 状态（与侧边栏 StatusIndicator 逻辑保持一致）
        val service = proj.getService(AcpClientService::class.java)
        val runningIds = service?.runningSnapshot()?.keys ?: emptySet()
        val newIds = SessionStorage.newSessionIds(proj)
        val abnormalIds = SessionStorage.abnormalIds(proj)
        val unreadIds = SessionStorage.unreadIds(proj)
        val interactedIds = SessionStorage.interactedIds(proj)
        val durationIds = SessionStorage.loadLastDurations(proj).keys

        val isRunning = sid in runningIds
        val isNew = sid in newIds && sid !in interactedIds && sid !in durationIds
        val isAbnormal = sid in abnormalIds
        val isUnread = sid in unreadIds

        // 图标选择逻辑与 SessionCard.StatusIndicator 保持一致
        val (iconName, ext) = when {
            isRunning -> "session-running" to "png"
            isNew -> "session-new" to "svg"
            isAbnormal && isUnread -> "session-abnormal-unread" to "svg"
            isAbnormal -> "session-abnormal-read" to "svg"
            isUnread -> "session-normal-unread" to "svg"
            else -> "session-normal-read" to "svg"
        }

        return loadSessionIcon(iconName, ext)
    }

    companion object {
        private val isDark: Boolean get() {
            val bg = EditorColorsManager.getInstance().globalScheme.defaultBackground
            val brightness = (bg.red * 0.299 + bg.green * 0.587 + bg.blue * 0.114) / 255.0
            return brightness < 0.5
        }

        private fun loadSessionIcon(name: String, ext: String): Icon? {
            val variant = if (isDark) "dark" else "light"
            val path = "/icons/$name-$variant.$ext"
            return IconLoader.getIcon(path, SessionFileIconProvider::class.java)
        }
    }
}
