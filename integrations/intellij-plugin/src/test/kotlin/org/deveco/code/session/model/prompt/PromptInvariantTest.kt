package org.deveco.code.session.model.prompt

import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.snapshots.Snapshot
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.FileNotFoundException
import java.util.concurrent.CancellationException

internal class PromptInvariantTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `embedded resources reject empty contents`() {
        assertThrows(IllegalArgumentException::class.java) {
            PromptPart.Resource.Text(
                uri = "file:///tmp/Main.kt",
                text = "",
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            PromptPart.Resource.Text(
                uri = " ",
                text = "code",
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            PromptPart.Resource.Blob(
                uri = "file:///tmp/archive.bin",
                mimeType = "application/octet-stream",
                base64Content = "",
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            PromptPart.Resource.Blob(
                uri = " ",
                mimeType = "application/octet-stream",
                base64Content = "AQID",
            )
        }
    }

    @Test
    fun `text resources default display metadata without affecting identity`() {
        val text = PromptPart.Resource.Text(
            uri = "file:///tmp/Main.kt",
            text = "code",
        )
        val named = PromptPart.Resource.Text(
            uri = "file:///tmp/Main.kt",
            text = "code",
            name = "Selection",
        )

        assertEquals("text/plain", text.mimeType)
        assertEquals("Main.kt", text.displayName)
        assertEquals("Selection", named.displayName)
        assertEquals(text, named)
        assertEquals(text.hashCode(), named.hashCode())
    }

    @Test
    fun `image base64 cache is derived and excluded from identity`() {
        val file = temporaryFolder.newFile("image.png").apply {
            writeBytes(byteArrayOf(1))
        }
        val image = PromptPart.Image(file.path, "image.png", "image/png")

        assertEquals("AQ==", image.base64Content)
        file.writeBytes(byteArrayOf(2))
        assertEquals("AQ==", image.base64Content)

        image.clearBase64Content()
        assertEquals("Ag==", image.base64Content)

        val seeded = PromptPart.Image("/deleted/image.png", "image.png", "image/png")
        seeded.seedBase64Content("c2VlZA==")
        assertEquals("c2VlZA==", seeded.base64Content)
        assertEquals(PromptPart.Image(file.path, "image.png", "image/png"), image)
    }

    @Test
    fun `image prepared from original bytes survives source deletion`() {
        val image = PromptPart.Image("/deleted/image.png", "image.png", "image/png")

        image.prepareBase64Content(byteArrayOf(1, 2, 3), "image/png")

        assertEquals("AQID", image.cachedBase64Content)
        assertEquals("AQID", image.base64Content)
        assertEquals("image/png", image.mimeTypeForSend)
    }

    @Test
    fun `failed lazy preparation releases its lock for the next caller`() {
        val file = temporaryFolder.newFile("retry.png")
        val image = PromptPart.Image(file.path, file.name, "image/png")
        file.delete()

        assertThrows(FileNotFoundException::class.java) {
            image.base64Content
        }

        file.writeBytes(byteArrayOf(1, 2, 3))
        assertEquals("AQID", image.base64Content)
    }

    @Test
    fun `cancelled image preparation leaves no partial cache and can be retried`() {
        val image = PromptPart.Image("/not/read/during/cancellation.png", "image.png", "image/png")

        assertThrows(CancellationException::class.java) {
            image.prepareBase64Content(
                bytes = byteArrayOf(1, 2, 3),
                sourceMimeType = "image/png",
                isCancelled = { true },
            )
        }

        assertEquals(null, image.cachedBase64Content)
        assertEquals("AQID", image.prepareBase64Content(byteArrayOf(1, 2, 3), "image/png"))
    }

    @Test
    fun `inline images use seeded cache without synthetic identity`() {
        val first = PromptPart.Image(path = null, name = "image", mimeType = "image/png")
        first.seedBase64Content("AQID")
        val second = PromptPart.Image(
            path = null,
            name = "image",
            mimeType = "image/png",
            initialBase64Content = "AQID",
        )

        assertEquals("AQID", first.base64Content)
        assertEquals(first, second)
        assertEquals(first.hashCode(), second.hashCode())
    }

    @Test
    fun `image cache is observable Compose state`() = runBlocking {
        val image = PromptPart.Image("/tmp/observable.png", "observable.png", "image/png")
        val values = Channel<String?>(Channel.UNLIMITED)
        val collection = launch(start = CoroutineStart.UNDISPATCHED) {
            snapshotFlow { image.cachedBase64Content }.collect { values.send(it) }
        }

        assertEquals(null, withTimeout(1_000) { values.receive() })
        withContext(Dispatchers.Default) {
            image.seedBase64Content("AQID")
        }
        Snapshot.sendApplyNotifications()
        assertEquals("AQID", withTimeout(1_000) { values.receive() })
        collection.cancel()
    }
}
