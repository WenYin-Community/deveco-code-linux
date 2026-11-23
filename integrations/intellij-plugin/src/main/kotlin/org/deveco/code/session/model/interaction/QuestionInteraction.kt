package org.deveco.code.session.model.interaction

import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.snapshots.SnapshotStateMap

internal data class QuestionInteraction(
    val id: String,
    val state: InteractionState,
    val title: String,
    val message: String,
    val fields: List<ElicitationFieldItem>,
    val answers: Map<String, List<String>>? = null,
    val activityId: String? = null,
    val subagentId: String? = null,
    val selections: SnapshotStateMap<String, Set<String>> = mutableStateMapOf(),
    val customAnswers: SnapshotStateMap<String, String> = mutableStateMapOf(),
)
