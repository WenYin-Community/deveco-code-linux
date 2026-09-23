package org.deveco.code.session.ui.composer

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtilCore
import org.deveco.code.DevEcoTheme
import org.deveco.code.session.ui.messages.FileIcon
import org.jetbrains.jewel.ui.component.Text

private const val MENTION_MAX_RESULTS = 20
private val MENTION_POPUP_MAX_WIDTH = 450.dp

// --- Mention (file context) support ---

internal data class MentionItem(val name: String, val path: String, val relativePath: String)

private val MENTION_EXCLUDE_DIRS = setOf(
    ".gradle", "build", ".idea", "s", ".git", "node_modules", ".cxx", "oh_modules",
    "ic", "is", ".intellijPlatform", ".dbg", ".run", "gradle", ".kotlin",
)

internal fun computeMentionItems(text: String, cursor: Int, project: Project): List<MentionItem> {
    val beforeCursor = text.substring(0, minOf(cursor, text.length))
    val atIndex = beforeCursor.lastIndexOf('@')
    if (atIndex < 0) return emptyList()
    if (atIndex > 0 && !beforeCursor[atIndex - 1].isWhitespace()) return emptyList()

    val query = beforeCursor.substring(atIndex + 1)
    if (query.contains(' ')) return emptyList()

    val baseDir = project.basePath ?: return emptyList()
    val baseVFile = LocalFileSystem.getInstance().findFileByPath(baseDir) ?: return emptyList()

    val results = mutableListOf<MentionItem>()
    VfsUtilCore.processFilesRecursively(baseVFile) { vfile ->
        if (results.size >= MENTION_MAX_RESULTS) return@processFilesRecursively false
        if (!vfile.isDirectory) {
            val relPath = vfile.path.removePrefix(baseDir).removePrefix("/").replace("\\", "/")
            val firstSeg = relPath.substringBefore('/', "")
            if (firstSeg !in MENTION_EXCLUDE_DIRS && vfile.name.contains(query, ignoreCase = true)) {
                results.add(MentionItem(vfile.name, vfile.path, relPath))
            }
        }
        true
    }
    return results
}

@Composable
internal fun MentionPopupContent(
    items: List<MentionItem>,
    selectedIndex: Int,
    background: Color,
    muted: Color,
    accent: Color,
    maxHeight: androidx.compose.ui.unit.Dp,
    onSelect: (MentionItem) -> Unit,
) {
    val scrollState = rememberScrollState()
    val selectedBg = accent.copy(alpha = 0.12f)
    val itemHeightPx = with(LocalDensity.current) { 48.dp.toPx().toInt() }

    LaunchedEffect(selectedIndex, items.size) {
        if (items.isEmpty()) return@LaunchedEffect
        val targetTop = selectedIndex * itemHeightPx
        val targetBottom = targetTop + itemHeightPx
        val viewportTop = scrollState.value
        val viewportBottom = viewportTop + scrollState.viewportSize
        if (targetTop < viewportTop) {
            scrollState.animateScrollTo(targetTop)
        } else if (targetBottom > viewportBottom) {
            scrollState.animateScrollTo((targetBottom - scrollState.viewportSize).coerceAtLeast(0))
        }
    }

    Column(
        Modifier
            .widthIn(min = COMPOSER_POPUP_MIN_WIDTH, max = MENTION_POPUP_MAX_WIDTH)
            .heightIn(max = maxHeight)
            .clip(RoundedCornerShape(7.dp))
            .background(background)
            .border(1.dp, DevEcoTheme.popupBorder, RoundedCornerShape(7.dp))
            .verticalScroll(scrollState)
            .padding(vertical = 4.dp),
    ) {
        items.forEachIndexed { index, item ->
            Row(
                Modifier.fillMaxWidth()
                    .clickable { onSelect(item) }
                    .background(if (index == selectedIndex) selectedBg else Color.Transparent)
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                FileIcon(filePath = item.path, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
                Text(
                    item.name,
                    color = Color.Unspecified,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    item.relativePath,
                    color = muted,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}
