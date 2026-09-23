package org.deveco.code.session.ui.composer

// Image formats that Java ImageIO can reliably decode and generate thumbnails for.
// svg is intentionally excluded —it's a vector format that ImageIO cannot decode into a
// raster image, so thumbnails would silently fail and the user would just see a file icon.
internal val SUPPORTED_IMAGE_EXTENSIONS = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp")

internal fun isSupportedImageFile(name: String): Boolean =
    name.substringAfterLast('.', "").lowercase() in SUPPORTED_IMAGE_EXTENSIONS

// MIME prefixes for application/* types that are actually text and can be safely inlined.
private val TEXT_BASED_MIME_PREFIXES = listOf(
    "application/json",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/sql",
    "application/vnd.dart",
)

// Exact-match MIME set for formats whose IANA type isn't covered by a prefix.
private val TEXT_BASED_MIME_EXACT = setOf("application/yaml")

// @return true iff the MIME type can be losslessly decoded as text.
internal fun isTextLikeMimeType(mimeType: String): Boolean {
    if (mimeType.isBlank()) return false
    if (mimeType.startsWith("text/")) return true
    if (mimeType in TEXT_BASED_MIME_EXACT) return true
    return TEXT_BASED_MIME_PREFIXES.any { mimeType.startsWith(it) }
}

// @return true iff the file is a supported text/code attachment (non-image).
internal fun isSupportedTextFile(name: String): Boolean =
    !isSupportedImageFile(name) && isTextLikeMimeType(detectMimeType(name))

private val MIME_TYPE_MAP: Map<String, String> = mapOf(
    "png" to "image/png",
    "jpg" to "image/jpeg",
    "jpeg" to "image/jpeg",
    "gif" to "image/gif",
    "webp" to "image/webp",
    "bmp" to "image/bmp",
    "svg" to "image/svg+xml",
    "pdf" to "application/pdf",
    "txt" to "text/plain",
    "log" to "text/plain",
    "md" to "text/markdown",
    "markdown" to "text/markdown",
    "json" to "application/json",
    "xml" to "application/xml",
    "csv" to "text/csv",
    "html" to "text/html",
    "htm" to "text/html",
    "css" to "text/css",
    "yaml" to "text/yaml",
    "yml" to "text/yaml",
    "js" to "application/javascript",
    "ts" to "application/typescript",
    "tsx" to "application/typescript",
    "jsx" to "application/typescript",
    "kt" to "text/x-kotlin",
    "kts" to "text/x-kotlin",
    "java" to "text/x-java",
    "py" to "text/x-python",
    "go" to "text/x-go",
    "rs" to "text/x-rust",
    "c" to "text/x-c",
    "h" to "text/x-c",
    "cpp" to "text/x-c++",
    "cxx" to "text/x-c++",
    "cc" to "text/x-c++",
    "hpp" to "text/x-c++",
    "rb" to "text/x-ruby",
    "sh" to "text/x-shellscript",
    "bash" to "text/x-shellscript",
    "swift" to "text/x-swift",
    "scala" to "text/x-scala",
    "dart" to "application/vnd.dart",
    "sql" to "application/sql",
    "doc" to "application/msword",
    "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls" to "application/vnd.ms-excel",
    "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ppt" to "application/vnd.ms-powerpoint",
    "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "rtf" to "application/rtf",
    "odt" to "application/vnd.oasis.opendocument.text",
    "ods" to "application/vnd.oasis.opendocument.spreadsheet",
    "odp" to "application/vnd.oasis.opendocument.presentation",
    "zip" to "application/zip",
    "tar" to "application/gzip",
    "gz" to "application/gzip",
    "rar" to "application/vnd.rar",
    "7z" to "application/x-7z-compressed",
)

internal fun detectMimeType(name: String): String {
    val ext = name.substringAfterLast('.', "").lowercase()
    return MIME_TYPE_MAP[ext] ?: "application/octet-stream"
}

// 所有 agent 支持的文本/代码文件扩展名（从 MIME_TYPE_MAP 中筛选 text-like 类型）。
// 用于文件选择对话框的 withExtensionFilter，仅显示这些类型的文件。
internal val SUPPORTED_TEXT_EXTENSIONS: Set<String> = MIME_TYPE_MAP
    .filterValues { isTextLikeMimeType(it) }
    .keys
