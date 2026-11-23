package org.deveco.code.session.model.configuration

import org.deveco.code.MyMessageBundle

internal enum class PermissionMode(val id: String, private val labelKey: String) {
    RECOMMENDED("recommended", "permission.mode.recommended"),
    SANDBOX("sandbox", "permission.mode.default"),
    AUTO("auto", "permission.mode.auto"),
    ;

    val label: String get() = MyMessageBundle.message(labelKey)
}
