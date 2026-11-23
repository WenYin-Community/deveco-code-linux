package org.deveco.code.session.model.configuration

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** Per-session configuration selected by the user. */
@Stable
internal class SessionConfiguration(
    selectedModelId: String? = null,
    selectedModeId: String? = null,
    permissionMode: PermissionMode = PermissionMode.RECOMMENDED,
    tokenLimit: Long = 0L,
) {
    var selectedModelId: String? by mutableStateOf(selectedModelId)
    var selectedModeId: String? by mutableStateOf(selectedModeId)
    var permissionMode: PermissionMode by mutableStateOf(permissionMode)
    var tokenLimit: Long by mutableLongStateOf(tokenLimit)
}
