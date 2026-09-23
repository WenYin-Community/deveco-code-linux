package org.deveco.code.session.ui.messages

import androidx.compose.foundation.Image
import androidx.compose.foundation.ScrollbarStyle
import androidx.compose.foundation.VerticalScrollbar
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.rememberScrollbarAdapter
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toComposeImageBitmap
import org.jetbrains.skia.Image as SkiaImage
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.JBColor
import org.deveco.code.DevEcoTheme
import org.jetbrains.jewel.bridge.toComposeColor
import org.jetbrains.jewel.ui.component.Icon as JewelIcon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icons.AllIconsKeys
import java.awt.image.BufferedImage
import javax.swing.Icon

/**
 * Ambient state: the file path currently displayed in the editor preview.
 * Provided by [SessionFileEditor] and read by [FileTreeList] to highlight
 * the file whose content is shown in the right-side editor area.
 */
internal val LocalPreviewedFilePath = compositionLocalOf<String?> { null }

/**
 * Returns the icon color for a file extension.
 * Shared across all tool output renderers for visual consistency.
 */
internal fun getFileNameColor(extension: String): Color {
    return when (extension.lowercase()) {
        "ets" -> Color(0xFF5B8DEF)
        "java" -> Color(0xFFE76F00)
        "ts", "tsx" -> Color(0xFF3178C6)
        "js", "jsx", "mjs" -> Color(0xFFF7DF1E)
        "json", "json5" -> Color(0xFF5B8DEF)
        "xml", "html", "htm" -> Color(0xFFE76F00)
        "kt", "kts" -> Color(0xFF7F52FF)
        "css", "scss", "less" -> Color(0xFF1572B6)
        "md", "markdown" -> Color(0xFF083FA1)
        "png", "jpg", "jpeg", "gif", "svg", "webp" -> Color(0xFF4CAF50)
        else -> DevEcoTheme.foreground
    }
}

/**
 * Bridge layer: Converts a javax.swing.Icon to a Compose ImageBitmap.
 * Renders the Swing icon to a BufferedImage, encodes to PNG, then decodes as Skia Image.
 */
private fun iconToImageBitmap(icon: Icon, size: Int = 16): androidx.compose.ui.graphics.ImageBitmap? {
    val bufferedImage = BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB)
    val graphics = bufferedImage.createGraphics()
    return try {
        graphics.setRenderingHint(java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_ON)
        icon.paintIcon(null, graphics, 0, 0)
        // Encode BufferedImage to PNG bytes
        val outputStream = java.io.ByteArrayOutputStream()
        javax.imageio.ImageIO.write(bufferedImage, "PNG", outputStream)
        val pngBytes = outputStream.toByteArray()
        // Decode PNG bytes as Skia Image, then convert to Compose ImageBitmap
        val skiaImage = SkiaImage.makeFromEncoded(pngBytes)
        skiaImage?.toComposeImageBitmap()
    } catch (e: Exception) {
        null
    } finally {
        graphics.dispose()
    }
}

/**
 * File icon component that uses IDE file type icons when available,
 * falling back to colored badges for unknown files.
 *
 * The icon follows the IDE theme (Darcula / Light / etc.) because
 * it uses VirtualFile.fileType.icon from the IntelliJ platform.
 */
@Composable
internal fun FileIcon(
    filePath: String,
    modifier: Modifier = Modifier,
) {
    val extension = FileTreeParser.getFileExtension(filePath)
    // Detect if this is a folder: no extension or path ends with /
    val isFolder = extension.isEmpty() || filePath.endsWith("/")

    if (isFolder) {
        JewelIcon(
            key = AllIconsKeys.Nodes.Folder,
            contentDescription = null,
            modifier = modifier.size(16.dp),
        )
    } else {
        // Try to get the IDE file type icon
        // Normalize path separators for the current OS before lookup
        val nativePath = remember(filePath) {
            filePath.replace('/', java.io.File.separatorChar).replace('\\', java.io.File.separatorChar)
        }
        val virtualFile = remember(nativePath) {
            LocalFileSystem.getInstance().findFileByPath(nativePath)
        }

        if (virtualFile != null) {
            val swingIcon = remember(virtualFile) { virtualFile.fileType.icon }
            val imageBitmap = remember(swingIcon) {
                swingIcon?.let { iconToImageBitmap(it, 16) }
            }
            if (imageBitmap != null) {
                Image(
                    bitmap = imageBitmap,
                    contentDescription = null,
                    modifier = modifier.size(16.dp),
                )
            } else {
                // Fallback to colored badge if icon conversion fails
                FileIconBadge(filePath, modifier)
            }
        } else {
            FileIconBadge(filePath, modifier)
        }
    }
}

