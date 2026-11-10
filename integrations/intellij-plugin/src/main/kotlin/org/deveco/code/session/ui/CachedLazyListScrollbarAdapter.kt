package org.deveco.code.session.ui

import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.v2.ScrollbarAdapter
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.snapshots.SnapshotStateMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// How long after the last scrollbar scrollTo() the interaction is considered
// still active. Must exceed the gaps between pointer events inside one drag,
// so the frozen metrics hold through mid-drag pauses.
private const val SCROLLBAR_INTERACTION_RELEASE_MS = 300L

/**
 * Scrollbar adapter whose content metrics come from a persistent per-item height cache keyed by
 * LazyColumn item key, instead of the stock adapter's "average of currently visible rows" estimate.
 *
 * The stock `rememberScrollbarAdapter(LazyListState)` re-estimates the total content height from
 * whatever rows happen to be on screen at each layout pass. Chat rows range from a one-line
 * thought to a tall tool group, so the estimate jumps on every scroll and the scrollbar thumb
 * length visibly changes even though the content is unchanged. Caching measured heights keeps the
 * total stable: scrolling through already-measured rows no longer moves the estimate, and new rows
 * converge once measured.
 *
 * Dragging: the stock scrollbar's thumb drag is incremental — every pointer event re-bases on this
 * adapter's reported `scrollOffset` and asks for a new absolute target. Deriving that report from
 * the live layout therefore feeds every real-vs-estimate mismatch straight back into the next
 * event: a requested offset past an unmeasured row's real height makes LazyList advance the anchor,
 * the report shifts, and the drag rubber-bands, sticks or jumps. This adapter instead OWNS its
 * reported position — set to exactly the last requested target, and synced from the real layout
 * only while no scrollbar interaction is in progress. During an interaction the item keys, the
 * fallback row height and the content size are frozen, so the mapping and the thumb geometry are
 * stable for the whole drag; the height cache converges from real measurements between events.
 */
