package org.deveco.code.session

import com.agentclientprotocol.annotations.UnstableApi
import com.agentclientprotocol.model.SessionId
import com.agentclientprotocol.model.SessionInfo
import com.intellij.testFramework.LightPlatformTestCase
import org.deveco.code.session.model.AttachmentItem
import org.deveco.code.session.model.FileReference
import org.deveco.code.util.PluginStateFiles
import java.nio.file.Files

/**
 * Platform-fixture unit tests for [SessionStorage]: the properties-backed
 * persistence layer for session flags, titles, favorites/archive records,
 * durations, per-message attachments / file refs / original texts, prompt
 * history and the delete-local-session cleanup. State files are wiped per
 * test for isolation.
 */
@OptIn(UnstableApi::class)
class SessionStorageTest : LightPlatformTestCase() {

    private lateinit var viewStateStore: SessionViewStateStore

    override fun setUp() {
        super.setUp()
        Files.deleteIfExists(PluginStateFiles.path(getProject(), "sessions.properties"))
        Files.deleteIfExists(PluginStateFiles.path(getProject(), "durations.properties"))
        (getProject() as com.intellij.serviceContainer.ComponentManagerImpl).replaceServiceInstance(
            SessionViewStateStore::class.java,
            SessionViewStateStore().also { viewStateStore = it },
            testRootDisposable,
        )
    }

    private fun project() = getProject()

    private fun sessionInfo(id: String, title: String? = "Title $id", updatedAt: String? = "2026-11-11T10:00:00Z") =
        SessionInfo(SessionId(id), "/work/dir", title, updatedAt)

    // --- Last active ---

    fun testLastActiveSessionIdRoundTrip() {
        assertNull(SessionStorage.lastActiveSessionId(project()))

        SessionStorage.setLastActiveSessionId(project(), "s1")
        assertEquals("s1", SessionStorage.lastActiveSessionId(project()))

        SessionStorage.setLastActiveSessionId(project(), null)
        assertNull(SessionStorage.lastActiveSessionId(project()))

        SessionStorage.setLastActiveSessionId(project(), "")
        assertNull(SessionStorage.lastActiveSessionId(project()))
    }

    // --- Favorites / archive ---

    fun testToggleFavoriteAddsThenRemoves() {
        SessionStorage.toggleFavorite(project(), sessionInfo("s1"))
        assertEquals(setOf("s1"), SessionStorage.favoriteIds(project()))

        SessionStorage.toggleFavorite(project(), sessionInfo("s1"))
        assertTrue(SessionStorage.favoriteIds(project()).isEmpty())
    }

    fun testToggleFavoriteWithExplicitFlag() {
        SessionStorage.toggleFavorite(project(), sessionInfo("s1"), favorite = true)
        SessionStorage.toggleFavorite(project(), sessionInfo("s1"), favorite = true)
        assertEquals(setOf("s1"), SessionStorage.favoriteIds(project()))

        SessionStorage.toggleFavorite(project(), sessionInfo("s1"), favorite = false)
        assertTrue(SessionStorage.favoriteIds(project()).isEmpty())
    }

    fun testRemoveFavoriteOnMissingSessionIsNoop() {
        SessionStorage.removeFavorite(project(), "missing")
        assertTrue(SessionStorage.favoriteIds(project()).isEmpty())
    }

    fun testArchiveRecordsTimestampAndMetadata() {
        SessionStorage.archive(project(), sessionInfo("s1"))

        assertEquals(setOf("s1"), SessionStorage.archivedIds(project()))
        val record = SessionStorage.archived(project())["s1"]
        assertNotNull(record)
        assertEquals("s1", record!!.sessionId)
        assertEquals("Title s1", record.title)
        assertEquals("2026-11-11T10:00:00Z", record.updatedAt)
        assertNotNull(record.archivedAt)

        SessionStorage.unarchive(project(), "s1")
        assertTrue(SessionStorage.archivedIds(project()).isEmpty())
    }

    // --- Custom titles ---

    fun testCustomTitleRoundTripAndBlankRemoval() {
        SessionStorage.setCustomTitle(project(), "s1", "My session")
        assertEquals("My session", SessionStorage.customTitle(project(), "s1"))

        SessionStorage.setCustomTitle(project(), "s1", "   ")
        assertNull(SessionStorage.customTitle(project(), "s1"))
    }

    fun testCustomTitleSanitizesTabsAndNewlines() {
        SessionStorage.setCustomTitle(project(), "s1", "a\tb\nc")

        assertEquals("a b c", SessionStorage.customTitle(project(), "s1"))
    }