/**
 * Colored badge fallback showing file extension.
 */
@Composable
private fun FileIconBadge(
    filePath: String,
    modifier: Modifier = Modifier,
) {
    val extension = FileTreeParser.getFileExtension(filePath)
    val iconColor = getFileNameColor(extension)

    Box(
        modifier = modifier
            .size(16.dp)
            .clip(RoundedCornerShape(3.dp))
            .background(iconColor),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = extension.uppercase().take(2),
            color = Color.White,
            fontSize = 8.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

/**
 * File tree item component with hover and selection states.
 *
 * Visual states (matching design mockup):
 * - Normal: transparent background, muted text
 * - Hover: subtle gray background
 * - Active/Selected: blue highlight background
 */
@Composable
internal fun FileTreeItem(
    filePath: String,
    isPreviewed: Boolean = false,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val isHovered by interactionSource.collectIsHoveredAsState()

    val extension = FileTreeParser.getFileExtension(filePath)
    val isFolder = extension.isEmpty() || filePath.endsWith("/")

    val backgroundColor = when {
        isPreviewed -> Color(0xFF2B4A7E)
        isHovered && !isFolder -> Color(0x33FFFFFF)
        else -> Color.Transparent
    }
    val textColor = when {
        isPreviewed -> JBColor(0x000000, 0xFFFFFF).toComposeColor()
        else -> DevEcoTheme.muted
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(4.dp))
            .background(backgroundColor)
            .then(
                if (isFolder) Modifier else Modifier.hoverable(interactionSource)
            )
            .then(
                if (isFolder) Modifier else Modifier.clickable(
                    interactionSource = interactionSource,
                    indication = null,
                ) {
                    onClick()
                }
            )
            .padding(horizontal = 6.dp, vertical = 5.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FileIcon(filePath = filePath)
            Spacer(Modifier.width(8.dp))

            Text(
                text = FileTreeParser.normalizePath(filePath),
                color = textColor,
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

/**
 * File tree list component that displays file paths with scrollable container.
 * When there are more than 5 files, a scrollbar appears and new files are shown at the bottom.
 */
@Composable
internal fun FileTreeList(
    filePaths: List<String>,
    onFileClick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (filePaths.isEmpty()) return

    val maxVisibleFiles = 5
    val hasMoreFiles = filePaths.size > maxVisibleFiles
    val scrollState = rememberScrollState()
    val previewedFilePath = LocalPreviewedFilePath.current

    // Auto-scroll to bottom when new files are added
    LaunchedEffect(filePaths.size) {
        if (hasMoreFiles) {
            scrollState.animateScrollTo(scrollState.maxValue)
        }
    }

    Column(
        modifier = modifier.fillMaxWidth(),
    ) {
        if (hasMoreFiles) {
            // Scrollable container with fixed height for 5 items + scrollbar
            BoxWithConstraints(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = (maxVisibleFiles * 28).dp),
            ) {
                val scrollbarWidth = 6.dp
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .verticalScroll(scrollState),
                ) {
                    Column {
                        filePaths.forEachIndexed { index, filePath ->
                            FileTreeItem(
                                filePath = filePath,
                                isPreviewed = previewedFilePath == filePath,
                                onClick = {
                                    onFileClick(filePath)
                                },
                                modifier = Modifier.fillMaxWidth(),
                            )
                            if (index < filePaths.lastIndex) {
                                Spacer(Modifier.height(1.dp))
                            }
                        }
                    }
                }
                VerticalScrollbar(
                    adapter = rememberScrollbarAdapter(scrollState),
                    modifier = Modifier
                        .align(Alignment.CenterEnd)
                        .fillMaxHeight()
                        .padding(end = 2.dp),
                    style = ScrollbarStyle(
                        minimalHeight = 16.dp,
                        thickness = 6.dp,
                        shape = RoundedCornerShape(3.dp),
                        hoverDurationMillis = 300,
                        unhoverColor = Color(0x33FFFFFF), // 半透明白色，暗色主题协调
                        hoverColor = Color(0x66FFFFFF),    // 悬停时稍亮
                    ),
                )
            }
        } else {
            // No scrollbar needed, show all files directly
            filePaths.forEachIndexed { index, filePath ->
                FileTreeItem(
                    filePath = filePath,
                    isPreviewed = previewedFilePath == filePath,
                    onClick = {
                        onFileClick(filePath)
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                if (index < filePaths.lastIndex) {
                    Spacer(Modifier.height(1.dp))
                }
            }
        }
    }
}
