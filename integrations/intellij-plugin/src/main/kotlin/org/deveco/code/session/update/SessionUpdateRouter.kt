package org.deveco.code.session.update

import com.agentclientprotocol.model.SessionConfigOption
import com.agentclientprotocol.model.SessionUpdate
import com.intellij.openapi.diagnostic.Logger
import org.deveco.code.acp.AcpSessionUpdate

internal class SessionUpdateRouter(
    private val sessionId: () -> String,
    private val queue: SessionUpdateQueue,
    private val onLiveTurnEvent: () -> Unit,
    private val isSessionLoading: () -> Boolean,
    private val isPrompting: () -> Boolean,
    private val isStopped: () -> Boolean,
    private val isCompacting: () -> Boolean,
    private val finishThought: () -> Unit,
    private val onAgentMessage: (SessionUpdate.AgentMessageChunk) -> Unit,
    private val onUserMessage: (SessionUpdate.UserMessageChunk) -> Unit,
    private val onThought: (SessionUpdate.AgentThoughtChunk) -> Unit,
    private val onToolCall: (SessionUpdate) -> Unit,
    private val applyCurrentMode: (String) -> Unit,
    private val updateConfigOptions: (List<SessionConfigOption>) -> Unit,
    private val acceptAvailableCommands: (SessionUpdate.AvailableCommandsUpdate) -> Unit,
    private val handleUsageUpdate: (Long, Long) -> Unit,
    private val reportOrderingWarning: (String) -> Unit,
    private val log: Logger = Logger.getInstance(SessionUpdateRouter::class.java),
) {
    fun accept(notification: AcpSessionUpdate) {
        // Filter on the ACP notification thread so another session's events
        // never consume this session's ordered UI queue.
        if (notification.sessionId.value != sessionId()) return
        queue.enqueue {
            onLiveTurnEvent()
            route(notification.update)
        }
    }

    private fun route(update: SessionUpdate) {
        // During backend load, historical config, mode, command, and usage
        // updates are applied inline. Message-producing events fall through so
        // replay still populates the conversation.
        if (isSessionLoading()) {
            when (update) {
                is SessionUpdate.CurrentModeUpdate -> {
                    applyCurrentMode(update.currentModeId.value)
                    return
                }

                is SessionUpdate.ConfigOptionUpdate -> {
                    updateConfigOptions(update.configOptions)
                    return
                }

                is SessionUpdate.AvailableCommandsUpdate -> {
                    acceptAvailableCommands(update)
                    return
                }

                is SessionUpdate.UsageUpdate -> {
                    handleUsageUpdate(update.used, update.size)
                    return
                }

                is SessionUpdate.AgentMessageChunk,
                is SessionUpdate.UserMessageChunk,
                is SessionUpdate.AgentThoughtChunk,
                is SessionUpdate.ToolCall,
                is SessionUpdate.ToolCallUpdate,
                -> Unit

                else -> return
            }
        } else if (!isPrompting() && !isStopped() && !isCompacting()) {
            // Message events outside replay/turn violate the load ordering
            // contract. Compaction runs without prompting=true, while stopped
            // turns drop their tail events below.
            when (update) {
                is SessionUpdate.AgentMessageChunk,
                is SessionUpdate.UserMessageChunk,
                is SessionUpdate.AgentThoughtChunk,
                is SessionUpdate.ToolCall,
                is SessionUpdate.ToolCallUpdate,
                -> reportOrderingWarning(
                    "Message event outside replay/turn: ${update::class.java.simpleName} " +
                        "for sessionId=${sessionId()} — replay ordering contract may be violated",
                )

                else -> Unit
            }
        }

        // After stop, queued message events must not append content below the
        // interrupted turn's action bar. Usage updates still apply because they
        // can legitimately report partial billing.
        if (isStopped()) {
            when (update) {
                is SessionUpdate.AgentMessageChunk,
                is SessionUpdate.AgentThoughtChunk,
                is SessionUpdate.UserMessageChunk,
                is SessionUpdate.ToolCall,
                is SessionUpdate.ToolCallUpdate,
                -> {
                    log.info(
                        "onSessionUpdate STOPPED: dropping ${update::class.java.simpleName} " +
                            "for sessionId=${sessionId()}",
                    )
                    return
                }

                else -> Unit
            }
        }

        if (update is SessionUpdate.AgentMessageChunk ||
            update is SessionUpdate.UserMessageChunk ||
            update is SessionUpdate.ToolCall
        ) {
            finishThought()
        }
        when (update) {
            is SessionUpdate.AgentMessageChunk -> onAgentMessage(update)
            is SessionUpdate.UserMessageChunk -> onUserMessage(update)
            is SessionUpdate.AgentThoughtChunk -> onThought(update)
            is SessionUpdate.ToolCall -> onToolCall(update)
            is SessionUpdate.ToolCallUpdate -> onToolCall(update)
            is SessionUpdate.CurrentModeUpdate -> applyCurrentMode(update.currentModeId.value)
            is SessionUpdate.AvailableCommandsUpdate -> acceptAvailableCommands(update)
            is SessionUpdate.UsageUpdate -> handleUsageUpdate(update.used, update.size)
            else -> Unit
        }
    }
}