    fun testCustomTitlesMapAndRemove() {
        SessionStorage.setCustomTitle(project(), "s1", "One")
        SessionStorage.setCustomTitle(project(), "s2", "Two")

        assertEquals(mapOf("s1" to "One", "s2" to "Two"), SessionStorage.customTitles(project()))

        SessionStorage.removeCustomTitle(project(), "s1")
        assertEquals(mapOf("s2" to "Two"), SessionStorage.customTitles(project()))
    }

    // --- New / interacted flags ---

    fun testNewSessionIdsAddAndRemove() {
        SessionStorage.addNewSession(project(), "s1")
        SessionStorage.addNewSession(project(), "s2")
        SessionStorage.addNewSession(project(), "s1")

        assertEquals(setOf("s1", "s2"), SessionStorage.newSessionIds(project()))

        SessionStorage.removeNewSession(project(), "s1")
        assertEquals(setOf("s2"), SessionStorage.newSessionIds(project()))
    }

    fun testMarkInteractedAddsToInteractedAndClearsNewFlag() {
        SessionStorage.addNewSession(project(), "s1")

        SessionStorage.markInteracted(project(), "s1")

        assertEquals(setOf("s1"), SessionStorage.interactedIds(project()))
        assertTrue(SessionStorage.newSessionIds(project()).isEmpty())
    }

    fun testMarkInteractedBatchAndPrune() {
        SessionStorage.markInteractedBatch(project(), setOf("s1", "s2"))

        assertEquals(setOf("s1", "s2"), SessionStorage.interactedIds(project()))

        SessionStorage.pruneInteractedIds(project(), setOf("s1"))
        assertEquals(setOf("s1"), SessionStorage.interactedIds(project()))
    }

    fun testRebuildNewSessionIdsKeepsUnreportedAndAddsLive() {
        SessionStorage.addNewSession(project(), "not-in-backend")

        SessionStorage.rebuildNewSessionIds(project(), liveIds = setOf("live-1"))

        assertEquals(setOf("not-in-backend", "live-1"), SessionStorage.newSessionIds(project()))
    }

    // --- Abnormal / unread ---

    fun testAbnormalIdsLifecycle() {
        SessionStorage.markAbnormal(project(), "s1")
        assertEquals(setOf("s1"), SessionStorage.abnormalIds(project()))

        SessionStorage.clearAbnormal(project(), "s1")
        assertTrue(SessionStorage.abnormalIds(project()).isEmpty())

        SessionStorage.markAbnormal(project(), "s1")
        SessionStorage.markAbnormal(project(), "s2")
        SessionStorage.pruneAbnormalIds(project(), setOf("s1"))
        assertEquals(setOf("s1"), SessionStorage.abnormalIds(project()))
    }

    fun testUnreadIdsLifecycle() {
        SessionStorage.markUnread(project(), "s1")
        SessionStorage.markUnread(project(), "s2")
        assertEquals(setOf("s1", "s2"), SessionStorage.unreadIds(project()))

        SessionStorage.markRead(project(), "s1")
        assertEquals(setOf("s2"), SessionStorage.unreadIds(project()))

        SessionStorage.pruneUnreadIds(project(), emptySet())
        assertTrue(SessionStorage.unreadIds(project()).isEmpty())
    }

    // --- Durations ---

    fun testDurationsRoundTripAndRemoval() {
        SessionStorage.saveLastDuration(project(), "s1", 5L)
        SessionStorage.saveLastDuration(project(), "s2", 7L)

        assertEquals(mapOf("s1" to 5L, "s2" to 7L), SessionStorage.loadLastDurations(project()))

        SessionStorage.removeLastDuration(project(), "s1")
        assertEquals(mapOf("s2" to 7L), SessionStorage.loadLastDurations(project()))
    }

    // --- Attachments / file refs / original texts ---

    private fun attachment(name: String, path: String) =
        AttachmentItem(name = name, path = path, mimeType = "text/plain", isImage = false)

    fun testAttachmentsRoundTripWithEscaping() {
        val items = listOf(attachment("a|b%2", "/tmp/x|y%z"), attachment("plain.txt", "/tmp/plain.txt"))

        SessionStorage.saveAttachments(project(), "s1", mapOf(0 to items.subList(0, 1), 2 to items.subList(1, 2)))

        assertEquals(
            mapOf(0 to listOf(items[0]), 2 to listOf(items[1])),
            SessionStorage.loadAttachmentsByIndex(project(), "s1"),
        )
    }

    fun testSaveAttachmentsWithEmptyMapClears() {
        SessionStorage.saveAttachments(project(), "s1", mapOf(0 to listOf(attachment("a", "/a"))))
        SessionStorage.saveAttachments(project(), "s1", emptyMap())

        assertTrue(SessionStorage.loadAttachmentsByIndex(project(), "s1").isEmpty())
    }

