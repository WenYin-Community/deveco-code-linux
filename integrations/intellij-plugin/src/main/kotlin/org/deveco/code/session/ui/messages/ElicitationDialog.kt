package org.deveco.code.session.ui.messages

import androidx.compose.foundation.ScrollbarStyle
import androidx.compose.foundation.VerticalScrollbar
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.rememberScrollbarAdapter
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.intellij.ui.JBColor
import org.jetbrains.jewel.bridge.toComposeColor
import org.jetbrains.jewel.ui.component.Text
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.deveco.code.session.model.ElicitationFieldItem
import org.deveco.code.session.model.ElicitationItem

// Roughly six option rows stay visible per step; anything longer scrolls inside the card
// (design rule: 单步最多显示 6 项，过多滚动隐藏).
private val OPTION_AREA_MAX_HEIGHT = 240.dp

@Composable
internal fun ElicitationDialog(
    item: ElicitationItem,
    onDismiss: () -> Unit,
) {
    val card = JBColor.namedColor("Editor.SearchField.background", 0x27282C).toComposeColor()
    val border = JBColor.namedColor("Group.separatorColor", 0xD0D7DE).toComposeColor()
    val foreground = JBColor.namedColor("Label.foreground", 0x1E1F22).toComposeColor()
    val accent = DevEcoTheme.accent
    val muted = JBColor.namedColor("Label.infoForeground", 0x868A91).toComposeColor()
    if (item.fields.isEmpty()) return
    // Multi-field questions are stepped through one field at a time, so a long
    // questionnaire cannot flood the card and push the actions off-screen.
    var step by remember(item) { mutableStateOf(0) }
    val multiStep = item.fields.size > 1
    val field = item.fields[step]
    val lastStep = step == item.fields.size - 1
    val selections = item.selections
    val customAnswers = item.customAnswers
    val answers = item.fields.mapNotNull { f ->
        val values = selections[f.key].orEmpty().toList() +
            listOfNotNull(customAnswers[f.key]?.trim()?.takeIf { it.isNotEmpty() })
        values.distinct().takeIf { it.isNotEmpty() }?.let { f.key to it }
    }.toMap()
    val canSubmit = item.fields.filter { it.required }.all { answers[it.key].orEmpty().isNotEmpty() }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp, vertical = 8.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(card)
            .border(1.dp, accent.copy(alpha = 0.5f), RoundedCornerShape(8.dp))
            .padding(12.dp),
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = item.title,
                    color = accent,
                    fontSize = 14.sp,
                )
                if (multiStep) {
                    Text(text = "${step + 1}/${item.fields.size}", color = muted, fontSize = 12.sp)
                }
            }

            val scrollState = rememberScrollState()
            // weight(fill = false) keeps the title and action row measured first, so the
            // options area only takes what is left above the composer and never evicts
            // the submit button even in a short tool window.
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f, fill = false)
                    .heightIn(max = OPTION_AREA_MAX_HEIGHT)
                    .clipToBounds(),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .verticalScroll(scrollState),
                ) {
                    FieldContent(
                        field = field,
                        card = card,
                        border = border,
                        foreground = foreground,
                        accent = accent,
                        muted = muted,
                        selections = selections,
                        customAnswers = customAnswers,
                    )
                }
                if (scrollState.maxValue > 0) {
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
                            unhoverColor = JBColor(0x33000000, 0x33FFFFFF).toComposeColor(),
                            hoverColor = JBColor(0x66000000, 0x66FFFFFF).toComposeColor(),
                        ),
                    )
                }
            }
            LaunchedEffect(step) { scrollState.scrollTo(0) }

            Spacer(Modifier.height(10.dp))
            if (multiStep) {
                Box(modifier = Modifier.fillMaxWidth()) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterStart)
                            .clickable { onDismiss() }
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                    ) {
                        Text(text = MyMessageBundle.message("elicitation.cancel"), color = muted, fontSize = 12.sp)
                    }
                    Row(
                        modifier = Modifier.align(Alignment.Center),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (step > 0) {
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(4.dp))
                                    .background(border.copy(alpha = 0.35f))
                                    .clickable { step-- }
                                    .padding(horizontal = 12.dp, vertical = 6.dp),
                            ) {
                                Text(
                                    text = MyMessageBundle.message("elicitation.previous"),
                                    color = foreground,
                                    fontSize = 12.sp,
                                )
                            }
                        }
                        val nextEnabled = !lastStep || canSubmit
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(4.dp))
                                .background(if (nextEnabled) accent else muted.copy(alpha = 0.35f))
                                .clickable(enabled = nextEnabled) {
                                    if (lastStep) item.onSubmit(answers) else step++
                                }
                                .padding(horizontal = 12.dp, vertical = 6.dp),
                        ) {
                            Text(
                                text = if (lastStep) {
                                    MyMessageBundle.message("elicitation.submit")
                                } else {
                                    MyMessageBundle.message("elicitation.next")
                                },
                                color = card,
                                fontSize = 12.sp,
                            )
                        }
                    }
                }
            } else {
                Row(modifier = Modifier.align(Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .clickable { onDismiss() }
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                    ) {
                        Text(text = MyMessageBundle.message("elicitation.cancel"), color = muted, fontSize = 12.sp)
                    }
                    Spacer(Modifier.width(6.dp))
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(4.dp))
                            .background(if (canSubmit) accent else muted.copy(alpha = 0.35f))
                            .clickable(enabled = canSubmit) { item.onSubmit(answers) }
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                    ) {
                        Text(text = MyMessageBundle.message("elicitation.submit"), color = card, fontSize = 12.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun FieldContent(
    field: ElicitationFieldItem,
    card: Color,
    border: Color,
    foreground: Color,
    accent: Color,
    muted: Color,
    selections: SnapshotStateMap<String, Set<String>>,
    customAnswers: SnapshotStateMap<String, String>,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = field.question,
            color = foreground,
            fontSize = 13.sp,
        )
        if (field.options.isNotEmpty()) Spacer(Modifier.height(6.dp))
        field.options.forEach { option ->
            val selected = option.value in selections[field.key].orEmpty()
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 2.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(accent.copy(alpha = if (selected) 0.2f else 0.08f))
                    .clickable {
                        selections[field.key] = if (field.multiple) {
                            if (selected) selections[field.key].orEmpty() - option.value
                            else selections[field.key].orEmpty() + option.value
                        } else {
                            setOf(option.value)
                        }
                        if (!field.multiple) customAnswers.remove(field.key)
                    }
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = if (field.multiple) {
                            if (selected) "☑ " else "☐ "
                        } else {
                            if (selected) "◉ " else "○ "
                        },
                        color = accent,
                        fontSize = 13.sp,
                    )
                    Spacer(Modifier.width(6.dp))
                    Column {
                        Text(text = option.label, color = foreground, fontSize = 13.sp)
                        option.description?.takeIf { it.isNotBlank() }?.let {
                            Text(text = it, color = muted, fontSize = 11.sp)
                        }
                    }
                }
            }
        }
        if (field.allowCustom || field.options.isEmpty()) {
            Spacer(Modifier.height(6.dp))
            BasicTextField(
                value = customAnswers[field.key].orEmpty(),
                onValueChange = {
                    customAnswers[field.key] = it
                    if (!field.multiple && it.isNotBlank()) selections.remove(field.key)
                },
                textStyle = TextStyle(color = foreground, fontSize = 13.sp),
                cursorBrush = SolidColor(foreground),
                singleLine = !field.multiple,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(4.dp))
                    .background(card)
                    .border(1.dp, border, RoundedCornerShape(4.dp))
                    .padding(horizontal = 8.dp, vertical = 7.dp),
                decorationBox = { innerTextField ->
                    Box {
                        if (customAnswers[field.key].isNullOrEmpty()) {
                            Text(text = MyMessageBundle.message("elicitation.placeholder"), color = muted, fontSize = 13.sp)
                        }
                        innerTextField()
                    }
                },
            )
        }
    }
}
