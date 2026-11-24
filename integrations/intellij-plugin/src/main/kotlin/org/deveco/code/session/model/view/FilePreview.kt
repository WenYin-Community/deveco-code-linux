package org.deveco.code.session.model.view

internal data class FilePreview(
    val path: String,
    val line: Int? = null,
    val offset: Int? = null,
    val limit: Int? = null,
)