    fun testFileRefsRoundTripAndRemoval() {
        val refs = listOf(FileReference("/src/a b.txt", 1, 5))

        SessionStorage.saveFileRefs(project(), "s1", mapOf(0 to refs))
        assertEquals(mapOf(0 to refs), SessionStorage.loadFileRefsByIndex(project(), "s1"))

        SessionStorage.removeFileRefs(project(), "s1")
        assertTrue(SessionStorage.loadFileRefsByIndex(project(), "s1").isEmpty())
    }

    fun testOriginalTextsRoundTripWithEscapes() {
        val texts = mapOf(0 to "line1\nline2", 1 to "back\\slash and |pipe| and\ttab")

        SessionStorage.saveOriginalTexts(project(), "s1", texts)

        assertEquals(texts, SessionStorage.loadOriginalTexts(project(), "s1"))

        SessionStorage.removeOriginalTexts(project(), "s1")
        assertTrue(SessionStorage.loadOriginalTexts(project(), "s1").isEmpty())
    }

    // --- Backend message counter / interrupted indices ---

    fun testBackendUserMsgCount() {
        assertEquals(0, SessionStorage.getBackendUserMsgCount(project(), "s1"))

        SessionStorage.setBackendUserMsgCount(project(), "s1", 3)
        assertEquals(3, SessionStorage.getBackendUserMsgCount(project(), "s1"))
    }

    fun testInterruptedIndicesRoundTripAndClear() {
        SessionStorage.saveInterruptedIndices(project(), "s1", setOf(1, 3, 5))
        assertEquals(setOf(1, 3, 5), SessionStorage.loadInterruptedIndices(project(), "s1"))

        SessionStorage.saveInterruptedIndices(project(), "s1", emptySet())
        assertTrue(SessionStorage.loadInterruptedIndices(project(), "s1").isEmpty())
    }

    // --- Prompt history ---

    fun testPromptHistoryRoundTripWithDelimitersAndMetadata() {
        val history = listOf(
            PromptHistoryEntry(
                "hello\nworld|with\ttabs\\and backslash",
                listOf(attachment("notes|1.txt", "/tmp/notes\t1.txt")),
                listOf(FileReference("/src/main.kt", 10, 20)),
            ),
            PromptHistoryEntry("second", emptyList(), emptyList()),
        )

        SessionStorage.savePromptHistory(project(), "s1", history)
        assertEquals(history, SessionStorage.loadPromptHistory(project(), "s1"))

        SessionStorage.savePromptHistory(project(), "s1", emptyList())
        assertTrue(SessionStorage.loadPromptHistory(project(), "s1").isEmpty())
    }

    // --- Teardown ---

    fun testDeleteLocalSessionClearsAllPersistedState() {
        SessionStorage.toggleFavorite(project(), sessionInfo("s1"))
        SessionStorage.archive(project(), sessionInfo("s1"))
        SessionStorage.setCustomTitle(project(), "s1", "Doomed")
        SessionStorage.addNewSession(project(), "s1")
        SessionStorage.saveLastDuration(project(), "s1", 9L)
        SessionStorage.saveAttachments(project(), "s1", mapOf(0 to listOf(attachment("a", "/a"))))
        SessionStorage.saveFileRefs(project(), "s1", mapOf(0 to listOf(FileReference("/f", 1, 2))))
        SessionStorage.saveOriginalTexts(project(), "s1", mapOf(0 to "text"))
        SessionStorage.saveInterruptedIndices(project(), "s1", setOf(2))
        SessionStorage.setBackendUserMsgCount(project(), "s1", 4)
        viewStateStore.save("s1", org.deveco.code.session.model.SessionViewState.initial())

        SessionStorage.deleteLocalSession(project(), "s1")

        assertTrue(SessionStorage.favoriteIds(project()).isEmpty())
        assertTrue(SessionStorage.archivedIds(project()).isEmpty())
        assertNull(SessionStorage.customTitle(project(), "s1"))
        assertTrue(SessionStorage.newSessionIds(project()).isEmpty())
        assertTrue(SessionStorage.loadLastDurations(project()).isEmpty())
        assertTrue(SessionStorage.loadAttachmentsByIndex(project(), "s1").isEmpty())
        assertTrue(SessionStorage.loadFileRefsByIndex(project(), "s1").isEmpty())
        assertTrue(SessionStorage.loadOriginalTexts(project(), "s1").isEmpty())
        assertTrue(SessionStorage.loadInterruptedIndices(project(), "s1").isEmpty())
        assertEquals(0, SessionStorage.getBackendUserMsgCount(project(), "s1"))
        assertNull(viewStateStore.get("s1"))
    }
}
