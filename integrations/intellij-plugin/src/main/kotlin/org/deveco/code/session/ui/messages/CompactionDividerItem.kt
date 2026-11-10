package org.deveco.code.session.ui.messages

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.jetbrains.jewel.ui.component.Text

// TUI parity: the terminal UI renders a compaction-only user message as a
// horizontal rule with a centered "Compaction" title instead of a bubble
// (packages/tui session route, border-top box with centered title).
@Composable
internal fun CompactionDividerItem(muted: Color) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val line = Modifier.weight(1f).height(1.dp).background(muted.copy(alpha = 0.5f))
        Box(line)
        // The label mirrors the persisted mode token ("compaction"), which the TUI
        // also shows untranslated; keep it locale-independent.
        Text("Compaction", color = muted, fontSize = 12.sp)
        Box(line)
    }
}
