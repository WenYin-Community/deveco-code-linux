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

// Client-side commands: session ops executed immediately on selection; prompt-style
// server commands insert into the composer instead (see selectSlashItem).
// Carries its description keys so iterating it can never miss a localization.
private val CLIENT_COMMANDS = mapOf(
    "compact" to "slash.command.compact.desc",
    "new" to "slash.command.new.desc",
)

// Commands the backend registers but the product does not expose yet: hidden
// from autocomplete only. Typed "/goal ..." still goes through the send path
// unchanged (controller.commands keeps the entry), so echo/replay stay correct.
private val HIDDEN_COMMANDS = setOf("goal")

// Server-side commands come from the server list (the single source of truth for
// what can actually execute); KNOWN_COMMANDS only localizes the description of
// names we ship bundle keys for, so a stale entry here can never offer a dead command.
private val KNOWN_COMMANDS = CLIENT_COMMANDS + mapOf(
    "debug" to "slash.command.debug.desc",
    "init" to "slash.command.init.desc",
    "review" to "slash.command.review.desc",
    "analyze" to "slash.command.analyze.desc",
    "customize-deveco" to "slash.command.customize-deveco.desc",
    "deveco-cli" to "slash.command.deveco-cli.desc",
    "hmos-dfx-analyzer" to "slash.command.hmos-dfx-analyzer.desc",
    "hmos-arkui-develop-skill" to "slash.command.hmos-arkui-develop-skill.desc",
    "hmos-design-to-arkts" to "slash.command.hmos-design-to-arkts.desc",
    "ui-verification-with-deeplink" to "slash.command.ui-verification-with-deeplink.desc",
)

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
    if (spaceIndex < 0) return buildFilterItems(afterSlash.lowercase(), commands)

    val commandName = afterSlash.substring(0, spaceIndex).lowercase()
    val rest = afterSlash.substring(spaceIndex + 1)
    // A trailing space (left by command insertion or a restored draft) is not an
    // argument: keep offering command completions until real argument text appears.
    // "/models " is the exception — its trailing space opens the model sub-list.
    if (rest.isBlank() && commandName != "models") {
        return buildFilterItems(commandName, commands)
    }
    return buildSubItems(commandName, rest.trim().lowercase(), models)
}

private fun buildFilterItems(filter: String, commands: List<CommandChoice>): List<SlashItem> {
    val clientCommands = CLIENT_COMMANDS.entries
        .filter { it.key.startsWith(filter) }
        .map { entry ->
            SlashItem(
                displayText = "/${entry.key}",
                description = MyMessageBundle.message(entry.value),
                kind = SlashItemKind.COMMAND,
                payload = entry.key,
            )
        }
    val serverCommands = commands
        .filter { cmd ->
            cmd.name.lowercase().let {
                it.startsWith(filter) && it !in CLIENT_COMMANDS && it !in HIDDEN_COMMANDS
            }
        }
        .sortedBy { it.kind.ordinal }
        .map { cmd ->
            SlashItem(
                displayText = "/${cmd.name}",
                description = KNOWN_COMMANDS[cmd.name.lowercase()]
                    ?.let { MyMessageBundle.message(it) }
                    ?: cmd.description,
                kind = SlashItemKind.SERVER_COMMAND,
                payload = cmd.name,
                tag = when (cmd.kind) {
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
