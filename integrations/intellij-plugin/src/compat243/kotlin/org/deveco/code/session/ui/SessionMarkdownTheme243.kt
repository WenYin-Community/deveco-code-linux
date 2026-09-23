package org.deveco.code.session.ui

import androidx.compose.runtime.Composable
import com.intellij.openapi.project.Project
import org.jetbrains.jewel.intui.markdown.bridge.ProvideMarkdownStyling

@Composable
internal fun SessionMarkdownTheme(project: Project, content: @Composable () -> Unit) {
    ProvideMarkdownStyling(project = project, content = content)
}
