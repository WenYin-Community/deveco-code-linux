package org.deveco.code.session.editor

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.EditorKind
import com.intellij.openapi.editor.LogicalPosition
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.colors.EditorColorsScheme
import com.intellij.openapi.editor.ex.EditorEx
import com.intellij.openapi.editor.highlighter.EditorHighlighterFactory
import com.intellij.openapi.editor.markup.EffectType
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import org.deveco.code.session.model.ToolFileLocation
import org.deveco.code.util.runInEdt
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicLong
import javax.swing.JButton
import javax.swing.JPanel

private const val PREVIEW_MIN_WIDTH = 320

internal class SessionEditorPreview(
    private val project: Project,
    private val host: JPanel,
    private val onCloseRequested: () -> Unit,
    private val onPreviewChanged: (String?) -> Unit = {},
) {
    private val log = Logger.getInstance(SessionEditorPreview::class.java)
    private var editor: EditorEx? = null
    var location: ToolFileLocation? = null
        private set
    private val openVersion = AtomicLong(0)

    fun open(location: ToolFileLocation): Boolean {
        val scheme = EditorColorsManager.getInstance().schemeForCurrentUITheme
        val background = scheme.defaultBackground
        val myVersion = openVersion.incrementAndGet()
        this.location = location

        ApplicationManager.getApplication().executeOnPooledThread {
            val virtualFile = resolveFile(location.path)
            if (virtualFile == null) {
                log.warn("Cannot open file preview: '${location.path}'")
                return@executeOnPooledThread
            }
            if (virtualFile.isDirectory) {
                log.warn("Preview: skipping directory '${virtualFile.path}'")
                return@executeOnPooledThread
            }
            val document = try {
                ApplicationManager.getApplication().runReadAction<Document?> {
                    FileDocumentManager.getInstance().getDocument(virtualFile)
                }
            } catch (e: Throwable) {
                log.error("Preview: document load failed for '${virtualFile.path}'", e)
                null
            }
            if (document == null) {
                log.error("Preview: no document for '${virtualFile.path}'")
                return@executeOnPooledThread
            }
            UIUtil.invokeAndWaitIfNeeded {
                if (myVersion != openVersion.get()) return@invokeAndWaitIfNeeded
                val createdEditor = try {
                    createEditorFromDocument(document, virtualFile, scheme, background)
                } catch (e: Throwable) {
                    log.error("Preview: editor creation failed for '${virtualFile.path}'", e)
                    null
                } ?: return@invokeAndWaitIfNeeded
                releaseEditor()
                editor = createdEditor
                mountEditor(createdEditor, location, background)
                onPreviewChanged(location.path)
            }
        }
        return true
    }

    private fun createEditorFromDocument(
        document: com.intellij.openapi.editor.Document,
        virtualFile: VirtualFile,
        scheme: EditorColorsScheme,
        background: Color,
    ): EditorEx {
        val editor = (
            EditorFactory.getInstance().createEditor(
                document,
                project,
                EditorKind.PREVIEW,
            ) as EditorEx
            ).apply {
            colorsScheme = scheme
            backgroundColor = background
            settings.isLineNumbersShown = true
            settings.isFoldingOutlineShown = true
            settings.isRightMarginShown = false
            settings.isWhitespacesShown = false
            settings.isUseSoftWraps = false
        }
        try {
            editor.highlighter = EditorHighlighterFactory.getInstance()
                .createEditorHighlighter(project, virtualFile)
        } catch (e: Throwable) {
            log.warn(
                "Preview: highlighter unavailable for '${virtualFile.path}', falling back to plain text",
                e,
            )
        }
        return editor
    }

    private fun mountEditor(newEditor: EditorEx, location: ToolFileLocation, background: Color) {
        val header = JPanel(BorderLayout()).apply {
            isOpaque = true
            this.background = background
            border = JBUI.Borders.empty(4, 10)
            add(
                JBLabel(location.path).apply {
                    foreground = JBColor.namedColor("Label.infoForeground", 0x868A91)
                },
                BorderLayout.CENTER,
            )
            add(
                JButton("×").apply {
                    isFocusable = false
                    isOpaque = false
                    isContentAreaFilled = false
                    border = JBUI.Borders.empty(2, 8)
                    addActionListener { onCloseRequested() }
                },
                BorderLayout.EAST,
            )
        }
        val content = JPanel(BorderLayout()).apply {
            isOpaque = true
            this.background = background
            minimumSize = Dimension(PREVIEW_MIN_WIDTH, 0)
            add(header, BorderLayout.NORTH)
            add(newEditor.component, BorderLayout.CENTER)
        }
        host.removeAll()
        host.add(content, BorderLayout.CENTER)
        host.minimumSize = Dimension(PREVIEW_MIN_WIDTH, 0)
        host.revalidate()
        host.repaint()

        project.runInEdt {
            if (editor === newEditor) positionEditor(newEditor, location)
        }
    }

    fun close() {
        openVersion.incrementAndGet()
        host.removeAll()
        host.minimumSize = Dimension(0, 0)
        releaseEditor()
        location = null
        onPreviewChanged(null)
        host.revalidate()
        host.repaint()
    }

    fun dispose() = close()

    private fun releaseEditor() {
        editor?.let { EditorFactory.getInstance().releaseEditor(it) }
        editor = null
    }

    internal fun resolveFile(path: String): VirtualFile? {
        val trimmed = path.trim()
        if (trimmed.isEmpty()) return null
        val rawPath = Path.of(trimmed)
        val resolved = if (rawPath.isAbsolute) {
            rawPath
        } else {
            val base = project.basePath ?: return null
            Path.of(base).resolve(rawPath)
        }.normalize().toString().replace('\\', '/')
        return LocalFileSystem.getInstance().refreshAndFindFileByPath(resolved)
    }

    private fun positionEditor(editor: EditorEx, location: ToolFileLocation) {
        val document = editor.document
        if (document.lineCount == 0) return
        val rawLine = location.offset ?: location.line?.minus(1) ?: return
        val line = rawLine.coerceIn(0, document.lineCount - 1)
        val lastLine = (line + (location.limit ?: 1) - 1).coerceIn(line, document.lineCount - 1)
        val start = document.getLineStartOffset(line)
        val end = document.getLineEndOffset(lastLine)
        val lineText = document.charsSequence.subSequence(start, document.getLineEndOffset(line))
        val column = lineText.indexOfFirst { !it.isWhitespace() }.coerceAtLeast(0)
        editor.caretModel.moveToLogicalPosition(LogicalPosition(line, column))
        editor.scrollingModel.scrollToCaret(ScrollType.CENTER)
        editor.markupModel.addRangeHighlighter(
            start,
            end.coerceAtLeast(start + 1).coerceAtMost(document.textLength),
            HighlighterLayer.SELECTION - 1,
            TextAttributes(
                null,
                null,
                JBColor.namedColor("Component.focusColor", 0x3574F0),
                EffectType.BOXED,
                0,
            ),
            HighlighterTargetArea.EXACT_RANGE,
        )
    }
}
