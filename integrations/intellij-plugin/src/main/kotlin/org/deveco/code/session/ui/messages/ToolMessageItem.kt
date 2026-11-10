package org.deveco.code.session.ui.messages

import androidx.compose.foundation.ScrollbarStyle
import androidx.compose.foundation.VerticalScrollbar
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.rememberScrollbarAdapter
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentclientprotocol.model.ToolCallStatus
import com.agentclientprotocol.model.ToolKind
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.deveco.code.DevEcoTheme
import org.deveco.code.SmallSpinner
import org.deveco.code.acp.AcpToolInputParser
import org.deveco.code.util.hoverable
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.model.ChatItem
import org.deveco.code.session.model.ChatRole
import org.deveco.code.session.model.PermissionChoice
import com.intellij.ui.JBColor
import org.jetbrains.jewel.bridge.theme.retrieveEditorTextStyle
import org.jetbrains.jewel.bridge.toComposeColor
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icons.AllIconsKeys
import org.jetbrains.jewel.markdown.Markdown
import org.jetbrains.jewel.markdown.extensions.LocalMarkdownBlockRenderer

/**
 * Heuristic check: does [path] look like a file path rather than file content?
 * File paths contain separators, drive letters, or extensions.
 * File content typically contains newlines or starts with copyright/license text.
 */
private fun looksLikeFilePath(path: String): Boolean {
    if (path.contains('\n') || path.contains('\r')) return false
    if (path.contains('/') || path.contains('\\')) return true
    if (path.matches(Regex("^[A-Za-z]:.*"))) return true
    // Has a file extension (e.g. .ets, .java, .ts, .json5)
    if (path.contains('.') && path.substringAfterLast('.').length in 1..6) return true
    return false
}

/**
 * Children of a tool group that actually render as file rows: TOOL items whose
 * path looks like a file. Folders without descendants are dropped — they would
 * render as an expand stub with nothing under it.
 */
internal fun toolRenderableChildren(children: List<ChatItem>): List<ChatItem> =
    children
        .filter { child ->
            child.role == ChatRole.TOOL &&
                !child.toolPath.isNullOrBlank() &&
                looksLikeFilePath(child.toolPath)
        }
        .distinctBy { it.toolPath }
        .let { items ->
            val allPaths = items.mapNotNull { it.toolPath }.toSet()
            items.filter { child ->
                val path = child.toolPath!!
                val ext = FileTreeParser.getFileExtension(path)
                if (ext.isNotEmpty()) {
                    true // File: always keep
                } else {
                    // Folder: keep only if it has at least one descendant
                    val prefix = path.trimEnd('/') + "/"
                    allPaths.any { other -> other != path && other.startsWith(prefix) }
                }
            }
        }

/**
 * Rows a merged tool group renders: [toolRenderableChildren] plus the group's
 * parent call. The parent is the run's first call and renders only as the
 * "title (N)" header, so without re-inserting it here its own file silently
 * disappears from both the list and the count (5 created files shown as 4).
 * Applies to any merged kind (edit, read, ide_create_new_file, ...); the
 * parent only joins when the group actually renders child file rows.
 */
internal fun toolRenderableRows(item: ChatItem, children: List<ChatItem>): List<ChatItem> {
    val childRows = toolRenderableChildren(children)
    val groupParentRow = item.takeIf {
        childRows.isNotEmpty() &&
            !it.toolPath.isNullOrBlank() &&
            !FileTreeParser.isDirectoryPath(it.toolPath) &&
            looksLikeFilePath(it.toolPath)
    }
    return (listOfNotNull(groupParentRow) + childRows).distinctBy { it.toolPath }
}

/** Output text of [item] with JSON-wrapped tree/text payloads unwrapped for display. */
internal fun toolProcessedText(item: ChatItem): String {
    if (item.toolKind in setOf(ToolKind.EDIT, ToolKind.DELETE, ToolKind.EXECUTE, ToolKind.THINK, ToolKind.MOVE)) {
        return item.text
    }
    if (item.text.trimStart().startsWith("{")) {
        try {
            val json = Json.parseToJsonElement(item.text)
            if (json is JsonObject) {
                val treeContent = json["tree"]?.jsonPrimitive?.contentOrNull
                val textContent = json["text"]?.jsonPrimitive?.contentOrNull
                val content = treeContent ?: textContent ?: item.text
                return content.replace("\\n", "\n")
            }
            return item.text
        } catch (e: Exception) {
            return item.text
        }
    }
    return item.text
}

/**
 * File paths parsed from the output text of [item]. READ outputs are file
 * content, not path lists, so they never parse paths from text.
 */
internal fun toolParsedFilePaths(item: ChatItem): List<String> =
    when (item.toolKind) {
        ToolKind.EDIT, ToolKind.DELETE, ToolKind.EXECUTE,
        ToolKind.THINK, ToolKind.MOVE -> emptyList()
        ToolKind.READ -> emptyList()
        else -> FileTreeParser.parseFilePaths(toolProcessedText(item))
    }

/** Per-file diff stats for EDIT/DELETE tools; empty for every other kind. */
internal fun toolDiffStats(item: ChatItem): List<Triple<String, Int, Int>> =
    if (item.toolKind == ToolKind.EDIT || item.toolKind == ToolKind.DELETE) {
        parseDiffStats(item.text)
    } else {
        emptyList()
    }

/** EDIT/DELETE tools with non-diff text: file paths extracted as fallback. */
internal fun toolFallbackEditFilePaths(item: ChatItem): List<String> =
    if ((item.toolKind == ToolKind.EDIT || item.toolKind == ToolKind.DELETE) &&
        toolDiffStats(item).isEmpty() &&
        toolParsedFilePaths(item).isEmpty()
    ) {
        FileTreeParser.parseFilePaths(item.text)
    } else {
        emptyList()
    }

/**
 * Path of a READ call that stands alone (no renderable merged children): it
 * renders as a titled "read (1)" group whose expanded body is this single file
 * row, instead of a bare title-less path row.
 */
internal fun toolLeafReadPath(item: ChatItem, children: List<ChatItem>): String? =
    if (item.toolKind == ToolKind.READ &&
        !item.toolPath.isNullOrBlank() &&
        toolRenderableChildren(children).isEmpty()
    ) {
        item.toolPath
    } else {
        null
    }

