package org.deveco.code.session.ui.composer

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import org.deveco.code.DevEcoTheme
import org.deveco.code.MyMessageBundle
import org.jetbrains.jewel.ui.component.Text

private val IMAGE_VIEWER_WIDTH = 600.dp
private val IMAGE_VIEWER_HEIGHT = 500.dp

@Composable
internal fun ImageViewerPopup(
    imageBytes: ByteArray,
    onDismiss: () -> Unit,
) {
    val skiaImage = remember(imageBytes) { runCatching { org.jetbrains.skia.Image.makeFromEncoded(imageBytes) }.getOrNull() }
    val imageBitmap = remember(skiaImage) { skiaImage?.toComposeImageBitmap() }
    Popup(
        alignment = Alignment.Center,
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true),
    ) {
        Box(
            modifier = Modifier
                .size(IMAGE_VIEWER_WIDTH, IMAGE_VIEWER_HEIGHT)
                .clip(RoundedCornerShape(12.dp))
                .background(DevEcoTheme.cardFg)
                .border(1.dp, DevEcoTheme.popupBorder, RoundedCornerShape(12.dp))
        ) {
            if (imageBitmap != null) {
                Image(
                    bitmap = imageBitmap,
                    contentDescription = "Full image preview",
                    modifier = Modifier.fillMaxSize().clickable { onDismiss() },
                )
            } else {
                Text(
                    MyMessageBundle.message("composer.imageDecodeError"),
                    color = DevEcoTheme.onAccent.copy(alpha = DevEcoTheme.mutedActionAlpha),
                    fontSize = 14.sp,
                    modifier = Modifier.align(Alignment.Center),
                )
            }
        }
    }
}
