package org.deveco.code.session.model.interaction

internal data class ElicitationFieldItem(
    val key: String,
    val title: String,
    val question: String,
    val options: List<ElicitationOptionItem>,
    val multiple: Boolean,
    val required: Boolean,
    val allowCustom: Boolean,
)
