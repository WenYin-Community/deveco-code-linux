package org.deveco.code.session.model.prompt

import org.deveco.code.session.model.conversation.ConversationItem
import org.deveco.code.session.model.conversation.ConversationThread

private const val MAX_SUBMITTED_PROMPTS = 50

/** Composer history derived from the visible user messages in this conversation. */
internal class PromptHistory(private val conversation: ConversationThread) {
    private var navigationIndex = -1

    val submittedPrompts: List<Prompt>
        get() = conversation.items()
            .asSequence()
            .filterIsInstance<ConversationItem.User>()
            .filterNot { it.internalOnly }
            .map { it.input.prompt.userVisible }
            .filter { it.hasUserVisibleContent }
            .toList()
            .asReversed()
            .distinctAdjacent()
            .take(MAX_SUBMITTED_PROMPTS)

    /** `direction < 0` walks older; `direction > 0` walks newer. */
    fun navigate(direction: Int): Prompt? {
        val prompts = submittedPrompts
        navigationIndex = nextPromptHistoryIndex(prompts.size, navigationIndex, direction)
        return prompts.getOrNull(navigationIndex)
    }
}

private fun List<Prompt>.distinctAdjacent(): List<Prompt> = buildList {
    for (prompt in this@distinctAdjacent) {
        if (lastOrNull() != prompt) add(prompt)
    }
}

internal fun nextPromptHistoryIndex(historySize: Int, historyIndex: Int, direction: Int): Int {
    if (historySize == 0) return -1
    return when {
        direction < 0 -> (historyIndex + 1) % historySize
        historyIndex <= 0 -> -1
        else -> historyIndex - 1
    }
}
