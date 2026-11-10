package org.deveco.code.session.editor

import com.intellij.ide.FileIconProvider
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.IconLoader
import com.intellij.openapi.vfs.VirtualFile
import javax.swing.Icon

class SessionFileIconProvider : FileIconProvider {
    override fun getIcon(file: VirtualFile, flags: Int, project: Project?): Icon? {
        if (file !is SessionVirtualFile) return null
        return loadDevEcoCodeIcon()
    }

    companion object {
        private val isDark: Boolean get() {
            val bg = EditorColorsManager.getInstance().globalScheme.defaultBackground
            val brightness = (bg.red * 0.299 + bg.green * 0.587 + bg.blue * 0.114) / 255.0
            return brightness < 0.5
        }

        private fun loadDevEcoCodeIcon(): Icon? {
            val variant = if (isDark) "dark" else "light"
            return IconLoader.getIcon("/icons/deveco-code-$variant.svg", SessionFileIconProvider::class.java)
        }
    }
}
