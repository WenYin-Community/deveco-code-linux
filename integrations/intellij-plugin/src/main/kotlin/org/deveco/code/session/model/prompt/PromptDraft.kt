package org.deveco.code.session.model.prompt

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import org.deveco.code.session.model.FileReference

/**
 * One complete editable prompt input. The composer is the main editor, while bridge and
 * navigation entry points can assemble the same model without sharing composer state.
 * Context is stored directly as PromptPart. Attachment identity lives in the PromptPart;
 * only transient UI markers and thumbnails are kept separately.
 *
 * The text body is deliberately a separate field. Context order is preserved among contexts, but
 * the relative order of text and context is not: snapshot places the body first. This is an accepted
 * composer limitation, not an ordered-editing contract.
 */
@Stable
internal class PromptDraft {
    var text: String by mutableStateOf("")

    val parts: SnapshotStateList<PromptPart> = mutableStateListOf()
    private val attachmentThumbnails = mutableStateMapOf<String, ByteArray>()

    val attachments: List<PromptPart>
        get() = parts.filter(::isAttachment)

    val hasAttachments: Boolean
        get() = attachments.isNotEmpty()

    val fileReferences: List<FileReference>
        get() = parts.mapNotNull(::partFileReference)

    val hasContent: Boolean
        get() = text.isNotBlank() || parts.isNotEmpty()

    fun addText(value: String) {
        text = value
    }

    fun addFileMention(reference: FileReference) {
        val range = reference.takeIf { it.hasLineRange }?.let { it.startLine..it.endLine }
        parts += PromptPart.ResourceLink(
            uri = pathToPromptUri(reference.path, range),
            name = reference.fileName,
        )
    }

    fun addFileMention(path: String) {
        parts += PromptPart.ResourceLink(
            uri = pathToPromptUri(path),
            name = promptFileName(path),
        )
    }

    fun addEditorSelection(path: String, startLine: Int, endLine: Int, selectedText: String) {
        require(selectedText.isNotEmpty()) { "Editor selection snapshot cannot be empty" }
        require(startLine > 0 && endLine >= startLine) { "Editor selection line range is invalid" }
        parts += PromptPart.Resource.Text(
            uri = pathToPromptUri(path, startLine..endLine),
            text = selectedText,
            name = promptFileName(path),
        )
    }

    fun addImageAttachment(path: String, name: String, mimeType: String): PromptPart.Image {
        val image = PromptPart.Image(path, name, mimeType)
        parts += image
        return image
    }

    fun addFileAttachment(path: String, name: String) {
        parts += PromptPart.ResourceLink(
            uri = pathToPromptUri(path),
            name = name,
        )
    }

    fun addFileReference(reference: FileReference) {
        val selectedText = reference.selectedText
        if (reference.hasLineRange && !selectedText.isNullOrEmpty()) {
            addEditorSelection(reference.path, reference.startLine, reference.endLine, selectedText)
        } else {
            addFileMention(reference)
        }
    }

    fun removeAttachmentAt(index: Int) {
        val targets = parts.withIndex().filter { isAttachment(it.value) }
        targets.getOrNull(index)?.let {
            parts.removeAt(it.index)
            attachmentPath(it.value)?.let(attachmentThumbnails::remove)
        }
    }

    fun removeAttachmentByPath(path: String): Boolean {
        val index = parts.indexOfFirst { isAttachment(it) && attachmentPath(it) == path }
        if (index < 0) return false
        parts.removeAt(index)
        attachmentThumbnails.remove(path)
        return true
    }

    fun updateImageThumbnail(path: String, thumbnail: ByteArray) {
        attachmentThumbnails[path] = thumbnail
    }

    fun attachmentThumbnail(path: String): ByteArray? = attachmentThumbnails[path]

    fun removeFileReference(reference: FileReference) {
        val index = parts.indexOfFirst { isFileReference(it) && partPath(it) == reference.path }
        if (index >= 0) parts.removeAt(index)
    }

    fun clearFileReferences() {
        parts.removeAll(::isFileReference)
    }

    fun clearContext() {
        parts.clear()
        attachmentThumbnails.clear()
    }

    fun clear() {
        text = ""
        clearContext()
    }

