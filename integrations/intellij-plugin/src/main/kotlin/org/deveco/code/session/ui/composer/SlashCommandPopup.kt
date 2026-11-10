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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.model.CommandChoice
import org.deveco.code.session.model.CommandKind
import org.deveco.code.session.model.ModelChoice
import org.jetbrains.jewel.ui.component.Text

internal val COMPOSER_POPUP_MIN_WIDTH = 280.dp
private val SLASH_POPUP_MAX_WIDTH = 400.dp

// --- Slash command popup ---

// Client-side commands: selected → executed immediately via sendPrompt.
// Server-side commands: selected → expanded as "/<name> " in the input for user to add args.
// Both share localized description keys.
private val KNOWN_COMMANDS = mapOf(
    "compact" to "slash.command.compact.desc",
    "new" to "slash.command.new.desc",
    "debug" to "slash.command.debug.desc",
    "init" to "slash.command.init.desc",
    "review" to "slash.command.review.desc",
    "arkts-error-fixes" to "slash.command.arkts-error-fixes.desc",
    "arkts-grammar-standards" to "slash.command.arkts-grammar-standards.desc",
    "arkts-runtime-fix" to "slash.command.arkts-runtime-fix.desc",
    "customize-deveco" to "slash.command.customize-deveco.desc",
    "deveco-cli" to "slash.command.deveco-cli.desc",
    "deveco-create-project" to "slash.command.deveco-create-project.desc",
    "analyze" to "slash.command.analyze.desc",
    "hmos-dfx-analyzer" to "slash.command.hmos-dfx-analyzer.desc",
    "hmos-arkui-develop-skill" to "slash.command.hmos-arkui-develop-skill.desc",
    "hmos-design-to-arkts" to "slash.command.hmos-design-to-arkts.desc",
)

private val CLIENT_COMMANDS = setOf("compact", "new")

internal enum class SlashItemKind { COMMAND, MODEL, SERVER_COMMAND }

internal data class SlashItem(
    val displayText: String,
    val description: String,
    val kind: SlashItemKind,
    val payload: String? = null,
    val tag: String? = null,
)

internal fun computeSlashItems(
    text: String,
    models: List<ModelChoice>,
    commands: List<CommandChoice>,
): List<SlashItem> {
    val trimmed = text.trimStart()
    if (!trimmed.startsWith("/")) return emptyList()

    val afterSlash = trimmed.substring(1)
    val spaceIndex = afterSlash.indexOf(' ')

    return if (spaceIndex < 0) {
        buildFilterItems(afterSlash.lowercase(), commands)
    } else {
        val commandName = afterSlash.substring(0, spaceIndex).lowercase()
        val filter = afterSlash.substring(spaceIndex + 1).trim().lowercase()
        buildSubItems(commandName, filter, models)
    }
}

private fun buildFilterItems(filter: String, commands: List<CommandChoice>): List<SlashItem> {
    val knownNamesLower = KNOWN_COMMANDS.keys.map { it.lowercase() }
    val serverKindMap = commands.associate { it.name.lowercase() to it.kind }

    val knownNames = KNOWN_COMMANDS.keys.filter { it.lowercase().startsWith(filter) }
    val clientCommands = knownNames
        .map { name ->
            val isClient = name in CLIENT_COMMANDS
            val kind = serverKindMap[name.lowercase()]?.let { k ->
                when (k) {
                    CommandKind.SKILL -> "Skill"
                    CommandKind.MCP -> "MCP"
                    else -> null
                }
            }
            SlashItem(
                displayText = "/$name",
                description = MyMessageBundle.message(KNOWN_COMMANDS[name]!!),
                kind = if (isClient) SlashItemKind.COMMAND else SlashItemKind.SERVER_COMMAND,
                payload = name,
                tag = if (isClient) null else kind,
            )
        }
    // Filter out server commands that match known commands (case-insensitive)
    val serverCommands = commands
        .filter { cmd ->
            cmd.name.lowercase().startsWith(filter) && cmd.name.lowercase() !in knownNamesLower
        }
        .sortedBy { it.kind.ordinal }
        .map {
            SlashItem(
                displayText = "/${it.name}",
                description = it.description,
                kind = SlashItemKind.SERVER_COMMAND,
                payload = it.name,
                tag = when (it.kind) {
                    CommandKind.SKILL -> "Skill"
                    CommandKind.MCP -> "MCP"
                    else -> null
                },
            )
        }
    return clientCommands + serverCommands
}

private fun buildSubItems(
    commandName: String,
    filter: String,
    models: List<ModelChoice>,
): List<SlashItem> = when (commandName) {
    "models" -> models
        .filter { matchesFilter(it.name, it.id, filter) }
        .map {
            SlashItem(
                displayText = it.name,
                description = MyMessageBundle.message("slash.command.model"),
                kind = SlashItemKind.MODEL,
                payload = it.id,
            )
        }
    else -> emptyList()
}

private fun matchesFilter(name: String, id: String, filter: String): Boolean =
    filter.isEmpty() || name.lowercase().contains(filter) || id.lowercase().contains(filter)


@Composable
internal fun SlashCommandPopupContent(
    items: List<SlashItem>,
    selectedIndex: Int,
    background: Color,
    muted: Color,
    accent: Color,
    maxHeight: androidx.compose.ui.unit.Dp,
    onSelect: (SlashItem) -> Unit,
) {
    val scrollState = rememberScrollState()
    val selectedBg = accent.copy(alpha = 0.12f)
    val itemHeightPx = with(LocalDensity.current) { 36.dp.toPx().toInt() }

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
            .widthIn(min = COMPOSER_POPUP_MIN_WIDTH, max = SLASH_POPUP_MAX_WIDTH)
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
                Text(
                    item.displayText,
                    color = Color.Unspecified,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(12.dp))
                Text(
                    item.description,
                    color = muted,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 200.dp),
                )
                item.tag?.let { tag ->
                    Spacer(Modifier.width(8.dp))
                    Text(
                        tag,
                        color = accent.copy(alpha = 0.6f),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}
