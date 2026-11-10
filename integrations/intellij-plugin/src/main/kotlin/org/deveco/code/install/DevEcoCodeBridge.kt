package org.deveco.code.install

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import org.deveco.code.MyMessageBundle
import org.deveco.code.acp.AcpClientService
import org.deveco.code.action.DevEcoSessionActions
import org.deveco.code.session.SessionController
import org.deveco.code.session.SessionStorage
import org.deveco.code.session.editor.SessionEditorRegistry
import org.deveco.code.session.editor.SessionFileEditor
import org.deveco.code.session.editor.revealChatTab
import org.deveco.code.util.errorMessage
import org.deveco.code.util.runInEdt
import java.io.File

/**
 * Entry point DevEco Studio calls, by reflection, to hand a compile error over to a DevEco Code
 * conversation. [BridgeRequestParser] documents the payload; its options decide which conversation
 * receives the prompt, which mode it is put in first, and whether the prompt goes out immediately
 * or only lands in the composer.
 *
 * Setting the mode is what makes reusing a conversation safe: ACP resolves the agent from the
 * session when the prompt arrives, so a blank conversation the user left in `plan` would plan a
 * compile-error fix instead of building it. A freshly created conversation is born in the default
 * mode, which is why this only ever showed up on the reuse path.
 *
 * The flow is create → configure → send, orchestrated from this package alone, so no session,
 * action or sessions code has to know the bridge exists beyond the one [SessionController.onReady]
 * hook it uses to act once a load has settled.
 */
object DevEcoCodeBridge {

    private const val TYPE_FILE = "FILE"
    private const val TOOL_WINDOW_ID = "DevEco Code"

    private val log = Logger.getInstance(DevEcoCodeBridge::class.java)

    @JvmStatic
    fun handleDevEcoCode(project: Project, json: String) {
        if (project.isDisposed || json.isBlank()) return
        // The caller's thread is whatever DevEco Studio reflected in on — possibly its EDT — and
        // inlining FILE contexts reads whole files, so parse and build off-thread. A failure must
        // not escape onto this thread's uncaught handler either: the caller cannot see it there.
        pooled {
            val request = BridgeRequestParser.parse(json)
            if (request == null) {
                // The protocol comes from another IDE, so a typo or a version mismatch has to be
                // diagnosable; the payload itself can hold whole source files, so log only its size.
                log.warn("bridge: ignoring an unparsable or empty payload (${json.length} chars)")
                return@pooled
            }
            val prompt = runCatching { buildPrompt(request) }.getOrElse {
                log.warn("bridge: building the prompt failed", it)
                report(
                    project,
                    MyMessageBundle.message("bridge.delivery.prompt.failed", errorMessage(it)),
                    error = true,
                )
                return@pooled
            }
            if (prompt.isBlank()) return@pooled
            project.runInEdt { dispatch(project, request, prompt) }
        }
    }

    private fun buildPrompt(request: BridgeRequest): String {
        val parts = request.contexts.map { context ->
            if (context.type != TYPE_FILE) return@map context.text
            val file = File(context.text)
            if (file.exists() && file.isFile) file.readText() else "File not found: ${context.text}"
        }
        if (parts.isEmpty()) return ""
        val body = parts.joinToString("\n\n")
        val prefix = when (val lead = request.promptPrefix) {
            PromptLeadIn.Default -> MyMessageBundle.message("bridge.fix.compile.error")
            PromptLeadIn.None -> null
            is PromptLeadIn.Text -> lead.value
        }
        if (prefix == null) return body
        return "$prefix\n\n$body"
    }

    // ----------------------------------------------------------------------------------------
    // Dispatch. EDT: resolve the target, then move the blocking work off it.
    // ----------------------------------------------------------------------------------------

