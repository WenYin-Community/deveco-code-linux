package org.deveco.code.acp

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.ExperimentalCoroutinesApi

/** Binary bridge for ACP 0.25's unnamed limitedParallelism(1) on IDE 243. */
object LegacyCoroutineBridge {
    @JvmStatic
    @OptIn(ExperimentalCoroutinesApi::class)
    fun limitedParallelismDefault(
        dispatcher: CoroutineDispatcher,
        parallelism: Int,
        name: String?,
        mask: Int,
        marker: Any?,
    ): CoroutineDispatcher {
        // The SDK's default-argument call supplies no dispatcher name. Fail clearly
        // if a future SDK changes this contract instead of silently dropping it.
        require(marker == null && (mask and 2 != 0 || name == null)) {
            "Unsupported named ACP dispatcher on IDE 243"
        }
        return dispatcher.limitedParallelism(parallelism)
    }
}
