package org.deveco.code.session

import org.deveco.code.session.model.SessionViewState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for [SessionViewStateStore]: per-session view-state storage with
 * atomic read-modify-write updates and independent prompt-history storage.
 */
class SessionViewStateStoreTest {

    private fun state(draft: String = ""): SessionViewState = SessionViewState(
        anchorMessageId = null,
        firstVisibleItemIndex = 0,
        firstVisibleItemOffset = 0,
        followTail = true,
        expandedThoughts = emptyMap(),
        expandedTools = emptyMap(),
        previewFilePath = null,
        previewLine = null,
        previewOffset = null,
        previewLimit = null,
        previewProportion = 0f,
        draft = draft,
    )

    private fun history(text: String): PromptHistoryEntry = PromptHistoryEntry(text, emptyList(), emptyList())

    @Test
    fun getReturnsNullForUnknownSession() {
        assertNull(SessionViewStateStore().get("missing"))
    }

    @Test
    fun saveStoresStatePerSession() {
        val store = SessionViewStateStore()
        val a = state("draft a")
        val b = state("draft b")
        store.save("s1", a)
        store.save("s2", b)
        assertSame(a, store.get("s1"))
        assertSame(b, store.get("s2"))
    }

    @Test
    fun updateTransformsExistingStateAtomically() {
        val store = SessionViewStateStore()
        store.save("s1", state("old"))
        store.update("s1") { existing -> existing!!.copy(draft = "new") }
        assertEquals("new", store.get("s1")?.draft)
    }

    @Test
    fun updateCreatesStateWhenAbsent() {
        val store = SessionViewStateStore()
        store.update("s1") { existing ->
            assertNull(existing)
            state("from null")
        }
        assertEquals("from null", store.get("s1")?.draft)
    }

    @Test
    fun updateReturningNullRemovesEntry() {
        val store = SessionViewStateStore()
        store.save("s1", state("doomed"))
        store.update("s1") { null }
        assertNull(store.get("s1"))
    }

    @Test
    fun removeClearsStateAndPromptHistory() {
        val store = SessionViewStateStore()
        store.save("s1", state("draft"))
        store.savePromptHistory("s1", listOf(history("hi")))
        store.remove("s1")
        assertNull(store.get("s1"))
        assertNull(store.getPromptHistory("s1"))
    }

    @Test
    fun promptHistoryRoundTripsPerSession() {
        val store = SessionViewStateStore()
        val s1History = listOf(history("first"), history("second"))
        val s2History = listOf(history("other"))
        store.savePromptHistory("s1", s1History)
        store.savePromptHistory("s2", s2History)
        assertEquals(s1History, store.getPromptHistory("s1"))
        assertEquals(s2History, store.getPromptHistory("s2"))
        assertNull(store.getPromptHistory("s3"))
        assertTrue(store.getPromptHistory("s3") == null)
    }

    @Test
    fun savePromptHistoryOverwritesPreviousEntries() {
        val store = SessionViewStateStore()
        store.savePromptHistory("s1", listOf(history("old")))
        store.savePromptHistory("s1", listOf(history("new")))
        assertEquals(listOf(history("new")), store.getPromptHistory("s1"))
    }
}