    private fun dispatch(project: Project, request: BridgeRequest, prompt: String) {
        if (project.isDisposed) return
        runCatching { ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)?.activate(null) }
        val actions = DevEcoSessionActions.forProject(project)
        val editor = SessionEditorRegistry.getInstance(project).chatEditor()
        when (val target = resolveTarget(editor, request.session)) {
            is Target.LiveEditor -> {
                revealChatTab(project, target.editor.sessionFile, target.editor, focusEditor = true)
                deliver(project, target.editor.controller, request, prompt)
            }

            // Creating a conversation takes seconds (connect, then session/new); a second trigger
            // in that window would create another one and fight over the single chat tab. Set here
            // on the EDT and cleared by createAndDeliver once the tab is bound, so the guard spans
            // the whole placement instead of just the backend call.
            Target.CreateNew -> {
                if (actions.busy) return report(project, MyMessageBundle.message("bridge.delivery.busy"), error = false)
                actions.busy = true
                pooled { createAndDeliver(project, actions, request, prompt) }
            }

            Target.Busy -> report(project, MyMessageBundle.message("bridge.delivery.turn.busy"), error = false)

            Target.Unavailable -> report(project, MyMessageBundle.message("bridge.delivery.unavailable"), error = false)
        }
    }

    private sealed interface Target {
        data class LiveEditor(val editor: SessionFileEditor) : Target
        data object CreateNew : Target
        data object Busy : Target
        data object Unavailable : Target
    }

    private fun resolveTarget(editor: SessionFileEditor?, target: SessionTarget): Target {
        // A conversation mid-turn is never blank (sendPrompt appends the user message synchronously),
        // so a blank-only request has nothing to reuse here — and must not fall back to creating one,
        // which is what "only reuse a blank conversation" rules out.
        if (editor != null && editor.controller.isTurnActive) {
            return when (target) {
                SessionTarget.Current -> Target.Busy
                SessionTarget.BlankOnly -> Target.Unavailable
                else -> Target.CreateNew
            }
        }
        return when (target) {
            SessionTarget.New -> Target.CreateNew
            SessionTarget.BlankOrNew -> blankEditor(editor)?.let { Target.LiveEditor(it) } ?: Target.CreateNew
            SessionTarget.BlankOnly -> blankEditor(editor)?.let { Target.LiveEditor(it) } ?: Target.Unavailable
            SessionTarget.Current -> editor?.let { Target.LiveEditor(it) } ?: Target.CreateNew
        }
    }

    private fun blankEditor(editor: SessionFileEditor?) = editor?.takeIf { it.controller.messages.isEmpty() }

    // ----------------------------------------------------------------------------------------
    // Delivery
    // ----------------------------------------------------------------------------------------

    /**
     * Creates a conversation, puts it in the requested mode, then opens it and hands the prompt
     * over. Configuring *before* the tab opens is what avoids waiting for the load: the controller
     * loads a session this process created with `replay = false`, which hits the connection cache
     * and issues no RPC (`AcpClientConnection.loadSession`), so `session/load` never gets to
     * recompute the mode from history.
     *
     * Always a fresh session, for the same reason: an unsent one left over from an earlier IDE
     * process is not in this connection's `sessions` map, so `setSessionMode` would fail on it with
     * "ACP session is not loaded" — and it would stay in the pool, failing every later call too.
     *
     * Owns `actions.busy` from here on; dispatch set it on the EDT.
     */
    private fun createAndDeliver(
        project: Project,
        actions: DevEcoSessionActions,
        request: BridgeRequest,
        prompt: String,
    ) {
        // dispatch set busy = true on the EDT; every exit path — including unexpected
        // exceptions from SessionStorage or applyMode — must clear it, or the next bridge
        // delivery would be rejected forever. The finally block dispatches back to the EDT
        // so the write happens on the same thread that set it.
        try {
            val service = project.getService(AcpClientService::class.java)
            val sessionId = runCatching {
                if (!service.isConnected() && !service.connect()) error(service.statusText())
                service.newSession()
            }.getOrElse {
                log.warn("bridge: session creation failed", it)
                report(
                    project,
                    MyMessageBundle.message("bridge.delivery.create.failed", errorMessage(it)),
                    error = true,
                )
                return
            }
            // Pooled as unsent, so a failure further down leaves a reusable blank conversation behind
            // rather than an orphan, and the toolbar's new-session can still adopt it.
            SessionStorage.addNewSession(project, sessionId)
            applyMode(project, sessionId, request.mode)?.let { blocked ->
                report(project, blocked, error = true)
                return
            }
            project.runInEdt {
                if (project.isDisposed) return@runInEdt
                actions.ops.openSession(sessionId, MyMessageBundle.message("toolwindow.deveco.new.title"), true)
                actions.uiOnRefresh?.invoke()
                val controller = SessionEditorRegistry.getInstance(project).chatEditor()?.controller
                if (controller == null) {
                    report(project, MyMessageBundle.message("bridge.delivery.no.editor"), error = true)
                    return@runInEdt
                }
                // The load serves the configOptions cached at session/new, which still name the default
                // mode, and set_mode pushes no update of its own — so without this the selector would
                // show the default while the backend runs the requested mode.
                controller.onReady = { mirrorMode(controller, request.mode) }
                handOff(controller, prompt, request.sendImmediately)
            }
        } finally {
            project.runInEdt { actions.busy = false }
        }
    }

    /**
     * Puts an attached conversation in the requested mode and hands the prompt over. EDT.
     *
     * While the session is still loading, configuring now would be undone — `session/load`
     * recomputes the mode from history — so the whole configure-and-send moves to
     * [SessionController.onReady], which fires at the point the load has settled.
     */
    private fun deliver(project: Project, controller: SessionController, request: BridgeRequest, prompt: String) {
        if (controller.isTurnActive) {
            // A running turn also reads !ready (sendPrompt clears it), and onReady is consumed by
            // the load-complete hook alone — parking the prompt there would lose it.
            controller.pendingPrompt = prompt
            log.info("bridge: ${controller.sessionId} is mid-turn; left the prompt in the composer")
            return
        }
        if (!controller.ready) {
            controller.onReady = { deliverNow(project, controller, request, prompt) }
            return
        }
        deliverNow(project, controller, request, prompt)
    }

    private fun deliverNow(project: Project, controller: SessionController, request: BridgeRequest, prompt: String) {
        pooled {
            applyMode(project, controller.sessionId, request.mode)?.let { blocked ->
                report(project, blocked, error = true)
                return@pooled
            }
            project.runInEdt {
                mirrorMode(controller, request.mode)
                handOff(controller, prompt, request.sendImmediately)
            }
        }
    }

    /**
     * Puts the session in [mode]. Pooled thread: a blocking RPC that has to land before the prompt,
     * because ACP reads the agent off the session at prompt time. Returns the localized reason the
     * delivery has to be abandoned, or null when the mode is in effect.
     */
    private fun applyMode(project: Project, sessionId: String, mode: String?): String? {
        if (mode == null) return null
        val failure = runCatching {
            project.getService(AcpClientService::class.java).setSessionMode(sessionId, mode)
        }.exceptionOrNull()
        if (failure == null) {
            log.info("bridge: $sessionId switched to mode '$mode'")
            return null
        }
        return MyMessageBundle.message("bridge.delivery.mode.failed", mode, errorMessage(failure))
    }

    /**
     * `session/set_mode` does not push `current_mode_update` — only the plan_enter/plan_exit tools
     * do (`packages/opencode/src/acp/event.ts`, `syncMode`) — so without this the selector would keep
     * showing the mode the user left it in even though the backend already switched. Going through
     * the controller is what a click on the dropdown does; the write it fires carries the value
     * [applyMode] just landed, so it is idempotent. A no-op while the mode list is unloaded.
     */
    private fun mirrorMode(controller: SessionController, mode: String?) {
        if (mode == null || controller.selectedMode?.id == mode) return
        controller.selectMode(mode)
    }

    /**
     * Places the prompt. EDT. Sends when the conversation can take it now; otherwise parks it — in
     * the composer when the caller asked not to send or a turn started in the meantime, on the
     * load-complete hook while the session is still loading.
     */
    private fun handOff(controller: SessionController, prompt: String, sendNow: Boolean) {
        when {
            !sendNow || controller.isTurnActive -> controller.pendingPrompt = prompt
            !controller.ready -> controller.autoSendOnReady = prompt
            else -> controller.sendPrompt(prompt)
        }
    }

    // ----------------------------------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------------------------------

    private fun pooled(body: () -> Unit) = ApplicationManager.getApplication().executeOnPooledThread(body)

    /**
     * Surfaces a message with no modal dialog: the bridge is triggered from DevEco Studio, so a
     * dialog would block the IDE over something the user did not start interactively. The sidebar's
     * status line is the channel `SessionOps.reportFailure` already uses; it is silent while the tool
     * window is not composed, which is why every call is logged too. [error] additionally paints it
     * red — an ordinary rejection is not an error, and neither kind may touch the shared busy flag,
     * which another creation in flight still owns.
     */
    private fun report(project: Project, message: String, error: Boolean) {
        if (error) log.warn("bridge: $message") else log.info("bridge: $message")
        if (project.isDisposed) return
        project.runInEdt {
            DevEcoSessionActions.forProject(project).uiOnStateChange?.invoke {
                it.copy(status = message, error = if (error) message else null)
            }
        }
    }
}
