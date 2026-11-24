package org.deveco.code.session.media

/**
 * View-only decoded image bytes reconstructed from ACP replay. This is intentionally separate
 * from the canonical Prompt and is bounded to avoid retaining historical image payloads.
 */
internal object PromptImageViewCache {
    private const val MAX_ENTRIES = 32
    private val images = object : LinkedHashMap<String, ByteArray>(MAX_ENTRIES, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ByteArray>?): Boolean =
            size > MAX_ENTRIES
    }

    fun put(path: String, bytes: ByteArray) {
        synchronized(images) {
            images[path] = bytes
        }
    }

    fun get(path: String): ByteArray? = synchronized(images) {
        images[path]
    }
}
