package org.deveco.code.session.ui.composer

import org.deveco.code.SmallSpinner

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.TodoDockItem
import org.deveco.code.session.TodoDockStatus
import org.jetbrains.jewel.ui.component.Icon
import org.jetbrains.jewel.ui.component.Text
import org.jetbrains.jewel.ui.icons.AllIconsKeys

@Composable
internal fun TodoDock(
    items: List<TodoDockItem>,
    onJumpToTool: (toolItemId: String) -> Unit,
) {
    if (items.isEmpty()) return
    var expanded by remember { mutableStateOf(true) }
    val borderColor = DevEcoTheme.toolOutputBorder
    val itemRowBg = DevEcoTheme.toolReadBg

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 6.dp),
    ) {
        Column(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .border(1.dp, borderColor, RoundedCornerShape(12.dp)),
        ) {
            Row(
                Modifier.fillMaxWidth()
                    .clickable { expanded = !expanded }
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    key = if (expanded) AllIconsKeys.General.ChevronDown
                    else AllIconsKeys.General.ChevronRight,
                    contentDescription = if (expanded) "Collapse" else "Expand",
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    MyMessageBundle.message("todo.title"),
                    color = DevEcoTheme.muted,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                )
                Spacer(Modifier.width(8.dp))
                val completed = items.count { it.status == TodoDockStatus.COMPLETED }
                Text(
                    "$completed/${items.size}",
                    color = DevEcoTheme.muted,
                    fontSize = 12.sp,
                )
            }

            if (expanded) {
                Column(
                    Modifier.padding(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 8.dp),
                ) {
                    items.forEach { todo ->
                        TodoDockRow(todo, itemRowBg, onJumpToTool)
                        if (todo != items.last()) {
                            Spacer(Modifier.height(4.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TodoDockRow(
    todo: TodoDockItem,
    itemRowBg: Color,
    onJumpToTool: (toolItemId: String) -> Unit,
) {
    val clickable = todo.status == TodoDockStatus.COMPLETED
    Row(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(itemRowBg)
            .then(if (clickable) Modifier.clickable { onJumpToTool(todo.toolItemId) } else Modifier)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
            when (todo.status) {
                TodoDockStatus.COMPLETED -> {
                    Text(
                        "✓",
                        color = DevEcoTheme.green,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
                TodoDockStatus.IN_PROGRESS -> {
                    SmallSpinner(color = DevEcoTheme.loadingIndicatorColor)
                }
                TodoDockStatus.PENDING -> {
                    Box(
                        Modifier.size(12.dp)
                            .border(1.dp, DevEcoTheme.mutedGray.copy(alpha = 0.5f), CircleShape),
                    )
                }
                TodoDockStatus.CANCELLED -> {
                    Box(
                        Modifier.size(12.dp)
                            .border(1.dp, DevEcoTheme.mutedGray.copy(alpha = 0.3f), CircleShape),
                    )
                }
            }
        }
        Spacer(Modifier.width(8.dp))
        Text(
            todo.content,
            color = when (todo.status) {
                TodoDockStatus.COMPLETED -> DevEcoTheme.green
                TodoDockStatus.IN_PROGRESS -> DevEcoTheme.foreground
                TodoDockStatus.PENDING -> DevEcoTheme.mutedGray
                TodoDockStatus.CANCELLED -> DevEcoTheme.mutedGray.copy(alpha = 0.5f)
            },
            fontSize = 12.sp,
        )
    }
}
