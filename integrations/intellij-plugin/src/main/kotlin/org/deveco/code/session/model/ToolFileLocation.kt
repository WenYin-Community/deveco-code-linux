package org.deveco.code.session.model

internal data class ToolFileLocation(
    val path: String,
    val line: Int? = null,
    val offset: Int? = null,
    val limit: Int? = null,
)
