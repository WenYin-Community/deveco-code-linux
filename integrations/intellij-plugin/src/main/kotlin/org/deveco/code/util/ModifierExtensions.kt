package org.deveco.code.util

import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerMoveFilter

@OptIn(ExperimentalComposeUiApi::class)
fun Modifier.hoverable(onHoverChange: (Boolean) -> Unit): Modifier = pointerMoveFilter(
    onEnter = {
        onHoverChange(true)
        false
    },
    onExit = {
        onHoverChange(false)
        false
    },
)
