package org.deveco.code.session.ui.messages

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import org.deveco.code.DevEcoTheme
import org.jetbrains.jewel.markdown.Markdown
import org.jetbrains.jewel.markdown.extensions.LocalMarkdownBlockRenderer

private val CODE_BLOCK_REGEX = Regex("```([\\w+#.-]*)\\n([\\s\\S]*?)```")

private data class MarkdownBlock(
    val type: Type,
    val content: String,
    val language: String? = null,
) {
    enum class Type { CODE, TEXT }
}

private fun parseMarkdownBlocks(text: String): List<MarkdownBlock> {
    val blocks = mutableListOf<MarkdownBlock>()
    var lastIndex = 0

    for (match in CODE_BLOCK_REGEX.findAll(text)) {
        // Add text before this code block
        if (match.range.first > lastIndex) {
            val textBefore = text.substring(lastIndex, match.range.first)
            if (textBefore.isNotEmpty()) {
                blocks.add(MarkdownBlock(MarkdownBlock.Type.TEXT, textBefore))
            }
        }

        // Add code block
        val language = match.groupValues[1].ifEmpty { null }
        val code = match.groupValues[2].trimEnd()
        blocks.add(MarkdownBlock(MarkdownBlock.Type.CODE, code, language))

        lastIndex = match.range.last + 1
    }

    // Add remaining text after last code block
    if (lastIndex < text.length) {
        val remainingText = text.substring(lastIndex)
        if (remainingText.isNotEmpty()) {
            blocks.add(MarkdownBlock(MarkdownBlock.Type.TEXT, remainingText))
        }
    }

    return blocks
}

@Composable
internal fun MarkdownWithCodeBlocks(
    text: String,
    modifier: Modifier = Modifier,
    selectable: Boolean = false,
) {
    // Check if text contains any fenced code blocks
    val hasCodeBlocks = CODE_BLOCK_REGEX.containsMatchIn(text)

    if (!hasCodeBlocks) {
        // No code blocks, let Jewel render the entire markdown directly
        // This preserves table formatting and inline code styling
        Markdown(
            text,
            modifier,
            blockRenderer = LocalMarkdownBlockRenderer.current,
        )
        return
    }

    // Has code blocks, parse and render separately
    val blocks = remember(text) { parseMarkdownBlocks(text) }

    Column(modifier = modifier) {
        blocks.forEach { block: MarkdownBlock ->
            when (block.type) {
                MarkdownBlock.Type.CODE -> {
                    // Reconstruct markdown code block for Jewel to render with syntax highlighting
                    val markdownCode = "```${normalizeFenceLanguage(block.language)}\n${block.content}\n```"
                    if (selectable) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 8.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .border(3.dp, DevEcoTheme.codeBlockBorder, RoundedCornerShape(8.dp))
                                .background(DevEcoTheme.codeBlockBg),
                        ) {
                            Markdown(
                                markdownCode,
                                Modifier.fillMaxWidth(),
                                blockRenderer = LocalMarkdownBlockRenderer.current,
                            )
                        }
                    } else {
                        val lineCount = block.content.lines().size
                        val needsExpand = lineCount > 5
                        var isExpanded by remember { mutableStateOf(false) }

                        CodeBlockWrapper(
                            code = block.content,
                            isExpanded = isExpanded,
                            onExpandToggle = { isExpanded = !isExpanded },
                            needsExpand = needsExpand,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 8.dp),
                        ) {
                            Markdown(
                                markdownCode,
                                Modifier.fillMaxWidth(),
                                blockRenderer = LocalMarkdownBlockRenderer.current,
                            )
                        }
                    }
                }
                MarkdownBlock.Type.TEXT -> {
                    Markdown(
                        block.content,
                        Modifier.fillMaxWidth(),
                        blockRenderer = LocalMarkdownBlockRenderer.current,
                    )
                }
            }
        }
    }
}