internal class CachedLazyListScrollbarAdapter(
    private val listState: LazyListState,
    private val itemKeys: () -> List<Any>,
    private val heights: SnapshotStateMap<Any, Int>,
    private val scope: CoroutineScope,
) : ScrollbarAdapter {

    // Non-null while a scrollbar interaction is active; also freezes the mapping
    // (frozenKeys, frozenContentSize) for the whole interaction. Null means the
    // estimates update normally from the live layout.
    private var frozenFallbackHeight: Double? = null
    private var frozenKeys: List<Any> = emptyList()
    private var frozenContentSize = 0.0
    private var releaseJob: Job? = null

    // The scroll position this adapter reports. Owned: written by scrollTo() with the
    // exact requested target, and synced from the real layout only when no scrollbar
    // interaction owns it.
    private var reportedScrollOffset = 0.0

    val scrollbarInteracting: Boolean
        get() = frozenFallbackHeight != null

    override val scrollOffset: Double
        get() = reportedScrollOffset

    override val contentSize: Double
        get() {
            if (scrollbarInteracting) return frozenContentSize
            val keys = itemKeys()
            if (keys.isEmpty()) return 0.0
            return computeContentSize(keys, listState.layoutInfo)
        }

    override val viewportSize: Double
        get() = listState.layoutInfo.viewportSize.height.toDouble()

    override suspend fun scrollTo(target: Double) {
        beginInteraction()
        try {
            snapTo(target.coerceIn(0.0, (frozenContentSize - viewportSize).coerceAtLeast(0.0)))
        } finally {
            scheduleRelease()
        }
    }

    private suspend fun snapTo(target: Double) {
        val info = listState.layoutInfo
        val keys = frozenKeys
        var start = 0.0
        keys.forEachIndexed { index, key ->
            val height = heightOf(key, info)
            if (target < start + height || index == keys.lastIndex) {
                // For a measured row the model height IS the real height, so the offset
                // always fits and LazyList never advances the anchor. For an unmeasured
                // row the real height may be smaller and the anchor advances once; the
                // visible-size write below records the real sizes, so the error is
                // bounded and converges on first traversal. The thumb is unaffected:
                // it reports the requested target either way.
                val offset = (target - start).toInt().coerceIn(0, (height.toInt() - 1).coerceAtLeast(0))
                listState.scrollToItem(index, offset)
                listState.layoutInfo.visibleItemsInfo.forEach { item ->
                    heights[item.key] = item.size
                }
                reportedScrollOffset = target
                return
            }
            start += height + info.mainAxisItemSpacing
        }
    }

    /** Syncs the reported position from the real layout; no-op on transient empty layouts. */
    fun syncFromLayout() {
        val info = listState.layoutInfo
        val first = info.visibleItemsInfo.firstOrNull() ?: return
        val keys = itemKeys()
        var start = 0.0
        for (i in 0 until first.index.coerceAtMost(keys.size)) {
            start += heightOf(keys[i], info) + info.mainAxisItemSpacing
        }
        reportedScrollOffset = (start - first.offset).coerceAtLeast(0.0)
    }

    private fun beginInteraction() {
        releaseJob?.cancel()
        releaseJob = null
        if (frozenFallbackHeight != null) return
        val info = listState.layoutInfo
        frozenKeys = itemKeys()
        frozenFallbackHeight = fallbackHeight(info)
        frozenContentSize = computeContentSize(frozenKeys, info)
    }

    private fun scheduleRelease() {
        releaseJob?.cancel()
        releaseJob = scope.launch {
            delay(SCROLLBAR_INTERACTION_RELEASE_MS)
            frozenFallbackHeight = null
            frozenKeys = emptyList()
            heights.keys.retainAll(itemKeys().toHashSet())
            syncFromLayout()
        }
    }

    private fun computeContentSize(keys: List<Any>, info: LazyListLayoutInfo): Double {
        var total = keys.sumOf { heightOf(it, info) }
        total += info.mainAxisItemSpacing.toDouble() * (keys.size - 1).coerceAtLeast(0)
        total += info.beforeContentPadding + info.afterContentPadding
        return total
    }

    private fun heightOf(key: Any, info: LazyListLayoutInfo): Double {
        heights[key]?.let { return it.toDouble() }
        return frozenFallbackHeight ?: fallbackHeight(info)
    }

    // Uncached rows fall back to the average of cached heights; before any cache exists the
    // stock visible-row average bootstraps the estimate.
    private fun fallbackHeight(info: LazyListLayoutInfo): Double {
        val cached = heights.values
        if (cached.isNotEmpty()) return cached.sum().toDouble() / cached.size
        val visible = info.visibleItemsInfo
        if (visible.isEmpty()) return 0.0
        return visible.sumOf { it.size }.toDouble() / visible.size
    }
}

@Composable
internal fun rememberCachedScrollbarAdapter(
    listState: LazyListState,
    itemKeys: List<Any>,
): CachedLazyListScrollbarAdapter {
    val heights = remember { mutableStateMapOf<Any, Int>() }
    val keys = rememberUpdatedState(itemKeys)
    val scope = rememberCoroutineScope()
    val adapter = remember(listState) {
        CachedLazyListScrollbarAdapter(listState, { keys.value }, heights, scope)
    }

    // Converge the height cache from the real layout, and keep the adapter's reported
    // scroll position honest for scrolls that bypass the scrollbar (wheel over the list,
    // tail auto-scroll, position restores). Both are muted while a scrollbar interaction
    // owns the reported position.
    LaunchedEffect(listState) {
        snapshotFlow { listState.layoutInfo }.collect { info ->
            if (adapter.scrollbarInteracting) return@collect
            info.visibleItemsInfo.forEach { item ->
                heights[item.key] = item.size
            }
            adapter.syncFromLayout()
        }
    }
    LaunchedEffect(listState) {
        snapshotFlow { keys.value }.collect { current ->
            if (adapter.scrollbarInteracting) return@collect
            heights.keys.retainAll(current.toHashSet())
        }
    }
    return adapter
}