/**
 * Number of content rows [ToolItem] renders for [item]; follows the same
 * priority order as the rendering branches inside [ToolItem].
 */
internal fun toolFileCount(item: ChatItem, children: List<ChatItem>): Int {
    val renderableChildren = toolRenderableRows(item, children)
    val filePaths = toolParsedFilePaths(item)
    val diffStats = toolDiffStats(item)
    val fallbackEditFilePaths = toolFallbackEditFilePaths(item)
    return when {
        // Primary source: the group parent's own file plus merged child TOOL items with valid paths
        renderableChildren.isNotEmpty() -> renderableChildren.size
        // Fallback: parsed file paths from item.text (only when no children)
        filePaths.isNotEmpty() -> filePaths.size
        // EDIT/DELETE tools: diff stats from text
        diffStats.isNotEmpty() -> diffStats.size
        // EDIT/DELETE tools: file paths extracted from non-diff text
        fallbackEditFilePaths.isNotEmpty() -> fallbackEditFilePaths.size
        // EDIT/DELETE tools: single file path from metadata (e.g. write tool with no diff)
        (item.toolKind == ToolKind.EDIT || item.toolKind == ToolKind.DELETE) &&
            !item.toolPath.isNullOrBlank() &&
            looksLikeFilePath(item.toolPath) -> 1
        // Standalone READ call: its single path row
        toolLeafReadPath(item, children) != null -> 1
        // Tools with text output (EXECUTE, FETCH, etc.) — exclude EDIT/DELETE which should only show file info
        item.toolKind != ToolKind.READ &&
            item.toolKind != ToolKind.EDIT &&
            item.toolKind != ToolKind.DELETE &&
            item.text.isNotBlank() -> 1
        else -> 0
    }
}

/**
 * Whether [ToolItem] renders nothing at all for this item. The group slot must
 * not reserve vertical spacing for such an item, and its children must be
 * promoted to standalone rows instead of being swallowed behind an invisible
 * parent. A running THINK (task/subagent) card stays visible even before
 * content arrives — it is the only on-screen indicator that a subagent runs.
 */
internal fun toolItemRendersNothing(item: ChatItem, children: List<ChatItem>): Boolean {
    val running = item.toolStatus == ToolCallStatus.PENDING ||
        item.toolStatus == ToolCallStatus.IN_PROGRESS
    if (running && item.toolKind == ToolKind.THINK) return false
    return toolFileCount(item, children) == 0
}

