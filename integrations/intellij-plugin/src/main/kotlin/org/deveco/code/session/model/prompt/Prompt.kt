/*
 * Prompt model design
 * -------------------
 * Prompt is the single source of truth for committed user-authored model input. Its part sequence
 * preserves the block order sent to or received from ACP; file attachment, code selection, and URI
 * reference are distinguished by the PromptPart subtype and URI fragment without metadata wrappers.
 *
 * The editable composer model is narrower: it authors one text body plus context additions. It
 * snapshots the body before those additions and does not support arbitrary interleaving of text and
 * context while editing. Do not expose Prompt's transport sequence as an ordered-authoring API.
 */

package org.deveco.code.session.model.prompt

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.deveco.code.session.media.SendImageOptimizer
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.util.Base64
import java.util.concurrent.CancellationException
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

private const val IMAGE_LOCK_POLL_MS = 50L
private const val IMAGE_READ_BUFFER_BYTES = 64 * 1024

private fun throwIfImagePreparationCancelled(isCancelled: () -> Boolean) {
    if (isCancelled()) throw CancellationException("Image preparation cancelled")
}

internal data class Prompt(val parts: List<PromptPart>) {
    val userVisibleParts: List<PromptPart>
        get() = parts.filterNot { part ->
            part is PromptPart.Text && part.audience == PromptAudience.ASSISTANT
        }

    val userVisible: Prompt
        get() = Prompt(userVisibleParts)

    val text: String
        get() = userVisibleParts
            .filterIsInstance<PromptPart.Text>()
            .joinToString("\n\n") { it.text }
            .trim()

    val contextParts: List<PromptPart>
        get() = userVisibleParts.filterNot { it is PromptPart.Text }

    val attachmentParts: List<PromptPart>
        get() = parts.filter {
            it is PromptPart.Image ||
                (it is PromptPart.Resource && promptLineRange(it.uri) == null)
        }

    val hasUserVisibleContent: Boolean
        get() = text.isNotEmpty() || contextParts.isNotEmpty()

    val hasContent: Boolean
        get() = hasUserVisibleContent

    val requiresMaterialization: Boolean
        get() = parts.any { it is PromptPart.Image && it.cachedBase64Content == null }
}

internal enum class PromptAudience {
    USER,
    ASSISTANT,
}

internal sealed interface PromptPart {
    data class Text(val text: String, val audience: PromptAudience = PromptAudience.USER) : PromptPart

    class Image(val path: String?, val name: String, val mimeType: String, initialBase64Content: String? = null) :
        PromptPart {
        private val initializationLock = ReentrantLock()

        var cachedBase64Content: String? by mutableStateOf(initialBase64Content)
            private set

        @Volatile
        private var resolvedMimeType: String? = mimeType.takeIf { initialBase64Content != null }

        val base64Content: String
            get() = prepareBase64ContentFromSource()

        val mimeTypeForSend: String
            get() = resolvedMimeType ?: mimeType

        fun prepareBase64ContentFromSource(isCancelled: () -> Boolean = { false }): String =
            withInitializationLock(isCancelled) {
                cachedBase64Content ?: prepareBase64ContentLocked(
                    readSourceBytes(requireNotNull(path) { "Inline image requires base64Content" }, isCancelled),
                    mimeType,
                    isCancelled,
                )
            }

        fun prepareBase64Content(
            bytes: ByteArray,
            sourceMimeType: String = mimeType,
            isCancelled: () -> Boolean = { false },
        ): String = withInitializationLock(isCancelled) {
            prepareBase64ContentLocked(bytes, sourceMimeType, isCancelled)
        }

        private fun prepareBase64ContentLocked(
            bytes: ByteArray,
            sourceMimeType: String,
            isCancelled: () -> Boolean,
        ): String {
            cachedBase64Content?.let { return it }
            throwIfImagePreparationCancelled(isCancelled)
            val optimized = SendImageOptimizer.optimize(bytes, sourceMimeType, isCancelled)
            throwIfImagePreparationCancelled(isCancelled)
            val encoded = Base64.getEncoder().encodeToString(optimized)
            throwIfImagePreparationCancelled(isCancelled)
            val preparedMimeType = if (optimized.size < bytes.size) "image/jpeg" else sourceMimeType
            resolvedMimeType = preparedMimeType
            cachedBase64Content = encoded
            return encoded
        }

        private fun readSourceBytes(path: String, isCancelled: () -> Boolean): ByteArray =
            FileInputStream(File(path)).use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(IMAGE_READ_BUFFER_BYTES)
                while (true) {
                    throwIfImagePreparationCancelled(isCancelled)
                    val count = input.read(buffer)
                    if (count < 0) break
                    throwIfImagePreparationCancelled(isCancelled)
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }

        private fun <T> withInitializationLock(isCancelled: () -> Boolean, block: () -> T): T {
            while (true) {
                throwIfImagePreparationCancelled(isCancelled)
                try {
                    if (initializationLock.tryLock(IMAGE_LOCK_POLL_MS, TimeUnit.MILLISECONDS)) break
                } catch (error: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw CancellationException("Image preparation interrupted").apply { initCause(error) }
                }
            }
            try {
                throwIfImagePreparationCancelled(isCancelled)
                return block()
            } finally {
                initializationLock.unlock()
            }
        }

        fun seedBase64Content(value: String, preparedMimeType: String? = null) {
            require(value.isNotEmpty()) { "Image base64Content cannot be empty" }
            initializationLock.withLock {
                if (preparedMimeType != null) resolvedMimeType = preparedMimeType
                cachedBase64Content = value
            }
        }

        fun clearBase64Content() {
            initializationLock.withLock {
                cachedBase64Content = null
                resolvedMimeType = null
            }
        }

        override fun equals(other: Any?): Boolean = other is Image &&
            path == other.path &&
            name == other.name &&
            mimeType == other.mimeType

        override fun hashCode(): Int = listOf(path, name, mimeType).hashCode()
    }

    data class ResourceLink(val uri: String, val name: String) : PromptPart {
        val lineRange: IntRange? get() = promptLineRange(uri)
    }

    sealed interface Resource : PromptPart {
        val uri: String
        val name: String?
        val mimeType: String?
        val lineRange: IntRange? get() = promptLineRange(uri)

        data class Text(
            override val uri: String,
            val text: String,
            override val name: String? = null,
            override val mimeType: String = "text/plain",
        ) : Resource {
            init {
                require(uri.isNotBlank()) { "Text resource URI cannot be blank" }
                require(text.isNotEmpty()) { "Text resource must contain content" }
            }

            val displayName: String
                get() = name ?: promptUriToPath(uri).substringAfterLast('/').ifBlank { "resource" }

            override fun equals(other: Any?): Boolean = other is Text &&
                uri == other.uri &&
                text == other.text &&
                mimeType == other.mimeType

            override fun hashCode(): Int = listOf(uri, text, mimeType).hashCode()
        }

        data class Blob(
            override val uri: String,
            override val name: String? = null,
            override val mimeType: String,
            val base64Content: String,
        ) : Resource {
            init {
                require(uri.isNotBlank()) { "Blob resource URI cannot be blank" }
                require(base64Content.isNotEmpty()) { "Blob resource must contain base64Content" }
            }
        }
    }
}
