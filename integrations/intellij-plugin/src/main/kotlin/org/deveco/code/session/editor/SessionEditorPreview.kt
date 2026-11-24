package org.deveco.code.session.editor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.EditorKind
import com.intellij.openapi.editor.LogicalPosition
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.editor.colors.EditorColorsListener
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.colors.EditorColorsScheme
import com.intellij.openapi.editor.ex.EditorEx
import com.intellij.openapi.editor.highlighter.EditorHighlighterFactory
import com.intellij.openapi.editor.markup.EffectType
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import org.deveco.code.session.model.ToolFileLocation
import org.deveco.code.session.ui.SessionMarkdownTheme
import org.deveco.code.session.ui.messages.MarkdownWithCodeBlocks
import org.deveco.code.util.resolveVirtualFileWithRefresh
import org.deveco.code.util.runInEdt
import org.jetbrains.jewel.bridge.JewelComposePanel
import org.jetbrains.jewel.bridge.toComposeColor
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.util.concurrent.atomic.AtomicLong
import javax.swing.JButton
import javax.swing.JPanel

private const val PREVIEW_MIN_WIDTH = 320

internal class SessionEditorPreview(
    private val project: Project,
    private val host: JPanel,
    private val onCloseRequested: () -> Unit,
    private val onPreviewChanged: (String?) -> Unit = {},
    private val onMounted: () -> Unit = {},
) {
    private val log = Logger.getInstance(SessionEditorPreview::class.java)
    private var editor: EditorEx? = null
    private var editorFile: VirtualFile? = null
    var location: ToolFileLocation? = null
        private set
    private val openVersion = AtomicLong(0)
    private val themeVersion = mutableIntStateOf(0)
    private val colorsConnection = project.messageBus.connect().also {
        it.subscribe(
            EditorColorsManager.TOPIC,
            EditorColorsListener { newScheme ->
                val scheme = newScheme ?: return@EditorColorsListener
                themeVersion.intValue++
                val bg = scheme.defaultBackground
                host.background = bg
                updateChildBackgrounds(host, bg)
                editor?.let { ed ->
                    ed.colorsScheme = scheme
                    ed.backgroundColor = bg
                    editorFile?.let { vf ->
                        try {
                            ed.highlighter = EditorHighlighterFactory.getInstance()
                                .createEditorHighlighter(project, vf)
                        } catch (e: Throwable) {
                            log.warn("Preview: highlighter refresh failed for '${vf.name}'", e)
                        }
                    }
                    ed.reinitSettings()
                    ed.component.repaint()
                }
                host.revalidate()
                host.repaint()
            },
        )
    }

    fun open(location: ToolFileLocation): Boolean {
        val scheme = EditorColorsManager.getInstance().schemeForCurrentUITheme
        val background = scheme.defaultBackground
        val myVersion = openVersion.incrementAndGet()

        ApplicationManager.getApplication().executeOnPooledThread {
            val virtualFile = project.resolveVirtualFileWithRefresh(location.path)
            if (virtualFile == null) {
                log.debug("Cannot open file preview: '${location.path.substringAfterLast('/')}'")
                return@executeOnPooledThread
            }
            if (virtualFile.isDirectory) {
                log.debug("Preview: skipping directory '${virtualFile.name}'")
                return@executeOnPooledThread
            }
            // The platform creates documents for text files only, so a binary file (image,
            // archive) can never mount in the text preview; open it in the main editor
            // instead, which renders images natively — same as the composer chips do.
            if (virtualFile.fileType.isBinary) {
                project.runInEdt {
                    OpenFileDescriptor(project, virtualFile, 0, 0).navigate(true)
                }
                return@executeOnPooledThread
            }
            val document = try {
                ApplicationManager.getApplication().runReadAction<Document?> {
                    FileDocumentManager.getInstance().getDocument(virtualFile)
                }
            } catch (e: Throwable) {
                log.error("Preview: document load failed for '${virtualFile.name}'", e)
                null
            }
            if (document == null) {
                // Not a programming error: the file can have vanished or become unreadable
                // between the resolve above and this read, so keep it out of error reports.
                log.warn("Preview: no document for '${virtualFile.name}'")
                return@executeOnPooledThread
            }
            UIUtil.invokeAndWaitIfNeeded {
                if (myVersion != openVersion.get()) return@invokeAndWaitIfNeeded
                releaseEditor()
                this.location = location
                val isMarkdown = virtualFile.name.lowercase().endsWith(".md")
                if (isMarkdown) {
                    mountMarkdownPreview(document.text, location, background)
                    onPreviewChanged(location.path)
                    onMounted()
                    return@invokeAndWaitIfNeeded
                }
                val createdEditor = try {
                    createEditorFromDocument(document, virtualFile, scheme, background)
                } catch (e: Throwable) {
                    log.error("Preview: editor creation failed for '${virtualFile.name}'", e)
                    null
                } ?: return@invokeAndWaitIfNeeded
                editor = createdEditor
                editorFile = virtualFile
                mountEditor(createdEditor, location, background)
                onPreviewChanged(location.path)
                onMounted()
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
                "Preview: highlighter unavailable for '${virtualFile.name}', falling back to plain text",
                e,
            )
        }
        return editor
    }

    private fun mountEditor(newEditor: EditorEx, location: ToolFileLocation, background: Color) {
        host.border = null
        val content = JPanel(BorderLayout()).apply {
            isOpaque = true
            this.background = background
            minimumSize = Dimension(PREVIEW_MIN_WIDTH, 0)
            add(buildHeader(location), BorderLayout.NORTH)
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

    private fun mountMarkdownPreview(markdownText: String, location: ToolFileLocation, background: Color) {
        val divider = JPanel().apply {
            isOpaque = true
            setBackground(JBColor(0xD0D0D0, 0x3C3F41))
            preferredSize = Dimension(4, 0)
            minimumSize = Dimension(4, 0)
        }
        val composePanel = JewelComposePanel {
            themeVersion.intValue
            val currentBg = EditorColorsManager.getInstance().schemeForCurrentUITheme.defaultBackground
            SessionMarkdownTheme(project) {
                LazyColumn(
                    state = rememberLazyListState(),
                    modifier = Modifier.fillMaxSize()
                        .background(currentBg.toComposeColor()),
                ) {
                    item {
                        SelectionContainer {
                            MarkdownWithCodeBlocks(
                                markdownText,
                                Modifier.fillMaxWidth().padding(16.dp),
                                selectable = true,
                            )
                        }
                    }
                }
            }
        }.apply {
            this.background = background
        }
        val centerPanel = JPanel(BorderLayout()).apply {
            isOpaque = true
            this.background = background
            add(divider, BorderLayout.WEST)
            add(composePanel, BorderLayout.CENTER)
        }
        val content = JPanel(BorderLayout()).apply {
            isOpaque = true
            this.background = background
            minimumSize = Dimension(PREVIEW_MIN_WIDTH, 0)
            add(buildHeader(location), BorderLayout.NORTH)
            add(centerPanel, BorderLayout.CENTER)
        }
        host.border = null
        host.removeAll()
        host.add(content, BorderLayout.CENTER)
        host.minimumSize = Dimension(PREVIEW_MIN_WIDTH, 0)
        host.revalidate()
        host.repaint()
    }

    private fun updateChildBackgrounds(container: java.awt.Container, bg: Color) {
        for (comp in container.components) {
            if (comp is JPanel && comp.isOpaque && comp.background !is JBColor) {
                comp.background = bg
            }
            comp.repaint()
            if (comp is java.awt.Container) updateChildBackgrounds(comp, bg)
        }
    }

    private fun buildHeader(location: ToolFileLocation): JPanel = object : JPanel(BorderLayout()) {
        override fun paintComponent(g: java.awt.Graphics) {
            g.color = EditorColorsManager.getInstance().schemeForCurrentUITheme.defaultBackground
            g.fillRect(0, 0, width, height)
        }
    }.apply {
        isOpaque = true
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

    fun close() {
        openVersion.incrementAndGet()
        host.removeAll()
        host.border = null
        host.minimumSize = Dimension(0, 0)
        releaseEditor()
        location = null
        onPreviewChanged(null)
        host.revalidate()
        host.repaint()
    }

    fun dispose() {
        close()
        colorsConnection.disconnect()
    }

    private fun releaseEditor() {
        editor?.let { EditorFactory.getInstance().releaseEditor(it) }
        editor = null
        editorFile = null
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
