package org.deveco.code.session.model.configuration

import org.deveco.code.session.model.LabeledChoice

internal data class ModelChoice(
    override val id: String,
    override val name: String,
    val providerId: String = "",
    val modelId: String = "",
) : LabeledChoice
