package org.deveco.code.action

import org.deveco.code.session.model.FileReference

/**
 * One immutable staged handoff for the editor that binds its target session: the draft and
 * file reference merge into the session's view state at construction, while the prompt
 * delivery and mode mirror apply when the controller attaches. Never mutated after
 * staging, so a consumer always sees a complete snapshot even while another writer
 * replaces the entry.
 *
 * [releaseBusyOnConsume] is set by the bridge, which holds the shared creation guard from
 * its delivery until this handoff is consumed, superseded or settled by timeout.
 */
internal class PendingChatHandoff(
    val draft: String? = null,
    val fileReference: FileReference? = null,
    val fullPrompt: String? = null,
    val autoSendPrompt: String? = null,
    val mode: String? = null,
    val releaseBusyOnConsume: Boolean = false,
)