    fun snapshot(referencePaths: Collection<String> = fileReferences.map { it.path }): Prompt = Prompt(
        buildList {
            // Composer text is canonicalized ahead of context; interleaved positions are unsupported.
            val cleanText = stripAtPathRefs(text, referencePaths)
            if (cleanText.isNotEmpty()) add(PromptPart.Text(cleanText))
            addAll(parts)
        },
    )

    fun restore(prompt: Prompt) {
        // Collapse all text parts into the body; only the order among restored contexts is retained.
        val visiblePrompt = prompt.userVisible
        text = visiblePrompt.text
        parts.clear()
        parts.addAll(visiblePrompt.contextParts)
        attachmentThumbnails.clear()
    }

    private fun isAttachment(part: PromptPart): Boolean = when (part) {
        is PromptPart.Image -> true
        is PromptPart.ResourceLink -> false
        is PromptPart.Resource -> promptLineRange(part.uri) == null
        is PromptPart.Text -> false
    }

    private fun isFileReference(part: PromptPart): Boolean = when (part) {
        is PromptPart.ResourceLink -> true
        is PromptPart.Resource -> promptLineRange(part.uri) != null
        is PromptPart.Text, is PromptPart.Image -> false
    }

    private fun partFileReference(part: PromptPart): FileReference? = when {
        !isFileReference(part) -> null
        part is PromptPart.ResourceLink -> part.toFileReference()
        part is PromptPart.Resource -> part.toFileReference()
        else -> null
    }

    private fun partPath(part: PromptPart): String? = when (part) {
        is PromptPart.ResourceLink -> promptUriToPath(part.uri)
        is PromptPart.Resource -> promptUriToPath(part.uri)
        is PromptPart.Image -> part.path
        is PromptPart.Text -> null
    }

    private fun attachmentPath(part: PromptPart): String? = when (part) {
        is PromptPart.Image -> part.path

        is PromptPart.Resource -> promptUriToPath(part.uri)
            .takeIf { promptLineRange(part.uri) == null }

        is PromptPart.ResourceLink, is PromptPart.Text -> null
    }
}

internal fun PromptPart.promptPath(): String? = when (this) {
    is PromptPart.Image -> path
    is PromptPart.ResourceLink -> promptUriToPath(uri)
    is PromptPart.Resource -> promptUriToPath(uri)
    is PromptPart.Text -> null
}

internal fun PromptPart.promptName(): String? = when (this) {
    is PromptPart.Image -> name
    is PromptPart.ResourceLink -> name
    is PromptPart.Resource -> name ?: promptFileName(uri)
    is PromptPart.Text -> null
}

internal fun PromptPart.promptMimeType(): String? = when (this) {
    is PromptPart.Image -> mimeType
    is PromptPart.ResourceLink -> null
    is PromptPart.Resource -> mimeType
    is PromptPart.Text -> null
}

internal fun Prompt.toFileReferences(): List<FileReference> = parts.mapNotNull { part ->
    when (part) {
        is PromptPart.ResourceLink -> part.toFileReference()
        is PromptPart.Resource -> part.takeIf { promptLineRange(it.uri) != null }?.toFileReference()
        is PromptPart.Text, is PromptPart.Image -> null
    }
}

private fun PromptPart.ResourceLink.toFileReference(): FileReference {
    val range = promptLineRange(uri)
    return FileReference(
        path = promptUriToPath(uri),
        startLine = range?.first ?: 0,
        endLine = range?.last ?: 0,
    )
}

private fun PromptPart.Resource.toFileReference(): FileReference {
    val range = promptLineRange(uri)
    return FileReference(
        path = promptUriToPath(uri),
        startLine = range?.first ?: 0,
        endLine = range?.last ?: 0,
        selectedText = (this as? PromptPart.Resource.Text)?.text,
    )
}

private fun promptFileName(path: String): String =
    path.substringAfterLast('/').ifBlank { path.substringAfterLast('\\').ifBlank { "file" } }

private fun stripAtPathRefs(text: String, referencePaths: Collection<String>): String {
    if (referencePaths.isEmpty() || !text.contains('@')) return text.trim()
    return referencePaths.fold(text) { result, path ->
        val atPath = "@$path"
        if (result.contains(atPath)) result.replace(atPath, "").trim() else result
    }.trim()
}