@Composable
@OptIn(ExperimentalComposeUiApi::class)
internal fun ToolItem(
    item: ChatItem,
    card: Color,
    muted: Color,
    expandedTools: MutableMap<String, Boolean>,
    preserveScroll: ((() -> Unit) -> Unit),
    onOpenFile: (ChatItem) -> Unit,
    children: List<ChatItem> = emptyList(),
    isChild: Boolean = false,
    permissionChoices: List<PermissionChoice>? = null,
) {
    val expanded = expandedTools[item.id] ?: false
    val running = item.toolStatus == ToolCallStatus.PENDING ||
        item.toolStatus == ToolCallStatus.IN_PROGRESS
    val failed = item.toolStatus == ToolCallStatus.FAILED
    // For READ-type operations with children, file list is only visible when expanded
    val childrenAlwaysVisible = false
    var hovered by remember { mutableStateOf(false) }

    // Parse file paths from text for tools that return file lists.
    // Applies to SEARCH, READ, and tools with no specific kind (e.g. list_directory_tree).
    // READ tools should only show file paths from children/metadata, not parse file content.
    val processedText = remember(item.id, item.text) { toolProcessedText(item) }
    val filePaths = remember(item.id, item.text) { toolParsedFilePaths(item) }

    // Use tool kind name as primary title; for generic types (OTHER), prefer item.title.
    // THINK is the task/subagent tool: its title is the task description, which
    // says far more than the kind name.
    val effectiveTitle = when {
        item.toolKind == ToolKind.THINK && item.title.isNotBlank() -> item.title
        item.toolKind != null && item.toolKind != ToolKind.OTHER -> item.toolKind.name.lowercase()
        item.title.isNotBlank() -> item.title
        else -> "tool"
    }

    // When this is a child item with a single file path (no multi-file list),
    // only show file icon + path (skip title row)
    // But only if toolPath looks like a valid file path (not a directory or code)
    val isFilePath = !item.toolPath.isNullOrBlank() &&
        !FileTreeParser.isDirectoryPath(item.toolPath) &&
        !item.toolPath.trim().startsWith("//") &&
        !item.toolPath.trim().startsWith("import ") &&
        !item.toolPath.trim().startsWith("if ") &&
        !item.toolPath.trim().startsWith("function ") &&
        !item.toolPath.trim().startsWith("const ") &&
        !item.toolPath.trim().startsWith("let ") &&
        !item.toolPath.trim().startsWith("var ") &&
        !item.toolPath.trim().startsWith("return ") &&
        !item.toolPath.trim().startsWith("class ") &&
        !item.toolPath.contains("(") &&
        !item.toolPath.contains("{") &&
        !item.toolPath.contains("}") &&
        !item.toolPath.contains("'") &&
        !item.toolPath.contains("\"") &&
        !item.toolPath.contains("=") &&
        !Regex("\\b\\w+\\s+in\\s+\\w+").containsMatchIn(item.toolPath)

    if (isChild && isFilePath && filePaths.isEmpty()) {
        val childLineDiff = remember(item.id, item.toolRawInput) {
            AcpToolInputParser.computeLineDiff(item.toolRawInput)
        }
        var isHovered by remember { mutableStateOf(false) }
        Row(
            Modifier
                .fillMaxWidth()
                .clickable { onOpenFile(item) }
                .hoverable { isHovered = it }
                .background(
                    if (isHovered) muted.copy(alpha = 0.08f) else Color.Transparent
                )
                .padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FileIcon(filePath = item.toolPath)
            Spacer(Modifier.width(8.dp))
            Text(
                text = FileTreeParser.normalizePath(item.toolPath),
                color = muted,
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
            )
            if (childLineDiff != null && !childLineDiff.isEmpty()) {
                Spacer(Modifier.width(12.dp))
                if (childLineDiff.added > 0) {
                    Text(
                        "+${childLineDiff.added}",
                        color = DevEcoTheme.lineDiffAdded,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                if (childLineDiff.added > 0 && childLineDiff.removed > 0) {
                    Spacer(Modifier.width(4.dp))
                }
                if (childLineDiff.removed > 0) {
                    Text(
                        "-${childLineDiff.removed}",
                        color = DevEcoTheme.lineDiffRemoved,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
        return
    }

    // Child item with code content (not a file path) — render as plain text
    // READ tools should only show file paths, not raw text content. Command
    // (EXECUTE) items always keep their body: toolPath is only their working
    // directory, so rendering it instead of the output would hide the command.
    if (isChild && !isFilePath && !item.toolPath.isNullOrBlank() &&
        item.toolKind != ToolKind.READ && item.toolKind != ToolKind.EXECUTE) {
        Text(
            text = item.toolPath,
            color = DevEcoTheme.foreground,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            lineHeight = 17.sp,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 2.dp),
        )
        return
    }

    Column(Modifier.fillMaxWidth()) {
        // Compute file count for the tool info row.
        // CRITICAL: `fileCount` must match what will ACTUALLY be rendered below,
        // otherwise we get phantom "(N)" badges with no visible content.
        // The rendering logic below checks `renderableChildren` first; only if
        // empty does it fall back to parsed paths, then to the leaf READ path —
        // the same priority order [toolFileCount] applies.
        val renderableChildren = remember(item, children) { toolRenderableRows(item, children) }
        val diffStats = remember(item.id, item.text) { toolDiffStats(item) }
        val fallbackEditFilePaths = remember(item.id, item.text) { toolFallbackEditFilePaths(item) }
        val leafReadPath = remember(item, children) { toolLeafReadPath(item, children) }
        val fileCount = remember(item, children) { toolFileCount(item, children) }
        // Hide entire item if there's nothing renderable to show. A running
        // THINK (task/subagent) card must stay visible even before content
        // arrives — it is the only on-screen indicator that a subagent is
        // executing.
        if (fileCount == 0 && !(running && item.toolKind == ToolKind.THINK)) return

        // Title format: always show "tool_name (N)" for READ/EDIT/DELETE, regardless of count or expanded state
        val displayTitle = if (item.toolKind == ToolKind.READ ||
            item.toolKind == ToolKind.EDIT ||
            item.toolKind == ToolKind.DELETE
        ) {
            "$effectiveTitle ($fileCount)"
        } else if (fileCount > 1) {
            "$effectiveTitle ($fileCount)"
        } else {
            effectiveTitle
        }
        // Only show chevron if there's expandable content
        val hasExpandableContent = renderableChildren.isNotEmpty() ||
            filePaths.isNotEmpty() ||
            diffStats.isNotEmpty() ||
            leafReadPath != null ||
            (item.toolKind != ToolKind.READ && item.text.isNotBlank())

        // Tool content: title + tool info + file list (no outer card container)
        Column(
            Modifier.fillMaxWidth(),
        ) {
                // Tool info row with collapse arrow (only if there's expandable content)
                Row(
                    Modifier.fillMaxWidth()
                        .then(
                            if (hasExpandableContent) {
                                Modifier.clickable {
                                    preserveScroll { expandedTools[item.id] = !expanded }
                                }
                            } else {
                                Modifier
                            }
                        )
                        .hoverable { v -> hovered = v },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(14.dp), contentAlignment = Alignment.Center) {
                        if (running) {
                            SmallSpinner(modifier = Modifier.size(11.dp), size = 11.dp)
                        } else if (hasExpandableContent) {
                            Icon(
                                key = if (expanded) AllIconsKeys.General.ChevronDown
                                else AllIconsKeys.General.ChevronRight,
                                contentDescription = if (expanded) "Collapse tool output" else "Expand tool output",
                                modifier = Modifier.size(12.dp),
                            )
                        }
                    }
                    Spacer(Modifier.width(7.dp))
                    Text(
                        displayTitle,
                        color = if (failed) DevEcoTheme.danger else muted,
                        fontSize = DevEcoTheme.toolLabelSize.sp,
                    )
                }

                // File list content (when expanded or always for READ groups)
                val shouldShowChildren = childrenAlwaysVisible || expanded
                // thinkBody runs a full-text regex; memoize per item so streaming
                // recompositions do not re-parse the body every frame.
                val thinkCardBody = remember(item) { thinkBody(item) }
                // An empty container would leave its tree line as an orphan stub under the spinner.
                val hasVisibleBody = renderableChildren.isNotEmpty() ||
                    filePaths.isNotEmpty() ||
                    leafReadPath != null ||
                    !(item.toolKind == ToolKind.THINK && thinkCardBody == null)
                if (shouldShowChildren && hasVisibleBody) {
                    Column(
                        Modifier.fillMaxWidth()
                            .drawBehind {
                                val treeLineColor = Color(0xFF6F737A)
                                val lineX = 7.dp.toPx()
                                drawLine(
                                    color = treeLineColor,
                                    start = Offset(lineX, 0f),
                                    end = Offset(lineX, size.height),
                                    strokeWidth = 1f,
                                )
                            },
                    ) {
                        Spacer(Modifier.height(4.dp))

                        if (renderableChildren.isNotEmpty()) {
                        // For READ tools, use FileTreeList for simple path display
                        if (item.toolKind == ToolKind.READ) {
                            val childPaths = renderableChildren.mapNotNull { it.toolPath }
                            Box(Modifier.padding(start = 16.dp)) {
                                FileTreeList(
                                    filePaths = childPaths,
                                    onFileClick = { path ->
                                        val syntheticItem = item.copy(toolPath = path)
                                        onOpenFile(syntheticItem)
                                    },
                                )
                            }
                        } else {
                            // Render grouped children inline with folder expansion
                            // Track expanded state for each folder child
                            val expandedFolders = remember { mutableStateMapOf<String, Boolean>() }
                            val hasManyChildren = renderableChildren.size > 5
                            val childrenScrollState = rememberScrollState()
                            if (hasManyChildren) {
                                BoxWithConstraints(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .heightIn(max = (5 * 28).dp),
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .verticalScroll(childrenScrollState),
                                    ) {
                                        Column(
                                            Modifier.fillMaxWidth(),
                                        ) {
                                            RenderChildrenContent(
                                                renderableChildren,
                                                expandedFolders,
                                                onOpenFile,
                                                muted,
                                            )
                                        }
                                    }
                                    VerticalScrollbar(
                                        adapter = rememberScrollbarAdapter(childrenScrollState),
                                        modifier = Modifier
                                            .align(Alignment.CenterEnd)
                                            .fillMaxHeight()
                                            .padding(end = 2.dp),
                                        style = ScrollbarStyle(
                                            minimalHeight = 16.dp,
                                            thickness = 6.dp,
                                            shape = RoundedCornerShape(3.dp),
                                            hoverDurationMillis = 300,
                                            unhoverColor = Color(0x33FFFFFF),
                                            hoverColor = Color(0x66FFFFFF),
                                        ),
                                    )
                                }
                            } else {
                                Column(
                                    Modifier
                                        .fillMaxWidth(),
                                ) {
                                    RenderChildrenContent(
                                        renderableChildren,
                                        expandedFolders,
                                        onOpenFile,
                                        muted,
                                    )
                                }
                            }
                        }
                    } else if (filePaths.isNotEmpty()) {
                        Column(
                            Modifier
                                .fillMaxWidth(),
                        ) {
                            Box(Modifier.padding(start = 16.dp)) {
                                FileTreeList(
                                    filePaths = filePaths,
                                    onFileClick = { path ->
                                        val syntheticItem = item.copy(toolPath = path)
                                        onOpenFile(syntheticItem)
                                    },
                                )
                            }
                        }
                    } else if (leafReadPath != null) {
                        // Standalone READ call: its single path is the expandable body,
                        // so the row keeps the same titled-group shape as merged reads.
                        Column(
                            Modifier
                                .fillMaxWidth(),
                        ) {
                            Box(Modifier.padding(start = 16.dp)) {
                                FileTreeList(
                                    filePaths = listOf(leafReadPath),
                                    onFileClick = { path ->
                                        val syntheticItem = item.copy(toolPath = path)
                                        onOpenFile(syntheticItem)
                                    },
                                )
                            }
                        }
                    } else if (item.toolKind != ToolKind.READ) {
                        // READ tools should only show file paths, not raw text output
                        ToolOutput(item, expandedTools, preserveScroll, processedText, onOpenFile)
                    }
                    }
                }
                permissionChoices?.takeIf { it.isNotEmpty() }?.let {
                    PermissionChoicesRow(it)
                }
        }
    }
}

@Composable
private fun PermissionChoicesRow(choices: List<PermissionChoice>) {
    Row(
        Modifier.fillMaxWidth()
            .padding(start = 21.dp, top = 4.dp, bottom = 4.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(DevEcoTheme.toolOutputBg)
            .border(1.dp, DevEcoTheme.toolOutputBorder, RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            MyMessageBundle.message("session.permission.title"),
            color = DevEcoTheme.muted,
            fontSize = 11.sp,
        )
        Spacer(Modifier.width(10.dp))
        choices.forEach { choice ->
            Box(
                Modifier
                    .clip(RoundedCornerShape(4.dp))
                    .background(DevEcoTheme.linkAccent)
                    .clickable { choice.select() }
                    .padding(horizontal = 10.dp, vertical = 4.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    choice.name,
                    color = DevEcoTheme.onAccent,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                )
            }
            Spacer(Modifier.width(6.dp))
        }
    }
}

/**
 * Renders the children of a tool group (file paths, folders, plain text items).
 * Extracted to allow reuse in both scrollable and non-scrollable layouts.
 */
@Composable
private fun RenderChildrenContent(
    renderableChildren: List<ChatItem>,
    expandedFolders: MutableMap<String, Boolean>,
    onOpenFile: (ChatItem) -> Unit,
    muted: Color,
) {
    val previewedFilePath = LocalPreviewedFilePath.current
    renderableChildren.forEachIndexed { index, child ->
        val childPath = child.toolPath!!
        val extension = FileTreeParser.getFileExtension(childPath)
        val isFolder = extension.isEmpty()
        val isActualFilePath = FileTreeParser.isFilePath(childPath) ||
            FileTreeParser.isDirectoryPath(childPath)
        var isHovered by remember { mutableStateOf(false) }
        val isPreviewed = previewedFilePath == childPath
        val rowBg = when {
            isPreviewed -> DevEcoTheme.previewedFileBg
            isHovered -> Color(0x33FFFFFF)
            else -> Color.Transparent
        }
        if (!isActualFilePath) {
            // Not a file/folder path — render as plain text without icon
            Row(
                Modifier.fillMaxWidth()
                    .padding(start = 16.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = childPath,
                    color = DevEcoTheme.foreground,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.weight(1f),
                )
            }
        } else if (isFolder) {
            // Folder: show chevron + folder icon + path, click to expand/collapse
            val isExpanded = expandedFolders[childPath] ?: false
            // Find children of this folder (paths that start with this folder path)
            val folderChildren = renderableChildren.filter { other ->
                other.toolPath != null &&
                    other.toolPath != childPath &&
                    other.toolPath!!.startsWith(childPath.trimEnd('/') + "/")
            }
            Row(
                Modifier.fillMaxWidth()
                    .padding(start = 16.dp)
                    .clickable {
                        expandedFolders[childPath] = !isExpanded
                    }
                    .hoverable { isHovered = it }
                    .clip(RoundedCornerShape(4.dp))
                    .background(rowBg)
                    .padding(start = 16.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Chevron for expand/collapse
                Icon(
                    key = if (isExpanded) AllIconsKeys.General.ChevronDown else AllIconsKeys.General.ChevronRight,
                    contentDescription = if (isExpanded) "Collapse folder" else "Expand folder",
                    modifier = Modifier.size(12.dp),
                    tint = muted,
                )
                Spacer(Modifier.width(4.dp))
                Icon(
                    key = AllIconsKeys.Nodes.Folder,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = muted,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    text = FileTreeParser.normalizePath(childPath),
                    color = muted,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.weight(1f),
                )
                // Show child count if expanded
                if (isExpanded && folderChildren.isNotEmpty()) {
                    Text(
                        text = "(${folderChildren.size})",
                        color = muted.copy(alpha = 0.7f),
                        fontSize = 11.sp,
                    )
                }
            }
            // Show folder children when expanded
            if (isExpanded && folderChildren.isNotEmpty()) {
                Column(
                    Modifier.padding(start = 12.dp),
                ) {
                    folderChildren.forEach { folderChild ->
                        val folderChildPath = folderChild.toolPath!!
                        val folderChildExt = FileTreeParser.getFileExtension(folderChildPath)
                        var folderChildHovered by remember { mutableStateOf(false) }
                        val folderChildRowBg = when {
                            folderChildHovered -> Color(0x33FFFFFF)
                            else -> Color.Transparent
                        }
                        Row(
                            Modifier.fillMaxWidth()
                                .padding(start = 16.dp)
                                .then(
                                    if (folderChildExt.isNotEmpty()) {
                                        Modifier.clickable { onOpenFile(folderChild) }
                                    } else {
                                        Modifier
                                    }
                                )
                                .hoverable { folderChildHovered = it }
                                .clip(RoundedCornerShape(4.dp))
                                .background(folderChildRowBg)
                                .padding(start = 16.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (folderChildExt.isNotEmpty()) {
                                FileIcon(filePath = folderChildPath)
                            } else {
                                Icon(
                                    key = AllIconsKeys.Nodes.Folder,
                                    contentDescription = null,
                                    modifier = Modifier.size(12.dp),
                                    tint = muted,
                                )
                            }
                            Spacer(Modifier.width(6.dp))
                            Text(
                                text = FileTreeParser.normalizePath(folderChildPath),
                                color = muted,
                                fontSize = 11.sp,
                                fontFamily = FontFamily.Monospace,
                            )
                        }
                    }
                }
            }
        } else {
            val childLineDiff = remember(child.id, child.toolRawInput) {
                AcpToolInputParser.computeLineDiff(child.toolRawInput)
            }
            Row(
                Modifier.fillMaxWidth()
                    .padding(start = 16.dp)
                    .clickable { onOpenFile(child) }
                    .hoverable { isHovered = it }
                    .clip(RoundedCornerShape(4.dp))
                    .background(rowBg)
                    .padding(start = 16.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                FileIcon(filePath = childPath)
                Spacer(Modifier.width(8.dp))
                Text(
                    text = FileTreeParser.normalizePath(childPath),
                    color = if (isPreviewed) DevEcoTheme.previewedFileFg else muted,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                )
                if (childLineDiff != null && !childLineDiff.isEmpty()) {
                    Spacer(Modifier.width(12.dp))
                    if (childLineDiff.added > 0) {
                        Text(
                            "+${childLineDiff.added}",
                            color = DevEcoTheme.lineDiffAdded,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    if (childLineDiff.added > 0 && childLineDiff.removed > 0) {
                        Spacer(Modifier.width(4.dp))
                    }
                    if (childLineDiff.removed > 0) {
                        Text(
                            "-${childLineDiff.removed}",
                            color = DevEcoTheme.lineDiffRemoved,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }
        }
    }
}

/**
 * Dispatches to type-specific output renderers based on [ChatItem.toolKind].
 */
@Composable
private fun ToolOutput(
    item: ChatItem,
    expandedTools: MutableMap<String, Boolean>,
    preserveScroll: ((() -> Unit) -> Unit),
    displayText: String,
    onOpenFile: (ChatItem) -> Unit,
) {
    val plainKey = "${item.id}_plain"
    when (item.toolKind) {
        ToolKind.EDIT, ToolKind.DELETE -> DiffToolOutput(item, expandedTools, preserveScroll, onOpenFile)
        ToolKind.EXECUTE -> TerminalToolOutput(item)
        ToolKind.SEARCH -> SearchToolOutput(item)
        ToolKind.THINK -> ThinkToolOutput(item)
        ToolKind.MOVE -> MoveToolOutput(item)
        ToolKind.FETCH, ToolKind.SWITCH_MODE -> InfoToolOutput(item)
        else -> PlainToolOutput(
            displayText,
            expandedTools[plainKey] ?: false,
        ) { preserveScroll { expandedTools[plainKey] = !(expandedTools[plainKey] ?: false) } }
    }
}

// ── EDIT / DELETE — diff-style file list with stats ───────────────────────

/**
 * Parses unified diff output to extract per-file change stats.
 * Returns list of (fileName, added, removed) tuples.
 */
private fun parseDiffStats(text: String): List<Triple<String, Int, Int>> {
    val lines = text.lines()
    val result = mutableListOf<Triple<String, Int, Int>>()
    var currentFile: String? = null
    var added = 0
    var removed = 0

    fun flush() {
        val file = currentFile ?: return
        if (added > 0 || removed > 0) {
            result.add(Triple(file, added, removed))
        }
        added = 0
        removed = 0
    }

    for (line in lines) {
        when {
            line.startsWith("+++ b/") || line.startsWith("+++ ") -> {
                flush()
                currentFile = line.removePrefix("+++ b/").removePrefix("+++ ").trim()
            }
            line.startsWith("+") && !line.startsWith("+++") -> added++
            line.startsWith("-") && !line.startsWith("---") -> removed++
        }
    }
    flush()
    return result
}

@Composable
@OptIn(ExperimentalComposeUiApi::class)
private fun DiffToolOutput(
    item: ChatItem,
    expandedTools: MutableMap<String, Boolean>,
    preserveScroll: ((() -> Unit) -> Unit),
    onOpenFile: (ChatItem) -> Unit,
) {
    // Prefer the snapshot-based line-count engine when it produced per-file
    // edits; it is more accurate than parsing unified-diff text or rawInput
    // heuristics, and covers write/move operations the text parser misses.
    val diffStats = remember(item.id, item.text, item.toolFileEdits) {
        if (item.toolFileEdits.isNotEmpty()) {
            item.toolFileEdits.map { Triple(it.path, it.additions, it.deletions) }
        } else {
            parseDiffStats(item.text)
        }
    }
    var hoveredIndex by remember { mutableIntStateOf(-1) }
    val previewedFilePath = LocalPreviewedFilePath.current

    val fileCount = diffStats.size

    // Content — rendered only when parent ToolItem is expanded
    Column(
        Modifier
            .fillMaxWidth()
            .padding(
                horizontal = DevEcoTheme.toolOutputPaddingH.dp,
                vertical = 4.dp,
            )
            .then(if (fileCount > 5) Modifier.verticalScroll(rememberScrollState()).heightIn(max = 160.dp) else Modifier),
    ) {
        if (diffStats.isEmpty()) {
            // Try to extract file paths from non-diff text (e.g. "Edit applied successfully.\n/path/to/file")
            val fallbackFilePaths = remember(item.id, item.text) {
                FileTreeParser.parseFilePaths(item.text)
            }
            val lineDiff = remember(item.id, item.toolRawInput) {
                AcpToolInputParser.computeLineDiff(item.toolRawInput)
            }
            if (fallbackFilePaths.isNotEmpty()) {
                fallbackFilePaths.forEachIndexed { index, filePath ->
                    val isHovered = hoveredIndex == index
                    val isPreviewed = previewedFilePath == filePath
                    val rowBg = when {
                        isPreviewed -> DevEcoTheme.previewedFileBg
                        isHovered -> Color(0x33FFFFFF)
                        else -> Color.Transparent
                    }
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(4.dp))
                            .background(rowBg)
                            .clickable {
                                onOpenFile(item.copy(toolPath = filePath))
                            }
                            .hoverable { hoveredIndex = if (it) index else -1 }
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        FileIcon(filePath = filePath)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = FileTreeParser.normalizePath(filePath),
                            color = if (isPreviewed) DevEcoTheme.previewedFileFg else DevEcoTheme.muted,
                            fontSize = 13.sp,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1,
                            modifier = Modifier.weight(1f),
                        )
                        // +/- line diff badge at file row tail
                        if (lineDiff != null && !lineDiff.isEmpty()) {
                            if (lineDiff.added > 0) {
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    "+${lineDiff.added}",
                                    color = DevEcoTheme.lineDiffAdded,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                            if (lineDiff.added > 0 && lineDiff.removed > 0) {
                                Spacer(Modifier.width(3.dp))
                            }
                            if (lineDiff.removed > 0) {
                                Text(
                                    "-${lineDiff.removed}",
                                    color = DevEcoTheme.lineDiffRemoved,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                        }
                    }
                    if (index < fallbackFilePaths.lastIndex) {
                        Spacer(Modifier.height(2.dp))
                    }
                }
            } else if (!item.toolPath.isNullOrBlank() && looksLikeFilePath(item.toolPath)) {
                // Fallback: show single file path from metadata (e.g. write tool with no diff)
                val lineDiff = remember(item.id, item.toolRawInput) {
                    AcpToolInputParser.computeLineDiff(item.toolRawInput)
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(4.dp))
                        .clickable { onOpenFile(item) }
                        .hoverable { hoveredIndex = if (it) 0 else -1 }
                        .background(when {
                            previewedFilePath == item.toolPath -> DevEcoTheme.previewedFileBg
                            hoveredIndex == 0 -> Color(0x33FFFFFF)
                            else -> Color.Transparent
                        })
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    FileIcon(filePath = item.toolPath)
                    Spacer(Modifier.width(8.dp))
                    val isSinglePreviewed = previewedFilePath == item.toolPath
                    Text(
                        text = FileTreeParser.normalizePath(item.toolPath),
                        color = if (isSinglePreviewed) DevEcoTheme.previewedFileFg else DevEcoTheme.muted,
                        fontSize = 13.sp,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 1,
                        modifier = Modifier.weight(1f),
                    )
                    if (lineDiff != null && !lineDiff.isEmpty()) {
                        if (lineDiff.added > 0) {
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "+${lineDiff.added}",
                                color = DevEcoTheme.lineDiffAdded,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                        if (lineDiff.added > 0 && lineDiff.removed > 0) {
                            Spacer(Modifier.width(3.dp))
                        }
                        if (lineDiff.removed > 0) {
                            Text(
                                "-${lineDiff.removed}",
                                color = DevEcoTheme.lineDiffRemoved,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                }
            } else {
                    // Fallback: show raw diff lines
                    val lines = item.text.lines().filter { it.isNotBlank() }
                    if (lines.isEmpty()) {
                        Text(
                            MyMessageBundle.message("message.noOutput"),
                            color = DevEcoTheme.muted,
                            fontSize = 12.sp,
                        )
                    } else {
                        lines.forEachIndexed { index, line ->
                            val isAdded = line.startsWith("+")
                            val isRemoved = line.startsWith("-")
                            val lineBg = when {
                                isAdded -> DevEcoTheme.toolEditAddedLineBg
                                isRemoved -> DevEcoTheme.toolEditRemovedLineBg
                                else -> Color.Transparent
                            }
                            val lineFg = when {
                                isAdded -> DevEcoTheme.lineDiffAdded
                                isRemoved -> DevEcoTheme.lineDiffRemoved
                                else -> DevEcoTheme.foreground
                            }
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(2.dp))
                                    .background(lineBg)
                                    .padding(horizontal = 4.dp, vertical = 0.dp),
                            ) {
                                Text(
                                    line,
                                    color = lineFg,
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 12.sp,
                                    lineHeight = 17.sp,
                                )
                            }
                            if (index < lines.lastIndex) {
                                Spacer(Modifier.height(1.dp))
                            }
                        }
                    }
                }
            } else {
                diffStats.forEachIndexed { index, (fileName, addedCount, removedCount) ->
                    val isHovered = hoveredIndex == index
                    val isPreviewed = previewedFilePath == fileName
                    val rowBg = when {
                        isPreviewed -> DevEcoTheme.previewedFileBg
                        isHovered -> Color(0x33FFFFFF)
                        else -> Color.Transparent
                    }

                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(4.dp))
                            .background(rowBg)
                            .clickable {
                                onOpenFile(item.copy(toolPath = fileName))
                            }
                            .hoverable { hoveredIndex = if (it) index else -1 }
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        FileIcon(filePath = fileName)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = fileName,
                            color = if (isPreviewed) DevEcoTheme.previewedFileFg else DevEcoTheme.muted,
                            fontSize = 13.sp,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(8.dp))
                        if (addedCount > 0) {
                            Text(
                                "+$addedCount",
                                color = DevEcoTheme.lineDiffAdded,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                        if (addedCount > 0 && removedCount > 0) {
                            Spacer(Modifier.width(4.dp))
                        }
                        if (removedCount > 0) {
                            Text(
                                "-$removedCount",
                                color = DevEcoTheme.lineDiffRemoved,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                    if (index < diffStats.lastIndex) {
                        Spacer(Modifier.height(2.dp))
                    }
                }
            }
        }
    }

// ── EXECUTE — dark output box ─────────────────────────────────────────────

/**
 * Strip ANSI escape sequences from [text].
 * Handles both standard CSI sequences (`\x1b[...X` for any final byte — colors,
 * cursor moves and line erases alike) and the transport-escaped SGR variant
 * where the ESC byte is replaced with `@` (e.g. `@36m` or `@[36m`).
 */
private fun stripAnsiCodes(text: String): String {
    if (text.isEmpty()) return text
    // Standard CSI: ESC [ ... final byte (ESC = 0x1B, represented as \u001B)
    val standard = Regex("\u001B\\[[0-9;?]*[A-Za-z]")
    // Transport-escaped: @ ... m  (ESC byte replaced with '@' during serialization)
    val escaped = Regex("@[0-9;]*m")
    return text.replace(standard, "").replace(escaped, "")
}

/**
 * Render-layer-only cleanup for command output. The text is displayed verbatim,
 * with one terminal-accurate concession: a line repainted through `\r` keeps
 * only its last non-empty frame, which is what a terminal actually shows.
 * Numbers, paths and JSON bodies are never rewritten.
 */
private fun sanitizeToolOutput(text: String): String {
    if (text.isEmpty()) return text
    return text.split('\n').joinToString("\n") { line ->
        line.split('\r').lastOrNull { it.isNotBlank() } ?: ""
    }
}

@Composable
private fun TerminalToolOutput(item: ChatItem) {
    val cleanText = remember(item.id, item.text) { sanitizeToolOutput(stripAnsiCodes(item.text)) }
    // Match the IDE editor font family/size/line-height so execute output matches the editor.
    val editorStyle = retrieveEditorTextStyle()
    Box(
        Modifier
            .fillMaxWidth()
            .padding(start = DevEcoTheme.toolIndent.dp)
            .clip(RoundedCornerShape(DevEcoTheme.toolOutputRadius.dp))
            .background(DevEcoTheme.toolExecBg)
            .border(1.dp, DevEcoTheme.toolExecBorder, RoundedCornerShape(DevEcoTheme.toolOutputRadius.dp))
            .padding(
                horizontal = DevEcoTheme.toolOutputPaddingH.dp,
                vertical = 4.dp,
            ),
    ) {
        Column {
            Text(
                cleanText.ifBlank { MyMessageBundle.message("message.noOutput") },
                color = if (cleanText.isBlank()) DevEcoTheme.muted else DevEcoTheme.toolExecFg,
                fontFamily = editorStyle.fontFamily,
                fontSize = editorStyle.fontSize,
                lineHeight = editorStyle.lineHeight,
            )
        }
    }
}

// ── SEARCH — structured result list with file icons ────────────────────────

@Composable
@OptIn(ExperimentalComposeUiApi::class)
private fun SearchToolOutput(item: ChatItem) {
    val filePaths = remember(item.id, item.text) {
        FileTreeParser.parseFilePaths(item.text)
    }

    if (filePaths.isNotEmpty()) {
        // Use FileTreeList for styled file display
        FileTreeList(
            filePaths = filePaths,
            onFileClick = { /* File click handled by parent */ },
        )
    } else {
        // Fallback: show raw text as markdown in styled container
        val results = item.text.split("\n\n").filter { it.isNotBlank() }
        Box(
            Modifier
                .fillMaxWidth()
                .padding(start = DevEcoTheme.toolIndent.dp)
                .clip(RoundedCornerShape(DevEcoTheme.toolOutputRadius.dp))
                .background(DevEcoTheme.toolSearchBg)
                .border(1.dp, DevEcoTheme.toolSearchBorder, RoundedCornerShape(DevEcoTheme.toolOutputRadius.dp)),
        ) {
            Column(
                Modifier.padding(
                    horizontal = DevEcoTheme.toolOutputPaddingH.dp,
                    vertical = 4.dp,
                ),
            ) {
                if (results.isEmpty()) {
                    Text(
                        MyMessageBundle.message("message.noOutput"),
                        color = DevEcoTheme.muted,
                        fontSize = 12.sp,
                    )
                } else {
                    results.forEachIndexed { index, result ->
                        if (index > 0) {
                            Spacer(
                                Modifier
                                    .fillMaxWidth()
                                    .height(1.dp)
                                    .background(DevEcoTheme.toolSearchBorder.copy(alpha = 0.15f)),
                            )
                            Spacer(Modifier.height(6.dp))
                        }
                        MarkdownWithCodeBlocks(
                            text = result,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        if (index < results.lastIndex) {
                            Spacer(Modifier.height(6.dp))
                        }
                    }
                }
            }
        }
    }
}

// ── THINK — bordered card with markdown body ───────────────────────────────

@Composable
private fun ThinkToolOutput(item: ChatItem) {
    // Running subagent with no forwarded progress yet: the spinner row above
    // already signals activity — an empty "no output" box would be noise.
    // Memoized: thinkBody runs a full-text regex per item.
    val body = remember(item) { thinkBody(item) } ?: return
    Box(
        Modifier
            .fillMaxWidth()
            .padding(start = DevEcoTheme.toolIndent.dp)
            .clip(RoundedCornerShape(DevEcoTheme.toolOutputRadius.dp))
            .background(DevEcoTheme.toolOutputBg)
            .border(1.dp, DevEcoTheme.toolOutputBorder, RoundedCornerShape(DevEcoTheme.toolOutputRadius.dp))
            .padding(
                horizontal = DevEcoTheme.toolOutputPaddingH.dp,
                vertical = 4.dp,
            ),
    ) {
        // A finished subagent reports in full markdown (headings, tables, bold):
        // render it like agent messages instead of plain italic text.
        if (body.isBlank()) {
            Text(
                MyMessageBundle.message("message.noOutput"),
                color = DevEcoTheme.muted,
                fontSize = 13.sp,
                lineHeight = 18.sp,
            )
        } else {
            MarkdownWithCodeBlocks(
                text = body,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** THINK card body text, or null while the body must stay hidden. */
private fun thinkBody(item: ChatItem): String? {
    val running = item.toolStatus == ToolCallStatus.PENDING ||
        item.toolStatus == ToolCallStatus.IN_PROGRESS
    val wrapper = AcpToolInputParser.parseTaskWrapper(item.text)
    // The dispatch receipt ("started" wrapper) is model-facing instruction text.
    if (wrapper?.state == "running") return null
    val body = wrapper?.body ?: item.text
    return if (running && body.isBlank()) null else body
}

// ─ MOVE — accent-bordered compact card ────────────────────────────────────

@Composable
private fun MoveToolOutput(item: ChatItem) {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(start = DevEcoTheme.toolIndent.dp)
            .clip(RoundedCornerShape(DevEcoTheme.toolOutputRadius.dp))
            .background(DevEcoTheme.toolMoveBg)
            .border(1.dp, DevEcoTheme.toolMoveBorder, RoundedCornerShape(DevEcoTheme.toolOutputRadius.dp))
            .padding(
                horizontal = DevEcoTheme.toolOutputPaddingH.dp,
                vertical = 4.dp,
            ),
    ) {
        Text(
            item.text.ifBlank { MyMessageBundle.message("message.noOutput") },
            color = if (item.text.isBlank()) DevEcoTheme.muted else DevEcoTheme.foreground,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            lineHeight = 17.sp,
        )
    }
}

// ── FETCH / PUBLICATION / SWITCH_MODE — info card ──────────────────────────

@Composable
private fun InfoToolOutput(item: ChatItem) {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(start = DevEcoTheme.toolIndent.dp)
            .clip(RoundedCornerShape(DevEcoTheme.toolOutputRadius.dp))
            .background(DevEcoTheme.toolOutputBg)
            .border(1.dp, DevEcoTheme.toolOutputBorder, RoundedCornerShape(DevEcoTheme.toolOutputRadius.dp))
            .padding(
                horizontal = DevEcoTheme.toolOutputPaddingH.dp,
                vertical = 4.dp,
            ),
    ) {
        Text(
            item.text.ifBlank { MyMessageBundle.message("message.noOutput") },
            color = if (item.text.isBlank()) DevEcoTheme.muted else DevEcoTheme.foreground,
            fontSize = 13.sp,
            lineHeight = 18.sp,
        )
    }
}

// ─ Default — plain monospace card (READ, OTHER, etc.) ─────────────────────

private const val PLAIN_OUTPUT_DEFAULT_LINES = 10
private const val PLAIN_OUTPUT_EXPANDED_LINES = 500

@Composable
private fun PlainToolOutput(text: String, expanded: Boolean, onToggle: () -> Unit) {
    val lines = remember(text) { text.lines() }
    val totalLines = lines.size
    val needsExpand = totalLines > PLAIN_OUTPUT_DEFAULT_LINES
    val visibleLines = if (expanded) lines.take(PLAIN_OUTPUT_EXPANDED_LINES) else lines.take(PLAIN_OUTPUT_DEFAULT_LINES)
    val hiddenCount = if (expanded) (totalLines - PLAIN_OUTPUT_EXPANDED_LINES).coerceAtLeast(0) else (totalLines - PLAIN_OUTPUT_DEFAULT_LINES).coerceAtLeast(0)
    val canToggle = needsExpand || expanded

    Box(
        Modifier
            .fillMaxWidth()
            .padding(start = DevEcoTheme.toolIndent.dp)
            .clip(RoundedCornerShape(DevEcoTheme.toolOutputRadius.dp))
            .background(DevEcoTheme.toolOutputBg)
            .border(1.dp, DevEcoTheme.toolOutputBorder, RoundedCornerShape(DevEcoTheme.toolOutputRadius.dp)),
    ) {
        Column(
            Modifier
                .padding(
                    horizontal = DevEcoTheme.toolOutputPaddingH.dp,
                    vertical = 4.dp,
                )
                .focusProperties { canFocus = false },
        ) {
            visibleLines.forEach { line ->
                Text(
                    line.ifBlank { " " },
                    color = if (text.isBlank()) DevEcoTheme.muted else DevEcoTheme.foreground,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    lineHeight = 17.sp,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            // Expand/collapse toggle
            if (canToggle) {
                Spacer(Modifier.height(4.dp))
                val toggleText = if (expanded) {
                    if (hiddenCount > 0) "… $hiddenCount more lines (collapse)" else "collapse"
                } else {
                    "… $hiddenCount more lines"
                }
                Box(
                    modifier = Modifier
                        .height(20.dp)
                        .focusProperties { canFocus = false }
                        .clip(RoundedCornerShape(4.dp))
                        .pointerHoverIcon(PointerIcon.Default, overrideDescendants = true)
                        .pointerInput(Unit) {
                            var pressed = false
                            awaitPointerEventScope {
                                while (true) {
                                    val event = awaitPointerEvent(PointerEventPass.Initial)
                                    when (event.type) {
                                        PointerEventType.Press -> {
                                            event.changes.forEach { it.consume() }
                                            pressed = true
                                        }
                                        PointerEventType.Release -> {
                                            if (pressed) {
                                                event.changes.forEach { it.consume() }
                                                onToggle()
                                            }
                                            pressed = false
                                        }
                                    }
                                }
                            }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        toggleText,
                        color = DevEcoTheme.linkAccent,
                        fontSize = 11.sp,
                    )
                }
            }
        }
    }
}
